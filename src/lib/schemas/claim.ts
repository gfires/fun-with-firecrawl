import { z } from "zod";

export const AgentRole = z.enum(["historian", "operator", "investor", "skeptic"]);

/**
 * A role's POSITION on the question — the signal the disagreement detector reads. This 3-value set is
 * the OPPORTUNITY-ANALYSIS instantiation of a general "position": today's committee is a
 * thesis-adjudicator by construction (each Claim is a lean + confidence on the opportunity), so a
 * categorical stance just makes explicit the lean the roles already hold. `"insufficient"` is the
 * ABSTENTION value (evidence can't support a directional call yet). A future richer taxonomy only
 * GROWS this enum; the detector (decisiveStances / hasGenuineDisagreement / committeeStance) is
 * written over positions generally and needs no edit.
 */
export const CLAIM_STANCES = ["supports", "opposes", "insufficient"] as const;
export const ClaimStance = z.enum(CLAIM_STANCES);
export type ClaimStanceT = z.infer<typeof ClaimStance>;

/** The abstention value — a role that can't yet take a directional position. Excluded from decisive stances. */
export const ABSTENTION_STANCE: ClaimStanceT = "insufficient";

const STANCE_SET = new Set<string>(CLAIM_STANCES);

/**
 * Clamp an LLM-emitted stance to a valid value in CODE (never trust the model): a missing or
 * out-of-enum value becomes the abstention `"insufficient"`. Mirrors how confidence is range-clamped
 * after generation — enforce the invariant in code, so a drifting model can never kill a run.
 */
export function coerceStance(value: unknown): ClaimStanceT {
  return typeof value === "string" && STANCE_SET.has(value) ? (value as ClaimStanceT) : ABSTENTION_STANCE;
}

/**
 * One role's directed reply to a peer during debate. `stance` is what the role does to the
 * target's position; `point` says why (grounded in an evidence id). These pairs are the edges
 * of the who-disagrees-with-whom graph the debate produces — movement/contention signals are
 * computed from them mechanically, never from a made-up score.
 */
export const ResponseStance = z.enum(["rebut", "concede", "extend"]);
export type ResponseStanceT = z.infer<typeof ResponseStance>;

export const DebateResponseSchema = z.object({
  targetRole: AgentRole,
  stance: ResponseStance,
  point: z.string().describe(
    "one sentence: what you dispute/concede/extend and why — cite the evidence id that grounds it",
  ),
});
export type DebateResponse = z.infer<typeof DebateResponseSchema>;

export const ClaimSchema = z.object({
  id: z.string(),
  questionId: z.string(),
  agentRole: AgentRole,
  conclusion: z.string(),
  confidence: z.number().min(0).max(1),
  stance: ClaimStance,
  supportingEvidenceIds: z.array(z.string()),
  contradictingEvidenceIds: z.array(z.string()),
  missingEvidence: z.array(z.string()),
  loopIteration: z.number().int(),
  // Debate dimension, orthogonal to loopIteration (the retrieval loop). 0 = the independent
  // opening claim; >=1 = a conversational round where the role has seen its peers. `responses`
  // carries this turn's directed replies (empty on the opening round).
  debateRound: z.number().int(),
  responses: z.array(DebateResponseSchema),
});
export type Claim = z.infer<typeof ClaimSchema>;
export type AgentRoleT = z.infer<typeof AgentRole>;

// NOTE: no .min()/.max() constraints here — providers strip unsupported JSON-schema
// keywords, so they're never enforced during generation and only cause client-side
// AI_NoObjectGeneratedError when the model drifts past them. Steer with .describe()
// and clamp in code where a bound actually matters (confidence, list sizes).
export const ClaimOutputSchema = z.object({
  conclusion: z.string().describe("2-3 sentence conclusion — be direct, no preamble"),
  confidence: z.number().describe("calibrated confidence between 0 and 1"),
  stance: ClaimStance.describe(
    "your lean on the OPPORTUNITY based on THIS question's evidence: 'supports' = evidence points " +
      "toward the opportunity being real/attractive, 'opposes' = points against it, 'insufficient' = " +
      "evidence can't support a directional call yet",
  ),
  supportingEvidenceIds: z.array(z.string()),
  contradictingEvidenceIds: z.array(z.string()),
  missingEvidence: z.array(z.string()).describe("up to 3 specific evidence gaps, each under 100 chars"),
});

// Round-≥1 (conversational) LLM output: a revised claim PLUS the role's directed replies to the
// peers who challenged it. Same no-min/.max() rule — steer with .describe(), clamp in code.
export const DebateTurnOutputSchema = ClaimOutputSchema.extend({
  responses: z.array(DebateResponseSchema).describe(
    "your direct replies to the peers who challenged you — concede ONLY to evidence, never to consensus",
  ),
});