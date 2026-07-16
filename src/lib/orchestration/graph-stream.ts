import { GraphRecursionError } from "@langchain/langgraph";
import {
  compileResearchGraph,
  synthesizeReport,
  ensureAnswer,
  computeRecursionLimit,
  scopeEvidenceToQuestions,
  questionsNeedingDebate,
} from "./graph";
import { rollupTokens } from "./eval";
import type { ArmResult } from "./eval";
import { computeRunMechanics } from "./mechanics";
import type { ResearchStateT, Question, RetrievalMode } from "../schemas/state";
import type { Evidence } from "../schemas/evidence";
import type { SearchProgress } from "../evidence/provider";
import type { Claim } from "../schemas/claim";
import type { DebateRound } from "./debate";
import type { DigestItem } from "./digest";
import type { ResearcherProgress } from "./researcher";
import type { AnnotatedUsage } from "./eval";
import type { ResearchEvent, GateScore } from "../research-events";
import { TOTAL_RETRIEVAL_BUDGET, MAX_LOOP_ITERATIONS } from "../params";
import { startTrace } from "./trace";
import { runWithCostTracker, getActiveCostTracker, BudgetExceededError } from "./cost-tracker";

/**
 * One question's debate transcript → the board's `debate:opening`/`debate:round` SSE events
 * (question-board-spec.md §3c): round 0 streams as one `debate:opening` per role (mirroring
 * `debate:claim`'s per-claim style, for the live dots-snapping animation); rounds ≥1 stream as one
 * `debate:round` per round (a whole round's revised claims together, for the deliberation
 * timeline). The node (committee.ts/graph.ts) only walks state; this is graph-stream's own event
 * mapping, kept here so the researcher/committee layer stays unaware of the wire protocol.
 * Exported for direct unit testing.
 */
export function transcriptToEvents(questionId: string, rounds: DebateRound[]): ResearchEvent[] {
  const events: ResearchEvent[] = [];
  for (const round of [...rounds].sort((a, b) => a.round - b.round)) {
    if (round.round === 0) {
      for (const claim of round.claims) events.push({ type: "debate:opening", claim });
    } else {
      events.push({ type: "debate:round", questionId, round: round.round, claims: round.claims });
    }
  }
  return events;
}

export function runGraphStreaming(
  topic: string,
  send: (event: ResearchEvent) => void,
  budgetOverride?: number,
  // Default to the agentic arm: it's the flagship retrieval path and the ONLY one that emits the
  // per-question `researcher:*` progress the UI renders. `runGraph` (non-streaming) defaults to
  // "coded" as the eval control; the live/streaming surface defaults to "agentic" on purpose.
  retrievalMode: RetrievalMode = "agentic",
  // Overrides MAX_RUN_COST_USD (params.ts) for this run — the LLM $ cap, independent of
  // budgetOverride (the search/scrape CREDIT cap). Undefined keeps the default.
  usdBudgetOverride?: number,
): Promise<ArmResult> {
  // Per-run cost tracker via AsyncLocalStorage — see runWithCostTracker. Isolates
  // this run's spend from any other concurrent run in the same process.
  return runWithCostTracker(
    () => runGraphStreamingInner(topic, send, budgetOverride, retrievalMode),
    usdBudgetOverride,
  );
}

