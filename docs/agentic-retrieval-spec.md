# Spec — Agentic Retrieval (workflow → agency, scoped)

Status: reviewed via `/plan-eng-review` (2026-07-14). Outside voice: Claude subagent
(Codex was 401-unauthed). One CRITICAL flaw caught + folded (evidence orphaning).
Branch: `workflow-to-agentic-migration`. Base for PR: `origin/debate-refine-phase-interaction`.

## 1. Objective

Move retrieval from a code-driven workflow to a genuine agent, WITHOUT trading away the
committee debate's frozen-snapshot invariant (the core innovation) or the run's cost
control. The `retrieve` node becomes a bounded AI-SDK tool-loop (one researcher agent per
unresolved question). `gate` stays as the cross-pass, debate-informed VOI guardrail;
`refine` is deleted (its query-generation dissolves into the agent). A third eval arm
(`agentic`) measures whether the agency actually beats the tuned `orchestrated` workflow.

This is Option **D structure + B ambition for the node**: agency where the task is
genuinely a search problem; determinism where the guarantees live (budget, convergence,
frozen debate).

## 2. Locked decisions (from the review)

| # | Decision | Choice |
|---|----------|--------|
| Fork 1 | Tool granularity | **Split**: `webSearch` + `readSource`; agent replaces the fixed triage on this path |
| Fork 2 | Researcher model | **claude-haiku-4-5** (search planning, not deep reasoning) |
| Fork 3 | Batching | **One query per `webSearch` step** (reflect between searches); **multi-URL `readSource`** |
| Fork 4 | readSource payload | **Refined head-only**: relevance gate is the SNIPPET; readSource always stores full Evidence; agent sees title + first ~600 chars as a working memo |
| Fork 5 | Evidence→question scoping | **A**: add `Evidence.questionId`; agent tags by identity; `scopeEvidenceToQuestions` prefers it |
| Fork 6 | Budget model | **A**: single shared pass-budget pool, FCFS, each agent bounded by its own `maxSteps` |
| Fork 7 | Committee | **Unchanged** — frozen snapshot preserved, no tools for roles |

## 3. Target architecture

```
intake → decompose → retrieve* → debate → gate ─(continue)→ retrieve*  (loop)
                         ▲                   │
                         └───────────────────┘   (refine DELETED; gate loops straight to retrieve)
                                             └────(stop)────→ recommend → END

* retrieve = agentic researcher node: one researcher agent per unresolved question,
  run concurrently via Promise.all, drawing from ONE shared pass-budget pool.
```

Researcher agent (per question, model = Haiku):
```
mission:
  loop 0   → the question's decompose keyword queries + "reconnaissance: broad, shallow,
             gather at least RECON_FLOOR sources before stopping"  (code-enforced floor)
  loop ≥1  → this question's CONTESTED EVIDENTIAL gaps
             (missionForQuestion: extractContentions → type==='evidential' → missingEvidence)
             + the titles/urls already gathered (so it doesn't re-chase)
   │
   ▼
┌ agent step (generateText + tools + stopWhen) ─────────────────────────────────┐
│  getActiveCostTracker()?.check()   ← INTERIOR $-cap check, every step          │
│  webSearch(query: string)   → [{title,url,snippet}]     charges REAL credits   │
│  readSource(urls: string[]) → [{title, head: first 600 chars}]  (stores full)  │──► firecrawlLimiter
│  every tool: passPool.trySpend(realCredits)  → false → return "budget exhausted"│──► shared pass pool
│  readSource: ALWAYS stores full ~4500-char page as Evidence{questionId,...}     │
└────────────────────────────────────────────────────────────────────────────────┘
   │  stopWhen: stepCountIs(MAX_AGENT_STEPS)  OR  passPool empty  OR  check() throws
   ▼
Evidence[] tagged {questionId, sourceQuery, loopIteration}
   │
   ▼ retrieve NODE: dedupe by contentHash across agents → sum REAL credits →
     ONE signed budget delta + newEvidenceCount + totalUsage rollup
```

## 4. Invariants (what must not break)

1. **Sole budget writer.** The `retrieve` node returns the ONLY signed `budgetRemaining`/
   `budgetSpent` delta into `ResearchState`. Agents spend against a pass-local pool; the
   node reconciles once at node end. `gate` still writes no budget delta.
2. **Frozen snapshot.** Retrieve fully completes before `debate`. The committee never sees
   evidence mid-arrival. Confirmed sound by the review.
