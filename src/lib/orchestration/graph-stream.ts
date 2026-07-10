import { compileResearchGraph, synthesizeReport } from "./graph";
import { rollupTokens } from "./eval";
import type { ArmResult } from "./eval";
import type { ResearchStateT, Question } from "../schemas/state";
import type { Evidence } from "../schemas/evidence";
import type { Claim } from "../schemas/claim";
import type { AnnotatedUsage } from "./eval";
import type { ResearchEvent, GateScore } from "../research-events";
import { TOTAL_FIRECRAWL_BUDGET } from "../params";

export async function runGraphStreaming(
  topic: string,
  send: (event: ResearchEvent) => void,
  budgetOverride?: number,
): Promise<ArmResult> {
  const graph = compileResearchGraph();
  const threadId = `run-${Date.now()}`;
  const t0 = Date.now();

  send({ type: "research:start", topic });

  const stream = await graph.stream(
    { topic, budgetRemaining: budgetOverride ?? TOTAL_FIRECRAWL_BUDGET },
    { configurable: { thread_id: threadId }, streamMode: "updates" as const },
  );

  let allLlmCalls: AnnotatedUsage[] = [];
  let totalFirecrawlCalls = 0;
  let totalFirecrawlCredits = 0;
  let currentLoopIteration = 0;
  const seenNodes = new Set<string>();

  for await (const update of stream) {
    for (const [nodeName, nodeOutput] of Object.entries(update)) {
      const output = nodeOutput as Partial<ResearchStateT>;

      if (!seenNodes.has(nodeName)) {
        seenNodes.add(nodeName);
        sendBeginEvent(send, nodeName, currentLoopIteration, output);
      }

      switch (nodeName) {
        case "decompose": {
          const questions = (output.questions ?? []) as Question[];
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
          break;
        }

        case "retrieve": {
          const evidence = (output.evidence ?? []) as Evidence[];
          const calls = (output.firecrawlCalls ?? 0) as number;
          const credits = (output.firecrawlCredits ?? 0) as number;
          totalFirecrawlCalls += calls;
          totalFirecrawlCredits += credits;

          for (const ev of evidence) {
            send({ type: "retrieve:evidence", evidence: ev, questionId: ev.sourceQuery });
          }

          send({
            type: "retrieve:done",
            loopIteration: currentLoopIteration,
            evidenceCount: evidence.length,
            firecrawlCalls: calls,
          });
          break;
        }

        case "debate": {
          const claims = (output.claims ?? []) as Claim[];
          const usages = (output.llmCalls ?? []) as AnnotatedUsage[];
          allLlmCalls.push(...usages);

          for (const claim of claims) {
            send({ type: "debate:claim", claim });
          }

          for (const u of usages) {
            send({ type: "research:usage", usage: u });
          }

          send({ type: "debate:done", loopIteration: currentLoopIteration, claimCount: claims.length });
          break;
        }

        case "gate": {
          const loopIteration = (output.loopIteration ?? currentLoopIteration) as number;
          const converged = (output.converged ?? false) as boolean;
          const questions = (output.questions ?? []) as Question[];
          const usages = (output.llmCalls ?? []) as AnnotatedUsage[];
          const gateScores = (output.gateScores ?? []) as GateScore[];
          allLlmCalls.push(...usages);

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

          if (continueLoop) {
            currentLoopIteration = loopIteration;
            seenNodes.delete("refine");
            seenNodes.delete("retrieve");
            seenNodes.delete("debate");
            seenNodes.delete("gate");
          }
          break;
        }

        case "refine": {
          const questions = (output.questions ?? []) as Question[];
          const usages = (output.llmCalls ?? []) as AnnotatedUsage[];
          allLlmCalls.push(...usages);

          for (const u of usages) {
            send({ type: "research:usage", usage: u });
          }

          const refinedQueries = questions
            .filter(q => q.searchQueries && q.searchQueries.length > 0)
            .map(q => ({ questionId: q.id, queries: q.searchQueries! }));

          send({
            type: "refine:done",
            loopIteration: currentLoopIteration,
            refinedQueries,
          });
          break;
        }

        case "recommend": {
          break;
        }
      }
    }
  }

  const fullState = await graph.getState({ configurable: { thread_id: threadId } });
  const finalState = fullState.values as ResearchStateT;

  const report = synthesizeReport(finalState);
  send({ type: "recommend:done", report });

  return {
    arm: "orchestrated",
    topic,
    report,
    tokens: rollupTokens(allLlmCalls),
    firecrawlCalls: totalFirecrawlCalls,
    firecrawlCredits: totalFirecrawlCredits,
    durationMs: Date.now() - t0,
  };
}

function sendBeginEvent(
  send: (event: ResearchEvent) => void,
  nodeName: string,
  loopIteration: number,
  output: Partial<ResearchStateT>,
): void {
  switch (nodeName) {
    case "decompose":
      send({ type: "decompose:begin" });
      break;
    case "retrieve": {
      const evidence = (output.evidence ?? []) as Evidence[];
      const questionIds = [...new Set(evidence.map(e => e.sourceQuery))];
      send({ type: "retrieve:begin", loopIteration, questionIds });
      break;
    }
    case "debate": {
      const claims = (output.claims ?? []) as Claim[];
      const questionIds = [...new Set(claims.map(c => c.questionId))];
      send({ type: "debate:begin", loopIteration, questionIds });
      break;
    }
    case "gate":
      send({ type: "gate:begin", loopIteration });
      break;
    case "refine": {
      const questions = (output.questions ?? []) as Question[];
      const questionIds = questions.filter(q => !q.resolved).map(q => q.id);
      send({ type: "refine:begin", loopIteration, questionIds });
      break;
    }
    case "recommend":
      send({ type: "recommend:begin" });
      break;
  }
}
