# Status

Running log of what's built and what's left. Stable reference (architecture, key files, build commands, design principles) lives in [CLAUDE.md](CLAUDE.md).

## What this is

Adaptive multi-agent research system on top of a Next.js/TypeScript Firecrawl app ("Blindspot"). A manager decomposes a topic into questions; for each question a committee (Historian, Operator, Investor on Claude Sonnet 5; Skeptic on GPT-4o) each render one independent structured claim over the same evidence (parallel poll, not a back-and-forth debate), and a VOI gate allocates further retrieval budget. Orchestration is LangGraph.js. Two arms (baseline single-prompt vs orchestrated graph) run side-by-side.

## Wave 2 — token-efficiency overhaul (branch `wave-2-tokens`, ships to `visualization`)

Cuts orchestrated-arm token spend without losing signal. Phases, in graph order:

- **L2 — per-question digest** (`digest.ts`): a Haiku pass compresses each fresh source to one ≤400-char item keyed by its exact evidence id; the committee reasons over the digest, not full pages. Falls back to raw evidence on failure (never kills a run). Fix landed: Haiku echoed ids wrapped in `[...]`; `clampDigest` now strips brackets before matching.
- **L3 — committee prompt-cache split** (`committee.ts` `buildCommitteeMessages`): QUESTION + evidence + calibration live in a byte-identical **system** message across the 3 Claude roles (Anthropic serves it from cache); persona + instructions live in the **user** message. Historian runs first (cache write), operator/investor read. Needs `allowSystemInMessages: true` on `generateText`.
- **L4 — loop-aware model mix** (`params.ts`): loop 0 runs Sonnet×3 + gpt-4o; re-debates drop the 3 Claude roles to Haiku. Skeptic stays gpt-4o.
- **L6 — per-model concurrency + retries** (`limiter.ts`): FIFO semaphore caps gpt-4o to 2 in-flight; `LLM_MAX_RETRIES=4` on every call site.
- **B2/L1 — zero-progress kill + incremental re-debate** (`gate.ts` `gateShortCircuit`, `graph.ts`): a loop that retrieves 0 new evidence short-circuits (`no-progress`); re-debates only touch questions with fresh evidence and show each role its OWN prior claim to revise.
- **Firecrawl concurrency** (`FIRECRAWL_CONCURRENCY=2`): one shared FIFO queue over all search/scrape calls (Firecrawl throttles to ~2/account).
- **Supabase cache**: search/scrape/blocklist moved from `data/*.json` to Supabase (`blindspot` schema, `cache` + `blocklist` tables). Client in `src/lib/supabase.ts`; DDL in `supabase/schema.sql`; `npm run smoke:supabase` verifies the round-trip. Degrades gracefully (warn-once) if unreachable.
- **Cost accounting fix**: `toAnnotatedUsage` now reads AI-SDK v7 `usage.inputTokenDetails.{cacheReadTokens,cacheWriteTokens}` (was over-counting cache reads at full price ~35%).
- **Trace observability**: added `gate:converged` (with reason), `final_state` summary, `search/scrape-cache-hit` + live `scrape` outcome logging, and `loopIteration` on committee/digest LLM calls — so a single trace file fully explains reasoning quality, cache effectiveness, retrieval health, and convergence.
- **Historian confabulation fix** (2026-07-13): on precedent-free questions the historian claimed "no evidence was supplied" though the identical block was given to (and cited by) the other 3 roles — an over-generalization from the L3 system/user split, where the user message never pointed at the system evidence. Fix: a shared anchor line in every role's user message ("The QUESTION and its EVIDENCE are in the system message above…") + de-absolutized historian persona ("no precedent in this evidence" ≠ "no evidence at all"; never claim none was given). Covered by `test/orchestration/committee-messages.test.ts`. **Live-verified** on the 2026-07-13T17-30 freight-brokerage trace: 0/20 committee calls confabulated "no evidence supplied" (was 2/16), 0 claims cited zero support (historian now 3–6 supporting ids per claim), calibration held.

**Known design characteristic (not a bug):** the committee is a **parallel poll of independent claims, not a debate** — no role ever reads another role's output. The only cross-loop feedback is a role revising its OWN prior claim. Genuine cross-agent rebuttal (e.g. a round 2 where each role sees the skeptic's claim) is unbuilt and would be a deliberate architectural add.

## Done

