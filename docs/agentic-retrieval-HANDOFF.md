# HANDOFF — Agentic Retrieval build

You are picking up a **reviewed, locked** plan to make Blindspot's retrieval agentic. The
architecture is decided; your job is to **orchestrate the build**, delegating one phase at a
time. Do NOT relitigate the decisions below — they went through `/plan-eng-review` + an
adversarial outside-voice pass that caught a disqualifying bug (already fixed in the spec).

## Read these first (in order)

1. **`docs/agentic-retrieval-spec.md`** — the full spec. Your source of truth. Contains
   the target architecture, all invariants, the file list, the 5 phases, the test plan, and
   failure modes. Read it completely before delegating anything.
2. **`STATUS.md`** → "Next: agentic retrieval" section — the committed summary (decisions +
   landmines + build order). This is the durable copy if `.context` didn't travel.
3. **`CLAUDE.md`** — project guide: key files, build commands, and the design principles you
   must hold to ("enforce in code not prompts", "no hard caps in LLM output schemas", "no
   vibe floats", "all prompt wording in prompts.ts", "disregard dev time").
4. Skim the code you'll touch: `src/lib/orchestration/graph.ts` (retrieve + refine nodes,
   `scopeEvidenceToQuestions`, `computeRecursionLimit`, graph assembly, `routeAfterGate`),
   `src/lib/evidence/firecrawl.ts` (`search()`, `scrapeOne`, `getCache`),
   `src/lib/orchestration/gate.ts`, `cost-tracker.ts`, `debate.ts` (`extractContentions`),
   `src/lib/schemas/{evidence,state}.ts`, `scripts/compare-arms.ts`, `eval.ts`.

## Mission (one paragraph)

Replace the `retrieve` node with a bounded Haiku researcher **agent** (one per unresolved
question, AI-SDK `generateText` + `webSearch`/`readSource` tools + `stopWhen`). Delete the
`refine` node; its query-generation becomes the agent's loop-≥1 mission. `gate` stays as the
debate-informed VOI guardrail (`gate→retrieve` loop-back). The committee debate + frozen
evidence snapshot are **UNCHANGED** — roles get no tools. Add an `agentic` eval arm so we can
measure agentic retrieval against the tuned `orchestrated` workflow on the same topic.

## The landmines (memorize — these are why the review mattered)

1. **Evidence orphaning (was CRITICAL).** `scopeEvidenceToQuestions` buckets Evidence to a
   question only if its `sourceQuery` is in that question's `searchQueries`. An agent invents
   its own queries → its evidence would match nothing → silently dropped → committee sees
   NOTHING. **Fix (P1, do it first):** add `Evidence.questionId`; agent tags by identity;
   `scopeEvidenceToQuestions` prefers `questionId`.
2. **loopIteration filter trap.** `gate` increments `loopIteration` BEFORE the loop-back, so
   final-round claims carry the *pre-increment* loop. `missionForQuestion` must NOT filter
   claims by `=== loopIteration` (that's the exact no-op `refine` hit at `graph.ts:483`).
3. **Sole budget writer.** The `retrieve` node returns the ONLY signed `budgetRemaining`/
   `budgetSpent` delta. Agents spend a shared pass-local pool; node reconciles once at end.
   `gate` writes no budget delta — don't add one.
4. **Interior $-cap.** `getActiveCostTracker()?.check()` must run INSIDE the agent loop — the
   swarm bills dozens of Haiku calls per super-step; the node-entry check alone won't catch it.
5. **Real credits + clamp.** Charge post-cache actuals (cache hit = 0). Seed the pass pool
   `min(budgetRemaining, ceil(initialBudget × MAX_LOOP_SPEND_FRACTION))` — the `Math.min` is
   load-bearing on later loops.
6. **`newEvidenceCount` on every path** (including all-discard = 0) or `gateShortCircuit`
   no-progress breaks.
7. **`totalUsage` rollup** across all agent steps (not the final-step `usage`), or the cost
   comparison is corrupted.

## Build order — delegate ONE phase at a time (they form a dependency chain)

This is **sequential, one lane**: every phase touches `graph.ts` and/or `firecrawl.ts`, so
they do NOT parallelize. Gate each phase on **green `tsc` + `vitest` + a commit** before
starting the next.

| Phase | Scope | Done when |
|-------|-------|-----------|
| **P1** | `Evidence.questionId`; `scopeEvidenceToQuestions` prefers it; coded `retrieve` tags questionId | scoping tests pass; coded path unchanged; tsc+vitest green |
| **P2** | Firecrawl tool primitives: `webSearchRaw` (snippets) + `scrapeOneCached` (1 URL, cache-aware, real-credit) | unit tests w/ mocked Firecrawl client |
| **P3** | `researcher.ts`: tools, shared pass pool, `runResearcher`, interior `check()`, recon floor, dedup, `totalUsage` | mock-model tests cover every branch in the spec §7 |
| **P4** | Graph rewire: agentic `retrieve` behind `retrievalMode`; delete `refine`; `gate→retrieve`; recursion limit; `missionForQuestion` | 4 regression tests green (see spec §7) |
| **P5** | `arms[]` generalization; `agentic` arm in compare-arms/run-arm; SSE type updates | live `npm run compare -- "freight brokerage"`: agentic vs orchestrated |

## How to delegate

- **Use Conductor workspaces for substantive delegation, NOT headless `isolation:worktree`
  sub-agents** (they run invisibly, can't resume after a disconnect, and branch off `main`).
  See the project's `delegate-via-workspaces` guidance.
- **Push the branch first.** A new workspace bases off `origin/<branch>` and fetches — so
  commit + push `workflow-to-agentic-migration` (and set the new workspace's base to it)
  before delegating, or the workspace won't contain this spec/these commits.
- **One phase = one atomic task.** Don't hand a sub-agent "build the whole thing." Give it
  one phase, the spec section, the relevant files, and the acceptance gate. The dependency
  chain (shared files, questionId → tools → agent → rewire) means phases must land in order.
- **You (orchestrator) hold the gate.** After each delegated phase returns, verify `tsc` +
  `vitest` green yourself before delegating the next. A red gate blocks the chain.

## Build & check

```
npx tsc --noEmit        # typecheck (must stay clean)
npx vitest run          # tests (must stay green)
npm run compare -- "freight brokerage"   # P5 only — SPENDS API credits (human-run)
```

`tsc` + `vitest` are the only zero-cost checks. **The human runs all paid/live verification**
(the P5 compare run). Do not spend credits without the human.

## Do NOT (scope boundaries — from the review's "NOT in scope")

- Do not give the committee roles tools / break the frozen snapshot. That's the innovation.
- Do not build a manager-orchestrator agent (Option C) — trades away determinism/cost control.
- Do not delete the `coded` retrieve path — it's the permanent eval control arm.
- Do not add `.min()`/`.max()` to any Zod schema passed to `generateText`/`Output.object`
  (providers strip them → run-killing validation errors). Clamp in code.
- Do not reintroduce inline prompt strings in nodes — all wording goes in `prompts.ts`.

## Current state

- Branch `workflow-to-agentic-migration`, base `origin/debate-refine-phase-interaction`.
- Nothing built yet. Spec + this handoff are the only new artifacts (plus a STATUS.md note).
- First move: read the spec, then delegate **P1**.
