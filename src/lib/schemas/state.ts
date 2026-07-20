import { Annotation } from "@langchain/langgraph";
import type { Evidence } from "./evidence";
import type { Claim } from "./claim";
import { type ResearchBrief, fallbackBrief } from "./brief";
import type { AnnotatedUsage } from "../orchestration/eval";
import type { DigestItem } from "../orchestration/digest";
import type { DebateRound } from "../orchestration/debate";
import type { GateScore } from "../research-events";

/**
 * Reducer for the per-question digest channel: append this loop's fresh digest items onto
 * whatever a question already has, per questionId, leaving other questions untouched. Fresh
 * evidence is digested at most once (the debate node never re-digests old evidence), so
 * appending can't duplicate. Exported for direct unit testing.
 */
export function mergeDigests(
  prev: Record<string, DigestItem[]>,
  next: Record<string, DigestItem[]>,
): Record<string, DigestItem[]> {
  const merged: Record<string, DigestItem[]> = { ...prev };
  for (const [questionId, items] of Object.entries(next)) {
    merged[questionId] = [...(merged[questionId] ?? []), ...items];
  }
  return merged;
}

export interface Question {
  id: string;
  text: string;
  category: string;         // e.g. "market structure", "willingness to pay"
  confidence: number;        // running confidence 0-1, updated each loop
  resolved: boolean;
  searchQueries?: string[];  // refined queries from missingEvidence; falls back to text
}

/**
 * Which implementation the graph's `retrieve` node uses:
 * - "coded"   — the deterministic code-driven search/triage/scrape workflow (the permanent eval
 *               control arm; byte-identical behaviour across the whole test suite).
 * - "agentic" — one bounded Haiku researcher agent per unresolved question (agentic retrieval).
 * Defaults to "coded" so every existing run/test behaves identically unless explicitly seeded.
 */
export type RetrievalMode = "coded" | "agentic";

/**
 * Reducer for the debate-transcript channel: REPLACE a question's rounds wholesale, leaving other
 * questions untouched. Unlike digests (which accumulate across loops), a transcript is ephemeral to
 * one evidence snapshot — when a question is re-debated on a later loop its old conversation is
 * discarded and only the durable per-role claims (in `claims`) carry forward. Exported for testing.
 */
export function mergeTranscripts(
  prev: Record<string, DebateRound[]>,
  next: Record<string, DebateRound[]>,
): Record<string, DebateRound[]> {
  return { ...prev, ...next };
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
  /**
   * The intake node's reading of the raw topic (subject/objective/constraints). The manager
   * owns full replacement, like `questions`; defaults to an empty fallback brief so the channel
   * is always populated even before intake runs (and if intake degrades).
   */
  researchBrief: Annotation<ResearchBrief>({
    reducer: (_prev, next) => next,   // manager owns full replacement
    default: () => fallbackBrief(""),
  }),
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
  /** firecrawlCredits split by kind (search vs scrape) — same additive-delta shape, always
   * searchCredits + scrapeCredits === firecrawlCredits. See evidence/provider.ts's ExploreResult/
   * SearchResult and researcher.ts's PassPool.spentSearch/spentScrape for the sources. */
  searchCredits: Annotation<number>({ reducer: (prev, next) => prev + next, default: () => 0 }),
  scrapeCredits: Annotation<number>({ reducer: (prev, next) => prev + next, default: () => 0 }),
  converged: Annotation<boolean>({ reducer: (_prev, next) => next, default: () => false }),
  /**
   * Why the retrieval loop ended, set by the gate the moment it converges (gateShortCircuit's
   * reason, or "gate-decided-no-retrieve" / "zero-cost-resolved"). null while the loop is still
   * running. Surfaced on the `gate:done` event so the live board AND the replay can state the reason
   * a run stopped — a settled convergence vs a budget/loop truncation — instead of an unexplained halt.
   */
  convergedReason: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
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
  /** Per-question evidence digests, accumulated across loops (see mergeDigests). */
  digests: Annotation<Record<string, DigestItem[]>>({
    reducer: mergeDigests,
    default: () => ({}),
  }),
  /** Per-question debate transcript (all rounds), replaced per question each loop (see mergeTranscripts). */
  debateTranscripts: Annotation<Record<string, DebateRound[]>>({
    reducer: mergeTranscripts,
    default: () => ({}),
  }),
  /**
   * The recommend node's natural-language answer at the objective's altitude (A5), grounded
   * strictly in the per-question claims + surviving contentions. Empty string when no answer was
   * produced (intake had no objective, or the answer call degraded). Replace reducer.
   */
  answer: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
  /**
   * Which retrieval implementation the `retrieve` node dispatches to. Seeded once at run start
   * (runGraph) and never mutated mid-run. Default "coded" keeps the eval control arm byte-identical.
   */
  retrievalMode: Annotation<RetrievalMode>({ reducer: (_p, n) => n, default: () => "coded" }),
});
export type ResearchStateT = typeof ResearchState.State;