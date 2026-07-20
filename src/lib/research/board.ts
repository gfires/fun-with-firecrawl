/**
 * board.ts — pure, state-shaping helpers for the QuestionBoard (question-board-spec.md).
 *
 * Everything here is a pure function over data the stream already carries (Claims, GateScores,
 * Evidence, ResearcherPass) — no LLM calls, no invented scores. Components import these instead of
 * recomputing cell logic inline, so the derivation is unit-testable without a browser (per the
 * project's "reducer logic is pure and unit-testable" discipline).
 */
import type { AgentRoleT, Claim } from "@/lib/schemas/claim";
import type { Evidence } from "@/lib/schemas/evidence";
import type { GateScore } from "@/lib/research-events";
import type { GateDecision, QuestionStatus } from "@/lib/useResearchStream";
import { hasGenuineDisagreement, type CommitteeStance } from "@/lib/orchestration/debate";
import { latestClaimsByRole } from "@/lib/research/arena";

/** Source count gathered on loop 0 (the Recon cell). */
export function reconCount(evidence: Evidence[]): number {
  return evidence.filter((e) => e.loopIteration === 0).length;
}

/** Index an already-scoped (one question) claim list by role, last occurrence wins. */
export function claimsByRole(claims: Claim[]): Partial<Record<AgentRoleT, Claim>> {
  const result: Partial<Record<AgentRoleT, Claim>> = {};
  for (const c of claims) result[c.agentRole] = c;
  return result;
}

/**
 * The committee's CURRENT position for a question — one claim per role, each role's most recent
 * (highest `loopIteration`) claim. Feed this into `committeeStance`/stance-derived cells, never the
 * raw accumulated `claimsByQuestion` array: that array holds every loop's final claims, and unioning
 * stances across loops can manufacture a spurious "contested" read for a question that was contested
 * early but converged to a unanimous lean by its latest loop.
 */
export function currentCommitteeClaims(claims: Claim[], questionId: string): Claim[] {
  return Object.values(latestClaimsByRole(claims, questionId)).filter((c): c is Claim => c != null);
}

/** The Openings cell's "→" resolution: no claims yet, unanimous, or a genuine split. */
export function openingResolution(claims: Claim[]): "pending" | "agree" | "split" {
  if (claims.length === 0) return "pending";
  return hasGenuineDisagreement(claims) ? "split" : "agree";
}

/** The most recent GateScore recorded for one question, scanning decisions newest-first. */
export function latestGateScoreFor(
  decisions: GateDecision[],
  questionId: string,
): GateScore | undefined {
  for (let i = decisions.length - 1; i >= 0; i--) {
    const score = decisions[i].gateScores.find((s) => s.questionId === questionId);
    if (score) return score;
  }
  return undefined;
}

/**
 * Scope a run's GateDecisions down to one question — same shape, `gateScores`/`resolvedIds`/
 * `unresolvedIds` filtered to just that question — so the existing `GateDecisionPanel` (built for
 * the whole-run view) can be reused unchanged as the Gate drill-down (component disposition table).
 */
export function scopeGateDecisionsToQuestion(
  decisions: GateDecision[],
  questionId: string,
): GateDecision[] {
  return decisions.map((d) => ({
    ...d,
    gateScores: d.gateScores.filter((s) => s.questionId === questionId),
    resolvedIds: d.resolvedIds.filter((id) => id === questionId),
    unresolvedIds: d.unresolvedIds.filter((id) => id === questionId),
  }));
}

export type GateVerdict = "pending" | "settled" | "fault-line" | "limitation" | "retrieve" | "truncated";

/**
 * The Gate cell's route verdict — derived from the REAL gate decision (`retrieve`/`truncated`) plus
 * the committee's stance, mirroring gate.ts's own resolve reasoning (questionRoute/routeReason)
 * rather than collapsing every resolve into "settled":
 * - the gate sent it back to retrieval → "retrieve"
 * - `truncated` → the question was still RESOLVED (committee stance + report entry) but had a
 *   chase-able gap the run converged before pursuing (cost-headroom / budget clamp). It reads as
 *   "answered · gap unchased" — answered on the evidence in hand, with the gap noted — NOT a settled
 *   fault line and NOT a failure. Checked BEFORE stance so a budget-truncated `contested` question
 *   shows "truncated", not "fault-line".
 * - resolved + `"contested"` → a genuinely reported fault line (retrieval was futile), not a call
 * - resolved + `"insufficient"` → a LIMITATION (no chase-able gap, or diminishing returns gave up)
 * - resolved + a unanimous decisive lean (`supports`/`opposes`) → "settled", the only confident case
 */
export function gateVerdict(score: GateScore | undefined, stance: CommitteeStance): GateVerdict {
  if (!score) return "pending";
  if (score.retrieve) return "retrieve";
  if (score.truncated) return "truncated";
  if (stance === "contested") return "fault-line";
  if (stance === "insufficient") return "limitation";
  return "settled";
}

/**
 * The Deliberation cell's label. `debateOutcome === "skipped"` means the GRAPH didn't re-run this
 * question's committee this loop (no fresh evidence arrived — see debate:begin) — reuse of a prior
 * loop's claim, not the spec's hero "openings agreed" case. That case is `debateOutcome ===
 * "debated"` with `debateRounds === 0` AND the committee has actually finished — while still
 * `status === "debating"` with 0 rounds, openings are simply still arriving.
 *
 * The "0 rounds, committee finished" case splits in two, and conflating them is misleading: a
 * UNANIMOUS DECISIVE lean (supports/opposes) is genuinely settled — nothing to debate, agreement is
 * the answer. A UNANIMOUS INSUFFICIENT (every role abstained) is NOT agreement on an answer — it's
 * "we all agree we don't have enough evidence yet," which the gate routes back to retrieval when a
 * gap is named (questionRoute, gate.ts), not a resolution. Pass `stance` (committeeStance over the
 * question's current claims) so the label says which one actually happened — the Gate cell right
 * next to it already shows what happens as a result (retrieve/limitation/settled).
 */
export function deliberationLabel(
  q: Pick<QuestionStatus, "debateOutcome" | "debateRounds" | "status">,
  stance?: CommitteeStance,
): string {
  if (q.debateOutcome === "pending") return "—";
  if (q.debateOutcome === "skipped") return "↻ reused prior claim — no fresh evidence this loop";
  if (q.debateRounds > 0) return `🗣 debated ${q.debateRounds} round${q.debateRounds === 1 ? "" : "s"}`;
  if (q.status === "debating") return "🗣 opening...";
  if (stance === "insufficient") return "○ unanimous insufficient — evidence gap, not agreement";
  return "⚡ skipped — unanimous, no genuine disagreement";
}
