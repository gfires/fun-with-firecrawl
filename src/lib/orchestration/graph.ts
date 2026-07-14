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
import { ResearchBriefSchema, fallbackBrief, type ResearchBrief } from "../schemas/brief";
import type { Evidence } from "../schemas/evidence";
import type { Claim } from "../schemas/claim";
import { managerModel, gateModel } from "../models/provider";
import { type ArmResult, type AnnotatedUsage, toAnnotatedUsage, rollupTokens, estimateCostUsd } from "./eval";
import { MIN_QUESTIONS, MAX_QUESTIONS, MAX_BRIEF_CONSTRAINTS, MAX_SEARCH_QUERIES_PER_QUESTION, RESULTS_PER_QUESTION, TOTAL_FIRECRAWL_BUDGET, MAX_LOOP_ITERATIONS, DIGEST_ENABLED, LLM_MAX_RETRIES } from "../params";
import { getActiveTrace, startTrace } from "./trace";
import { getActiveCostTracker, runWithCostTracker, BudgetExceededError } from "./cost-tracker";

// --- Cross-agent integration imports (implemented on sibling branches) ---------
// evidence/firecrawl.ts: batch web search (queries, k, loop) → tagged Evidence.
import { search } from "../evidence/firecrawl";
// committee.ts: run the multi-role committee as a debate over a question + evidence → Claims +
// transcript. (committee derives the loop iteration from the evidence's own loopIteration.)
import { runDebate, splitEvidence } from "./committee";
import { extractContentions, type DebateRound } from "./debate";
// digest.ts: compress each question's fresh evidence with a cheap Haiku pass (L2).
import { digestEvidence, type DigestItem } from "./digest";
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
  // +1 base for the intake node (a fixed superstep in front of decompose).
  return 6 + 4 * maxLoops + 5; // needed supersteps + margin
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
// intake
// ---------------------------------------------------------------------------

/**
 * Read the raw topic into a ResearchBrief with ONE manager (Haiku) call, so the pipeline
 * adapts to whatever came in — a bare phrase, a sharper niche, a specific thesis, an
 * investment decision — instead of hardcoding one shape. The prompt keeps the PRODUCT
 * MANDATE: this is opportunity/market analysis, not open-ended research. A bare phrase
 * yields a survey objective + empty constraints (behaving as today); a thesis yields the
 * extracted ask. `objective` is the load-bearing field every downstream node reads.
 *
 * A bad brief must never kill a run: the budget gate is OUTSIDE the try (a hit cap must
 * halt the run), but any generation error degrades to fallbackBrief(topic) — mirroring the
 * digest node. Exported for direct unit testing.
 */
