import { generateText, Output } from "ai";
import { z } from "zod";
import { gateClassifierModel } from "../models/provider";
import type { ResearchStateT } from "../schemas/state";
import { MAX_LOOP_ITERATIONS, LLM_MAX_RETRIES, LOOP_CONFIDENCE_EPSILON, MIN_LOOP_COST_HEADROOM_USD } from "../params";
import { toAnnotatedUsage, type AnnotatedUsage } from "./eval";
import type { GateScore } from "../research-events";
import { getActiveTrace } from "./trace";
import { getActiveCostTracker } from "./cost-tracker";
import { extractContentions, contentionRoute, committeeStance, type Contention, type CommitteeStance } from "./debate";
import type { Claim } from "../schemas/claim";
// The gate-classifier prompt wording lives in src/lib/prompts.ts; this file computes the signals.
import { gatePrompt } from "../prompts";

const GateDecisionSchema = z.object({
  decisions: z.array(z.object({
    questionId: z.string(),
    retrieve: z.boolean(),
    reason: z.string(),
  })),
});

/**
 * Zero-LLM-cost convergence checks. Any non-null result means the loop MUST stop before
 * we pay for a gate classification call. Checked first in allocateBudget.
 *
 * - "budget": no Firecrawl budget left to retrieve with.
 * - "cost-headroom": too little LLM-cost headroom left under MAX_RUN_COST_USD to safely START
 *   another retrieve+debate cycle. Beginning one anyway risks hitting the cap MID-debate, which
 *   LangGraph rolls back — orphaning the just-gathered evidence and committing zero claims. Stop
 *   cleanly before the cycle and keep the last COMPLETE loop's claims. Fires only when a cost
 *   tracker is active; "no tracker" is treated as infinite headroom (keeps the pure tests inert).
 * - "max-loops": the loop-iteration cap is reached.
 * - "no-progress": a past-loop-0 iteration whose retrieve added no new evidence — running
 *   the committee and gate again would only reproduce the prior round. Loop 0 is exempt
 *   (newEvidenceCount is only meaningful once a retrieve has actually run).
 *
 * Order matters only for the returned reason string; all are terminal.
 */
export function gateShortCircuit(
  state: ResearchStateT,
): "budget" | "cost-headroom" | "max-loops" | "no-progress" | null {
  if (state.budgetRemaining <= 0) return "budget";
  // Affordability guard: converge rather than start a cycle the LLM budget can't finish. When no
  // tracker is active, remaining is undefined → treated as infinite headroom → guard stays inert.
  const remaining = getActiveCostTracker()?.getRemaining();
  if (remaining !== undefined && remaining < MIN_LOOP_COST_HEADROOM_USD) return "cost-headroom";
  if (state.loopIteration >= MAX_LOOP_ITERATIONS) return "max-loops";
  if (state.loopIteration > 0 && state.newEvidenceCount === 0) return "no-progress";
  return null;
}

/**
 * Diminishing-returns shut-off for the outer retrieval loop (zero LLM cost). Compares a question's
 * committee state across the two most recent loops it was debated in (claims are tagged with
 * loopIteration; state.claims holds the final-round claims per loop). Retrieval is "diminishing" when
 * the most recent loop NEITHER raised mean confidence (by more than `confidenceEpsilon`) NOR reduced
 * the total named-gap (missingEvidence) count versus the prior loop — the last retrieval bought
 * nothing, so repeating it is futile. Fewer than two debated loops → false (never cut on the first
 * pass). Pure/deterministic; the outer-loop analogue of debateMovement.
 */
export function diminishingReturns(questionClaims: Claim[], confidenceEpsilon: number): boolean {
  const byLoop = new Map<number, Claim[]>();
  for (const c of questionClaims) {
    const arr = byLoop.get(c.loopIteration);
    if (arr) arr.push(c);
    else byLoop.set(c.loopIteration, [c]);
  }
  const loops = [...byLoop.keys()].sort((a, b) => b - a);
  if (loops.length < 2) return false;
  const now = byLoop.get(loops[0])!;
  const prev = byLoop.get(loops[1])!;
  const mean = (cs: Claim[]) => cs.reduce((s, c) => s + c.confidence, 0) / cs.length;
  const gaps = (cs: Claim[]) => cs.reduce((s, c) => s + c.missingEvidence.length, 0);
  const improved = mean(now) > mean(prev) + confidenceEpsilon;
  const gapsReduced = gaps(now) < gaps(prev);
  return !improved && !gapsReduced;
}

