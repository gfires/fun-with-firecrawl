# Project Guide

Adaptive multi-agent research system on top of a Next.js/TypeScript Firecrawl app ("Blindspot"). A manager decomposes a topic into questions; for each question a committee of four role-agents (Historian, Operator on gpt-5.4-mini; Investor on Claude Sonnet 5; Skeptic on Gemini 3.1 Flash-Lite — see `src/lib/roles.ts`) holds a **real debate** over a frozen evidence snapshot (Wave 3): round 0 is the independent **blind** opening (each role renders one claim — a `conclusion`, a calibrated `confidence`, and a categorical `stance` — without seeing the others, so cross-role agreement is real signal), then — **only when the openings show genuine disagreement** (≥2 distinct decisive stances, or an evidence id-clash) — the roles read the full transcript and the challenges aimed at them and revise across conversational rounds, conceding only to evidence, until positions stop moving. The committee debates to RESOLVE disagreement; **agreement is a trigger to ACT, not a dead end.** A gate then routes each question on its committee stance: a unanimous decisive lean is a settled answer; a `contested` split routes by contention (interpretive → resolve + report the fault line, evidential/named-gap → more retrieval); an `insufficient` verdict with a named gap goes back to retrieval (go get it), and if that gap survives one no-progress loop it's noted as a limitation, not chased forever. Orchestration is LangGraph.js. Two arms (baseline single-prompt vs orchestrated graph) run side-by-side.

**Current status, changelog, and open issues live in [STATUS.md](STATUS.md).** This file holds stable reference only.

## Key files