export async function intake(state: ResearchStateT): Promise<Partial<ResearchStateT>> {
  const topic = state.topic;

  // Budget gate OUTSIDE the try: a BudgetExceededError must propagate to halt the run,
  // not be swallowed into a fallback brief.
  const costTracker = getActiveCostTracker();
  costTracker?.check();

  const prompt = [
    "You are the research manager for an OPPORTUNITY / MARKET ANALYSIS product (a committee",
    "of a historian, operator, investor and skeptic will evaluate the business case). Read the",
    "input below and produce a brief that points that machinery at the REAL ask.",
    "",
    `INPUT: ${topic}`,
    "",
    "Infer three things:",
    "- subject: the entity or space to search ABOUT (a short noun phrase).",
    "- objective: ONE statement of what output would satisfy THIS input, in the product's terms.",
    "  A bare industry phrase → a survey of the opportunity landscape. A sharper niche → a survey",
    "  scoped to it. A thesis or investment decision → the specific bet to adjudicate (a go/no-go,",
    "  a verdict). Do NOT turn it into generic open-ended research — keep the business-opportunity lens.",
    "- constraints: explicit scope boundaries, requirements, or decision criteria the INPUT stated",
    "  (budget, geography, timeframe, buyer segment, the specific claim to test). If the input is a",
    "  bare phrase that states none, return an EMPTY list — do not invent constraints.",
  ].join("\n");

  try {
    const { output: object, usage } = await generateText({
      model: managerModel,
      output: Output.object({ schema: ResearchBriefSchema }),
      prompt,
      maxRetries: LLM_MAX_RETRIES,
    });

    const annotated = toAnnotatedUsage(usage, managerModel.modelId, "intake");
    costTracker?.record({ model: managerModel.modelId, promptTokens: annotated.promptTokens, completionTokens: annotated.completionTokens });

    const trace = getActiveTrace();
    if (trace) {
      trace.logLlmCall("intake", { model: managerModel.modelId, prompt }, object, usage);
    }

    // Clamp constraint count in code — the schema carries no max (providers strip it).
    const researchBrief: ResearchBrief = {
      subject: object.subject,
      objective: object.objective,
      constraints: object.constraints.slice(0, MAX_BRIEF_CONSTRAINTS),
    };

    return { researchBrief, llmCalls: [annotated] };
  } catch (err) {
    // Degrade to a survey brief on any generation error — a run must never die on a bad brief.
    getActiveTrace()?.log("intake_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return { researchBrief: fallbackBrief(topic) };
  }
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
        searchQueries: z
          .array(z.string())
          .describe(
            "ONE short keyword search query (NOT the full question sentence) that would surface the " +
              'best public evidence — e.g. "mid-market law firm AI contract review pricing". Use the ' +
              "space's real jargon and named tools; a long natural-language question searches poorly.",
          ),
      }),
    )
    .describe(`between ${MIN_QUESTIONS} and ${MAX_QUESTIONS} questions`),
});

/**
 * Manager breaks the intake OBJECTIVE into 3–5 concrete questions whose answers would satisfy
 * it, respecting the stated CONSTRAINTS. This is the seam that makes decomposition adapt to the
 * input's shape: a survey objective yields broad coverage questions; a go/no-go objective yields
 * the questions that adjudicate that specific bet. It stays opinionated toward actionable
 * market/opportunity analysis (the committee's lens) rather than drifting generic.
 *
 * The generic facet list survives ONLY as a fallback hint for a broad survey objective, so a
 * bare-phrase brief decomposes essentially as it did before A3. Fresh questions start at zero
 * confidence and unresolved; the `questions` reducer replaces wholesale.
 */
