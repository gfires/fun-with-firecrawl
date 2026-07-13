# Project Guide

Adaptive multi-agent research system on top of a Next.js/TypeScript Firecrawl app ("Blindspot"). A manager decomposes a topic into questions; for each question a committee of four role-agents (Historian, Operator, Investor on Claude Sonnet 5; Skeptic on GPT-4o) holds a **real debate** over a frozen evidence snapshot (Wave 3): round 0 is the independent **blind** opening (each role renders one claim without seeing the others, so cross-role agreement is real signal), then — unless the openings already agree — the roles read the full transcript and the challenges aimed at them and revise across conversational rounds, conceding only to evidence, until positions stop moving. A VOI gate then routes the *surviving* disagreements — interpretive ones are resolved and reported as a fault line, evidential ones (a named gap) earn more retrieval budget. Orchestration is LangGraph.js. Two arms (baseline single-prompt vs orchestrated graph) run side-by-side.

**Current status, changelog, and open issues live in [STATUS.md](STATUS.md).** This file holds stable reference only.

## Key files

| File | Purpose |
|------|---------|
| `src/lib/schemas/state.ts` | ResearchState (LangGraph Annotation) + debateTranscripts channel (mergeTranscripts) |
| `src/lib/schemas/evidence.ts` | Evidence zod schema |
| `src/lib/schemas/claim.ts` | Claim + DebateResponse / DebateTurnOutput zod schemas (debateRound, responses) |
| `src/lib/models/provider.ts` | Model assignments per agent role |
| `src/lib/evidence/firecrawl.ts` | search() and explore() |
| `src/lib/evidence/store.ts` | In-memory Evidence store + contentHash |
| `src/lib/orchestration/graph.ts` | StateGraph + runGraph() + synthesizeReport() |
| `src/lib/orchestration/committee.ts` | runCommittee() (blind round-0 opening) + runDebate() (full debate loop) + buildCommitteeMessages/buildDebateMessages |
| `src/lib/orchestration/debate.ts` | Debate types + pure logic: roundOneConsensus, debateMovement, directedChallenges, renderTranscript, extractContentions, contentionRoute |
| `src/lib/orchestration/digest.ts` | Per-question Haiku evidence digest (L2) — compresses each source to one item before the committee |
| `src/lib/orchestration/gate.ts` | allocateBudget() — contention routing (resolve interpretive at zero LLM cost) + VOI scoring; gateShortCircuit() (budget / max-loops / no-progress) |
| `src/lib/orchestration/limiter.ts` | createLimiter() — per-model + Firecrawl FIFO concurrency caps |
| `src/lib/orchestration/cost-tracker.ts` | Per-run USD cost cap via AsyncLocalStorage (runWithCostTracker) |
| `src/lib/orchestration/eval.ts` | ArmResult types + runBaseline() + toAnnotatedUsage() + rollupTokens() |
| `src/lib/supabase.ts` | Supabase client backing the search/scrape/blocklist caches (`blindspot` schema; see `supabase/schema.sql`) |
| `src/lib/params.ts` | Orchestration tunables (budget, thresholds, loop limits, digest, prompt-cache, model mix, concurrency, debate rounds/consensus) |
| `scripts/compare-arms.ts` | A/B comparison harness (accepts --budget) |
| `src/lib/research-events.ts` | ResearchEvent union (SSE wire protocol for orchestration) |
| `src/lib/orchestration/graph-stream.ts` | runGraphStreaming() — streaming graph runner |
| `src/lib/useResearchStream.ts` | Frontend hook + reducer for research SSE |
| `src/app/api/research/orchestrated/route.ts` | SSE endpoint for orchestrated research |
| `src/components/research/` | Visualization components (PipelineGraph, AgentPanel, etc.) |
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
- **No hard caps in LLM output schemas.** Never put `.min()`/`.max()` (lengths, counts, numeric ranges) on Zod schemas passed to `generateText`/`Output.object` — providers strip unsupported JSON-schema keywords, so the model never sees the limit, and client-side validation turns a slightly-long response into a run-killing `NoOutputGeneratedError`. Steer with `.describe()` hints; clamp in code after generation where the bound actually matters.
- **No vibe floats.** Don't ask LLMs to produce made-up 0-1 scores (confidence, tractability, sensitivity) and then do math on them. The numbers look precise but are arbitrary. Prefer binary/categorical decisions from the LLM and compute quantitative signals from real data (gap counts, confidence spreads, evidence counts).
- - **Disregard dev time.** When evaluating different approaches, don't consider perceived human dev time at all. Look exclusively for the most correct, consistent, concise, and elegant solution.
