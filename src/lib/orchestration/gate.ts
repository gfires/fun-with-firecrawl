import { generateText, Output } from "ai";
import { z } from "zod";
import { gateClassifierModel } from "../models/provider";
import type { ResearchStateT } from "../schemas/state";
import { MAX_LOOP_ITERATIONS, LLM_MAX_RETRIES } from "../params";
import { toAnnotatedUsage, type AnnotatedUsage } from "./eval";
import type { GateScore } from "../research-events";
import { getActiveTrace } from "./trace";
import { getActiveCostTracker } from "./cost-tracker";

const GateDecisionSchema = z.object({
  decisions: z.array(z.object({
    questionId: z.string(),
    retrieve: z.boolean(),
    reason: z.string(),
  })),
});

/**
 * Zero-LLM-cost convergence checks. Any non-null result means the loop MUST stop before
 * we pay for a gate classification call. Checked first in allocateBudget.
 *
 * - "budget": no Firecrawl budget left to retrieve with.
 * - "max-loops": the loop-iteration cap is reached.
 * - "no-progress": a past-loop-0 iteration whose retrieve added no new evidence — running
 *   the committee and gate again would only reproduce the prior round. Loop 0 is exempt
 *   (newEvidenceCount is only meaningful once a retrieve has actually run).
 *
 * Order matters only for the returned reason string; all three are terminal.
 */
export function gateShortCircuit(
  state: ResearchStateT,
): "budget" | "max-loops" | "no-progress" | null {
  if (state.budgetRemaining <= 0) return "budget";
  if (state.loopIteration >= MAX_LOOP_ITERATIONS) return "max-loops";
  if (state.loopIteration > 0 && state.newEvidenceCount === 0) return "no-progress";
  return null;
}

export async function allocateBudget(
  state: ResearchStateT
): Promise<{ state: ResearchStateT; continueLoop: boolean; usage: AnnotatedUsage[]; gateScores: GateScore[] }> {
  // Zero-cost convergence checks first — budget, loop cap, zero-progress loop — so a
  // converged run never pays for a gate classification call.
  if (gateShortCircuit(state)) {
    return { state: { ...state, converged: true }, continueLoop: false, usage: [], gateScores: [] };
  }

  const unresolved = state.questions.filter(q => !q.resolved);

  const questionSignals = unresolved.map(q => {
    const claims = state.claims.filter(c => c.questionId === q.id);
    const confidences = claims.map(c => c.confidence);
    const gapCount = claims.reduce((sum, c) => sum + c.missingEvidence.length, 0);
    const confidenceSpread = confidences.length >= 2
      ? Math.max(...confidences) - Math.min(...confidences)
      : 0;

    const claimSummary = claims.length
      ? claims.map(c => `  - [${c.agentRole}] "${c.conclusion}" (confidence: ${c.confidence.toFixed(2)}, gaps: ${c.missingEvidence.length})`).join("\n")
      : "  - no claims yet";

    return { question: q, gapCount, confidenceSpread, claimSummary };
  });

  const sections = questionSignals.map(qs =>
    `Question ${qs.question.id} (${qs.question.category}): ${qs.question.text}\n` +
    `  Computed: gapCount=${qs.gapCount}, confidenceSpread=${qs.confidenceSpread.toFixed(2)}\n` +
    `  Claims:\n${qs.claimSummary}`
  );

  const prompt = `You are a research gate classifier deciding which questions need more evidence retrieval.

Current state: loop iteration ${state.loopIteration}, budget remaining ${state.budgetRemaining} calls.

Decision rules (apply in order):
- If this is iteration 0 (first pass): default to YES unless agents already agree directionally and no specific evidence gaps are named.
- If 3+ agents name overlapping missing evidence (similar data/sources): YES.
- If agents reach opposing conclusions on the same sub-question: YES.
- If all agents agree directionally and gaps are vague ("more data would help"): NO.
- If budget remaining is low (≤2 calls): only YES for the single highest-gap question.

For each question, decide: should we retrieve more evidence (true) or mark as resolved (false)?
Explain your decision in one sentence per question.

${sections.join("\n\n")}

Return a decision for every question ID listed above.`;

  const costTracker = getActiveCostTracker();
  costTracker?.check();

  const { output: object, usage } = await generateText({
    model: gateClassifierModel,
    output: Output.object({ schema: GateDecisionSchema }),
    prompt,
    maxRetries: LLM_MAX_RETRIES,
  });

  const annotated = toAnnotatedUsage(usage, gateClassifierModel.modelId, "gate");
  costTracker?.record({ model: gateClassifierModel.modelId, promptTokens: annotated.promptTokens, completionTokens: annotated.completionTokens });

  const trace = getActiveTrace();
  if (trace) {
    trace.logLlmCall("gate", { model: gateClassifierModel.modelId, prompt }, object, usage);
  }

  const callUsage = [annotated];

  const signalMap = new Map(questionSignals.map(qs => [qs.question.id, qs]));
  const validIds = new Set(questionSignals.map(qs => qs.question.id));

  const validDecisions = object.decisions.filter(d => validIds.has(d.questionId));

  const missingIds = [...validIds].filter(id => !validDecisions.some(d => d.questionId === id));
  for (const id of missingIds) {
    validDecisions.push({ questionId: id, retrieve: true, reason: "no LLM decision — defaulting to retrieve" });
  }

  let gateScores: GateScore[] = validDecisions.map(d => ({
    questionId: d.questionId,
    retrieve: d.retrieve,
    gapCount: signalMap.get(d.questionId)?.gapCount ?? 0,
    confidenceSpread: signalMap.get(d.questionId)?.confidenceSpread ?? 0,
    reason: d.reason,
  }));

  const retrieveCount = gateScores.filter(s => s.retrieve).length;
  if (retrieveCount > state.budgetRemaining) {
    const sorted = gateScores
      .filter(s => s.retrieve)
      .sort((a, b) => b.gapCount - a.gapCount);
    const keepIds = new Set(sorted.slice(0, state.budgetRemaining).map(s => s.questionId));
    gateScores = gateScores.map(s =>
      s.retrieve && !keepIds.has(s.questionId)
        ? { ...s, retrieve: false, reason: "clamped — budget insufficient" }
        : s
    );
  }

  const continueLoop = gateScores.some(d => d.retrieve);

  if (!continueLoop) {
    return { state: { ...state, converged: true }, continueLoop: false, usage: callUsage, gateScores };
  }

  const questions = state.questions.map(q => {
    const score = gateScores.find(s => s.questionId === q.id);
    return score && !score.retrieve ? { ...q, resolved: true } : q;
  });

  return {
    state: { ...state, questions, loopIteration: state.loopIteration + 1 },
    continueLoop: true,
    usage: callUsage,
    gateScores,
  };
}
