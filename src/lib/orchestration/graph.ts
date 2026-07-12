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
import { StateGraph, MemorySaver, START, END, GraphRecursionError, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { generateText, Output } from "ai";
import { z } from "zod";

import { ResearchState, type ResearchStateT, type Question } from "../schemas/state";
import type { Evidence } from "../schemas/evidence";
import type { Claim } from "../schemas/claim";
import { managerModel } from "../models/provider";
import { type ArmResult, toAnnotatedUsage, rollupTokens } from "./eval";
import { MIN_QUESTIONS, MAX_QUESTIONS, RESULTS_PER_QUESTION, TOTAL_FIRECRAWL_BUDGET, MAX_LOOP_ITERATIONS } from "../params";
import { getActiveTrace, startTrace } from "./trace";
import { getActiveCostTracker, runWithCostTracker, BudgetExceededError } from "./cost-tracker";

// --- Cross-agent integration imports (implemented on sibling branches) ---------
// evidence/firecrawl.ts: batch web search (queries, k, loop) → tagged Evidence.
import { search } from "../evidence/firecrawl";
// committee.ts: run the multi-role committee over a question + evidence → Claims.
// (committee derives the loop iteration from the evidence's own loopIteration.)
import { runCommittee } from "./committee";
// gate.ts (this package): budget allocation + loop control. Stub for now.
import { allocateBudget } from "./gate";

// ---------------------------------------------------------------------------
// Pure helpers — exported for direct unit testing
// ---------------------------------------------------------------------------

/**
 * LangGraph's default recursionLimit (25) collides with a full run: a single loop
 * pass is 4 supersteps (retrieve/debate/gate/refine), plus 4 initial supersteps
 * (decompose/retrieve/debate/gate) and a final recommend. So `maxLoops` full passes
 * need `4 + 4*maxLoops + 1` supersteps; we add a small margin.
 */
export function computeRecursionLimit(maxLoops: number): number {
  return 5 + 4 * maxLoops + 5; // needed supersteps + margin
}

export function scopeEvidenceToQuestions(
  questions: Question[],
  evidence: Evidence[],
): Map<string, Evidence[]> {
  const queryToQuestions = new Map<string, string[]>();
  for (const q of questions) {
    const queries = q.searchQueries?.length ? q.searchQueries : [q.text];
    for (const query of queries) {
      const owners = queryToQuestions.get(query) ?? [];
      if (!owners.includes(q.id)) owners.push(q.id);
      queryToQuestions.set(query, owners);
    }
  }
  const byQuestion = new Map<string, Evidence[]>();
  for (const e of evidence) {
    const owners = queryToQuestions.get(e.sourceQuery);
    if (!owners) continue;
    for (const qid of owners) {
      const bucket = byQuestion.get(qid) ?? [];
      bucket.push(e);
      byQuestion.set(qid, bucket);
    }
  }
  return byQuestion;
}

/**
 * Which unresolved questions actually need the committee re-run this loop. A question
 * needs debate iff it is unresolved AND either (a) it has no claims yet, or (b) some of
 * its scoped evidence is fresh this loop (loopIteration === currentLoop). A question that
 * is already claimed and gained no new evidence this round would only reproduce the same
 * deliberation, so we skip it — that's the L1 incremental-debate saving. `currentLoop` is
 * the current loop number (the gate increments it AFTER debate, so fresh evidence carries
 * exactly this value during debate).
 */
export function questionsNeedingDebate(
  questions: Question[],
  evidenceByQuestion: Map<string, Evidence[]>,
  claims: Claim[],
  currentLoop: number,
): Question[] {
  return questions.filter((q) => {
    if (q.resolved) return false;
    const hasClaims = claims.some((c) => c.questionId === q.id);
    if (!hasClaims) return true;
    const scoped = evidenceByQuestion.get(q.id) ?? [];
    return scoped.some((e) => e.loopIteration === currentLoop);
  });
}

export function queriesToSearch(
  questions: Question[],
  alreadySearched: string[],
): string[] {
  const already = new Set(alreadySearched);
  const candidates = questions.flatMap((q) =>
    q.searchQueries?.length ? q.searchQueries : [q.text],
  );
  return [...new Set(candidates)].filter((qq) => !already.has(qq));
}

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
    .describe(`between ${MIN_QUESTIONS} and ${MAX_QUESTIONS} questions`),
});

