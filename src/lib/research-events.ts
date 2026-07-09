import type { Question } from "./schemas/state";
import type { Evidence } from "./schemas/evidence";
import type { Claim } from "./schemas/claim";
import type { AnnotatedUsage } from "./orchestration/eval";
import type { ResearchReport } from "./orchestration/graph";

export type ResearchPhase = "decompose" | "retrieve" | "debate" | "gate" | "recommend" | "done";

export interface VoiScore {
  questionId: string;
  voi: number;
  disagreement: number;
  sensitivity: number;
  tractability: number;
}

export type ResearchEvent =
  | { type: "research:start"; topic: string }
  | { type: "decompose:begin" }
  | { type: "decompose:done"; questions: Question[]; usage: AnnotatedUsage }
  | { type: "retrieve:begin"; loopIteration: number; questionIds: string[] }
  | { type: "retrieve:evidence"; evidence: Evidence; questionId: string }
  | { type: "retrieve:done"; loopIteration: number; evidenceCount: number; firecrawlCalls: number }
  | { type: "debate:begin"; loopIteration: number; questionIds: string[] }
  | { type: "debate:claim"; claim: Claim }
  | { type: "debate:done"; loopIteration: number; claimCount: number }
  | { type: "gate:begin"; loopIteration: number }
  | {
      type: "gate:done";
      loopIteration: number;
      resolvedQuestionIds: string[];
      unresolvedQuestionIds: string[];
      continueLoop: boolean;
      voiScores: VoiScore[];
    }
  | { type: "recommend:begin" }
  | { type: "recommend:done"; report: ResearchReport }
  | { type: "research:usage"; usage: AnnotatedUsage }
  | { type: "research:error"; message: string };

export function researchPhaseFor(type: ResearchEvent["type"]): ResearchPhase {
  switch (type) {
    case "research:start":
    case "decompose:begin":
    case "decompose:done":
      return "decompose";
    case "retrieve:begin":
    case "retrieve:evidence":
    case "retrieve:done":
      return "retrieve";
    case "debate:begin":
    case "debate:claim":
    case "debate:done":
      return "debate";
    case "gate:begin":
    case "gate:done":
      return "gate";
    case "recommend:begin":
    case "recommend:done":
      return "recommend";
    case "research:usage":
      return "recommend";
    case "research:error":
      return "done";
  }
}
