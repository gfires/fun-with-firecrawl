import { generateObject } from "ai";
import { z } from "zod";
import { gateModel } from "../models/provider";
import type { ResearchStateT } from "../schemas/state";

// Cheap-iteration budget for the freight brokerage test run
export const BUDGET = {
  maxLoopIterations: 2,       // initial retrieval + at most one targeted round
  sourcesPerRetrieval: 4,     // Firecrawl calls per question per round
  maxQuestions: 4,            // keep the manager's decomposition small
  totalFirecrawlBudget: 32,   // hard cap: 4 questions x 4 sources x ~2 rounds
};

const GapScoreSchema = z.object({
  questionId: z.string(),
  disagreementMagnitude: z.number().min(0).max(1),   // spread across the 4 claims
  recommendationSensitivity: z.number().min(0).max(1), // how much this question moves the final call
  tractability: z.number().min(0).max(1),              // likely to find better evidence
});

export async function allocateBudget(
  state: ResearchStateT
): Promise<{ state: ResearchStateT; continueLoop: boolean }> {
  if (state.budgetRemaining <= 0 || state.loopIteration >= BUDGET.maxLoopIterations) {
    return { state: { ...state, converged: true }, continueLoop: false };
  }

  // score every unresolved question's value of further retrieval
  const { object: scores } = await generateObject({
    model: gateModel,
    schema: z.object({ scores: z.array(GapScoreSchema) }),
    prompt: buildGatePrompt(state), // TODO: summarize claims + disagreements per question
  });

  const ranked = scores.scores
    .map(s => ({
      ...s,
      voi: s.disagreementMagnitude * s.recommendationSensitivity * s.tractability,
    }))
    .sort((a, b) => b.voi - a.voi);

  const VOI_THRESHOLD = 0.15; // tune after first test run
  const worthPursuing = ranked.filter(r => r.voi > VOI_THRESHOLD);

  if (worthPursuing.length === 0) {
    return { state: { ...state, converged: true }, continueLoop: false };
  }

  const questions = state.questions.map(q =>
    worthPursuing.some(w => w.questionId === q.id) ? q : { ...q, resolved: true }
  );

  return {
    state: { ...state, questions, loopIteration: state.loopIteration + 1 },
    continueLoop: true,
  };
}

function buildGatePrompt(state: ResearchStateT): string {
  // summarize each question's claims (conclusion + confidence + contradiction count)
  // keep this short — it's the one prompt you should hand-tune the most
  return `...`; // fill in once you see real committee output
}