3. **Evidence scoping by identity.** Each Evidence carries `questionId` (the agent that
   produced it owns exactly one question). `scopeEvidenceToQuestions` prefers `questionId`;
   falls back to the `sourceQuery`→`searchQueries` match for the `coded` path (unchanged).
   This is the fix for the CRITICAL orphaning bug — agent-invented queries no longer need
   to be registered.
4. **loopIteration timing.** `gate` increments `loopIteration` BEFORE the loop-back to
   retrieve. Fresh evidence carries the post-increment value; `missionForQuestion` must
   read claims WITHOUT a `=== loopIteration` filter (the trap `refine` hit at graph.ts:483).
5. **Real credits.** Tools charge actual post-cache credits (cache hit = 0). The pass pool
   is seeded `min(budgetRemaining, ceil(initialBudget × MAX_LOOP_SPEND_FRACTION))`
   (the `Math.min` clamp is load-bearing on later loops — mirror graph.ts:319).
6. **Interior $-cap.** `getActiveCostTracker()?.check()` runs inside the agent loop (each
   step), not just at node entry — the swarm can bill dozens of Haiku calls per super-step.
   A thrown `BudgetExceededError` rejects the `Promise.all` and propagates to
   `runGraphInner`'s existing degrade path (acceptable: budget's blown, we stop).
7. **newEvidenceCount on every path.** Including the all-discard / zero-result path (=0),
   or `gateShortCircuit`'s `no-progress` check breaks.

## 5. Files

New:
- `src/lib/orchestration/researcher.ts` — the agent, its tools, the shared pass pool, and
  `runResearcher(question, mission, seenUrls, passPool, model, deps)`. Model + Firecrawl
  clients injectable (mirror the `now` clock injection in firecrawl.ts:67) for tests.

Changed:
- `src/lib/orchestration/graph.ts` — `retrieve` node body (agentic when `retrievalMode==='agentic'`);
  DELETE `refine` node + its edge; `routeAfterGate` → `"retrieve" | "recommend"`; edges
  `gate→retrieve`; re-derive `computeRecursionLimit` (3 supersteps/loop); thread
  `retrievalMode` into the builder + `arm` label; update the header ASCII (lines 5-9).
  Add `missionForQuestion(state, q)` helper.
- `src/lib/schemas/evidence.ts` — add optional `questionId`.
- `src/lib/orchestration/graph.ts` `scopeEvidenceToQuestions` — prefer `questionId`.
- `src/lib/evidence/firecrawl.ts` — export a snippet-only `webSearchRaw(query)` and a
  single-URL `scrapeOneCached(url)` the tools wrap (reuse `getCache`/`getSearchCache`/
  `firecrawlLimiter`/`scrapeOne`). No new Firecrawl plumbing.
- `src/lib/params.ts` — `MAX_AGENT_STEPS`, `RECON_FLOOR` (loop-0 minimum sources),
  `RESEARCHER_MODEL_ID`, add researcher model to `MODEL_CONCURRENCY`.
- `src/lib/prompts.ts` — researcher system prompt + tool descriptions (all wording here).
- `src/lib/orchestration/eval.ts` — generalize `ComparisonResult` → `arms: ArmResult[]`.
- `scripts/compare-arms.ts`, `scripts/run-arm.ts` — the `agentic` arm.
- `src/lib/orchestration/trace.ts` — a `logAgentStep` (or reuse `logLlmCall` per step).
- `src/lib/orchestration/graph-stream.ts` + SSE consumers — surface agent tool steps as
  `retrieve:progress`; update for the `arms[]` type change.

## 6. Implementation phases (tsc + vitest gate + commit per phase)

Sequential — shared files (graph.ts, firecrawl.ts) make this a one-lane job. See §9.

- **P1 — Evidence scoping fix (the CRITICAL bug), no agent yet.** Add `Evidence.questionId`;
  teach `scopeEvidenceToQuestions` to prefer it; have the CURRENT coded `retrieve` tag
  evidence with questionId too. Tests: scoping by questionId, coded fallback unchanged.
  This lands the invariant before anything depends on it.
- **P2 — Firecrawl tool primitives.** `webSearchRaw` (snippets, no scrape) + `scrapeOneCached`
  (single URL, cache-aware, real-credit report). Unit tests with a mocked Firecrawl client.
- **P3 — Researcher agent + shared pass pool.** `researcher.ts`: tools, pool, `runResearcher`,
  interior `check()`, recon floor, dedup, `totalUsage` rollup. Tests with a scripted mock model.
