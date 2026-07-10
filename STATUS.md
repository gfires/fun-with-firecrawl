# Status

Running log of what's built and what's left. Stable reference (architecture, key files, build commands, design principles) lives in [CLAUDE.md](CLAUDE.md).

## What this is

Adaptive multi-agent research system on top of a Next.js/TypeScript Firecrawl app ("Blindspot"). A manager decomposes a topic into questions, a committee (Historian, Operator, Investor on Claude Sonnet 5; Skeptic on GPT-4o) debates structured claims, and a VOI gate allocates further retrieval budget. Orchestration is LangGraph.js. Two arms (baseline single-prompt vs orchestrated graph) run side-by-side.

## Done

- **Four core branches merged**: `evidence` (`search()` + Evidence store), `committee` (`runCommittee()` four-role deliberation), `eval` (baseline arm + A/B compare), `graph` (LangGraph StateGraph: decompose → retrieve → debate → gate → recommend).
- **Gate prompt**: summarizes each unresolved question's claims (role, conclusion, confidence, evidence counts, gaps) so the gate scores disagreement, sensitivity, tractability.
- **Token tracking**: `ResearchState.llmCalls` threads through every `generateObject` call; `runGraph()` rolls up into `ArmResult.tokens`.
- **Params consolidation**: orchestration tunables in `src/lib/params.ts`.
- **Single-arm runner**: `scripts/run-arm.ts` (baseline or orchestrated); both scripts accept `--budget`.
- **Real-time visualization**: SSE from LangGraph nodes (`graph-stream.ts` + `/api/research/orchestrated`), `useResearchStream` hook + reducer. Live UI: pipeline graph, question tracker, 4-agent panel, evidence feed, gate table, cost counter. Landing-page mode toggle: "Industry Scan" vs "Deep Research".
- **Budget concurrency**: `CostTracker` moved from a module singleton to `AsyncLocalStorage` (per-run via `runWithCostTracker`) so concurrent runs don't clobber each other's spend; cost recorded from exact `usage`, no pre-call estimate (bounded one-wave overshoot accepted). `budgetRemaining`/`budgetSpent` use an additive reducer (`accumulate`) over signed deltas — `retrieve` is the sole writer, `gate` writes no budget — so same-super-step updates can't be lost.

## Remaining

- End-to-end run on "freight brokerage" (see debug notes below re: schema/run failures).
- Tune `VOI_THRESHOLD` and budget constants from real output.

## Open issues

- **Orchestrated run: "No object generated: response did not match schema"** + long silent `retrieve` phase. Debug context handed off separately.
