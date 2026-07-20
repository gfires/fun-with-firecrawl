import { describe, it, expect } from "vitest";
import { reduce, initialResearchState, normalizeGateScore, deriveConvergedReason } from "@/lib/useResearchStream";
import type { GateScore } from "@/lib/research-events";
import type { Claim } from "@/lib/schemas/claim";
import type { Question, ResearchStateT } from "@/lib/schemas/state";
import { computeRunMechanics } from "@/lib/orchestration/mechanics";
import { rollupTokens } from "@/lib/orchestration/eval";

function makeQuestion(id: string): Question {
  return { id, text: `text ${id}`, category: "cat", confidence: 0, resolved: false };
}

function makeClaim(overrides: Partial<Claim> & { agentRole: Claim["agentRole"]; questionId: string }): Claim {
  return {
    id: `claim-${overrides.agentRole}-${overrides.questionId}`,
    conclusion: "conclusion",
    confidence: 0.5,
    stance: "insufficient",
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingEvidence: [],
    loopIteration: 0,
    debateRound: 0,
    responses: [],
    ...overrides,
  };
}

describe("reduce — debateOutcome / debateRounds (board spec §3b)", () => {
  it("decompose:done seeds every question pending with 0 rounds", () => {
    const s = reduce(initialResearchState, {
      type: "decompose:done",
      questions: [makeQuestion("q1"), makeQuestion("q2")],
      usage: { model: "", promptTokens: 0, completionTokens: 0, label: "decompose", costUsd: 0 },
    });
    expect(s.questions.every((q) => q.debateOutcome === "pending" && q.debateRounds === 0)).toBe(true);
  });

  it("debate:begin marks questions in questionIds as debated, others as skipped", () => {
    let s = reduce(initialResearchState, {
      type: "decompose:done",
      questions: [makeQuestion("q1"), makeQuestion("q2")],
      usage: { model: "", promptTokens: 0, completionTokens: 0, label: "decompose", costUsd: 0 },
    });
    s = reduce(s, { type: "debate:begin", loopIteration: 0, questionIds: ["q1"] });

    const q1 = s.questions.find((q) => q.question.id === "q1")!;
    const q2 = s.questions.find((q) => q.question.id === "q2")!;
    expect(q1.debateOutcome).toBe("debated");
    expect(q1.status).toBe("debating");
    expect(q2.debateOutcome).toBe("skipped");
    expect(q2.status).not.toBe("debating");
  });

  it("does not touch an already-resolved question at debate:begin", () => {
    let s = reduce(initialResearchState, {
      type: "decompose:done",
      questions: [makeQuestion("q1")],
      usage: { model: "", promptTokens: 0, completionTokens: 0, label: "decompose", costUsd: 0 },
    });
    s = {
      ...s,
      questions: s.questions.map((q) => ({ ...q, status: "resolved", question: { ...q.question, resolved: true } })),
    };
    s = reduce(s, { type: "debate:begin", loopIteration: 1, questionIds: [] });
    const q1 = s.questions.find((q) => q.question.id === "q1")!;
    expect(q1.status).toBe("resolved");
    expect(q1.debateOutcome).toBe("pending");
  });

  it("debate:claim tracks the max debateRound seen for a question", () => {
    let s = reduce(initialResearchState, {
      type: "decompose:done",
      questions: [makeQuestion("q1")],
      usage: { model: "", promptTokens: 0, completionTokens: 0, label: "decompose", costUsd: 0 },
    });
    s = reduce(s, { type: "debate:claim", claim: makeClaim({ agentRole: "historian", questionId: "q1", debateRound: 0 }) });
    s = reduce(s, { type: "debate:claim", claim: makeClaim({ agentRole: "historian", questionId: "q1", debateRound: 2 }) });
    s = reduce(s, { type: "debate:claim", claim: makeClaim({ agentRole: "operator", questionId: "q1", debateRound: 1 }) });

    const q1 = s.questions.find((q) => q.question.id === "q1")!;
    expect(q1.debateRounds).toBe(2);
  });
});