export async function decompose(state: ResearchStateT): Promise<Partial<ResearchStateT>> {
  const costTracker = getActiveCostTracker();
  costTracker?.check();

  const { subject, objective, constraints } = state.researchBrief;
  const constraintsBlock = constraints.length > 0
    ? constraints.map((c) => `  - ${c}`).join("\n")
    : "  (none stated)";

  const prompt = [
    "You are the research manager scoping an investigation for an opportunity/market analysis",
    "committee (a historian, operator, investor and skeptic will evaluate the business case).",
    "",
    `SUBJECT: ${subject}`,
    `OBJECTIVE: ${objective}`,
    "CONSTRAINTS (respect these — scope every question inside them):",
    constraintsBlock,
    "",
    `Generate ${MIN_QUESTIONS}–${MAX_QUESTIONS} distinct, researchable questions whose answers`,
    "would together SATISFY the objective. Each must be answerable from web evidence, and the set",
    "must serve the objective's actual altitude: a broad survey wants wide coverage of the space;",
    "a go/no-go or thesis wants the questions that would actually settle that specific bet. Stay",
    "opinionated toward actionable market/opportunity analysis — do NOT drift into generic research.",
    "",
    "If (and only if) the objective is a broad survey with no sharper ask, default to covering the",
    "core facets: market, customers, competition, economics, risks.",
    "",
    "For EACH question also give ONE short keyword search query (not the sentence) — the literal",
    "string we will search — using the space's real jargon, named tools, and specifics.",
  ].join("\n");

  const { output: object, usage } = await generateText({
    model: managerModel,
    output: Output.object({ schema: DecompositionSchema }),
    prompt,
    maxRetries: LLM_MAX_RETRIES,
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
    // Keyword queries drive retrieval (retrieve/queriesToSearch prefer these over q.text). Clamp
    // count in code; omit when absent so retrieve falls back to the question text (pre-#2 behavior).
    ...(q.searchQueries?.length
      ? { searchQueries: q.searchQueries.slice(0, MAX_SEARCH_QUERIES_PER_QUESTION) }
      : {}),
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
  const { evidence, searchCredits, scrapeCredits, triageUsage } = await search(
    queries,
    RESULTS_PER_QUESTION,
    state.loopIteration,
    writer ? (progress) => writer({ node: "retrieve", progress }) : undefined,
    // Relevance context for triage: the subject grounds "is this candidate on-topic?".
    state.researchBrief.subject,
  );
  const totalCredits = searchCredits + scrapeCredits;
  // The triage call is one gpt-4o-mini pass inside search(); book its cost and thread its usage
  // into the token rollup (it runs outside the LLM-node path, so nothing else records it).
  const llmCalls: AnnotatedUsage[] = [];
  if (triageUsage) {
    getActiveCostTracker()?.record({ model: triageUsage.model, promptTokens: triageUsage.promptTokens, completionTokens: triageUsage.completionTokens });
    llmCalls.push({ ...triageUsage, label: "triage", costUsd: estimateCostUsd(triageUsage) });
  }
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
    ...(llmCalls.length ? { llmCalls } : {}),
  };
}

// ---------------------------------------------------------------------------
// debate
// ---------------------------------------------------------------------------

/**
 * Run the committee as a DEBATE over each unresolved question against ALL evidence gathered
 * so far, appending each question's FINAL-round claims (the durable positions) and its full
 * per-question transcript. The `claims` reducer is append-only; `debateTranscripts` replaces
 * per question (a fresh evidence snapshot discards the prior conversation — see mergeTranscripts).
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

  // Per question: digest only THIS loop's fresh evidence (never re-digest old sources),
  // combine with the prior-loop digests already in state, then run the debate over the
  // digest. A failed/disabled digest yields no items and the committee falls back to raw
  // evidence. Digest + debate for each question run concurrently across questions.
  const batches = await Promise.all(
    questions.map(async (q) => {
      const scoped = evidenceByQuestion.get(q.id) ?? [];
      const { fresh } = splitEvidence(scoped, state.loopIteration);
      const freshDigest =
        DIGEST_ENABLED && fresh.length > 0
          ? await digestEvidence(q, fresh)
          : { questionId: q.id, items: [] as DigestItem[], usage: undefined };
      const priorItems = state.digests[q.id] ?? [];
      const digestItems = [...priorItems, ...freshDigest.items];

      const debateResult = await runDebate(
        q,
        scoped,
        state.claims.filter((c) => c.questionId === q.id),
        digestItems,
        // Point the committee at the real ask (A4). Topic-level and identical across the three
        // Claude roles, so the L3 shared-prefix cache invariant holds.
        state.researchBrief.objective,
      );
      return { q, debateResult, freshItems: freshDigest.items, digestUsage: freshDigest.usage };
    }),
  );

  const claims: Claim[] = batches.flatMap((b) => b.debateResult.claims);
  const digestUsages = batches
    .map((b) => b.digestUsage)
    .filter((u): u is AnnotatedUsage => u !== undefined);
  const llmCalls = [...digestUsages, ...batches.flatMap((b) => b.debateResult.usage)];
  // Persist only this loop's fresh digest items; mergeDigests appends them per question.
  const digests: Record<string, DigestItem[]> = {};
  // Each question's full transcript; mergeTranscripts REPLACES per question (ephemeral snapshot).
  const debateTranscripts: Record<string, DebateRound[]> = {};
  for (const b of batches) {
    if (b.freshItems.length > 0) digests[b.q.id] = b.freshItems;
    debateTranscripts[b.q.id] = b.debateResult.rounds;
  }
  return { claims, llmCalls, digests, debateTranscripts };
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

export async function refine(state: ResearchStateT): Promise<Partial<ResearchStateT>> {
  const costTracker = getActiveCostTracker();
  costTracker?.check();

  const open = unresolved(state);
  if (open.length === 0) return {};

  const sections = open.map((q) => {
    // The latest debated positions for this question: the final debate round when present, else the
    // question's claims. Do NOT filter by state.loopIteration — the gate increments loopIteration
    // BEFORE refine runs, while these claims carry the PRE-increment loop, so a `=== loopIteration`
    // filter matched nothing and refine silently produced no queries (a no-op second pass).
    const rounds = state.debateTranscripts[q.id];
    const finalRound = rounds?.[rounds.length - 1];
    const latestClaims = finalRound?.claims ?? state.claims.filter((c) => c.questionId === q.id);
    // Draw gaps from the CONTESTED claims — the roles standing on either side of an evidential
    // contention (a named gap that could settle their disagreement). Focusing the second retrieval
    // pass there aims it at the actual fault line rather than every role's wishlist. Fall back to all
    // gaps when no specific evidential contention was found (e.g. no transcript this loop).
    const contested = new Set(
      (finalRound ? extractContentions(q.id, finalRound.claims) : [])
        .filter((c) => c.type === "evidential")
        .flatMap((c) => c.roles),
    );
    const gapClaims = contested.size ? latestClaims.filter((c) => contested.has(c.agentRole)) : latestClaims;
    const gaps = gapClaims.flatMap((c) => c.missingEvidence).filter(Boolean);
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
    maxRetries: LLM_MAX_RETRIES,
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
  /** The intake objective this run set out to satisfy (A5) — echoed from state.researchBrief. */
  objective: string;
  /**
   * Natural-language adjudication at the objective's altitude (A5): a landscape map for a survey,
   * a graded go/no-go + fault lines for a decision, with committee splits called out. Empty string
   * when no answer was produced (no objective, or the answer step degraded).
   */
  answer: string;
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
    // objective + answer are read straight from state (both LLM-produced upstream, in intake and
    // the recommend node) — synthesizeReport itself stays PURE: no LLM call, structural only.
    objective: state.researchBrief.objective,
    answer: state.answer,
    questions,
    unresolvedQuestions: state.questions.filter((q) => !q.resolved),
    evidence: state.evidence,
    claims: state.claims,
    loopIterations: state.loopIteration,
    budgetSpent: state.budgetSpent,
  };
}

