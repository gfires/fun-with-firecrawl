import { compileResearchGraph, synthesizeReport } from "./graph";
import { rollupTokens } from "./eval";
import type { ArmResult } from "./eval";
import type { ResearchStateT, Question } from "../schemas/state";
import type { Evidence } from "../schemas/evidence";
import type { Claim } from "../schemas/claim";
import type { AnnotatedUsage } from "./eval";
import type { ResearchEvent, VoiScore } from "../research-events";
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

  let finalState: ResearchStateT | null = null;
  let allLlmCalls: AnnotatedUsage[] = [];
  let totalFirecrawlCalls = 0;
  let totalFirecrawlCredits = 0;

  for await (const update of stream) {
    for (const [nodeName, nodeOutput] of Object.entries(update)) {
      const output = nodeOutput as Partial<ResearchStateT>;

      switch (nodeName) {
        case "decompose": {
          send({ type: "decompose:begin" });
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

          send({
            type: "retrieve:begin",
            loopIteration: 0,
            questionIds: evidence.map(e => e.sourceQuery),
          });

          for (const ev of evidence) {
            send({ type: "retrieve:evidence", evidence: ev, questionId: ev.sourceQuery });
          }

          send({
            type: "retrieve:done",
            loopIteration: 0,
            evidenceCount: evidence.length,
            firecrawlCalls: calls,
          });
          break;
        }

        case "debate": {
          const claims = (output.claims ?? []) as Claim[];
          const usages = (output.llmCalls ?? []) as AnnotatedUsage[];
          allLlmCalls.push(...usages);

          const questionIds = [...new Set(claims.map(c => c.questionId))];
          send({ type: "debate:begin", loopIteration: 0, questionIds });

          for (const claim of claims) {
            send({ type: "debate:claim", claim });
          }

          for (const u of usages) {
            send({ type: "research:usage", usage: u });
          }

          send({ type: "debate:done", loopIteration: 0, claimCount: claims.length });
          break;
        }

        case "gate": {
          const loopIteration = (output.loopIteration ?? 0) as number;
          const converged = (output.converged ?? false) as boolean;
          const questions = (output.questions ?? []) as Question[];
          const usages = (output.llmCalls ?? []) as AnnotatedUsage[];
          allLlmCalls.push(...usages);

          send({ type: "gate:begin", loopIteration });

          for (const u of usages) {
            send({ type: "research:usage", usage: u });
          }

          const resolvedQuestionIds = questions.filter(q => q.resolved).map(q => q.id);
          const unresolvedQuestionIds = questions.filter(q => !q.resolved).map(q => q.id);

          send({
            type: "gate:done",
            loopIteration,
            resolvedQuestionIds,
            unresolvedQuestionIds,
            continueLoop: !converged,
            voiScores: [],
          });
          break;
        }

        case "recommend": {
          send({ type: "recommend:begin" });
          break;
        }
      }

      if (output.questions || output.evidence || output.claims) {
        finalState = { ...finalState, ...output } as ResearchStateT;
      }
    }
  }

  const fullState = await graph.getState({ configurable: { thread_id: threadId } });
  finalState = fullState.values as ResearchStateT;

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
