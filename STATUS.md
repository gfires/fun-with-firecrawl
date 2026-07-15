# Status

Running log of what's built and what's left. Stable reference (architecture, key files, build commands, design principles) lives in [CLAUDE.md](CLAUDE.md).

## What this is

Adaptive multi-agent research system on top of a Next.js/TypeScript Firecrawl app ("Blindspot"). A manager decomposes a topic into questions; for each question a committee (Historian, Operator, Investor on Claude Sonnet 5; Skeptic on GPT-4o) holds a real debate over a frozen evidence snapshot — round 0 is the independent blind opening, then (unless the openings agree) the roles read each other's positions and revise across conversational rounds until they stop moving (Wave 3) — and a VOI gate routes the surviving disagreements, resolving interpretive ones and spending retrieval budget only on evidential gaps. Orchestration is LangGraph.js. Two arms (baseline single-prompt vs orchestrated graph) run side-by-side.

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

**Resolved in Wave 3 (below):** the committee was a parallel poll of independent claims. Wave 3 makes it a real debate — round 0 stays the blind opening (so cross-role agreement is still real signal), then the roles read each other and revise across rounds. See the Wave 3 section for details.

## Wave 3 — real committee debate (branch `visualization-v1`, base `wave-3-debate`)

Turns the committee from a parallel poll of four monologues into a real debate: agents read each other's positions and respond (rebut / concede / extend) across rounds until positions stop moving. **Two nested loops, evidence FROZEN during a debate** — only the outer retrieval loop adds evidence. D0 (schemas, `debateTranscripts` channel, params) landed earlier; D1–D5 below.

- **D1 — pure debate logic** (`debate.ts`): `roundOneConsensus` (genuine agreement — tight spread, above a floor, no contradiction — not shared low-confidence uncertainty), `debateMovement` (a role moved if confidence shifted past epsilon or its cited-id set changed; rebuttals counted by `from→target` pair identity, never fuzzy-matching the point text), `directedChallenges`, `renderTranscript` (byte-stable), `extractContentions` (evidential vs interpretive). All zero-LLM, computed from real committee output — no vibe floats.
- **D2 — cache-preserving debate messages** (`committee.ts` `buildDebateMessages`): the shared system prefix (question + evidence/digest block + rendered transcript + calibration) stays byte-identical across the 3 Claude roles so the L3 prompt cache still hits; per-role challenges, prior turn, and task live in the user message.
- **D3 — debate model policy** (`provider.ts` `modelForDebateRound`): round 0 keeps the loop-aware opening mix; conversational rounds drop the constructive roles to Haiku, and the skeptic holds gpt-4o through `DEBATE_SKEPTIC_STRONG_ROUNDS` then drops to gpt-4o-mini.
- **D4 — `runDebate`** (`committee.ts`): round-0 blind opening → consensus fast-path → conversational rounds (historian-first stagger preserved for the cache) → movement-based early stop / `MAX_DEBATE_ROUNDS` cap. Returns the final round's claims (durable) + the full transcript; the graph debate node now returns `debateTranscripts` (replace-per-question via `mergeTranscripts`).
- **D5 — gate contention routing** (`gate.ts`): `contentionRoute` resolves interpretive-only (or agreed) questions at **zero LLM cost** and reports the fault line; only evidential contentions (a named gap) reach the LLM gate under budget. `refine` draws its second-pass queries from the *contested* gaps specifically; the `final_state` trace gains debate stats (rounds run, evidential/interpretive counts, concessions), plus `debate:round` and `debate:contentions` trace entries.
- **Single source of truth cleanup**: `directedChallenges` returns `{ from, response }` so `buildDebateMessages` reads it directly instead of re-walking claims to recover the challenger — the challenger stays on the owning claim's `agentRole`, never denormalized onto the LLM-output `DebateResponse`.

**Status:** all D1–D5 committed, `tsc` clean, **175 vitest tests green**. **NOT yet live-verified** — no paid run has exercised the debate end-to-end (see Remaining). **D6 (streaming SSE `debate:round` events, debate-arena UI, report of unresolved contentions, poll-vs-debate eval harness) is OUT OF SCOPE** and tracked on a separate branch; the live UI still renders round-0 claims.

## Adaptive economics + deliverable quality (branch `debate-refine-phase-interaction`)

Post-Wave-3 pass: the debate/refine loop was live-verified, then tuned end-to-end for cost, convergence, and a citable, authoritative deliverable. All landed with `tsc` clean + 244 vitest green.