// No .min()/.max() — LLM-output schema. Steer with .describe(); the answer is free text.
const AnswerSchema = z.object({
  answer: z
    .string()
    .describe(
      "the final adjudication written at the objective's altitude (landscape map for a survey; " +
        "graded go/no-go + fault lines for a decision), grounded STRICTLY in the committee claims " +
        "and contentions given — introduce no new facts and cite no new sources",
    ),
});

/**
 * The recommend node's ANSWER step (A5): ONE gateModel (Sonnet, for quality) call that writes a
 * natural-language answer at the OBJECTIVE's altitude, grounded STRICTLY in the per-question claims
 * and the surviving contentions already in state — NO new evidence, NO retrieval. It adapts the
 * OUTPUT altitude to the input (a survey gets a landscape map; a decision gets a graded verdict +
 * the fault lines) and calls out any surviving committee split as evidential vs interpretive.
 *
 * Degrades to an empty answer on any generation error — the pure structural report always survives.
 * The answer is EXEMPT from the run's cost cap: we always want a final adjudication, even on a run
 * that otherwise blew its budget, so this books cost via record() but never gates on check().
 * Exported for direct unit testing.
 */
export async function answerObjective(
  state: ResearchStateT,
): Promise<{ answer: string; usage?: AnnotatedUsage }> {
  const objective = state.researchBrief.objective.trim();
  // No objective → nothing to adjudicate at; skip the call (answer stays empty).
  if (!objective) return { answer: "" };

  const costTracker = getActiveCostTracker();

  // Grounding, per question: the committee's FINAL-round positions and any surviving contention.
  // Pulled from the debate transcript when present (the durable final round), else the raw claims.
  const sections = state.questions.map((q) => {
    const rounds = state.debateTranscripts[q.id];
    const finalRound = rounds?.[rounds.length - 1];
    const claims = finalRound ? finalRound.claims : state.claims.filter((c) => c.questionId === q.id);
    const claimLines = claims.length
      ? claims.map((c) => `    - [${c.agentRole}] (conf ${c.confidence.toFixed(2)}) ${c.conclusion}`).join("\n")
      : "    - (no committee claims)";
    const contentions = finalRound ? extractContentions(q.id, finalRound.claims) : [];
    const contentionLines = contentions.length
      ? contentions.map((ct) => `    - SPLIT (${ct.type}) ${ct.roles.join(" vs ")}: ${ct.note}`).join("\n")
      : "    - (committee aligned — no surviving split)";
    return `  Question ${q.id} (${q.category}): ${q.text}\n  Committee positions:\n${claimLines}\n  Contentions:\n${contentionLines}`;
  });

  const constraints = state.researchBrief.constraints;
  const constraintsLine = constraints.length ? constraints.join("; ") : "(none stated)";

  const prompt = [
    "You are the research manager writing the FINAL adjudication for an opportunity/market analysis.",
    "",
    `OBJECTIVE (write the answer that satisfies THIS): ${objective}`,
    `CONSTRAINTS: ${constraintsLine}`,
    "",
    "Ground your answer STRICTLY in the committee's claims and contentions below. Introduce NO new",
    "facts and cite NO new sources — you are adjudicating what the committee already found, not researching.",
    "",
    "Match the objective's ALTITUDE:",
    "- a broad survey → a landscape map: the shape of the opportunity across the questions.",
    "- a go/no-go or thesis → a graded verdict (e.g. lean go / no-go / not yet) AND the fault lines the",
    "  decision turns on.",
    "Wherever the committee split, say so explicitly and name whether the split is EVIDENTIAL (a gap more",
    "evidence could close) or INTERPRETIVE (the roles read the same evidence differently) — do not paper over it.",
    "",
    "COMMITTEE FINDINGS:",
    ...sections,
  ].join("\n");

  try {
    const { output: object, usage } = await generateText({
      model: gateModel,
      output: Output.object({ schema: AnswerSchema }),
      prompt,
      maxRetries: LLM_MAX_RETRIES,
    });
    const annotated = toAnnotatedUsage(usage, gateModel.modelId, "synthesis:answer");
    costTracker?.record({ model: gateModel.modelId, promptTokens: annotated.promptTokens, completionTokens: annotated.completionTokens });
    getActiveTrace()?.logLlmCall("synthesis:answer", { model: gateModel.modelId, prompt }, object, usage);
    return { answer: object.answer, usage: annotated };
  } catch (err) {
    getActiveTrace()?.log("synthesis_answer_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return { answer: "" };
  }
}

/**
 * Guarantee the report carries an objective-level answer. The recommend node writes it on a normal
 * run, but a run that degrades (budget cap / recursion limit) halts BEFORE recommend — so if the
 * answer is still empty and there is an objective to adjudicate, produce it here. Because the answer
 * is exempt from the cost cap (see answerObjective), "we blew the budget" still yields an adjudication
 * rather than a blank. Returns the report plus the answer call's usage (empty when it no-ops) so the
 * caller can fold it into its token rollup — the call happens OUTSIDE the graph, so it never reaches
 * state.llmCalls on its own. A no-op when the answer is already present or there is no objective.
 */
export async function ensureAnswer(
  state: ResearchStateT,
  report: ResearchReport,
): Promise<{ report: ResearchReport; usage: AnnotatedUsage[] }> {
  if (report.answer || !state.researchBrief.objective.trim()) return { report, usage: [] };
  const { answer, usage } = await answerObjective(state);
  return { report: { ...report, answer }, usage: usage ? [usage] : [] };
}

/**
 * Assemble the final output. Folds each question's aggregate confidence back into
 * `state.questions`, writes the objective-level `answer` (answerObjective, A5), and marks the run
 * converged. The compiled graph's final state therefore carries settled confidences AND the answer;
 * call `synthesizeReport(finalState)` for the full structured report.
 */
export async function recommend(state: ResearchStateT): Promise<Partial<ResearchStateT>> {
  const report = synthesizeReport(state);
  const questions: Question[] = report.questions.map((qr) => ({
    ...qr.question,
    confidence: qr.confidence,
  }));

  const { answer, usage } = await answerObjective(state);
  getActiveTrace()?.log("synthesis:answer", {
    produced: answer.length > 0,
    objective: state.researchBrief.objective,
  });

  return { questions, converged: true, answer, ...(usage ? { llmCalls: [usage] } : {}) };
}

// ---------------------------------------------------------------------------
// graph assembly
// ---------------------------------------------------------------------------

const workflow = new StateGraph(ResearchState)
  .addNode("intake", intake)
  .addNode("decompose", decompose)
  .addNode("retrieve", retrieve)
  .addNode("debate", debate)
  .addNode("gate", gate)
  .addNode("refine", refine)
  .addNode("recommend", recommend)
  .addEdge(START, "intake")
  .addEdge("intake", "decompose")
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

    // Always produce an objective-level answer, even when the run degraded before recommend ran
    // (the answer is exempt from the cost cap). No-op with zero usage when recommend already wrote it.
    const { report, usage: answerUsage } = await ensureAnswer(finalState, synthesizeReport(finalState));
    if (degraded) {
      console.log(`[degrade] run halted early — synthesizing partial report`);
    }

    // Debate stats over the final transcripts — how much the committee actually deliberated, the
    // shape of the disagreement that survived, and how many concessions were made. All mechanical
    // (counts over the transcript), no invented scores.
    let questionsDebated = 0;
    let conversationalRounds = 0;
    let evidentialContentions = 0;
    let interpretiveContentions = 0;
    let concessions = 0;
    for (const [qid, rounds] of Object.entries(finalState.debateTranscripts)) {
      questionsDebated += 1;
      conversationalRounds += Math.max(0, rounds.length - 1); // round 0 is the opening, not debate
      const finalRound = rounds[rounds.length - 1];
      if (!finalRound) continue;
      for (const c of extractContentions(qid, finalRound.claims)) {
        if (c.type === "evidential") evidentialContentions += 1;
        else interpretiveContentions += 1;
      }
      for (const claim of finalRound.claims) {
        concessions += claim.responses.filter((r) => r.stance === "concede").length;
      }
    }

    // Self-contained end-of-run summary in the trace (the streaming runner logs its own).
    trace.log("final_state", {
      topic,
      degraded,
      questionsCount: finalState.questions.length,
      evidenceCount: finalState.evidence.length,
      claimsCount: finalState.claims.length,
      loopIterations: finalState.loopIteration,
      converged: finalState.converged,
      answerProduced: report.answer.length > 0,
      budgetSpent: finalState.budgetSpent,
      budgetRemaining: finalState.budgetRemaining,
      firecrawlCalls: finalState.firecrawlCalls,
      firecrawlCredits: finalState.firecrawlCredits,
      debate: {
        questionsDebated,
        conversationalRounds,
        contentions: { evidential: evidentialContentions, interpretive: interpretiveContentions },
        concessions,
      },
    });

    return {
      arm: "orchestrated" as const,
      topic,
      report,
      // Fold in the degrade-path answer's usage — it runs outside the graph, so it's not in llmCalls.
      tokens: rollupTokens([...finalState.llmCalls, ...answerUsage]),
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
