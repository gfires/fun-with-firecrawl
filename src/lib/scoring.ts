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
 * the incumbent software is weak, labor is scarce (so automation has leverage), the work is
 * suitable for AI, and there's budget to pay for a solution.
 *
 * `softwareMaturity` is INVERTED before weighting — mature software means LESS opportunity.
 */
export const OPPORTUNITY_WEIGHTS = {
  pain: 0.25,
  softwareGap: 0.2, // = (10 - softwareMaturity)
  laborScarcity: 0.2,
  aiSuitability: 0.2,
  budgetSignal: 0.15,
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
    scores.laborScarcity.value * OPPORTUNITY_WEIGHTS.laborScarcity +
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

/**
 * Derive the playful "diagnostic readout" stats from the scores. These are the shareable,
 * tongue-in-cheek lines ("AI Invasion Risk: 89%", "Software Maturity: 2008") that give the
 * report its personality. All derived deterministically so they're consistent with the gauges.
 *
 * The model MAY also return its own playfulStats; the route merges these in as a guaranteed
 * baseline so the section is never empty.
 */
export function derivePlayfulStats(scores: Scores, opportunity: number): { label: string; value: string }[] {
  const sw = scores.softwareMaturity.value;
  // Map software maturity (0–10) to a cheeky "software era" year. Low maturity => older year.
  const era = Math.round(2005 + sw * 2); // 0 => 2005, 10 => 2025
  const aiInvasion = Math.round(scores.aiSuitability.value * 10);
  const excelDependency = severityWord(10 - sw); // immature software => more Excel
  const civReadiness = Math.round(sw * 8 + scores.budgetSignal.value * 2); // 0–100-ish

  return [
    { label: "Excel Dependency", value: excelDependency },
    { label: "AI Invasion Risk", value: `${aiInvasion}%` },
    { label: "Civilizational Readiness", value: `${clamp(civReadiness, 0, 100)}%` },
    { label: "Founder Excitement Index", value: `${clamp(opportunity + 4, 0, 100)}%` },
    { label: "Software Maturity", value: `${era}` },
    { label: "Labor Squeeze", value: severityWord(scores.laborScarcity.value) },
  ];
}
