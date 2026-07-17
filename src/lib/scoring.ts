/**
 * scoring.ts — the deterministic scoring layer.
 *
 * FOR FUTURE AGENTS: The LLM produces the five 0–10 sub-scores (with evidence), but the
 * headline 0–100 Opportunity Score and the playful "diagnostic readout" stats are computed
 * HERE, in code, so they're explainable and stable rather than vibes from the model. This is
 * a deliberate product decision: the big number should be derivable from the sub-scores.
 *
 * Pure + unit-tested (test/scoring.test.ts). No I/O.
 */
import { clamp } from "./format";
import type { Scores } from "./schema";

/**
 * Weights for the composite Opportunity Score. They sum to 1.0.
 *
 * Intuition: an *opportunity* for an AI-native business is high when there's a lot of pain,
 * the incumbent software is weak, the industry is accessible to outsider founders, the work is
 * suitable for AI, and there's budget to pay for a solution.
 *
 * `softwareMaturity` is INVERTED before weighting — mature software means LESS opportunity.
 */
export const OPPORTUNITY_WEIGHTS = {
  pain: 0.30,
  softwareGap: 0.10, // = (10 - softwareMaturity)
  founderAccessibility: 0.10,
  aiSuitability: 0.30,
  budgetSignal: 0.20,
} as const;

/**
 * Compute the 0–100 Opportunity Score from the five sub-scores.
 * Deterministic, bounded, and monotonic in the "good" direction of each input.
 */
export function opportunityScore(scores: Scores): number {
  const softwareGap = 10 - scores.softwareMaturity.value;
  const weighted =
    scores.pain.value * OPPORTUNITY_WEIGHTS.pain +
    softwareGap * OPPORTUNITY_WEIGHTS.softwareGap +
    scores.founderAccessibility.value * OPPORTUNITY_WEIGHTS.founderAccessibility +
    scores.aiSuitability.value * OPPORTUNITY_WEIGHTS.aiSuitability +
    scores.budgetSignal.value * OPPORTUNITY_WEIGHTS.budgetSignal;
  // weighted is on a 0–10 scale (weights sum to 1); scale to 0–100 and round.
  return Math.round(clamp(weighted * 10, 0, 100));
}

/** Map a 0–10 value to a qualitative severity word (used for playful stats + gauges). */
export function severityWord(v: number): string {
  if (v >= 8.5) return "Severe";
  if (v >= 7) return "High";
  if (v >= 5) return "Moderate";
  if (v >= 3) return "Mild";
  return "Low";
}

