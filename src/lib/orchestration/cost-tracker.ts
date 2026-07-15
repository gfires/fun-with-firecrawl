import { AsyncLocalStorage } from "node:async_hooks";
import { MAX_RUN_COST_USD } from "../params";
import { estimateCostUsd } from "./eval";
import type { AnnotatedUsage } from "./eval";

export class BudgetExceededError extends Error {
  constructor(spent: number, cap: number) {
    super(`LLM cost budget exceeded: $${spent.toFixed(3)} spent, cap is $${cap.toFixed(2)}`);
    this.name = "BudgetExceededError";
  }
}

/**
 * Tracks cumulative LLM spend against a hard USD cap for a single research run.
 *
 * Every number that touches `spent` is a REAL `usage` figure from a completed call —
 * we never estimate a call's cost before it runs. `check()` gates a call by asking
 * "have we already spent the cap?"; `record()` books the exact cost on completion.
 *
 * SINGLE SOURCE OF TRUTH: `record()` also RETAINS every annotated usage it books
 * (`getUsages()`). The final report rolls up FROM the tracker, not from `state.llmCalls`,
 * because LangGraph rolls a super-step's state back to the last checkpoint when a call
 * throws mid-super-step — dropping already-billed calls from `llmCalls`. The tracker sees
 * every API-billed call (nothing is rolled back out of it), so its rollup reflects true
 * spend. Cost is estimated from the FULL annotated usage, so `spent`/the cap and the
 * rollup are prompt-cache accurate (cached/creation tokens billed at their multipliers).
 *
 * CONCURRENCY: the graph fans out up to ~20 structured-output LLM calls at once (the
 * committee runs 4 roles × N questions in parallel). `record()` is a plain synchronous
 * `+=`, and JS is single-threaded, so the increments themselves cannot corrupt each
 * other — no mutex needed. The only imprecision is that a whole fan-out wave can pass
 * `check()` before any of them has recorded, so spend can overshoot the cap by at most
 * one super-step's worth of calls. We accept that bounded overshoot rather than reserve
 * against a *guessed* pre-call cost — every recorded dollar stays exact, and the next
 * `check()` after the wave settles halts the run.
 */
class CostTracker {
  private spent = 0;
  private cap: number;
  private usages: AnnotatedUsage[] = [];

  constructor(cap: number) {
    this.cap = cap;
  }

  /** Gate before a call: throws if settled spend has already reached the cap. */
  check(): void {
    if (this.spent >= this.cap) {
      throw new BudgetExceededError(this.spent, this.cap);
    }
  }

  /**
   * Book a completed call's cache-accurate cost AND retain its full annotated usage.
   * Returns that cost. The retained usages are the report's single source of truth
   * (`getUsages()`) — they survive a super-step rollback that would drop the call from
   * `state.llmCalls`.
   */
  record(usage: AnnotatedUsage): number {
    const cost = estimateCostUsd(usage);
    this.spent += cost;
    this.usages.push(usage);
    return cost;
  }

  /** Every annotated usage booked so far (a copy — callers can't mutate the tracker). */
  getUsages(): AnnotatedUsage[] {
    return [...this.usages];
  }

  getSpent(): number {
    return this.spent;
  }

  getRemaining(): number {
    return Math.max(0, this.cap - this.spent);
  }
}

/**
 * Per-run isolation. The tracker lives in AsyncLocalStorage keyed to the run's async
 * call-tree, NOT a module global — so two concurrent research runs (two browser tabs,
 * compare-arms running both arms) each see their OWN tracker and never clobber each
 * other's spend. Every `getActiveCostTracker()` beneath `runWithCostTracker` in the
 * async tree resolves to that run's tracker.
 */
const storage = new AsyncLocalStorage<CostTracker>();

export function runWithCostTracker<T>(fn: () => Promise<T>, cap?: number): Promise<T> {
  const tracker = new CostTracker(cap ?? MAX_RUN_COST_USD);
  return storage.run(tracker, fn);
}

export function getActiveCostTracker(): CostTracker | null {
  return storage.getStore() ?? null;
}

export type { CostTracker };