| File | Purpose |
|------|---------|
| `src/lib/schemas/state.ts` | ResearchState (LangGraph Annotation) + debateTranscripts channel (mergeTranscripts) |
| `src/lib/schemas/evidence.ts` | Evidence zod schema |
| `src/lib/schemas/claim.ts` | Claim + DebateResponse / DebateTurnOutput zod schemas (debateRound, responses); `stance` (supports/opposes/insufficient) + `coerceStance` code clamp |
| `src/lib/roles.ts` | THE role catalog — name, system prompt (persona), and model + redebateModel per committee role, in one place |
| `src/lib/pricing.ts` | THE pricing catalog — `MODEL_CATALOG` (provider + $/1M input/output per LLM model id) AND `SEARCH_PROVIDER_PRICING` (credits/search + credits/scrape per search/scrape provider). eval.ts's cost estimator and the frontend cost display read MODEL_CATALOG from here; evidence/firecrawl.ts + evidence/exa.ts read their credit rate from here |
| `src/lib/models/provider.ts` | Resolves a role/model id to its SDK model instance purely off pricing.ts's `provider` field; modelForRole()/modelForDebateRound() read roles.ts |
| `src/lib/evidence/provider.ts` | THE search/scrape seam — explore()/search()/webSearchRaw()/scrapeOneCached(), the ONE provider-agnostic pipeline (dedupe/triage/cache/scrape worker pool) composed over whichever `SearchOps`/`ScrapeOps` evidence/config.ts's `SEARCH_PROVIDER`/`SCRAPE_PROVIDER` select — independently configurable operations. Call sites import from here, never from a specific vendor's file |
| `src/lib/evidence/config.ts` | Search/scrape tunables (intents, scrape depth, triage, provider concurrency) + the independent `SEARCH_PROVIDER`/`SCRAPE_PROVIDER` selectors (default: Exa search, Firecrawl scrape) |
| `src/lib/evidence/firecrawl.ts` | The Firecrawl SearchOps/ScrapeOps implementation — `rawSearch`/`scrapeUrl`, the bare provider-specific network calls only |
| `src/lib/evidence/exa.ts` | The Exa SearchOps/ScrapeOps implementation — `rawSearch`/`scrapeUrl`, mirroring firecrawl.ts |
| `src/lib/evidence/candidates.ts` | Pure, provider-agnostic candidate selection (dedupeCandidates/capCandidatesPerQuery/selectCandidatesByScore) shared by evidence/provider.ts's pipelines |
| `src/lib/evidence/store.ts` | In-memory Evidence store + contentHash |
| `src/lib/orchestration/graph.ts` | StateGraph + runGraph() + synthesizeReport() |
| `src/lib/orchestration/committee.ts` | runCommittee() (blind round-0 opening) + runDebate() (full debate loop) + buildCommitteeMessages/buildDebateMessages |
| `src/lib/orchestration/debate.ts` | Debate types + pure logic: decisiveStances / hasGenuineDisagreement / committeeStance (stance-based, position-general), debateMovement, directedChallenges, renderTranscript, extractContentions (idClashBetween), contentionRoute |
| `src/lib/orchestration/digest.ts` | Per-question Haiku evidence digest (L2) — compresses each source to one item before the committee |
| `src/lib/orchestration/gate.ts` | allocateBudget() — questionRoute() (route on committeeStance + named gap at zero LLM cost: settle unanimous, retrieve insufficient+gap, resolve interpretive fault lines) + VOI scoring; diminishingReturns (patience=1); gateShortCircuit() (budget / cost-headroom / max-loops / no-progress) |
| `src/lib/orchestration/limiter.ts` | createLimiter() — per-model + Firecrawl FIFO concurrency caps |
| `src/lib/orchestration/cost-tracker.ts` | Per-run USD cost cap via AsyncLocalStorage (runWithCostTracker) |
| `src/lib/orchestration/eval.ts` | ArmResult types + runBaseline() + toAnnotatedUsage() (cache-aware cost) + rollupTokens() |
| `src/lib/orchestration/mechanics.ts` | computeRunMechanics() + formatMechanicsReport() — per-run RUN MECHANICS report (retrieval, deliberation debated-vs-skipped + productive, cache-aware effort split, convergence) |
| `src/lib/supabase.ts` | Supabase client backing the search/scrape/blocklist caches (`blindspot` schema; see `supabase/schema.sql`) |
| `src/lib/params.ts` | Orchestration/gate-policy tunables (`TOTAL_RETRIEVAL_BUDGET` — ONE combined search+scrape credit cap, incl. per-loop reservation + $ cap, thresholds, loop limits, digest, prompt-cache, debate rounds, movement epsilon). Search/scrape MECHANICS tunables live in evidence/config.ts; role/model config lives in roles.ts + pricing.ts |
| `src/lib/prompts.ts` | Home for non-role-persona LLM prompt WORDING (CONFIDENCE_CALIBRATION, intake/decompose/digest/committee/debate/gate/answer builders). Nodes keep state-shaping; wording lives here. Role personas live in roles.ts |
| `scripts/compare-arms.ts` | A/B comparison harness (accepts --budget) |
| `src/lib/research-events.ts` | ResearchEvent union (SSE wire protocol for orchestration), incl. `debate:opening`/`debate:round` (blind opening + conversational rounds) and the terminal `research:mechanics` |
| `src/lib/orchestration/graph-stream.ts` | runGraphStreaming() — streaming graph runner; `transcriptToEvents()` maps the debate node's per-loop transcripts to `debate:opening`/`debate:round` |
| `src/lib/useResearchStream.ts` | Frontend hook + reducer for research SSE |
| `src/lib/useResearchReplay.ts` | Drives the SAME reducer over a static pre-recorded event array behind play/pause/scrub/speed |
| `src/lib/research/board.ts` | Pure cell-derivation helpers for `QuestionBoard` (stance/verdict/scoping) — no LLM calls, unit-tested |
| `src/lib/research/arena.ts` | `DebateArena`/`AgentSwimlane` pure graph + swimlane-cell builders (`debateRoundCells` keys by `debateRound`) |
| `src/app/api/research/orchestrated/route.ts` | SSE endpoint for orchestrated research |
| `src/app/api/research/replay/route.ts` | Serves the committed replay fixture (`test/fixtures/replay-events.json`) |
| `src/components/research/QuestionBoard.tsx` | Top-level question-centric swimlane board (`docs/question-board-spec.md`) — replaces the old `ResearchProgress`; recomposes the other research components as drill-downs |
| `scripts/run-arm.ts` | Single-arm runner (baseline or orchestrated, accepts --budget) |
| `src/lib/orchestration/trace.ts` | TraceLogger — exhaustive run trace (prompts, responses, state) |