/**
 * Manager breaks `state.topic` into 3–5 concrete questions. Fresh questions start
 * at zero confidence and unresolved; the `questions` reducer replaces wholesale.
 */
async function decompose(state: ResearchStateT): Promise<Partial<ResearchStateT>> {
  const costTracker = getActiveCostTracker();
  costTracker?.check();

  const prompt = [
    "You are the research manager scoping an investigation.",
    `Topic: ${state.topic}`,
    "",
    "Break this into 3–5 distinct, researchable questions that together cover the",
    "topic. Each question should be answerable from web evidence and target a",
    "different facet (market, customers, competition, economics, risks, etc.).",
  ].join("\n");

  const { output: object, usage } = await generateText({
    model: managerModel,
    output: Output.object({ schema: DecompositionSchema }),
    prompt,
  });

  const annotated = toAnnotatedUsage(usage, managerModel.modelId, "decompose");
  costTracker?.record({ model: managerModel.modelId, promptTokens: annotated.promptTokens, completionTokens: annotated.completionTokens });

  const trace = getActiveTrace();
  if (trace) {
    trace.logLlmCall("decompose", { model: managerModel.modelId, prompt }, object, usage);
  }

  // Schema count bounds are advisory only (providers strip min/max) — clamp here
  // so retrieval fan-out and budget stay bounded.
  const questions: Question[] = object.questions.slice(0, MAX_QUESTIONS).map((q, i) => ({
    id: `q${i + 1}`,
    text: q.text,
    category: q.category,
    confidence: 0,
    resolved: false,
  }));

  return {
    questions,
    llmCalls: [annotated],
  };
}

// ---------------------------------------------------------------------------
// retrieve
// ---------------------------------------------------------------------------

/** Questions still worth spending budget on this loop. */
const unresolved = (state: ResearchStateT): Question[] =>
  state.questions.filter((q) => !q.resolved);

/**
 * Search the web for every unresolved question and append the hits. `search` takes
 * the batch of query strings and parallelizes internally, tagging each Evidence with
 * its `sourceQuery` and the current `loopIteration`. The `evidence` reducer is
 * append-only, so we return only the new items.
 */
async function retrieve(
  state: ResearchStateT,
  config?: LangGraphRunnableConfig,
): Promise<Partial<ResearchStateT>> {
  const questions = unresolved(state);
  // Every return path sets newEvidenceCount so the gate can detect a zero-progress
  // loop: an early return adds no evidence, so the count is 0.
  if (questions.length === 0) return { newEvidenceCount: 0 };
  let queries = queriesToSearch(questions, state.searchedQueries);
  if (queries.length === 0) return { newEvidenceCount: 0 };
  // Each search query costs ~2 credits; cap so search alone doesn't blow the budget.
  const maxQueries = Math.max(1, Math.floor(state.budgetRemaining / 4));
  if (queries.length > maxQueries) queries = queries.slice(0, maxQueries);
  // Under streamMode "custom", config.writer forwards live search/scrape progress
  // to the SSE transport (graph-stream.ts). Absent (graph.invoke) → no emission.
  const writer = config?.writer;
  const { evidence, searchCredits, scrapeCredits } = await search(
    queries,
    RESULTS_PER_QUESTION,
    state.loopIteration,
    writer ? (progress) => writer({ node: "retrieve", progress }) : undefined,
  );
  const totalCredits = searchCredits + scrapeCredits;
  // budgetRemaining/budgetSpent reducers are ADDITIVE — return signed deltas, not
  // absolutes. Spending `totalCredits` credits: remaining goes down, spent goes up.
  return {
    evidence,
    searchedQueries: queries,
    firecrawlCalls: queries.length,
    firecrawlCredits: totalCredits,
    budgetRemaining: -totalCredits,
    budgetSpent: totalCredits,
    newEvidenceCount: evidence.length,
  };
}

// ---------------------------------------------------------------------------
// debate
// ---------------------------------------------------------------------------

