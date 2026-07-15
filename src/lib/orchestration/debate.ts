/**
 * debate.ts — the committee debate (Wave 3).
 *
 * The committee is a REAL debate, not a parallel poll: over a FROZEN evidence snapshot, each role
 * renders an independent opening claim (round 0), then across conversational rounds reads its peers'
 * positions and the challenges aimed at it and revises — conceding ONLY to evidence, never to
 * consensus. The debate runs until positions stop moving (a mechanical movement signal, never a
 * self-reported "I've converged") or a hard round cap, and skips entirely when the opening round
 * already agrees. Evidence never changes mid-debate; only the outer retrieval loop adds evidence.
 *
 * This module owns the debate's types and (from D1 on) its pure logic — consensus detection,
 * round-over-round movement, directed challenges, transcript rendering, and contention extraction.
 * Everything here is computed from data the committee already produces (confidences, cited-id sets,
 * response stances); nothing invents a score.
 */
import type { AgentRoleT, Claim, ClaimStanceT, DebateResponse } from "../schemas/claim";
import { ABSTENTION_STANCE } from "../schemas/claim";

/** One conversational round: every participating role's claim for that round. */
export interface DebateRound {
  round: number; // 0 = independent opening; >=1 = conversational
  claims: Claim[]; // one per role; each carries its `responses` (edges to peers)
}

/**
 * Canonical role order — same as committee.ts ROLES. Every ordering the debate produces
 * (transcript lines, contention pairs) keys off this so output is deterministic regardless
 * of the order the async committee returns claims in.
 */
const ROLE_ORDER: AgentRoleT[] = ["historian", "operator", "investor", "skeptic"];

/** True iff two id lists carry the same set of ids (order- and duplicate-insensitive). */
function sameIdSet(a: string[], b: string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const id of sa) if (!sb.has(id)) return false;
  return true;
}

/**
 * A disagreement that survived the debate. `type` decides routing at the gate:
 * - "evidential": a contested claim names missing evidence that could settle it → worth retrieval.
 * - "interpretive": the roles read the same evidence differently with no named gap → retrieving is
 *   futile; report the fault line rather than burning budget.
 */
export interface Contention {
  questionId: string;
  roles: [AgentRoleT, AgentRoleT];
  type: "evidential" | "interpretive";
  note: string; // short mechanical description (which claims clash, over which ids)
}

/**
 * The set of DECISIVE positions present among the claims — every distinct `stance` EXCEPT the
 * abstention value `"insufficient"`. Written over positions GENERALLY (returns `Set<string>`), so a
 * future richer stance taxonomy just adds more decisive values with no edit here. This is the raw
 * signal both the disagreement detector and the committee-stance rollup key off.
 */
export function decisiveStances(claims: Claim[]): Set<string> {
  const stances = new Set<string>();
  for (const c of claims) {
    if (c.stance !== ABSTENTION_STANCE) stances.add(c.stance);
  }
  return stances;
}

/** The evidence ids over which two claims read the SAME source oppositely (one supports, one contradicts). */
function idClashBetween(a: Claim, b: Claim): string[] {
  const aContra = new Set(a.contradictingEvidenceIds);
  const bContra = new Set(b.contradictingEvidenceIds);
  return [
    ...a.supportingEvidenceIds.filter((id) => bContra.has(id)),
    ...b.supportingEvidenceIds.filter((id) => aContra.has(id)),
  ];
}

/** True iff ANY pair of claims reads some evidence id oppositely (an id-clash exists among them). */
function anyIdClash(claims: Claim[]): boolean {
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      if (idClashBetween(claims[i], claims[j]).length > 0) return true;
    }
  }
  return false;
}

/**
 * Is there GENUINE disagreement worth debating over these (blind, round-0) opening claims? Two ways
 * to disagree: the roles took ≥2 distinct DECISIVE positions (`decisiveStances(claims).size >= 2`),
 * OR they read the same evidence oppositely (an `idClash` — reused from extractContentions, and valid
 * on blind openings because it needs no debate responses). For the current 3-value enum the stance
 * arm equals "supports AND opposes both present"; an N-way enum needs no edit. When NEITHER holds —
 * unanimous lean, one lean plus abstentions, or shared uncertainty — there is nothing to resolve, so
 * the conversational rounds (and the gate's retrieval on this signal) are skipped: agreement is a
 * trigger to ACT, not a debate to run.
 */
export function hasGenuineDisagreement(claims: Claim[]): boolean {
  return decisiveStances(claims).size >= 2 || anyIdClash(claims);
}

