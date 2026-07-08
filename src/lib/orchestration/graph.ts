/**
 * graph.ts — the research orchestration graph.
 *
 * A LangGraph `StateGraph` over `ResearchState` (src/lib/schemas/state.ts) that runs
 * an iterative research loop:
 *
 *   decompose → retrieve → debate → gate ─┬─(continue)→ retrieve   (loop back)
 *                                         └─(stop)────→ recommend → END
 *
 * Nodes:
 *   - decompose : the manager LLM breaks `topic` into 3–5 research Questions.
 *   - retrieve  : searches the web for each UNRESOLVED question, appends Evidence.
 *   - debate    : runs the multi-agent committee per unresolved question, appends Claims.
 *   - gate      : allocates budget (gate.ts) and decides whether to loop again.
 *   - recommend : synthesizes the final report (evidence graph + per-question
 *                 confidence + unresolved questions).
 *
 * The compiled graph uses a MemorySaver checkpointer, so every super-step is
 * persisted — giving us state history and time-travel for free.
 *
 * CONTRACT NOTE (multi-agent build): `search()` (evidence agent) and
 * `runCommittee()` (committee agent) are implemented on sibling branches. The
 * signatures consumed here are the integration contract; see their imports below.
 */
import { StateGraph, MemorySaver, START, END } from "@langchain/langgraph";
import { generateObject } from "ai";
import { z } from "zod";

import { ResearchState, type ResearchStateT, type Question } from "../schemas/state";
import type { Evidence } from "../schemas/evidence";
import type { Claim } from "../schemas/claim";
import { managerModel } from "../models/provider";

// --- Cross-agent contract imports (implemented on sibling branches) ------------
// evidence/firecrawl.ts: turn a question into web Evidence for the given loop.
import { search } from "../evidence/firecrawl";
// committee.ts: run the multi-role committee over a question + evidence → Claims.
import { runCommittee } from "../committee";
// gate.ts (this package): budget allocation + loop control. Stub for now.
import { allocateBudget } from "./gate";

// ---------------------------------------------------------------------------
// decompose
// ---------------------------------------------------------------------------

/** The manager's structured output: 3–5 questions, no ids/confidence yet. */
const DecompositionSchema = z.object({
  questions: z
    .array(
      z.object({
        text: z.string().describe("a specific, researchable question"),
        category: z
          .string()
          .describe('theme, e.g. "market structure" or "willingness to pay"'),
      }),
    )
    .min(3)
    .max(5),
});

/**
 * Manager breaks `state.topic` into 3–5 concrete questions. Fresh questions start
 * at zero confidence and unresolved; the `questions` reducer replaces wholesale.
 */
async function decompose(state: ResearchStateT): Promise<Partial<ResearchStateT>> {
  const { object } = await generateObject({
    model: managerModel,
    schema: DecompositionSchema,
    prompt: [
      "You are the research manager scoping an investigation.",
      `Topic: ${state.topic}`,
      "",
      "Break this into 3–5 distinct, researchable questions that together cover the",
      "topic. Each question should be answerable from web evidence and target a",
      "different facet (market, customers, competition, economics, risks, etc.).",
    ].join("\n"),
  });

  const questions: Question[] = object.questions.map((q, i) => ({
    id: `q${i + 1}`,
    text: q.text,
    category: q.category,
    confidence: 0,
    resolved: false,
  }));

  return { questions };
}

// ---------------------------------------------------------------------------
// retrieve
// ---------------------------------------------------------------------------

/** Questions still worth spending budget on this loop. */
const unresolved = (state: ResearchStateT): Question[] =>
  state.questions.filter((q) => !q.resolved);

/**
 * Search the web for each unresolved question (in parallel) and append the hits.
 * The `evidence` reducer is append-only, so we return only the new items.
 */
async function retrieve(state: ResearchStateT): Promise<Partial<ResearchStateT>> {
  const questions = unresolved(state);
  const batches = await Promise.all(
    questions.map((q) => search(q, state.loopIteration)),
  );
  const evidence: Evidence[] = batches.flat();
  return { evidence };
}

// ---------------------------------------------------------------------------
// debate
// ---------------------------------------------------------------------------

/**
 * Run the committee over each unresolved question against ALL evidence gathered so
 * far, appending the resulting claims. The `claims` reducer is append-only.
 */
async function debate(state: ResearchStateT): Promise<Partial<ResearchStateT>> {
  const questions = unresolved(state);
  const batches = await Promise.all(
    questions.map((q) => runCommittee(q, state.evidence, state.loopIteration)),
  );
  const claims: Claim[] = batches.flat();
  return { claims };
}

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