/**
 * Run the committee over each unresolved question against ALL evidence gathered so
 * far, appending the resulting claims. The `claims` reducer is append-only.
 */
async function debate(state: ResearchStateT): Promise<Partial<ResearchStateT>> {
  const evidenceByQuestion = scopeEvidenceToQuestions(state.questions, state.evidence);
  // Only re-run the committee where it can produce something new (L1). If nothing needs
  // debate, return an empty delta — the gate then short-circuits via newEvidenceCount===0.
  const questions = questionsNeedingDebate(
    state.questions,
    evidenceByQuestion,
    state.claims,
    state.loopIteration,
  );
  if (questions.length === 0) return {};

  const batches = await Promise.all(
    questions.map((q) =>
      runCommittee(
        q,
        evidenceByQuestion.get(q.id) ?? [],
        state.claims.filter((c) => c.questionId === q.id),
      ),
    ),
  );
  const claims: Claim[] = batches.flatMap((b) => b.claims);
  const llmCalls = batches.flatMap((b) => b.usage);
  return { claims, llmCalls };
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
  const { state: next, continueLoop, usage, gateScores } = await allocateBudget(state);
  // NB: allocateBudget does not spend Firecrawl credits — it only resolves questions
  // and advances loopIteration. So gate returns NO budget delta; budgetRemaining/
  // budgetSpent are owned solely by `retrieve`. Returning them here would double-count
  // under the additive reducer.
  return {
    questions: next.questions,
    loopIteration: next.loopIteration,
    converged: !continueLoop,
    llmCalls: usage,
    gateScores,
  };
}

/**
 * Conditional edge after `gate`: loop back to `refine` (which generates new queries
 * from missingEvidence before re-retrieving) while the gate wants to continue and
 * budget remains; otherwise finish.
 */
function routeAfterGate(state: ResearchStateT): "refine" | "recommend" {
  const continueLoop = !state.converged;
  return continueLoop && state.budgetRemaining > 0 ? "refine" : "recommend";
}

// ---------------------------------------------------------------------------
// refine — generate targeted queries from missingEvidence before re-retrieving
// ---------------------------------------------------------------------------

const RefineSchema = z.object({
  questions: z.array(z.object({
    questionId: z.string(),
    searchQueries: z.array(z.string()).describe("1-3 targeted search queries"),
  })),
});

