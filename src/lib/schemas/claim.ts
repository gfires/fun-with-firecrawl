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

/**
 * THE canonical, agent-facing definition of what each stance MEANS — the single source of truth used
 * by the claim schema's `.describe()` hint AND the committee/debate prompt builders (prompts.ts), so
 * a role never sees two subtly different definitions. Stance is the most-misread field, so this is
 * deliberately explicit about the one distinction roles get wrong: stance is the DIRECTIONAL
 * IMPLICATION for the opportunity, not whether the question was answerable or whether the evidence
 * "matches" the question. A fully-answered question still takes a directional stance.
 */
export const STANCE_DEFINITION = [
  "`stance` is your directional read on THE OPPORTUNITY (the overall go/no-go), seen through THIS",
  "question's evidence — NOT whether the question was answerable. Pick exactly one:",
  "• 'supports' = this question's evidence makes the opportunity look MORE real / attractive / winnable.",
  "• 'opposes'  = it makes the opportunity look LESS attractive — a risk, blocker, or negative signal.",
  "• 'insufficient' = the evidence is absent, off-topic, or too thin to point EITHER way (a genuine",
  "  abstention). This is NOT a hedge and NOT 'the answer is nuanced' — a nuanced-but-real signal still",
  "  gets a direction. Reserve 'insufficient' for when you truly cannot lean.",
  "A question can be fully answered and still be 'supports' or 'opposes': e.g. \"who are the competitors?\"",
  "answered as \"saturated by strong incumbents\" → 'opposes' (bad for a new entrant); \"fragmented, no",
  "leader\" → 'supports'. Judge the IMPLICATION for the opportunity, not the completeness of the answer.",
  "Do not default to 'insufficient' to play safe — take the direction the evidence warrants.",
].join("\n");

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
  stance: ClaimStance.describe(STANCE_DEFINITION),
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