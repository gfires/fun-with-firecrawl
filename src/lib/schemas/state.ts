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

/**
 * Additive reducer for the budget channels. Nodes return a signed DELTA and the
 * reducer accumulates it onto the running total. Accumulation is order-independent,
 * so two nodes updating budget in the same super-step can't lose an update the way a
 * last-write-wins replace reducer would. Exported for direct unit testing.
 */
export const accumulate = (prev: number, delta: number): number => prev + delta;

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
  // Per-loop signal from the retrieve node: how many NEW evidence items this loop's
  // retrieval added. -1 means "no retrieve has run yet" (loop 0 pre-retrieve); every
  // retrieve return path sets it (0 on an early return, evidence.length on the normal
  // path). Replace-reducer, not additive: it's the CURRENT loop's count, not a running
  // total — the gate reads it to short-circuit a zero-progress loop (see gateShortCircuit).
  newEvidenceCount: Annotation<number>({ reducer: (_prev, next) => next, default: () => -1 }),
  // budgetRemaining/budgetSpent use ADDITIVE reducers: nodes return a signed DELTA,
  // not an absolute value. A replace reducer would silently drop one decrement if two
  // nodes wrote budget in the same super-step (last-write-wins); accumulating deltas is
  // order-independent and race-free. The initial budgetRemaining is seeded via a delta
  // from the run entrypoint (see runGraph), since default() starts at 0.
  budgetRemaining: Annotation<number>({ reducer: accumulate, default: () => 0 }),
  budgetSpent: Annotation<number>({ reducer: accumulate, default: () => 0 }),
  firecrawlCalls: Annotation<number>({ reducer: (prev, next) => prev + next, default: () => 0 }),
  firecrawlCredits: Annotation<number>({ reducer: (prev, next) => prev + next, default: () => 0 }),
  converged: Annotation<boolean>({ reducer: (_prev, next) => next, default: () => false }),
  /** Every LLM call made anywhere in the graph (decompose, committee, gate), append-only. */
  llmCalls: Annotation<AnnotatedUsage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  searchedQueries: Annotation<string[]>({
    reducer: (prev, next) => [...new Set([...prev, ...next])],
    default: () => [],
  }),
  /** Per-question gate scores from the most recent gate evaluation. */
  gateScores: Annotation<GateScore[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
});
export type ResearchStateT = typeof ResearchState.State;