/**
 * Allocate budget and decide whether to loop again. `allocateBudget` (gate.ts) owns
 * the policy and returns the next state plus a `continueLoop` flag.
 *
 * We run it HERE, in a node, so its state mutation (budget spent, loopIteration,
 * questions resolved) is persisted by the checkpointer. The routing decision is
 * carried forward in `converged` (converged === !continueLoop) so the conditional
 * edge can read it without re-running the policy.
 */
async function gate(state: ResearchStateT): Promise<Partial<ResearchStateT>> {
  const { state: next, continueLoop } = allocateBudget(state);
  return {
    questions: next.questions,
    loopIteration: next.loopIteration,
    budgetRemaining: next.budgetRemaining,
    budgetSpent: next.budgetSpent,
    converged: !continueLoop,
  };
}

/**
 * Conditional edge after `gate`: loop back to `retrieve` while the gate wants to
 * continue (continueLoop === !converged) AND budget remains; otherwise finish.
 */
function routeAfterGate(state: ResearchStateT): "retrieve" | "recommend" {
  const continueLoop = !state.converged;
  return continueLoop && state.budgetRemaining > 0 ? "retrieve" : "recommend";
}

// ---------------------------------------------------------------------------
// recommend
// ---------------------------------------------------------------------------

/** Per-question rollup in the final report. */
export interface QuestionReport {
  question: Question;
  /** Aggregate confidence across the committee's claims (0–1). */
  confidence: number;
  claims: Claim[];
  resolved: boolean;
}

/**
 * The final research output: an evidence graph (evidence + claims that reference
 * evidence ids), confidence per question, and what remains unresolved.
 */
export interface ResearchReport {
  topic: string;
  questions: QuestionReport[];
  unresolvedQuestions: Question[];
  /** Every source retrieved — the nodes of the evidence graph. */
  evidence: Evidence[];
  /** Every claim — the edges, linking questions to supporting/contradicting evidence. */
  claims: Claim[];
  loopIterations: number;
  budgetSpent: number;
}

/**
 * Pure synthesis of a report from a (final) research state. Exported so callers and
 * tests can turn the graph's returned state into a structured report directly.
 *
 * A question's confidence is the mean of its committee claims' confidences, falling
 * back to the running `question.confidence` when it wasn't debated.
 */
export function synthesizeReport(state: ResearchStateT): ResearchReport {
  const questions: QuestionReport[] = state.questions.map((q) => {
    const claims = state.claims.filter((c) => c.questionId === q.id);
    const confidence =
      claims.length > 0
        ? claims.reduce((sum, c) => sum + c.confidence, 0) / claims.length
        : q.confidence;
    return { question: q, confidence, claims, resolved: q.resolved };
  });

  return {
    topic: state.topic,
    questions,
    unresolvedQuestions: state.questions.filter((q) => !q.resolved),
    evidence: state.evidence,
    claims: state.claims,
    loopIterations: state.loopIteration,
    budgetSpent: state.budgetSpent,
  };
}

/**
 * Assemble the final output. Folds each question's aggregate confidence back into
 * `state.questions` and marks the run converged. The compiled graph's final state
 * therefore carries settled confidences; call `synthesizeReport(finalState)` for the
 * full structured report.
 */
async function recommend(state: ResearchStateT): Promise<Partial<ResearchStateT>> {
  const report = synthesizeReport(state);
  const questions: Question[] = report.questions.map((qr) => ({
    ...qr.question,
    confidence: qr.confidence,
  }));
  return { questions, converged: true };
}

// ---------------------------------------------------------------------------
// graph assembly
// ---------------------------------------------------------------------------

const workflow = new StateGraph(ResearchState)
  .addNode("decompose", decompose)
  .addNode("retrieve", retrieve)
  .addNode("debate", debate)
  .addNode("gate", gate)
  .addNode("recommend", recommend)
  .addEdge(START, "decompose")
  .addEdge("decompose", "retrieve")
  .addEdge("retrieve", "debate")
  .addEdge("debate", "gate")
  .addConditionalEdges("gate", routeAfterGate, {
    retrieve: "retrieve",
    recommend: "recommend",
  })
  .addEdge("recommend", END);

/**
 * Compile the research graph with a MemorySaver checkpointer.
 *
 * The checkpointer persists every super-step, so consumers get state history and
 * time-travel for free — invoke with a `configurable.thread_id` to scope a run:
 *
 *   const graph = compileResearchGraph();
 *   const out = await graph.invoke({ topic }, { configurable: { thread_id: "1" } });
 *   const report = synthesizeReport(out);
 */
export function compileResearchGraph() {
  const checkpointer = new MemorySaver();
  return workflow.compile({ checkpointer });
}