- **Cross-round prompt caching** (`committee.ts` / `prompts.ts` `stableSystemHead`): the single `cacheControl` on a growing system message only ever cached within a round (read/write ratio stuck at 2.00). Added a second breakpoint at the STABLE head boundary (head + transcript as two consecutive `system` messages → one top-level `system` array via `@ai-sdk/anthropic`), so the head is served from cache across rounds. Probe-verified: single trailing breakpoint gives call-2 cacheRead 0; stable-head breakpoint gives cacheRead 13.3k. (Net effect modest in practice — see below.)
- **Debate stall-exit** (`debate.ts` `debateMovement`): converge on `moved === 0`, not `moved===0 && newRebuttals===0`. A round that moves no position over frozen evidence is terminal (the gate then routes the survivor); fresh rebuttals without a concession were the main churn source. Cuts wasted rounds (q4-style stalls exit after 1 round) while productive debates still run to the cap.
- **Budget reservation — layer 1** (`graph.ts` `retrieve`, `MAX_LOOP_SPEND_FRACTION=0.5`): no single retrieval pass may spend >½ the run's initial Firecrawl budget. Fixes the pathology where loop 0 drained the pool and the gap-targeted passes (the whole point of the outer loop) never ran (`loopIterations: 0`, converged on `budget`).
- **Reconnaissance-first loop 0 — layer 2** (`RECON_RESULTS_PER_QUESTION=3` vs `RESULTS_PER_QUESTION=6`, `resultsPerQuestionForLoop`): loop 0 scrapes shallow (broad coverage is low-value-per-credit before gaps are named); the gap-targeted passes go full depth. Grounding floor: not below 3, or thin evidence revives the historian-confabulation mode.
- **LLM cost cap $0.75** (`MAX_RUN_COST_USD` 2.00→0.75): gates deliberation; the objective ANSWER is exempt (records cost, never `check()`s) so the non-negotiable deliverable always completes on top.
- **Deliverable no longer truncates** (`answerObjective`, `SYNTHESIS_ANSWER_MAX_TOKENS=16000`): unset, the SDK sent Sonnet 5's 128k default and adaptive thinking ate the visible answer (real run shipped 1982 chars cut mid-word). Explicit ceiling + retry-once on `finishReason: "length"`, thinking kept on (disabling it degrades the answer). Live-verified complete (6.2k chars).
- **Cited, traceable answer** (`answerObjective`): the answer saw only prose conclusions and was told to "cite no sources" — it cited nothing despite 17/32 claims carrying evidence ids. Now threads the CITED evidence back as `[S#]` labels + digest facts + urls, tags each claim with its sources, requires citation. Live re-run: 0 → 22 citations across 11 sources.
- **Authoritative voice (A)** (`answerObjective`): lead with the directional VERDICT and what the evidence DOES establish, reason from best-available proxies, confine hedges — instead of threading "more evidence needed" throughout. (Empirically un-validated.)
- **Calibration #1 — credit proxies, findable vs structural gaps** (`prompts.ts` `CONFIDENCE_CALIBRATION`): trace showed the loop re-requesting the SAME gaps every loop because many are structurally non-public (competitor ARR/churn, pilot exit interviews, proprietary thresholds) that web search can't surface, and roles anchored confidence on ideal-but-unfindable data. Now: credit proxy/circumstantial evidence toward the confidence floor; list a gap only when load-bearing AND plausibly PUBLIC (structurally-private data is a noted limitation, not a gap to chase); don't pad gaps. Pure prompt change — roles stop listing unfindable gaps, so gate/refine stops chasing them, lifting confidence AND cutting wasted loops. Anti-overconfidence core untouched. (Empirically un-validated.)
- **All prompt wording centralized** (`src/lib/prompts.ts`): every persona, the calibration, and each node's prompt moved out of the orchestration nodes into one readable file (the prose analogue of `params.ts`); nodes keep state-shaping and pass computed pieces into builder functions. Pure relocation, byte-identical (proven by the substring-asserting tests).
- **Architecture note:** this is a LangGraph **workflow** (deterministic state machine + loops + checkpointer), not autonomous agents — the four roles are persona-differentiated single-shot structured LLM calls with no tools and no self-directed loops; retrieval is code-driven off named gaps. "Agent orchestration" holds in the multi-role-deliberation and LangGraph senses, not the autonomous-tool-agent sense.

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
- **~~Multi-loop run never exercised live.~~ ~~Live-verify the Wave 3 debate.~~** Done — 2026-07-14 runs (contract-review, biomechanical-CV) exercised 3 outer loops with real `debate:round` movement, `debate:contentions`, `final_state.debate` stats, and gap-targeted second/third retrieval passes; the historian cites ids in round 0 (no confabulation). Traces in `trace-output/`.
- **Live-verify calibration #1 + authoritative voice (A).** Both are committed and reasoned-through but NOT yet run live. A real run should show confidences landing in a more decisive band where proxies warrant it (without overclaiming), fewer wasted "need more evidence" loops on private-data-heavy topics, and an answer that leads with the verdict + `[S#]` citations. Protocol as above; the human runs all live/paid verification.
- Tune the debate/consensus/movement constants (`MAX_DEBATE_ROUNDS`, `DEBATE_CONSENSUS_*`, `DEBATE_CONFIDENCE_EPSILON`), the budget knobs (`MAX_LOOP_SPEND_FRACTION`, `RECON_RESULTS_PER_QUESTION`, `MAX_RUN_COST_USD`), and the calibration bar from real output.
- **~~Decide the agent-vs-workflow question.~~ DECIDED (2026-07-14): go agentic on RETRIEVAL only.** Reviewed via `/plan-eng-review` + adversarial outside voice. See "Next: agentic retrieval" below.

