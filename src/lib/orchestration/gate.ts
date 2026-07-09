import { generateObject } from "ai";
import { z } from "zod";
import { gateModel } from "../models/provider";
import type { ResearchStateT } from "../schemas/state";
import { MAX_LOOP_ITERATIONS, VOI_THRESHOLD } from "../params";
import { toAnnotatedUsage, type AnnotatedUsage } from "./eval";

const GapScoreSchema = z.object({
  questionId: z.string(),
  disagreementMagnitude: z.number().min(0).max(1),   // spread across the 4 claims
  recommendationSensitivity: z.number().min(0).max(1), // how much this question moves the final call
  tractability: z.number().min(0).max(1),              // likely to find better evidence
});

export async function allocateBudget(
  state: ResearchStateT
): Promise<{ state: ResearchStateT; continueLoop: boolean; usage: AnnotatedUsage[] }> {
  if (state.budgetRemaining <= 0 || state.loopIteration >= MAX_LOOP_ITERATIONS) {
    return { state: { ...state, converged: true }, continueLoop: false, usage: [] };
  }

  // score every unresolved question's value of further retrieval
  const { object: scores, usage } = await generateObject({
    model: gateModel,
    schema: z.object({ scores: z.array(GapScoreSchema) }),
    prompt: buildGatePrompt(state), // TODO: summarize claims + disagreements per question
  });
  const callUsage = [toAnnotatedUsage(usage, gateModel.modelId, "gate")];

  const ranked = scores.scores
    .map(s => ({
      ...s,
      voi: s.disagreementMagnitude * s.recommendationSensitivity * s.tractability,
    }))
    .sort((a, b) => b.voi - a.voi);

  const worthPursuing = ranked.filter(r => r.voi > VOI_THRESHOLD);

  if (worthPursuing.length === 0) {
    return { state: { ...state, converged: true }, continueLoop: false, usage: callUsage };
  }

  const questions = state.questions.map(q =>
    worthPursuing.some(w => w.questionId === q.id) ? q : { ...q, resolved: true }
  );

  return {
    state: { ...state, questions, loopIteration: state.loopIteration + 1 },
    continueLoop: true,
    usage: callUsage,
  };
}

function buildGatePrompt(state: ResearchStateT): string {
  const unresolved = state.questions.filter(q => !q.resolved);

  const sections = unresolved.map(q => {
    const claims = state.claims.filter(c => c.questionId === q.id);

    const claimLines = claims.length
      ? claims
          .map(c => {
            const missing = c.missingEvidence.length
              ? c.missingEvidence.join("; ")
              : "none noted";
            return `  - [${c.agentRole}] conclusion: "${c.conclusion}" | confidence: ${c.confidence.toFixed(
              2
            )} | supporting: ${c.supportingEvidenceIds.length} | contradicting: ${
              c.contradictingEvidenceIds.length
            } | missing evidence: ${missing}`;
          })
          .join("\n")
      : "  - no claims yet";

    return `Question ${q.id} (${q.category}): ${q.text}\n${claimLines}`;
  });

  return `You are scoring the value of further retrieval for each unresolved research question below.

For each question, the committee's per-agent claims are listed with their conclusion, confidence, evidence counts, and noted evidence gaps.

Score each question on three axes (0-1):
- disagreementMagnitude: how much the agents' conclusions and confidences diverge
- recommendationSensitivity: how much resolving this question would change the final recommendation
- tractability: how likely additional retrieval is to actually close the gap (based on missing evidence and contradiction counts)

${sections.join("\n\n")}

Return a score for every question ID listed above.`;
}