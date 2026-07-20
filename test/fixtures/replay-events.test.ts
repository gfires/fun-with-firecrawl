/**
 * replay-events.test.ts — guards the committed replay fixture (test/fixtures/replay-events.json).
 *
 * The fixture is a real agentic streaming run's `ResearchEvent[]`, extracted by
 * scripts/extract-replay-fixture.ts. The board's replay path (spec §5 / Phase 4) drives the SAME
 * `reduce` over it, so this test asserts the fixture still reduces to a finished, well-formed run —
 * catching a corrupted or stale fixture before it reaches the UI. It also locks in that the fixture
 * carries the two signals the board is built around: per-question `stance` and `researcher:*` events.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import type { ResearchEvent } from "@/lib/research-events";
import { reduce, initialResearchState } from "@/lib/useResearchStream";

const events = JSON.parse(
  readFileSync(join(__dirname, "replay-events.json"), "utf8"),
) as ResearchEvent[];

describe("replay fixture", () => {
  it("reduces to a finished, well-formed run", () => {
    const s = events.reduce(reduce, initialResearchState);
    expect(s.report).not.toBeNull();
    expect(s.questions.length).toBeGreaterThan(0);
    expect(s.claims.length).toBeGreaterThan(0);
    expect(s.gateDecisions.length).toBeGreaterThan(0);
    expect(s.running).toBe(false);
  });

  it("cost is coherent: Σ research:usage === authoritative mechanics total === reconciled header", () => {
    // Tier C (single-source drain) + Core 1 (reducer reconciliation): the streamed per-call events
    // must sum to the mechanics receipt's authoritative rollup, and the reduced header must equal it.
    // This is the invariant whose violation was the original "$0.71 vs $0.5x" bug.
    const usageSum = events
      .filter((e) => e.type === "research:usage")
      .reduce((a, e) => a + (e as { usage: { costUsd: number } }).usage.costUsd, 0);
    const s = events.reduce(reduce, initialResearchState);
    const mechTotal = s.mechanics?.convergence.totalCostUsd ?? -1;
    expect(usageSum).toBeCloseTo(mechTotal, 4);
    expect(s.usage.totalCostUsd).toBeCloseTo(mechTotal, 4);
  });

  it("a stopped run states WHY it stopped, and truncated questions don't masquerade as fault lines", () => {
    // Core 2 (convergedReason) + Core 3 (truncated), inc. backfill from pre-field traces: a converged
    // run's final gate must carry a reason, and any question flagged truncated must NOT read "settled".
    const s = events.reduce(reduce, initialResearchState);
    const lastGate = s.gateDecisions[s.gateDecisions.length - 1];
    expect(lastGate.continueLoop).toBe(false);
    expect(lastGate.convergedReason).toBeTruthy(); // e.g. "cost-headroom" — never a blank halt
    for (const score of lastGate.gateScores) {
      if (score.truncated) expect(score.retrieve).toBe(false); // truncated ⇒ resolved-without-retrieval
    }
  });

  it("carries the board's load-bearing signals: stance + researcher progress", () => {
    // Every streamed claim has a categorical stance (the openings/gate columns render it).
    const claimEvents = events.filter((e) => e.type === "debate:claim");
    expect(claimEvents.length).toBeGreaterThan(0);
    for (const e of claimEvents) {
      expect(["supports", "opposes", "insufficient"]).toContain((e as { claim: { stance: string } }).claim.stance);
    }
    // Agentic arm → researcher:* window-shopping events are present (the Loop-cell mini-viz feed).
    const researcher = events.filter((e) => e.type.startsWith("researcher:"));
    expect(researcher.length).toBeGreaterThan(0);
    expect(researcher.some((e) => e.type === "researcher:search")).toBe(true);
  });
});