/**
 * Route one unresolved question at the gate from its committee POSITION plus its named gap — the
 * decision that makes "the committee debates disagreement; agreement is a trigger to ACT" real
 * (zero LLM cost). This is the marginal-utility shut-off:
 *
 * - `"contested"` (a genuine fault line — the roles debated) → the EXISTING contention routing:
 *   an EVIDENTIAL contention (a named gap that could settle it) earns retrieval; an interpretive-only
 *   split (or no surviving contention) is futile to chase → resolve and report the fault line.
 * - `"supports"` / `"opposes"` (a UNANIMOUS decisive lean, no abstention) → a confident answer → resolve.
 * - `"insufficient"` (the committee can't call it yet) → a named, chase-able gap earns a retrieval
 *   ("go get it"); with no gap there is nothing to fetch → resolve.
 *
 * PATIENCE=1 is enforced UPSTREAM by diminishingReturns, not here: an insufficient gap that already
 * survived one no-progress retrieval loop is resolved (structural limitation) before this routing
 * runs, so a question reaching this function with `stance === "insufficient"` and a gap is one worth
 * trying (loop 0, or a loop that made progress). Pure/deterministic; mode-agnostic.
 */
export function questionRoute(args: {
  stance: CommitteeStance;
  contentions: Contention[];
  hasNamedGap: boolean;
}): "retrieve" | "resolve" {
  const { stance, contentions, hasNamedGap } = args;
  if (stance === "contested") {
    return contentionRoute(contentions) === "retrieve" ? "retrieve" : "resolve";
  }
  if (stance === "insufficient") {
    return hasNamedGap ? "retrieve" : "resolve";
  }
  // A unanimous decisive lean (supports/opposes) — settled.
  return "resolve";
}

/** The zero-cost-resolve reason string for a question the gate settles from its stance route. */
function routeReason(stance: CommitteeStance, contentions: Contention[]): string {
  if (stance === "contested") {
    return contentions.length
      ? "interpretive contention — retrieving is futile, reporting the fault line"
      : "committee split with no surviving contention — reporting the fault line";
  }
  if (stance === "insufficient") {
    return "committee can't call it and named no chase-able gap — nothing to retrieve";
  }
  return `committee reached a unanimous ${stance} — settled`;
}