async function refine(state: ResearchStateT): Promise<Partial<ResearchStateT>> {
  const costTracker = getActiveCostTracker();
  costTracker?.check();

  const open = unresolved(state);
  if (open.length === 0) return {};

  const latestLoop = state.loopIteration;
  const sections = open.map((q) => {
    const claims = state.claims.filter(
      (c) => c.questionId === q.id && c.loopIteration === latestLoop,
    );
    const gaps = claims.flatMap((c) => c.missingEvidence).filter(Boolean);
    const gapText = gaps.length > 0 ? gaps.join("; ") : "";
    return { id: q.id, text: q.text, gaps, gapText };
  });

  const hasAnyGaps = sections.some((s) => s.gaps.length > 0);
  if (!hasAnyGaps) return {};

  const sectionText = sections.map(
    (s) => `Question ${s.id}: ${s.text}\n  Evidence gaps: ${s.gapText || "none noted — generate diverse queries"}`,
  );

  const refinePrompt = [
    "You are a research manager refining search queries for a second pass.",
    "The committee has reviewed initial evidence and identified gaps.",
    "For each question below, generate 1–3 NEW, targeted search queries that",
    "specifically address the noted evidence gaps. Do NOT repeat the original",
    "question verbatim — instead craft queries that will surface the missing",
    "information (specific data, counterexamples, named sources, etc.).",
    "",
    ...sectionText,
    "",
    "Return a searchQueries array for every question ID listed.",
  ].join("\n");

  const { output: object, usage } = await generateText({
    model: managerModel,
    output: Output.object({ schema: RefineSchema }),
    prompt: refinePrompt,
  });

  const annotated = toAnnotatedUsage(usage, managerModel.modelId, "refine");
  costTracker?.record({ model: managerModel.modelId, promptTokens: annotated.promptTokens, completionTokens: annotated.completionTokens });

  const trace = getActiveTrace();
  if (trace) {
    trace.logLlmCall("refine", { model: managerModel.modelId, prompt: refinePrompt }, object, usage);
  }

  // Clamp query count in code — each query is a Firecrawl search, so this bounds spend.
  const queryMap = new Map(
    object.questions
      .filter((q) => q.searchQueries.length > 0)
      .map((q) => [q.questionId, q.searchQueries.slice(0, 3)]),
  );
  // ACCUMULATE, don't replace: evidence already gathered under q.searchQueries (or
  // q.text, for loop 0) is tagged with those exact query strings via Evidence.sourceQuery
  // (see search()/retrieve()). debate() reconstructs question ownership from that
  // history (scopeEvidenceToQuestions below) — overwriting searchQueries here would
  // orphan every prior loop's evidence from all future committee calls.
  const questions = state.questions.map((q) => {
    const newQueries = queryMap.get(q.id);
    if (!newQueries) return q;
    const priorQueries = q.searchQueries && q.searchQueries.length > 0 ? q.searchQueries : [q.text];
    return { ...q, searchQueries: [...new Set([...priorQueries, ...newQueries])] };
  });

  return {
    questions,
    llmCalls: [annotated],
  };
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
  .addNode("refine", refine)
  .addNode("recommend", recommend)
  .addEdge(START, "decompose")
  .addEdge("decompose", "retrieve")
  .addEdge("retrieve", "debate")
  .addEdge("debate", "gate")
  .addConditionalEdges("gate", routeAfterGate, {
    refine: "refine",
    recommend: "recommend",
  })
  .addEdge("refine", "retrieve")
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

export function runGraph(topic: string, budgetOverride?: number): Promise<ArmResult> {
  // Run the whole graph inside a per-run cost tracker (AsyncLocalStorage) so every
  // getActiveCostTracker() in the async tree resolves to THIS run's tracker — two
  // concurrent runs never share or clobber each other's spend.
  return runWithCostTracker(() => runGraphInner(topic, budgetOverride));
}

async function runGraphInner(topic: string, budgetOverride?: number): Promise<ArmResult> {
  const trace = startTrace();
  const graph = compileResearchGraph();
  const threadId = `run-${Date.now()}`;
  const t0 = Date.now();

  try {
    let finalState: ResearchStateT;
    let degraded = false;

    try {
      finalState = await graph.invoke(
        { topic, budgetRemaining: budgetOverride ?? TOTAL_FIRECRAWL_BUDGET },
        { configurable: { thread_id: threadId }, recursionLimit: computeRecursionLimit(MAX_LOOP_ITERATIONS) },
      );
    } catch (err) {
      // Graceful degradation: both a hit budget cap and a hit recursion limit fall
      // back to synthesizing whatever partial state the checkpointer persisted.
      if (err instanceof BudgetExceededError) {
        degraded = true;
        trace.log("budget_exceeded", { message: err.message });
        const partial = await graph.getState({ configurable: { thread_id: threadId } });
        finalState = partial.values as ResearchStateT;
      } else if (err instanceof GraphRecursionError) {
        degraded = true;
        trace.log("recursion_limit", { message: err.message });
        const partial = await graph.getState({ configurable: { thread_id: threadId } });
        finalState = partial.values as ResearchStateT;
      } else {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        trace.log("run_failed", { message, stack });
        console.error("[research] orchestrated run failed:", err);
        throw err;
      }
    }

    const report = synthesizeReport(finalState);
    if (degraded) {
      console.log(`[degrade] run halted early — synthesizing partial report`);
    }

    return {
      arm: "orchestrated" as const,
      topic,
      report,
      tokens: rollupTokens(finalState.llmCalls),
      firecrawlCalls: finalState.firecrawlCalls,
      firecrawlCredits: finalState.firecrawlCredits,
      durationMs: Date.now() - t0,
    };
  } finally {
    // Always write the trace — even when the run threw — so failures are debuggable.
    // Its own try/catch: a write failure must never mask the run error.
    try {
      const tracePath = await trace.writeToDisk(topic);
      console.log(`[trace] written to ${tracePath}`);
    } catch (err) {
      console.error("[trace] failed to write:", err);
    }
  }
}