/**
 * The committee's overall position, rolled up from the per-role stances:
 * - ≥2 decisive stances present → `"contested"` (a genuine fault line);
 * - else if ANY role abstains (`"insufficient"`) → `"insufficient"` — a one-sided lean with any
 *   abstention is "not enough to call" (decision 3: only a UNANIMOUS decisive lean is a confident answer);
 * - else the single decisive stance the whole committee shares (`"supports"` / `"opposes"`);
 * - else (no claims) → `"insufficient"`.
 * The return type is the opportunity instantiation; the logic is position-general.
 */
export type CommitteeStance = "contested" | ClaimStanceT;
export function committeeStance(claims: Claim[]): CommitteeStance {
  const decisive = decisiveStances(claims);
  if (decisive.size >= 2) return "contested";
  if (claims.some((c) => c.stance === ABSTENTION_STANCE)) return ABSTENTION_STANCE;
  if (decisive.size === 1) return [...decisive][0] as ClaimStanceT;
  return ABSTENTION_STANCE;
}

/** Every (fromRole → targetRole) pair carrying a "rebut" stance in a round, as `from>target` keys. */
function rebuttalPairs(round: DebateRound): Set<string> {
  const pairs = new Set<string>();
  for (const claim of round.claims) {
    for (const r of claim.responses) {
      if (r.stance === "rebut") pairs.add(`${claim.agentRole}>${r.targetRole}`);
    }
  }
  return pairs;
}

/**
 * Mechanical round-over-round movement — the debate's only convergence signal (we never let a role
 * self-report "I've converged"). `moved` counts roles whose confidence shifted by more than `epsilon`
 * OR whose supporting/contradicting id-set changed between the rounds. `newRebuttals` counts rebut
 * edges present in `next` but absent from `prev`, compared by (from→target) PAIR IDENTITY only — never
 * by fuzzy-matching the free-text `point`.
 *
 * A round that moves NO position has `converged: true` and the debate stops — even if roles kept
 * firing fresh rebuttals. Because a role may concede ONLY to evidence (never to consensus) over a
 * FROZEN evidence snapshot, a round where nobody moved means the evidence in hand can't shift anyone:
 * either the committee has settled or it is stuck on a gap. Both are terminal for THIS snapshot — the
 * gate then routes the survivor (interpretive split → report the fault line; evidential gap → earn
 * more retrieval), which is far cheaper than another rebuttal round of roles restating disagreement.
 * (Traces show round-over-round movement dries up fast once evidence is exhausted; `newRebuttals`
 * without movement was the main source of churn — it is still reported for the trace, just no longer
 * keeps the debate alive.)
 */
export function debateMovement(
  prev: DebateRound,
  next: DebateRound,
  epsilon: number,
): { moved: number; newRebuttals: number; converged: boolean } {
  const prevByRole = new Map(prev.claims.map((c) => [c.agentRole, c]));
  let moved = 0;
  for (const claim of next.claims) {
    const before = prevByRole.get(claim.agentRole);
    if (!before) {
      // A role that wasn't in the prior round is a new position — count it as movement.
      moved += 1;
      continue;
    }
    const confidenceMoved = Math.abs(claim.confidence - before.confidence) > epsilon;
    const supportChanged = !sameIdSet(claim.supportingEvidenceIds, before.supportingEvidenceIds);
    const contraChanged = !sameIdSet(claim.contradictingEvidenceIds, before.contradictingEvidenceIds);
    if (confidenceMoved || supportChanged || contraChanged) moved += 1;
  }

  const prevPairs = rebuttalPairs(prev);
  let newRebuttals = 0;
  for (const pair of rebuttalPairs(next)) {
    if (!prevPairs.has(pair)) newRebuttals += 1;
  }

  // Stop the moment a round moves no position — a stall over frozen evidence, whether settled or
  // gap-blocked. `newRebuttals` is reported but no longer gates convergence (it was the churn source).
  return { moved, newRebuttals, converged: moved === 0 };
}

/**
 * A challenge aimed at a role, paired with WHO raised it. The response itself only names its
 * target and stance — the challenger is the `agentRole` of the claim that owns the response — so we
 * surface `from` here rather than denormalizing a source role onto every DebateResponse (which,
 * being an LLM output field, would just be a chance for a model to misstate its own role).
 */
export interface DirectedChallenge {
  from: AgentRoleT;
  response: DebateResponse;
}

/**
 * The challenges this `role` must answer next: every response in the latest round aimed AT it, each
 * tagged with the peer that raised it. Single source of truth for the "CHALLENGES AIMED AT YOU"
 * block in the role's next-round user message (D2).
 */
export function directedChallenges(latestRound: DebateRound, role: AgentRoleT): DirectedChallenge[] {
  return latestRound.claims.flatMap((c) =>
    c.responses
      .filter((r) => r.targetRole === role)
      .map((response) => ({ from: c.agentRole, response })),
  );
}