## Next: agentic retrieval (branch `workflow-to-agentic-migration`)

Move the `retrieve` node from code-driven Firecrawl to a bounded **Haiku researcher agent**
(one per unresolved question, AI-SDK `generateText` + `webSearch`/`readSource` tools +
`stopWhen`). Delete `refine` (its query-gen becomes the agent's loop-≥1 mission from the
contested evidential gaps). `gate` stays as the debate-informed VOI guardrail (`gate→retrieve`
loop-back). **Committee debate + frozen evidence snapshot UNCHANGED** — roles get no tools;
preserving the frozen snapshot is why we chose this (Option D) over agentic roles. A third
eval arm (`agentic`, via a `retrievalMode` flag) measures it against the `orchestrated` arm.

Full spec + operational handoff (tracked, travel with the branch): `docs/agentic-retrieval-spec.md`
and `docs/agentic-retrieval-HANDOFF.md` — a fresh orchestrator reads the HANDOFF first.

**Locked decisions:** split tools (agent replaces triage) · Haiku researcher · one query per
search step + multi-URL reads · refined head-only (relevance gate on the snippet; `readSource`
always stores full Evidence; agent sees a 600-char memo) · `Evidence.questionId` scoping ·
single shared pass-budget pool (FCFS + per-agent `maxSteps`) · `agentic` eval arm.

**Landmines (from the review — don't repeat):**
1. `scopeEvidenceToQuestions` buckets by `sourceQuery ∈ question.searchQueries`; an agent
   inventing queries would silently orphan 100% of its evidence → **fix first** with
   `Evidence.questionId` + scope-by-identity.
2. `missionForQuestion` must NOT filter claims by `=== loopIteration` (gate increments before
   the loop-back — the no-op trap `refine` hit at graph.ts:483).
3. `retrieve` stays the SOLE writer of signed budget deltas; `gate` writes none.
4. `getActiveCostTracker()?.check()` must run INSIDE the agent loop (node-entry check misses
   the per-super-step Haiku swarm).
5. Charge real post-cache credits; seed the pool `min(budgetRemaining, ceil(initial×MAX_LOOP_SPEND_FRACTION))`.
6. Return `newEvidenceCount` on every path; roll up `totalUsage` across all agent steps.

**Build order (sequential — one lane, shared graph.ts/firecrawl.ts; tsc+vitest+commit gate each):**
P1 `Evidence.questionId` scoping fix → P2 Firecrawl tool primitives → P3 `researcher.ts`
(agent + shared pool + interior check + recon floor) → P4 graph rewire (delete refine,
gate→retrieve, recursion limit) → P5 `agentic` eval arm + live `compare` run.

**Verification:** human runs all paid/live runs (the P5 `npm run compare` is the cost/quality check).

## Open issues

- None blocking. Historian confabulation fix confirmed live (2026-07-14 traces: round-0 claims cite ids). Previous schema-crash, silent-retrieve, and cost-overcount issues resolved — see Done / Wave 2.
- **Known-but-not-blocking — prompt caching is largely inert (~7% of input served from cache).** The cross-round caching win doesn't materialize in practice: re-debates run on Haiku (4096-token cache floor the digested blocks don't clear) and the stall-exit removes most round-2s (where cross-round reuse would occur); committee openings fall below Anthropic's per-model minimum because the digest shrinks them. Not worth chasing — the digest and the Haiku tier each save more than the forfeited cache; the real cost driver is re-debating across loops.
- **Structural ceiling — decision-critical B2B data is often non-public.** Web search can't surface competitor ARR/churn, WTP, procurement specifics, or proprietary thresholds; calibration #1 makes the committee reason from proxies instead of chasing these, but a truly authoritative answer on unit economics would need proprietary sources (PitchBook/Crunchbase-style data, expert interviews). A known boundary of the tool, not a bug.
