import type { Question } from "./schemas/state";
import type { Evidence } from "./schemas/evidence";
import type { Claim } from "./schemas/claim";
import type { AnnotatedUsage } from "./orchestration/eval";
import type { ResearchReport } from "./orchestration/graph";
import type { RunMechanics } from "./orchestration/mechanics";

export type ResearchPhase = "decompose" | "retrieve" | "debate" | "gate" | "recommend" | "done";

export interface GateScore {
  questionId: string;
  retrieve: boolean;
  gapCount: number;
  confidenceSpread: number;
  reason: string;
  /**
   * The question WANTED another retrieval loop (a chase-able evidential gap) but the run converged
   * before it could — a budget/cost/loop truncation, not an epistemic result. Set when the loop was
   * short-circuited (e.g. cost-headroom) or the retrieve was clamped for insufficient budget. Lets
   * the board render a distinct "truncated · gap" verdict instead of collapsing these into a genuine
   * "fault line". Absent/false means the resolve was a real conclusion (settled / fault line / limitation).
   */
  truncated?: boolean;
}

export type ResearchEvent =
  | { type: "research:start"; topic: string }
  | { type: "decompose:begin" }
  | { type: "decompose:done"; questions: Question[]; usage: AnnotatedUsage }
  | { type: "retrieve:begin"; loopIteration: number; questionIds: string[] }
  | { type: "retrieve:progress"; loopIteration: number; kind: "search" | "scrape"; message: string }
  | { type: "retrieve:evidence"; evidence: Evidence; questionId: string }
  | { type: "retrieve:done"; loopIteration: number; evidenceCount: number; firecrawlCalls: number }
  // Per-question researcher-agent lifecycle (agentic arm only) — the window-shopping story live:
  // `search.capped` = the 1/pass cap refused a reformulation; `read.hitCeiling` = read up to the
  // per-pass evidence ceiling and stopped. Emitted by runResearcher, forwarded via the custom writer.
  | { type: "researcher:begin"; questionId: string; loopIteration: number; mission: string }
  | { type: "researcher:search"; questionId: string; loopIteration: number; query: string; hits: number; credits: number; capped: boolean }
  | { type: "researcher:read"; questionId: string; loopIteration: number; stored: number; requested: number; hitCeiling: boolean }
  | { type: "researcher:done"; questionId: string; loopIteration: number; evidenceCount: number; searchCalls: number }
  | { type: "debate:begin"; loopIteration: number; questionIds: string[] }
  | { type: "debate:digest"; questionId: string; loopIteration: number; evidenceCount: number; usage: AnnotatedUsage }
  // The board's openings/deliberation columns (question-board-spec.md §3c): the round-0 blind
  // opening, one per role per question, and each conversational round's revised claims. Emitted
  // from graph-stream.ts by walking the debate node's `debateTranscripts` output — additive
  // emissions of state the graph already produces, no new computation.
  | { type: "debate:opening"; claim: Claim }
  | { type: "debate:round"; questionId: string; round: number; claims: Claim[] }
  | { type: "debate:claim"; claim: Claim }
  | { type: "debate:done"; loopIteration: number; claimCount: number }
  | { type: "gate:begin"; loopIteration: number }
  | {
      type: "gate:done";
      loopIteration: number;
      resolvedQuestionIds: string[];
      unresolvedQuestionIds: string[];
      continueLoop: boolean;
      gateScores: GateScore[];
      /**
       * Why the loop ended when it did (gateShortCircuit's reason — "cost-headroom" / "no-progress" /
       * "max-loops" / "budget" — or "gate-decided-no-retrieve" / "zero-cost-resolved"). null while the
       * loop continues. Persisted, so the replay states the reason a run stopped, not just that it did.
       */
      convergedReason?: string | null;
    }
  | { type: "recommend:begin" }
  | { type: "recommend:done"; report: ResearchReport }
  | { type: "research:usage"; usage: AnnotatedUsage }
  // Terminal — the run-mechanics receipt (question-board-spec.md §6 Phase 5 / §7). computeRunMechanics
  // already runs server-side after the stream (see ArmResult.mechanics); this just puts its output on
  // the wire so the board can render it as the closing artifact instead of only via a batch run.
  | { type: "research:mechanics"; mechanics: RunMechanics }
  | { type: "research:error"; message: string };

export function researchPhaseFor(type: ResearchEvent["type"]): ResearchPhase {
  switch (type) {
    case "research:start":
    case "decompose:begin":
    case "decompose:done":
      return "decompose";
    case "retrieve:begin":
    case "retrieve:progress":
    case "retrieve:evidence":
    case "retrieve:done":
    case "researcher:begin":
    case "researcher:search":
    case "researcher:read":
    case "researcher:done":
      return "retrieve";
    case "debate:begin":
    case "debate:digest":
    case "debate:opening":
    case "debate:round":
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
    case "research:mechanics":
      return "recommend";
    case "research:error":
      return "done";
  }
}
