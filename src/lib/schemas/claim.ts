import { z } from "zod";

export const AgentRole = z.enum(["historian", "operator", "investor", "skeptic"]);

export const ClaimSchema = z.object({
  id: z.string(),
  questionId: z.string(),
  agentRole: AgentRole,
  conclusion: z.string(),
  confidence: z.number().min(0).max(1),
  supportingEvidenceIds: z.array(z.string()),   // IDs into the evidence store, never inline text
  contradictingEvidenceIds: z.array(z.string()),
  missingEvidence: z.array(z.string()),          // natural-language gaps
  loopIteration: z.number().int(),
});
export type Claim = z.infer<typeof ClaimSchema>;
export type AgentRoleT = z.infer<typeof AgentRole>;