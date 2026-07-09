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

### Must do before first end-to-end run
- **gate.ts prompt**: `buildGatePrompt()` returns `"..."` — needs real summarization of claims/disagreements per question. This is the core VOI logic, to be written by hand.

### Done (2026-07-09)
- **Token tracking**: `ResearchState.llmCalls` (append-only `AnnotatedUsage[]`) threads through every `generateObject` call in `decompose`/`debate`/`gate` (graph.ts), `runCommittee` (committee.ts), and `allocateBudget` (gate.ts). `eval.ts` exports `toAnnotatedUsage()` (builds a usage record from a `generateObject` result) and `rollupTokens()` (aggregates into `ArmTokens`). `runGraph()` now rolls up `finalState.llmCalls` into `ArmResult.tokens` instead of returning zeros. Added `claude-sonnet-5` pricing to `MODEL_COST` in eval.ts.

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
| `src/lib/orchestration/gate.ts` | allocateBudget() — VOI scoring (prompt incomplete) |
| `src/lib/orchestration/eval.ts` | ArmResult types + runBaseline() |
| `scripts/compare-arms.ts` | A/B comparison harness |

## Build & check

```
npx tsc --noEmit        # typecheck (should be clean)
npx vitest run           # tests
npm run compare -- "freight brokerage"   # run both arms
```