- **P4 — Graph rewire.** Agentic `retrieve` node behind `retrievalMode`; delete `refine`;
  rewire edges + `routeAfterGate` + recursion limit; `missionForQuestion`. Regression tests.
- **P5 — Eval arm.** `arms[]` generalization; `agentic` arm in compare-arms/run-arm; SSE type
  updates. Then a live `compare` run on "freight brokerage": agentic vs orchestrated.

## 7. Test plan (all new paths; regressions marked)

See the coverage diagram in the review. Concretely, the must-have tests:

- **[REGRESSION]** sole-writer budget delta: node sums real credits → one signed delta; no double-count.
- **[REGRESSION]** `gate→retrieve` loop-back; `routeAfterGate` returns retrieve/recommend; `budgetRemaining>0` guard kept.
- **[REGRESSION]** `computeRecursionLimit` re-derived (3/loop) — a full `MAX_LOOP_ITERATIONS` run doesn't hit the limit early.
- **[REGRESSION]** `retrievalMode:'coded'` path byte-identical to today (eval baseline can't drift).
- `runResearcher`: loop-0 recon-floor enforced (can't stop below RECON_FLOOR); loop-≥1 mission from evidential contentions; budget-exhausted mid-loop → partial evidence kept; maxSteps hit; zero-result pass → returns [] and newEvidenceCount 0.
- tools: real-credit charge (cache hit = 0); budget refusal at cap (code, not prompt); firecrawl error → `[]`/empty (no throw); PDF skip; multi-URL partial read until cap.
- scoping: evidence tagged questionId buckets correctly; two agents inventing the same query string do NOT cross-contaminate (this is why we chose questionId over query-write-back).
- `missionForQuestion`: does NOT filter claims by loopIteration; empty when no evidential contention.
- usage: `totalUsage` across all steps rolled into `llmCalls`.
- Vitest gotcha: brace `beforeEach` bodies that call `mockReset()` (prior learning `vitest-beforeeach-returns-mock`).

## 8. Failure modes

| Codepath | Realistic failure | Test? | Handled? | Visible? |
|---|---|---|---|---|
| agent loop | search→search, never reads, burns steps | maxSteps test | stopWhen + pool | trace `logAgentStep` |
| agent loop | LLM $ blows mid-swarm | interior-check test | `check()` throws → degrade path | run degrades, answer still written |
| readSource | scrape fails | tool test | empty content, citable from snippet | source appears thin, not missing |
| retrieve node | all agents discard everything | zero-result test | newEvidenceCount=0 → gate no-progress | loop stops cleanly |
| scoping | agent evidence orphaned (THE bug) | scoping test | questionId identity tag | — (would've been silent; now fixed) |
| budget | cache hit charged as spend | real-credit test | charge post-cache actuals | reported credits = actual |

No critical gaps (no failure that is untested AND unhandled AND silent) once P1-P4 tests land.

## 9. Parallelization

**Sequential, one lane.** P1-P4 all touch `graph.ts` and/or `firecrawl.ts` and form a
dependency chain (scoping invariant → tool primitives → agent → rewire). No safe parallel
split. Build inline in this workspace, one phase at a time, `tsc` + `vitest` + commit per
phase. P5 (eval wiring) is the only weakly-independent piece but depends on P4's node.

## 10. NOT in scope (deferred, with rationale)

- **Tool-using committee roles / breaking the frozen snapshot** — explicitly rejected; it's
  the innovation. Revisit only if the eval shows agentic retrieval alone doesn't move quality.
- **Manager-as-orchestrator agent (Option C)** — trades away determinism/cost control; not now.
- **Dynamic per-question budget reallocation beyond FCFS** — shared pool is enough for v1.
- **Streaming the agent's internal reasoning to the debate-arena UI** — trace-only for now
  (same call the Wave-3 D6 work made); live UI still renders round-0 claims.
- **Prompt-caching the growing agent context** — caching is already ~inert (STATUS); skip.
- **Replacing the `coded` retrieve path** — kept permanently as the eval control arm.

## 11. Open risks / TODOs

- Cost multiplication (`outer_loops × questions × maxSteps` Haiku calls) is bounded by four
  independent limits but the *product* is unvalidated live — the first `compare` run is the check.
- Latency: one-query-per-step adds serial LLM round-trips; multi-URL reads + Haiku speed
  should keep it near current, but measure it in P5.
- The recon-floor enforcement must not deadlock a question with genuinely no sources — floor
  is `min(RECON_FLOOR, what's findable)`; the agent stops on maxSteps/pool regardless.
