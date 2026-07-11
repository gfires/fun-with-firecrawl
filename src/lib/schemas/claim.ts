import { z } from "zod";

export const AgentRole = z.enum(["historian", "operator", "investor", "skeptic"]);

export const ClaimSchema = z.object({
  id: z.string(),
  questionId: z.string(),
  agentRole: AgentRole,
  conclusion: z.string(),
  confidence: z.number().min(0).max(1),
  supportingEvidenceIds: z.array(z.string()),
  contradictingEvidenceIds: z.array(z.string()),
  missingEvidence: z.array(z.string()),
  loopIteration: z.number().int(),
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
  supportingEvidenceIds: z.array(z.string()),
  contradictingEvidenceIds: z.array(z.string()),
  missingEvidence: z.array(z.string()).describe("up to 3 specific evidence gaps, each under 100 chars"),
});