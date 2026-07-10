import { Annotation } from "@langchain/langgraph";
import type { Evidence } from "./evidence";
import type { Claim } from "./claim";
import type { AnnotatedUsage } from "../orchestration/eval";
import type { GateScore } from "../research-events";

export interface Question {
  id: string;
  text: string;
  category: string;         // e.g. "market structure", "willingness to pay"
  confidence: number;        // running confidence 0-1, updated each loop
  resolved: boolean;
  searchQueries?: string[];  // refined queries from missingEvidence; falls back to text
}

export const ResearchState = Annotation.Root({
  topic: Annotation<string>,
  questions: Annotation<Question[]>({
    reducer: (_prev, next) => next,   // manager owns full replacement
    default: () => [],
  }),
  evidence: Annotation<Evidence[]>({
    reducer: (prev, next) => [...prev, ...next],   // append-only
    default: () => [],
  }),
  claims: Annotation<Claim[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  loopIteration: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  budgetRemaining: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  budgetSpent: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  firecrawlCalls: Annotation<number>({ reducer: (prev, next) => prev + next, default: () => 0 }),
  firecrawlCredits: Annotation<number>({ reducer: (prev, next) => prev + next, default: () => 0 }),
  converged: Annotation<boolean>({ reducer: (_prev, next) => next, default: () => false }),
  /** Every LLM call made anywhere in the graph (decompose, committee, gate), append-only. */
  llmCalls: Annotation<AnnotatedUsage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  /** Per-question gate scores from the most recent gate evaluation. */
  gateScores: Annotation<GateScore[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
});
export type ResearchStateT = typeof ResearchState.State;