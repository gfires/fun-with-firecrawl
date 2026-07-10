# Project Status

## What this is

Adaptive multi-agent research system built on top of a Next.js/TypeScript Firecrawl app ("Blindspot"). A manager decomposes a topic into questions, a committee of expert agents (Historian, Operator, Investor on Claude Sonnet 5; Skeptic on GPT-4o) debates structured claims, and a VOI gate allocates further retrieval budget. Orchestration is LangGraph.js. Two arms (baseline single-prompt vs orchestrated graph) run side-by-side for direct comparison.

## What was just completed (2026-07-09)

All four parallel agent branches merged into main:

- **evidence**: `src/lib/evidence/firecrawl.ts` — refactored Firecrawl search/scrape into `search(queries, k, loopIteration) → Evidence[]` with dedup and caching. `evidence/store.ts` has in-memory Evidence store + contentHash.
- **committee**: `src/lib/orchestration/committee.ts` — four-role calibrated deliberation via `runCommittee(question, evidence) → Claim[]` using `generateObject`.
- **eval**: `src/lib/orchestration/eval.ts` + `scripts/compare-arms.ts` — baseline arm harness (`runBaseline`) and A/B comparison script. `ArmResult.report` is `ScanReport | ResearchReport`.
- **graph**: `src/lib/orchestration/graph.ts` — LangGraph StateGraph (decompose → retrieve → debate → gate → recommend). Exports `compileResearchGraph()`, `synthesizeReport()`, and `runGraph(topic) → ArmResult`.

Integration fixes applied during graph merge:
- `allocateBudget` call awaited (main's gate.ts is async)
- `firecrawlCalls`/`firecrawlCredits` counters added to `ResearchState`
- Evidence zod schema aligned to match `search()` output (domain+content, not retrievedAt)
- `ArmResult.report` widened to `ScanReport | ResearchReport`

## What remains

### Done (2026-07-09)
- **gate.ts prompt**: `buildGatePrompt()` now summarizes each unresolved question's claims (role, conclusion, confidence, supporting/contradicting evidence counts, missing evidence) so the gate model can score disagreement magnitude, recommendation sensitivity, and tractability.
- **Token tracking**: `ResearchState.llmCalls` (append-only `AnnotatedUsage[]`) threads through every `generateObject` call in `decompose`/`debate`/`gate` (graph.ts), `runCommittee` (committee.ts), and `allocateBudget` (gate.ts). `eval.ts` exports `toAnnotatedUsage()` (builds a usage record from a `generateObject` result) and `rollupTokens()` (aggregates into `ArmTokens`). `runGraph()` now rolls up `finalState.llmCalls` into `ArmResult.tokens` instead of returning zeros. Added `claude-sonnet-5` pricing to `MODEL_COST` in eval.ts.
- **Single-arm runner**: `scripts/run-arm.ts` runs either the baseline or orchestrated arm in isolation. Both scripts accept `--budget` to override `TOTAL_FIRECRAWL_BUDGET` without editing `params.ts`.
- **Params consolidation**: Orchestration tunables (`RESULTS_PER_QUESTION`, `MAX_LOOP_ITERATIONS`, `TOTAL_FIRECRAWL_BUDGET`, `VOI_THRESHOLD`, `MIN/MAX_QUESTIONS`) moved from gate.ts and graph.ts into `src/lib/params.ts`.
- **Real-time orchestration visualization**: SSE streaming from LangGraph nodes via `graph-stream.ts` + `/api/research/orchestrated` route. Frontend `useResearchStream` hook with pure reducer. Live UI: SVG pipeline graph with loop arc, question tracker with confidence bars, 4-agent debate panel, evidence feed, gate decision table with VOI scores, cost counter. Mode toggle on landing page: "Industry Scan" vs "Deep Research".

### After first run
- SSE streaming integration (wire graph node events into existing UI)
- End-to-end test on "freight brokerage"
- Tune VOI_THRESHOLD (currently 0.15) and BUDGET constants based on real output

## Key files

| File | Purpose |
|------|---------|
| `src/lib/schemas/state.ts` | ResearchState (LangGraph Annotation) |
| `src/lib/schemas/evidence.ts` | Evidence zod schema |
| `src/lib/schemas/claim.ts` | Claim zod schema |
| `src/lib/models/provider.ts` | Model assignments per agent role |
| `src/lib/evidence/firecrawl.ts` | search() and explore() |
| `src/lib/evidence/store.ts` | In-memory Evidence store + contentHash |
| `src/lib/orchestration/graph.ts` | StateGraph + runGraph() + synthesizeReport() |
| `src/lib/orchestration/committee.ts` | runCommittee() — four-role deliberation |
| `src/lib/orchestration/gate.ts` | allocateBudget() — VOI scoring with per-question claim summaries |
| `src/lib/orchestration/eval.ts` | ArmResult types + runBaseline() + toAnnotatedUsage() + rollupTokens() |
| `src/lib/params.ts` | Orchestration tunables (budget, thresholds, loop limits) |
| `scripts/compare-arms.ts` | A/B comparison harness (accepts --budget) |
| `src/lib/research-events.ts` | ResearchEvent union (SSE wire protocol for orchestration) |
| `src/lib/orchestration/graph-stream.ts` | runGraphStreaming() — streaming graph runner |
| `src/lib/useResearchStream.ts` | Frontend hook + reducer for research SSE |
| `src/app/api/research/orchestrated/route.ts` | SSE endpoint for orchestrated research |
| `src/components/research/` | Visualization components (PipelineGraph, AgentPanel, etc.) |
| `scripts/run-arm.ts` | Single-arm runner (baseline or orchestrated, accepts --budget) |

## Build & check

```
npx tsc --noEmit        # typecheck (should be clean)
npx vitest run           # tests
npm run compare -- "freight brokerage"              # run both arms
npx tsx scripts/run-arm.ts orchestrated "freight brokerage"  # single arm
npx tsx scripts/run-arm.ts baseline "freight brokerage" --budget 20  # with budget override
```

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

## Design principles

- **Enforce in code, not prompts.** If a constraint can be checked or clamped programmatically, do it — don't rely on the LLM obeying a prompt instruction. Prompts are hints; code is guarantees. Examples: budget caps, enum membership, ID validation, range clamping.
- **No vibe floats.** Don't ask LLMs to produce made-up 0-1 scores (confidence, tractability, sensitivity) and then do math on them. The numbers look precise but are arbitrary. Prefer binary/categorical decisions from the LLM and compute quantitative signals from real data (gap counts, confidence spreads, evidence counts).