/** Order a round's claims by canonical role order so the rendered transcript is deterministic. */
function orderedClaims(round: DebateRound): Claim[] {
  return [...round.claims].sort(
    (a, b) => ROLE_ORDER.indexOf(a.agentRole) - ROLE_ORDER.indexOf(b.agentRole),
  );
}

/**
 * Compact, deterministic rendering of a debate transcript for the shared system prefix (D2).
 * One line per claim — `[role] (conf X): conclusion — support[ids]/contra[ids]` — followed by
 * one indented line per directed response — `→ stance @target: point`. Rounds are emitted in
 * ascending order and claims within a round in canonical role order, so the text is byte-stable
 * (a requirement for the L3 prompt cache).
 */
export function renderTranscript(rounds: DebateRound[]): string {
  const lines: string[] = [];
  for (const round of [...rounds].sort((a, b) => a.round - b.round)) {
    lines.push(`Round ${round.round}:`);
    for (const c of orderedClaims(round)) {
      const support = c.supportingEvidenceIds.join(",");
      const contra = c.contradictingEvidenceIds.join(",");
      lines.push(
        `  [${c.agentRole}] (conf ${c.confidence.toFixed(2)}): ${c.conclusion} — support[${support}]/contra[${contra}]`,
      );
      for (const r of c.responses) {
        lines.push(`    → ${r.stance} @${r.targetRole}: ${r.point}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Extract the disagreements that SURVIVED the debate, from its final-round claims. A role pair is in
 * contention when, in the final round, one role `rebut`s the other and the other did NOT `concede`
 * back (an unresolved rebuttal), OR the two read the same evidence oppositely — one lists an id in
 * `contradictingEvidenceIds` that the other lists in `supportingEvidenceIds`. Classification is
 * mechanical and drives gate routing (D5): `evidential` when either contested claim names a
 * `missingEvidence` gap that retrieval could settle, else `interpretive` (retrieving is futile —
 * report the fault line). Pairs are ordered and de-duplicated by canonical role order.
 */
export function extractContentions(questionId: string, finalClaims: Claim[]): Contention[] {
  const byRole = new Map(finalClaims.map((c) => [c.agentRole, c]));
  const contentions: Contention[] = [];

  for (let i = 0; i < ROLE_ORDER.length; i++) {
    for (let j = i + 1; j < ROLE_ORDER.length; j++) {
      const roleA = ROLE_ORDER[i];
      const roleB = ROLE_ORDER[j];
      const a = byRole.get(roleA);
      const b = byRole.get(roleB);
      if (!a || !b) continue;

      const aRebutsB = a.responses.some((r) => r.targetRole === roleB && r.stance === "rebut");
      const bConcedesA = b.responses.some((r) => r.targetRole === roleA && r.stance === "concede");
      const bRebutsA = b.responses.some((r) => r.targetRole === roleA && r.stance === "rebut");
      const aConcedesB = a.responses.some((r) => r.targetRole === roleB && r.stance === "concede");
      const unresolvedRebuttal = (aRebutsB && !bConcedesA) || (bRebutsA && !aConcedesB);

      const clashIds = idClashBetween(a, b);
      const idClash = clashIds.length > 0;

      if (!unresolvedRebuttal && !idClash) continue;

      const evidential = a.missingEvidence.length > 0 || b.missingEvidence.length > 0;
      const note = idClash
        ? `clash over evidence [${[...new Set(clashIds)].join(",")}]`
        : `unresolved rebuttal between ${roleA} and ${roleB}`;
      contentions.push({
        questionId,
        roles: [roleA, roleB],
        type: evidential ? "evidential" : "interpretive",
        note,
      });
    }
  }

  return contentions;
}

/**
 * Route a question's surviving contentions at the gate (D5) — the marginal-utility shut-off on the
 * retrieval loop. A contention that names NO missing evidence is INTERPRETIVE: the roles read the
 * same evidence differently, so more retrieval is futile — "resolve" and report the fault line. Only
 * an EVIDENTIAL contention (a named gap that could settle it) is worth spending budget on, so
 * "retrieve" hands the question to the LLM gate to decide under budget. `null` means no signal (no
 * debate transcript for this question yet) — defer to the gate's normal flow rather than force a
 * resolution. Note: an empty contention set means the committee AGREED → "resolve" (nothing to chase).
 */
export function contentionRoute(
  contentions: Contention[] | undefined,
): "retrieve" | "resolve" | null {
  if (!contentions) return null;
  if (contentions.some((c) => c.type === "evidential")) return "retrieve";
  return "resolve";
}