export async function allocateBudget(
  state: ResearchStateT
): Promise<{ state: ResearchStateT; continueLoop: boolean; usage: AnnotatedUsage[]; gateScores: GateScore[] }> {
  // Zero-cost convergence checks first — budget, loop cap, zero-progress loop — so a
  // converged run never pays for a gate classification call.
  const shortCircuit = gateShortCircuit(state);
  if (shortCircuit) {
    getActiveTrace()?.log("gate:converged", {
      reason: shortCircuit,
      loopIteration: state.loopIteration,
      budgetRemaining: state.budgetRemaining,
      newEvidenceCount: state.newEvidenceCount,
    });
    return { state: { ...state, converged: true }, continueLoop: false, usage: [], gateScores: [] };
  }

  const unresolved = state.questions.filter(q => !q.resolved);

  // Diminishing-returns shut-off (past loop 0): a question whose last targeted retrieval neither
  // raised confidence nor closed a gap won't be helped by more retrieval — resolve it here (zero LLM
  // cost) and let synthesis report the persistent gap, instead of re-spending to reconfirm an
  // unfillable one. Takes precedence over contention routing (which would keep routing an evidential
  // gap to the LLM gate loop after loop).
  const diminishingResolved: GateScore[] = [];
  const diminishingIds = new Set<string>();
  if (state.loopIteration > 0) {
    for (const q of unresolved) {
      const qClaims = state.claims.filter(c => c.questionId === q.id);
      if (diminishingReturns(qClaims, LOOP_CONFIDENCE_EPSILON)) {
        const latestLoop = Math.max(...qClaims.map(c => c.loopIteration));
        const gapCount = qClaims
          .filter(c => c.loopIteration === latestLoop)
          .reduce((s, c) => s + c.missingEvidence.length, 0);
        diminishingResolved.push({
          questionId: q.id,
          retrieve: false,
          gapCount,
          confidenceSpread: 0,
          reason: "diminishing returns — retrieval did not raise confidence or close the gap",
        });
        diminishingIds.add(q.id);
      }
    }
  }

  if (diminishingResolved.length) {
    getActiveTrace()?.log("gate:diminishing", {
      loopIteration: state.loopIteration,
      questionIds: [...diminishingIds],
    });
  }

  // --- Stance routing (Phase B): the marginal-utility shut-off on the retrieval loop ---
  // For each unresolved question, route on the committee's POSITION plus its named gap (see
  // questionRoute): a UNANIMOUS decisive lean is a settled answer; an INTERPRETIVE split (or a
  // contested question with no surviving contention) is futile to chase — both resolve HERE at zero
  // LLM cost and report the fault line. An INSUFFICIENT question with a named gap — the "we agree we
  // need more data" case — routes to RETRIEVE ("go get it"), NOT resolve, which was the bug a
  // contention-only gate had (a skipped question has no debate responses → 0 contentions → it would
  // silently give up). Only questions routed to retrieve — or with no transcript yet — reach the LLM
  // gate below. patience=1 for insufficient gaps is enforced upstream by diminishingReturns.
  const contentionsByQuestion = new Map<string, Contention[]>();
  const stanceByQuestion = new Map<string, CommitteeStance>();
  const stanceResolved: GateScore[] = [];
  for (const q of unresolved.filter(q => !diminishingIds.has(q.id))) {
    const rounds = state.debateTranscripts[q.id];
    const finalRound = rounds?.[rounds.length - 1];
    if (!finalRound) continue; // no debate transcript → defer to the LLM gate (route null)
    const claims = finalRound.claims;
    const contentions = extractContentions(q.id, claims);
    const stance = committeeStance(claims);
    const hasNamedGap = claims.some(c => c.missingEvidence.length > 0);
    contentionsByQuestion.set(q.id, contentions);
    stanceByQuestion.set(q.id, stance);
    if (questionRoute({ stance, contentions, hasNamedGap }) === "resolve") {
      stanceResolved.push({
        questionId: q.id,
        retrieve: false,
        gapCount: claims.reduce((s, c) => s + c.missingEvidence.length, 0),
        confidenceSpread: 0,
        reason: routeReason(stance, contentions),
      });
    }
  }

  getActiveTrace()?.log("debate:contentions", {
    loopIteration: state.loopIteration,
    perQuestion: [...contentionsByQuestion.entries()].map(([questionId, cs]) => ({
      questionId,
      stance: stanceByQuestion.get(questionId),
      evidential: cs.filter(c => c.type === "evidential").length,
      interpretive: cs.filter(c => c.type === "interpretive").length,
      resolved: stanceResolved.some(s => s.questionId === questionId),
    })),
  });

  const zeroCostResolved = [...diminishingResolved, ...stanceResolved];
  const zeroCostResolvedIds = new Set(zeroCostResolved.map(s => s.questionId));
  const gateQuestions = unresolved.filter(q => !zeroCostResolvedIds.has(q.id));

  // Every unresolved question resolved at zero LLM cost (diminishing + contention) → converge with
  // NO LLM gate call.
  if (gateQuestions.length === 0) {
    getActiveTrace()?.log("gate:converged", {
      reason: "zero-cost-resolved",
      loopIteration: state.loopIteration,
      budgetRemaining: state.budgetRemaining,
    });
    const questions = state.questions.map(q =>
      zeroCostResolvedIds.has(q.id) ? { ...q, resolved: true } : q,
    );
    return {
      state: { ...state, questions, converged: true },
      continueLoop: false,
      usage: [],
      gateScores: zeroCostResolved,
    };
  }

  const questionSignals = gateQuestions.map(q => {
    const claims = state.claims.filter(c => c.questionId === q.id);
    const confidences = claims.map(c => c.confidence);
    const gapCount = claims.reduce((sum, c) => sum + c.missingEvidence.length, 0);
    const confidenceSpread = confidences.length >= 2
      ? Math.max(...confidences) - Math.min(...confidences)
      : 0;

    const claimSummary = claims.length
      ? claims.map(c => `  - [${c.agentRole}] "${c.conclusion}" (confidence: ${c.confidence.toFixed(2)}, gaps: ${c.missingEvidence.length})`).join("\n")
      : "  - no claims yet";

    return { question: q, gapCount, confidenceSpread, claimSummary };
  });

  const sections = questionSignals.map(qs =>
    `Question ${qs.question.id} (${qs.question.category}): ${qs.question.text}\n` +
    `  Computed: gapCount=${qs.gapCount}, confidenceSpread=${qs.confidenceSpread.toFixed(2)}\n` +
    `  Claims:\n${qs.claimSummary}`
  );

  const prompt = gatePrompt({
    loopIteration: state.loopIteration,
    budgetRemaining: state.budgetRemaining,
    sections,
  });

  const costTracker = getActiveCostTracker();
  costTracker?.check();

  const { output: object, usage } = await generateText({
    model: gateClassifierModel,
    output: Output.object({ schema: GateDecisionSchema }),
    prompt,
    maxRetries: LLM_MAX_RETRIES,
  });

  const annotated = toAnnotatedUsage(usage, gateClassifierModel.modelId, "gate");
  costTracker?.record(annotated);

  const trace = getActiveTrace();
  if (trace) {
    trace.logLlmCall("gate", { model: gateClassifierModel.modelId, prompt }, object, usage);
  }

  const callUsage = [annotated];

  const signalMap = new Map(questionSignals.map(qs => [qs.question.id, qs]));
  const validIds = new Set(questionSignals.map(qs => qs.question.id));

  const validDecisions = object.decisions.filter(d => validIds.has(d.questionId));

  const missingIds = [...validIds].filter(id => !validDecisions.some(d => d.questionId === id));
  for (const id of missingIds) {
    validDecisions.push({ questionId: id, retrieve: true, reason: "no LLM decision — defaulting to retrieve" });
  }

  let gateScores: GateScore[] = validDecisions.map(d => ({
    questionId: d.questionId,
    retrieve: d.retrieve,
    gapCount: signalMap.get(d.questionId)?.gapCount ?? 0,
    confidenceSpread: signalMap.get(d.questionId)?.confidenceSpread ?? 0,
    reason: d.reason,
  }));

  const retrieveCount = gateScores.filter(s => s.retrieve).length;
  if (retrieveCount > state.budgetRemaining) {
    const sorted = gateScores
      .filter(s => s.retrieve)
      .sort((a, b) => b.gapCount - a.gapCount);
    const keepIds = new Set(sorted.slice(0, state.budgetRemaining).map(s => s.questionId));
    gateScores = gateScores.map(s =>
      s.retrieve && !keepIds.has(s.questionId)
        ? { ...s, retrieve: false, reason: "clamped — budget insufficient" }
        : s
    );
  }

  // Fold in the zero-cost-resolved questions (diminishing + contention, all retrieve:false) so the
  // report and the questions map below see them alongside the LLM gate's decisions.
  gateScores = [...gateScores, ...zeroCostResolved];

  const continueLoop = gateScores.some(d => d.retrieve);

  if (!continueLoop) {
    getActiveTrace()?.log("gate:converged", {
      reason: "gate-decided-no-retrieve",
      loopIteration: state.loopIteration,
      budgetRemaining: state.budgetRemaining,
    });
    return { state: { ...state, converged: true }, continueLoop: false, usage: callUsage, gateScores };
  }

  const questions = state.questions.map(q => {
    const score = gateScores.find(s => s.questionId === q.id);
    return score && !score.retrieve ? { ...q, resolved: true } : q;
  });

  return {
    state: { ...state, questions, loopIteration: state.loopIteration + 1 },
    continueLoop: true,
    usage: callUsage,
    gateScores,
  };
}