- **Four core branches merged**: `evidence` (`search()` + Evidence store), `committee` (`runCommittee()` — four role-agents, one independent Claim each), `eval` (baseline arm + A/B compare), `graph` (LangGraph StateGraph: decompose → retrieve → debate → gate → recommend).
- **Gate prompt**: summarizes each unresolved question's claims (role, conclusion, confidence, evidence counts, gaps) so the gate scores disagreement, sensitivity, tractability.
- **Token tracking**: `ResearchState.llmCalls` threads through every structured-output LLM call; `runGraph()` rolls up into `ArmResult.tokens`.
- **Params consolidation**: orchestration tunables in `src/lib/params.ts`.
- **Single-arm runner**: `scripts/run-arm.ts` (baseline or orchestrated); both scripts accept `--budget`.
- **Real-time visualization**: SSE from LangGraph nodes (`graph-stream.ts` + `/api/research/orchestrated`), `useResearchStream` hook + reducer. Live UI: pipeline graph, question tracker, 4-agent panel, evidence feed, gate table, cost counter. Landing-page mode toggle: "Industry Scan" vs "Deep Research".
- **Budget concurrency**: `CostTracker` moved from a module singleton to `AsyncLocalStorage` (per-run via `runWithCostTracker`) so concurrent runs don't clobber each other's spend; cost recorded from exact `usage`, no pre-call estimate (bounded one-wave overshoot accepted). `budgetRemaining`/`budgetSpent` use an additive reducer (`accumulate`) over signed deltas — `retrieve` is the sole writer, `gate` writes no budget — so same-super-step updates can't be lost.
- **Schema-crash fix**: root-caused the intermittent "No object generated: response did not match schema" that killed orchestrated runs. Zod `.min()`/`.max()` caps in LLM output schemas (`ClaimOutputSchema` conclusion ≤400 chars etc.) are stripped by providers before generation and only validated client-side — the model exceeded them ~1 in 7 committee calls, and one bad call rejected the whole `Promise.all`. Removed the caps from `ClaimOutputSchema`, `DecompositionSchema`, `RefineSchema` (steering stays in `.describe()` hints); bounds that matter downstream are clamped in code (confidence → [0,1] and `missingEvidence` → 3 in `committee.ts`; questions → `MAX_QUESTIONS` in `decompose`; search queries → 3 in `refine`).
- **Live streaming progress**: fixed the UI freezing for minutes during `retrieve`. `graph-stream.ts` now emits each node's `begin` event eagerly on its predecessor's completion (successors are deterministic; the post-gate choice mirrors `routeAfterGate` including the budget condition), instead of waiting for `streamMode: "updates"` node-completion. Stream mode is now `["updates", "custom"]`: the retrieve node forwards per-query search results and a scrape counter from `search()` (new optional `onProgress` callback, `SearchProgress` type) through LangGraph's `config.writer`, surfaced as the new `retrieve:progress` SSE event and rendered in the trace feed (scrape counter lines coalesce). Verified live: first `begin` at ~0s, 17 progress events across a 67s retrieve.
- **AI SDK v7 migration**: replaced deprecated `generateObject` with `generateText` + `Output.object({ schema })` at all four call sites (`committee.ts`, `gate.ts`, `graph.ts` decompose/refine). Usage shape unchanged (`inputTokens`/`outputTokens`), so cost tracking and tracing flow through as before. Note: schema-validation failures now throw `NoOutputGeneratedError` (was `NoObjectGeneratedError`).

## Remaining

- **Re-run "freight brokerage" to confirm the historian fix live.** The 2026-07-13 trace (budget 50) showed the historian confabulating "no evidence" on 2 of 4 questions; the anchor + persona fix is committed but only unit-verified. Next trace should show the historian citing ≥1 id whenever the block is non-empty.
- **Multi-loop run never exercised live.** Every trace so far converges in one loop (`no-progress`, 0 new evidence on loop 1), so the re-debate path (L1/L4 Haiku, incremental prior-claim revision) has never actually fired end-to-end. Bump budget / pick a topic that keeps surfacing new evidence to exercise it.
- **Decide whether the committee should actually debate.** Today it's a parallel poll of independent claims — see the "Known design characteristic" note above. A genuine round-2 rebuttal (each role shown the others' claims, esp. the skeptic's) is an architectural add, not a bug fix.
- Tune budget/threshold constants from real output once the above land.

## Open issues

- None currently blocking. The historian "no evidence" confabulation is fixed in code (pending a live re-run to confirm). Previous schema-crash, silent-retrieve, and cost-overcount issues resolved — see Done / Wave 2.