## Build & check

```
npx tsc --noEmit        # typecheck (should be clean)
npx vitest run           # tests
npm run smoke:supabase   # verify the Supabase cache round-trips (live but free)
npm run compare -- "freight brokerage"              # run both arms
npx tsx scripts/run-arm.ts orchestrated "freight brokerage"  # single arm
npx tsx scripts/run-arm.ts baseline "freight brokerage" --budget=20  # with budget override (use --budget=N, not a space)
```

`tsc` + `vitest` are the only zero-cost checks; everything below `smoke:supabase` spends API credits.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health

## Agent orchestration (delegating work)

- **Delegate through Conductor workspaces, not headless sub-agents.** For parallel or delegated work, create a Conductor workspace (own pane: live chat + terminal + diff viewer, resumable via checkpoints, correct base branch). Do NOT use the Agent tool's `isolation: worktree` sub-agents for substantive delegation — they run invisibly, can't be cleanly resumed after an API disconnect, and branch off the root checkout's HEAD (`main`), not the workspace branch. See [[worktree-base-branch-gotcha]].
- **New workspaces base off the pushed base branch.** A Conductor workspace is created from `origin/<base>` (it fetches first). To continue work on a local feature branch, push it first, then set the new workspace's base branch to it — otherwise the workspace won't contain unpushed commits.
- **Keep delegated tasks small and atomic.** One file / one function per task. Large multi-hundred-line re-indents are what die mid-edit on a disconnect. Sequential dependency chains (shared files, symbol dependencies) don't parallelize — do them inline or in one workspace, one phase at a time, with a `tsc`/`vitest` gate + commit per phase.

## Design principles

- **Enforce in code, not prompts.** If a constraint can be checked or clamped programmatically, do it — don't rely on the LLM obeying a prompt instruction. Prompts are hints; code is guarantees. Examples: budget caps, enum membership, ID validation, range clamping.
- **Prompt/model/config wording and tuning live in dedicated single-source-of-truth files, not scattered inline.** `src/lib/prompts.ts` holds non-role-persona LLM prompt WORDING (the prose analogue of `params.ts`) — calibration text, node instruction builders. `src/lib/roles.ts` holds each committee role's full config — name, persona/system prompt, AND model + redebateModel — together, since a role's identity and its model assignment are one configuration surface. `src/lib/pricing.ts` holds the model catalog (provider + $/1M pricing) AND the search/scrape provider credit rates (`SEARCH_PROVIDER_PRICING`) everything else resolves against. `src/lib/evidence/config.ts` holds search/scrape tunables + the independent active `SEARCH_PROVIDER`/`SCRAPE_PROVIDER`. When tuning a persona, a model assignment, pricing, or a node's instructions, edit the file that owns it — orchestration nodes keep only state-shaping and pass computed pieces into builder functions. Don't reintroduce inline prompt strings, model ids, or pricing numbers in the nodes. Prompt/config transparency is a product requirement; one readable file per concern serves it.
- **No hard caps in LLM output schemas.** Never put `.min()`/`.max()` (lengths, counts, numeric ranges) on Zod schemas passed to `generateText`/`Output.object` — providers strip unsupported JSON-schema keywords, so the model never sees the limit, and client-side validation turns a slightly-long response into a run-killing `NoOutputGeneratedError`. Steer with `.describe()` hints; clamp in code after generation where the bound actually matters.
- **No vibe floats.** Don't ask LLMs to produce made-up 0-1 scores (confidence, tractability, sensitivity) and then do math on them. The numbers look precise but are arbitrary. Prefer binary/categorical decisions from the LLM and compute quantitative signals from real data (gap counts, confidence spreads, evidence counts).
- - **Disregard dev time.** When evaluating different approaches, don't consider perceived human dev time at all. Look exclusively for the most correct, consistent, concise, and elegant solution.
