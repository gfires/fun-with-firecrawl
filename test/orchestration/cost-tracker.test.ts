/**
 * cost-tracker.test.ts — the CostTracker is the report's single source of truth for LLM spend.
 *
 * The class itself is only exported as a TYPE; tests reach it through runWithCostTracker /
 * getActiveCostTracker, exactly as the graph does. Two things are proven here:
 *   1. record() retains every annotated usage, and getSpent() is the cache-accurate sum of them.
 *   2. The degraded-undercount regression: when a super-step's state is rolled back, the report
 *      must still bill the calls the APIs already charged for — because it rolls up from the
 *      tracker, not from the (rolled-back) state.llmCalls.
 */
import { describe, it, expect } from "vitest";
import { runWithCostTracker, getActiveCostTracker } from "@/lib/orchestration/cost-tracker";
import { estimateCostUsd, rollupTokens, type AnnotatedUsage } from "@/lib/orchestration/eval";

/** Build an AnnotatedUsage with a real cost, so the tracker and rollup agree by construction. */
function usage(
  label: string,
  fields: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number },
  model = "claude-haiku-4-5-20251001",
): AnnotatedUsage {
  const base = { model, ...fields };
  return { ...base, label, costUsd: estimateCostUsd(base) };
}

describe("CostTracker.record / getUsages / getSpent", () => {
  it("retains every recorded usage and getSpent() sums their cache-accurate cost", async () => {
    await runWithCostTracker(async () => {
      const t = getActiveCostTracker()!;
      const a = usage("intake", { promptTokens: 1_000_000, completionTokens: 0 });
      const b = usage("gate", { promptTokens: 0, completionTokens: 1_000_000 });

      t.record(a);
      t.record(b);

      expect(t.getUsages()).toEqual([a, b]);
      expect(t.getSpent()).toBeCloseTo(a.costUsd + b.costUsd, 10);
      // Haiku: $1/1M in, $5/1M out → $1 + $5 = $6.
      expect(t.getSpent()).toBeCloseTo(6, 10);
    });
  });

  it("getUsages() returns a copy — callers cannot mutate the tracker's ledger", async () => {
    await runWithCostTracker(async () => {
      const t = getActiveCostTracker()!;
      t.record(usage("intake", { promptTokens: 1_000_000, completionTokens: 0 }));
      const snapshot = t.getUsages();
      snapshot.push(usage("bogus", { promptTokens: 9_000_000, completionTokens: 0 }));
      expect(t.getUsages()).toHaveLength(1);
    });
  });

  it("is cache-accurate: a cached call costs less (and the cap sees the lower number)", async () => {
    await runWithCostTracker(async () => {
      const t = getActiveCostTracker()!;
      // Same 1M prompt tokens, but 900k served from cache (billed at 0.1x).
      const cached = usage("cached", { promptTokens: 1_000_000, completionTokens: 0, cachedPromptTokens: 900_000 });
      const uncached = usage("uncached", { promptTokens: 1_000_000, completionTokens: 0 });

      expect(cached.costUsd).toBeLessThan(uncached.costUsd);

      t.record(cached);
      // getSpent() reflects the cache discount, not the naive full-input price.
      expect(t.getSpent()).toBeCloseTo(cached.costUsd, 10);
      expect(t.getSpent()).toBeLessThan(uncached.costUsd);
    });
  });
});

describe("degraded-undercount regression — rollup from the tracker, not from rolled-back state", () => {
  it("the tracker's rollup bills the rolled-back super-step; state.llmCalls undercounts it", async () => {
    await runWithCostTracker(async () => {
      const tracker = getActiveCostTracker()!;

      // A committed super-step's calls: they survive in state.llmCalls after a checkpoint.
      const committed = [
        usage("intake", { promptTokens: 500_000, completionTokens: 100_000 }),
        usage("decompose", { promptTokens: 400_000, completionTokens: 80_000 }),
      ];
      // A super-step that threw mid-flight: its calls are ALREADY billed by the APIs and the
      // tracker saw them, but LangGraph rolled the state back — so they never reach state.llmCalls.
      const rolledBack = [
        usage("committee:historian", { promptTokens: 300_000, completionTokens: 50_000 }),
        usage("committee:operator", { promptTokens: 320_000, completionTokens: 60_000 }),
        usage("committee:investor", { promptTokens: 310_000, completionTokens: 55_000 }),
      ];

      // The tracker records everything the APIs billed, in call order.
      for (const u of [...committed, ...rolledBack]) tracker.record(u);

      // The degraded run's persisted state carries ONLY the committed subset.
      const finalStateLlmCalls: AnnotatedUsage[] = committed;

      const trackerCost = rollupTokens(tracker.getUsages()).totalCostUsd;
      const stateCost = rollupTokens(finalStateLlmCalls).totalCostUsd;

      // The report (tracker rollup) equals true billed spend...
      expect(trackerCost).toBeCloseTo(tracker.getSpent(), 10);
      // ...and is STRICTLY greater than the rolled-back-state subset would have reported.
      expect(trackerCost).toBeGreaterThan(stateCost);
      // The hole is exactly the rolled-back super-step's cost.
      const rolledBackCost = rollupTokens(rolledBack).totalCostUsd;
      expect(trackerCost - stateCost).toBeCloseTo(rolledBackCost, 10);
    });
  });
});
