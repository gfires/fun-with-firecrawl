# Project Guide

Adaptive multi-agent research system on top of a Next.js/TypeScript Firecrawl app ("Blindspot"). A manager decomposes a topic into questions, a committee (Historian, Operator, Investor on Claude Sonnet 5; Skeptic on GPT-4o) debates structured claims, and a VOI gate allocates further retrieval budget. Orchestration is LangGraph.js. Two arms (baseline single-prompt vs orchestrated graph) run side-by-side.

**Current status, changelog, and open issues live in [STATUS.md](STATUS.md).** This file holds stable reference only.

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
| `src/lib/orchestration/trace.ts` | TraceLogger — exhaustive run trace (prompts, responses, state) |

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