describe("reduce — debate:opening / debate:round (board spec §3c)", () => {
  it("accumulates openings for the same question within one loop", () => {
    let s = initialResearchState;
    s = reduce(s, { type: "debate:opening", claim: makeClaim({ agentRole: "historian", questionId: "q1", loopIteration: 0 }) });
    s = reduce(s, { type: "debate:opening", claim: makeClaim({ agentRole: "operator", questionId: "q1", loopIteration: 0 }) });
    expect(s.openingsByQuestion.q1).toHaveLength(2);
  });

  it("replaces (not appends) once a new loop's openings arrive", () => {
    let s = initialResearchState;
    s = reduce(s, { type: "debate:opening", claim: makeClaim({ agentRole: "historian", questionId: "q1", loopIteration: 0 }) });
    s = reduce(s, { type: "debate:opening", claim: makeClaim({ agentRole: "operator", questionId: "q1", loopIteration: 0 }) });
    s = reduce(s, { type: "debate:opening", claim: makeClaim({ agentRole: "historian", questionId: "q1", loopIteration: 1 }) });
    expect(s.openingsByQuestion.q1).toHaveLength(1);
    expect(s.openingsByQuestion.q1[0].loopIteration).toBe(1);
  });

  it("accumulates conversational rounds for the same question within one loop", () => {
    let s = initialResearchState;
    s = reduce(s, {
      type: "debate:round",
      questionId: "q1",
      round: 1,
      claims: [makeClaim({ agentRole: "historian", questionId: "q1", loopIteration: 0, debateRound: 1 })],
    });
    s = reduce(s, {
      type: "debate:round",
      questionId: "q1",
      round: 2,
      claims: [makeClaim({ agentRole: "historian", questionId: "q1", loopIteration: 0, debateRound: 2 })],
    });
    expect(s.roundsByQuestion.q1).toHaveLength(2);
    expect(s.roundsByQuestion.q1.map((r) => r.round)).toEqual([1, 2]);
  });

  it("replaces rounds once a new loop's rounds arrive", () => {
    let s = initialResearchState;
    s = reduce(s, {
      type: "debate:round",
      questionId: "q1",
      round: 1,
      claims: [makeClaim({ agentRole: "historian", questionId: "q1", loopIteration: 0, debateRound: 1 })],
    });
    s = reduce(s, {
      type: "debate:round",
      questionId: "q1",
      round: 1,
      claims: [makeClaim({ agentRole: "historian", questionId: "q1", loopIteration: 1, debateRound: 1 })],
    });
    expect(s.roundsByQuestion.q1).toHaveLength(1);
    expect(s.roundsByQuestion.q1[0].claims[0].loopIteration).toBe(1);
  });
});

describe("reduce — researcherByQuestion (board spec §3d)", () => {
  it("accumulates one pass: begin -> search x2 -> read -> done", () => {
    let s = initialResearchState;
    s = reduce(s, { type: "researcher:begin", questionId: "q1", loopIteration: 0, mission: "find pricing data" });
    s = reduce(s, { type: "researcher:search", questionId: "q1", loopIteration: 0, query: "market size", hits: 10, credits: 1, capped: false });
    s = reduce(s, { type: "researcher:search", questionId: "q1", loopIteration: 0, query: "market size again", hits: 0, credits: 0, capped: true });
    s = reduce(s, { type: "researcher:read", questionId: "q1", loopIteration: 0, stored: 3, requested: 5, hitCeiling: true });
    s = reduce(s, { type: "researcher:done", questionId: "q1", loopIteration: 0, evidenceCount: 3, searchCalls: 1 });

    const passes = s.researcherByQuestion.q1;
    expect(passes).toHaveLength(1);
    expect(passes[0].mission).toBe("find pricing data");
    expect(passes[0].searches).toHaveLength(2);
    expect(passes[0].searches[1].capped).toBe(true);
    expect(passes[0].reads).toEqual([{ stored: 3, requested: 5, hitCeiling: true }]);
    expect(passes[0].done).toEqual({ evidenceCount: 3, searchCalls: 1 });
  });

  it("opens a new pass per begin, updating only the latest", () => {
    let s = initialResearchState;
    s = reduce(s, { type: "researcher:begin", questionId: "q1", loopIteration: 0, mission: "m0" });
    s = reduce(s, { type: "researcher:done", questionId: "q1", loopIteration: 0, evidenceCount: 1, searchCalls: 1 });
    s = reduce(s, { type: "researcher:begin", questionId: "q1", loopIteration: 1, mission: "m1" });
    s = reduce(s, { type: "researcher:search", questionId: "q1", loopIteration: 1, query: "q", hits: 5, credits: 1, capped: false });

    const passes = s.researcherByQuestion.q1;
    expect(passes).toHaveLength(2);
    expect(passes[0].done).toEqual({ evidenceCount: 1, searchCalls: 1 });
    expect(passes[1].mission).toBe("m1");
    expect(passes[1].searches).toHaveLength(1);
    expect(passes[1].done).toBeUndefined();
  });
});