async function runGraphStreamingInner(
  topic: string,
  send: (event: ResearchEvent) => void,
  budgetOverride?: number,
  retrievalMode: RetrievalMode = "agentic",
): Promise<ArmResult> {
  const trace = startTrace();
  const graph = compileResearchGraph();
  const threadId = `run-${Date.now()}`;
  const t0 = Date.now();

  const originalSend = send;
  send = (event: ResearchEvent) => {
    trace.logEvent(event);
    originalSend(event);
  };

  send({ type: "research:start", topic });
  // Sent before graph.stream(): that await doesn't resolve until the graph has
  // already begun executing, which would delay the first begin event by seconds.
  send({ type: "decompose:begin" });

  const initialBudget = budgetOverride ?? TOTAL_RETRIEVAL_BUDGET;
  const stream = await graph.stream(
    { topic, budgetRemaining: initialBudget, retrievalMode },
    // "updates" fires only on node COMPLETION, so begin events are emitted eagerly
    // below (each node's successor is deterministic). "custom" carries live
    // search/scrape progress written by the retrieve node's config.writer.
    {
      configurable: { thread_id: threadId },
      streamMode: ["updates", "custom"] as const,
      recursionLimit: computeRecursionLimit(MAX_LOOP_ITERATIONS),
    },
  );

  let allLlmCalls: AnnotatedUsage[] = [];
  let totalFirecrawlCalls = 0;
  let totalFirecrawlCredits = 0;
  let currentLoopIteration = 0;
  // Mirror of graph state needed to build eager begin events: the routing decision
  // after gate depends on budgetRemaining (see routeAfterGate), and begin payloads
  // need the current question list. Both are reconstructed from node outputs —
  // retrieve returns budget DELTAS (additive reducer), decompose/gate return
  // the full question list.
  let currentQuestions: Question[] = [];
  let budgetRemaining = initialBudget;
  const unresolvedIds = () => currentQuestions.filter(q => !q.resolved).map(q => q.id);
  // Accumulated node outputs needed to mirror the graph's incremental-debate decision:
  // the eager debate:begin must announce only the questions the debate node will actually
  // run (questionsNeedingDebate), not every unresolved id. Evidence is append-only in the
  // graph; claims accrue across loops — we mirror both from the "updates" stream.
  const allEvidence: Evidence[] = [];
  const allClaims: Claim[] = [];

  let degraded = false;
  let degradeMessage = "";

  // Always persist the trace — on success and on failure — with its own try/catch so a
  // write failure never masks the run error. A local helper (called on the normal path
  // and before a hard-fail rethrow) instead of a finally, to avoid wrapping the entire
  // streaming loop in another try level.
  const writeTrace = async () => {
    try {
      const tracePath = await trace.writeToDisk(topic);
      console.log(`[trace] written to ${tracePath}`);
    } catch (err) {
      console.error("[trace] failed to write:", err);
    }
  };

  try {
    for await (const chunk of stream as AsyncIterable<[string, unknown]>) {
      const [mode, payload] = chunk;

      if (mode === "custom") {
        const custom = payload as { node?: string; progress?: SearchProgress; researcher?: ResearcherProgress };
        // Agentic arm: per-question researcher-agent progress → `researcher:*` SSE events. The domain
        // ResearcherProgress kinds map 1:1 onto the wire events (kind → `researcher:<kind>`); the
        // explicit switch keeps the payloads type-checked rather than casting the union.
        if (custom?.node === "researcher" && custom.researcher) {
          const r = custom.researcher;
          switch (r.kind) {
            case "begin":
              send({ type: "researcher:begin", questionId: r.questionId, loopIteration: r.loopIteration, mission: r.mission });
              break;
            case "search":
              send({ type: "researcher:search", questionId: r.questionId, loopIteration: r.loopIteration, query: r.query, hits: r.hits, credits: r.credits, capped: r.capped });
              break;
            case "read":
              send({ type: "researcher:read", questionId: r.questionId, loopIteration: r.loopIteration, stored: r.stored, requested: r.requested, hitCeiling: r.hitCeiling });
              break;
            case "done":
              send({ type: "researcher:done", questionId: r.questionId, loopIteration: r.loopIteration, evidenceCount: r.evidenceCount, searchCalls: r.searchCalls });
              break;
          }
          continue;
        }
        if (custom?.node === "retrieve" && custom.progress) {
          const p = custom.progress;
          send(
            p.kind === "search"
              ? {
                  type: "retrieve:progress",
                  loopIteration: currentLoopIteration,
                  kind: "search",
                  message: `searched "${p.query.slice(0, 80)}" — ${p.hits} hits${p.cached ? " (cached)" : ""}`,
                }
              : {
                  type: "retrieve:progress",
                  loopIteration: currentLoopIteration,
                  kind: "scrape",
                  message: `scraping pages… ${p.done}/${p.total}`,
                },
          );
        }
        continue;
      }

      const update = payload as Record<string, unknown>;
      for (const [nodeName, nodeOutput] of Object.entries(update)) {
        const output = nodeOutput as Partial<ResearchStateT>;

        trace.logStateSnapshot(nodeName, output);

        switch (nodeName) {
          case "decompose": {
            const questions = (output.questions ?? []) as Question[];
            currentQuestions = questions;
            const usage = output.llmCalls?.[0];
            if (usage) {
              allLlmCalls.push(usage);
              send({ type: "research:usage", usage });
            }
            send({
              type: "decompose:done",
              questions,
              usage: usage ?? { model: "", promptTokens: 0, completionTokens: 0, label: "decompose", costUsd: 0 },
            });
            // Next node is deterministic: decompose → retrieve.
            send({ type: "retrieve:begin", loopIteration: currentLoopIteration, questionIds: unresolvedIds() });
            break;
          }

          case "retrieve": {
            const evidence = (output.evidence ?? []) as Evidence[];
            const calls = (output.firecrawlCalls ?? 0) as number;
            const credits = (output.firecrawlCredits ?? 0) as number;
            totalFirecrawlCalls += calls;
            totalFirecrawlCredits += credits;
            allEvidence.push(...evidence);
            // retrieve returns budget DELTAS (additive reducer) — accumulate to
            // mirror state.budgetRemaining for the post-gate routing prediction.
            budgetRemaining += (output.budgetRemaining ?? 0) as number;

            for (const ev of evidence) {
              // Prefer the real question id (agentic arm tags every Evidence with it — see
              // researcher.ts) over sourceQuery, mirroring scopeEvidenceToQuestions's own identity-
              // first scoping. Without this, evidenceByQuestion keys on the raw search query text
              // and the board's per-question Recon/Loop cells never match a question id.
              send({ type: "retrieve:evidence", evidence: ev, questionId: ev.questionId ?? ev.sourceQuery });
            }

            send({
              type: "retrieve:done",
              loopIteration: currentLoopIteration,
              evidenceCount: evidence.length,
              firecrawlCalls: calls,
            });
            // Next node is deterministic: retrieve → debate. Mirror the debate node's
            // incremental filter so the begin event announces only the questions that
            // will actually be re-run this loop (see questionsNeedingDebate in graph.ts).
            const needing = questionsNeedingDebate(
              currentQuestions,
              scopeEvidenceToQuestions(currentQuestions, allEvidence),
              allClaims,
              currentLoopIteration,
            );
            send({
              type: "debate:begin",
              loopIteration: currentLoopIteration,
              questionIds: needing.map(q => q.id),
            });
            break;
          }

          case "debate": {
            const claims = (output.claims ?? []) as Claim[];
            const usages = (output.llmCalls ?? []) as AnnotatedUsage[];
            const digests = (output.digests ?? {}) as Record<string, DigestItem[]>;
            const transcripts = (output.debateTranscripts ?? {}) as Record<string, DebateRound[]>;
            allLlmCalls.push(...usages);
            allClaims.push(...claims);

            // Openings + rounds first (§3c) — the debate node's output only carries THIS loop's
            // transcripts, so this is exactly the fresh opening/round activity to stream.
            for (const [qid, rounds] of Object.entries(transcripts)) {
              for (const transcriptEvent of transcriptToEvents(qid, rounds)) send(transcriptEvent);
            }

            for (const claim of claims) {
              send({ type: "debate:claim", claim });
            }

            for (const u of usages) {
              // Digest calls are tagged `digest:<questionId>` (see digest.ts) — surface
              // them as their own event before folding into the usage totals.
              if (u.label.startsWith("digest:")) {
                const questionId = u.label.slice("digest:".length);
                send({
                  type: "debate:digest",
                  questionId,
                  loopIteration: currentLoopIteration,
                  evidenceCount: digests[questionId]?.length ?? 0,
                  usage: u,
                });
              }
              send({ type: "research:usage", usage: u });
            }

            send({ type: "debate:done", loopIteration: currentLoopIteration, claimCount: claims.length });
            // Next node is deterministic: debate → gate.
            send({ type: "gate:begin", loopIteration: currentLoopIteration });
            break;
          }

          case "gate": {
            const loopIteration = (output.loopIteration ?? currentLoopIteration) as number;
            const converged = (output.converged ?? false) as boolean;
            const questions = (output.questions ?? []) as Question[];
            const usages = (output.llmCalls ?? []) as AnnotatedUsage[];
            const gateScores = (output.gateScores ?? []) as GateScore[];
            allLlmCalls.push(...usages);
            if (questions.length > 0) currentQuestions = questions;

            for (const u of usages) {
              send({ type: "research:usage", usage: u });
            }

            const resolvedQuestionIds = questions.filter(q => q.resolved).map(q => q.id);
            const unresolvedQuestionIds = questions.filter(q => !q.resolved).map(q => q.id);
            const continueLoop = !converged;

            send({
              type: "gate:done",
              loopIteration: currentLoopIteration,
              resolvedQuestionIds,
              unresolvedQuestionIds,
              continueLoop,
              gateScores,
            });

            // Next node mirrors routeAfterGate: retrieve when the gate wants another
            // loop AND budget remains (the loop-back retrieval pass); else recommend.
            if (continueLoop && budgetRemaining > 0) {
              currentLoopIteration = loopIteration;
              send({ type: "retrieve:begin", loopIteration: currentLoopIteration, questionIds: unresolvedIds() });
            } else {
              send({ type: "recommend:begin" });
            }
            break;
          }

          case "recommend": {
            // The recommend node's answerObjective step (A5) is one LLM call; fold its usage
            // into the running total so the streamed token rollup stays complete.
            const usages = (output.llmCalls ?? []) as AnnotatedUsage[];
            allLlmCalls.push(...usages);
            for (const u of usages) send({ type: "research:usage", usage: u });
            break;
          }
        }
      }
    }
  } catch (err) {
    // Graceful degradation: a hit budget cap and a hit recursion limit both fall back
    // to synthesizing whatever partial state the checkpointer persisted.
    if (err instanceof BudgetExceededError) {
      degraded = true;
      degradeMessage = "LLM cost cap reached — synthesizing partial report";
      trace.log("budget_exceeded", { message: err.message });
    } else if (err instanceof GraphRecursionError) {
      degraded = true;
      degradeMessage = "recursion limit reached — synthesizing partial report";
      trace.log("recursion_limit", { message: err.message });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      trace.log("run_failed", { message, stack });
      console.error("[research] orchestrated streaming run failed:", err);
      await writeTrace();
      throw err;
    }
  }

  const fullState = await graph.getState({ configurable: { thread_id: threadId } });
  const finalState = fullState.values as ResearchStateT;

  // Always produce an objective-level answer, even when the run degraded before recommend ran (the
  // answer is exempt from the cost cap). No-op when recommend already wrote it; otherwise fold the
  // out-of-graph answer call's usage into the streamed rollup.
  const { report, usage: answerUsage } = await ensureAnswer(finalState, synthesizeReport(finalState));
  for (const u of answerUsage) {
    allLlmCalls.push(u);
    send({ type: "research:usage", usage: u });
  }
  if (degraded) {
    send({ type: "research:error", message: degradeMessage });
  }
  send({ type: "recommend:done", report });

  trace.log("final_state", {
    topic,
    questionsCount: finalState.questions.length,
    evidenceCount: finalState.evidence.length,
    claimsCount: finalState.claims.length,
    loopIterations: finalState.loopIteration,
    budgetSpent: finalState.budgetSpent,
    budgetRemaining: finalState.budgetRemaining,
    converged: finalState.converged,
    answerProduced: report.answer.length > 0,
    llmCallCount: allLlmCalls.length,
    firecrawlCalls: totalFirecrawlCalls,
    firecrawlCredits: totalFirecrawlCredits,
    durationMs: Date.now() - t0,
  });

  // `allLlmCalls` drives the live SSE `research:usage` stream, but the FINAL rollup must come
  // from the cost tracker: a degraded run rolls the failing super-step's state back to the last
  // checkpoint, dropping already-billed calls from that array (and from state.llmCalls). The
  // tracker retains every billed call — including the rolled-back super-step and the answer
  // (recorded once via answerObjective/ensureAnswer) — so its rollup reflects true spend without
  // double-counting the answer. Fall back to allLlmCalls only if no tracker is active.
  const tracker = getActiveCostTracker();
  const rollupUsages = tracker ? tracker.getUsages() : allLlmCalls;
  const tokens = rollupTokens(rollupUsages);
  const mechanics = computeRunMechanics(trace.getEntries(), finalState, tokens);
  send({ type: "research:mechanics", mechanics });
  const result = {
    arm: "orchestrated" as const,
    topic,
    report,
    tokens,
    firecrawlCalls: totalFirecrawlCalls,
    firecrawlCredits: totalFirecrawlCredits,
    durationMs: Date.now() - t0,
    mechanics,
  };

  await writeTrace();

  return result;
}