const gs = (over: Partial<GateScore>): GateScore => ({
  questionId: "q1",
  retrieve: false,
  gapCount: 0,
  confidenceSpread: 0,
  reason: "",
  ...over,
});

describe("normalizeGateScore / deriveConvergedReason (backfill for pre-field traces)", () => {
  it("honors an explicit truncated flag (new runs) without touching it", () => {
    expect(normalizeGateScore(gs({ truncated: true, reason: "anything" })).truncated).toBe(true);
    expect(normalizeGateScore(gs({ truncated: false, reason: "would retrieve, but converged (x)" })).truncated).toBe(false);
  });

  it("derives truncated from a cost-headroom / clamp reason string (old fixtures)", () => {
    expect(normalizeGateScore(gs({ reason: "evidential contention — would retrieve, but converged (cost-headroom)" })).truncated).toBe(true);
    expect(normalizeGateScore(gs({ reason: "clamped — budget insufficient" })).truncated).toBe(true);
  });

  it("does NOT flag a genuine resolve (fault line / settled) as truncated", () => {
    expect(normalizeGateScore(gs({ reason: "committee split with no surviving contention — reporting the fault line" })).truncated).toBe(false);
    expect(normalizeGateScore(gs({ reason: "committee reached a unanimous supports — settled" })).truncated).toBe(false);
  });

  it("prefers the event's own convergedReason when present", () => {
    expect(deriveConvergedReason({ convergedReason: "max-loops", continueLoop: false, gateScores: [] })).toBe("max-loops");
  });

  it("derives the reason from a score's 'converged (X)' string when the field is absent", () => {
    expect(
      deriveConvergedReason({ continueLoop: false, gateScores: [gs({ reason: "named evidence gap — would retrieve, but converged (cost-headroom)" })] }),
    ).toBe("cost-headroom");
  });

  it("is null while the loop is still continuing", () => {
    expect(deriveConvergedReason({ continueLoop: true, gateScores: [gs({ reason: "would retrieve, but converged (cost-headroom)" })] })).toBeNull();
  });
});

describe("reduce — research:mechanics (board spec §6 Phase 5)", () => {
  it("sets state.mechanics from the terminal event, read-only from computeRunMechanics", () => {
    const mechanics = computeRunMechanics([], {} as ResearchStateT, rollupTokens([]));
    const s = reduce(initialResearchState, { type: "research:mechanics", mechanics });
    expect(s.mechanics).toBe(mechanics);
  });

  it("starts null before any research:mechanics event", () => {
    expect(initialResearchState.mechanics).toBeNull();
  });

  it("reconciles the header cost to the authoritative mechanics total (fixes streamed-vs-total drift)", () => {
    // The per-call stream can under-total (an old fixture missing usage events, a degraded run). The
    // mechanics receipt carries the cost tracker's authoritative rollup — snapping to it makes the
    // displayed final cost correct in live AND replay.
    let s = initialResearchState;
    s = reduce(s, {
      type: "research:usage",
      usage: { model: "m", promptTokens: 100, completionTokens: 20, label: "a", costUsd: 0.02 },
    });
    expect(s.usage.totalCostUsd).toBeCloseTo(0.02);

    const mechanics = computeRunMechanics([], {} as ResearchStateT, rollupTokens([]));
    mechanics.convergence.totalCostUsd = 0.075; // authoritative rollup > the streamed sum
    s = reduce(s, { type: "research:mechanics", mechanics });

    expect(s.usage.totalCostUsd).toBeCloseTo(0.075); // snapped to authoritative
    expect(s.usage.totalPromptTokens).toBe(100); // token counts untouched
    expect(s.usage.totalCompletionTokens).toBe(20);
  });
});
