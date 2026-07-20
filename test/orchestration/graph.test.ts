import { describe, it, expect } from "vitest";
import { compileResearchGraph, synthesizeReport, computeRecursionLimit, resultsPerQuestionForLoop, routeAfterGate } from "@/lib/orchestration/graph";
import { MAX_LOOP_ITERATIONS } from "@/lib/params";
import { RESULTS_PER_QUESTION, RECON_RESULTS_PER_QUESTION } from "@/lib/evidence/config";
import { accumulate } from "@/lib/schemas/state";
import { fallbackBrief } from "@/lib/schemas/brief";
import type { ResearchStateT, Question } from "@/lib/schemas/state";
import type { Evidence } from "@/lib/schemas/evidence";
import type { Claim } from "@/lib/schemas/claim";

/** Minimal Question factory for tests. */
function q(id: string, overrides: Partial<Question> = {}): Question {
  return { id, text: `q ${id}`, category: "cat", confidence: 0, resolved: false, ...overrides };
}

/** Minimal Claim factory — only the fields synthesizeReport reads matter here. */
function claim(questionId: string, confidence: number): Claim {
  return {
    id: `${questionId}:c${confidence}`,
    questionId,
    agentRole: "historian",
    conclusion: "…",
    confidence,
    stance: "insufficient",
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingEvidence: [],
    loopIteration: 0,
    debateRound: 0,
    responses: [],
  };
}

/** Assemble a ResearchStateT literal; synthesizeReport only reads, so a plain object is fine. */
function stateOf(over: Partial<ResearchStateT>): ResearchStateT {
  return {
    topic: "widgets market",
    researchBrief: fallbackBrief("widgets market"),
    questions: [],
    evidence: [],
    claims: [],
    loopIteration: 0,
    budgetRemaining: 0,
    budgetSpent: 0,
    converged: false,
    convergedReason: null,
    searchedQueries: [],
    answer: "",
    debateTranscripts: {},
    ...over,
  } as ResearchStateT;
}

describe("computeRecursionLimit", () => {
  it("exceeds LangGraph's default of 25 at the max loop count", () => {
    // A 5-loop run structurally needs ~25 supersteps; the default limit of 25 must be cleared.
    expect(computeRecursionLimit(5)).toBeGreaterThan(25);
  });

  it("is strictly monotonic in maxLoops", () => {
    for (let n = 0; n < 8; n++) {
      expect(computeRecursionLimit(n + 1)).toBeGreaterThan(computeRecursionLimit(n));
    }
  });

  it("[REGRESSION] comfortably clears a full MAX_LOOP_ITERATIONS run's superstep count (3/loop)", () => {
    // Front matter (intake, decompose, initial retrieve/debate/gate) + recommend = 6, then 3
    // supersteps per extra loop. The limit must sit strictly above that so a full run never trips it.
    const neededSupersteps = 6 + 3 * MAX_LOOP_ITERATIONS;
    expect(computeRecursionLimit(MAX_LOOP_ITERATIONS)).toBeGreaterThan(neededSupersteps);
  });
});

describe("routeAfterGate [REGRESSION]", () => {
  const routeState = (over: Partial<ResearchStateT>): ResearchStateT =>
    stateOf({ converged: false, budgetRemaining: 10, ...over });

  it("loops back to retrieve while not converged and budget remains", () => {
    expect(routeAfterGate(routeState({ converged: false, budgetRemaining: 10 }))).toBe("retrieve");
  });

  it("routes to recommend once converged", () => {
    expect(routeAfterGate(routeState({ converged: true, budgetRemaining: 10 }))).toBe("recommend");
  });

  it("routes to recommend when budget is exhausted, even if not converged (budgetRemaining > 0 guard)", () => {
    expect(routeAfterGate(routeState({ converged: false, budgetRemaining: 0 }))).toBe("recommend");
    expect(routeAfterGate(routeState({ converged: false, budgetRemaining: -5 }))).toBe("recommend");
  });
});

describe("resultsPerQuestionForLoop", () => {
  it("scrapes the shallow recon depth on loop 0", () => {
    // Loop 0 is reconnaissance — fewer results per query than the later targeted passes.
    expect(resultsPerQuestionForLoop(0)).toBe(RECON_RESULTS_PER_QUESTION);
  });

  it("scrapes the full depth on every later, gap-targeted pass", () => {
    for (const loop of [1, 2, 5]) {
      expect(resultsPerQuestionForLoop(loop)).toBe(RESULTS_PER_QUESTION);
    }
  });

  it("keeps recon at or above the grounding floor of 3, and below full depth", () => {
    // The floor guards the "historian confabulation" bug; recon must still be shallower than full.
    expect(RECON_RESULTS_PER_QUESTION).toBeGreaterThanOrEqual(3);
    expect(RECON_RESULTS_PER_QUESTION).toBeLessThan(RESULTS_PER_QUESTION);
  });
});

describe("synthesizeReport", () => {
  it("averages committee claim confidences per question", () => {
    const state = stateOf({
      questions: [q("q1"), q("q2")],
      claims: [claim("q1", 0.4), claim("q1", 0.8), claim("q2", 0.5)],
    });
    const report = synthesizeReport(state);
    const q1 = report.questions.find((r) => r.question.id === "q1")!;
    const q2 = report.questions.find((r) => r.question.id === "q2")!;
    expect(q1.confidence).toBeCloseTo(0.6, 5); // (0.4 + 0.8) / 2
    expect(q2.confidence).toBeCloseTo(0.5, 5);
    expect(q1.claims).toHaveLength(2);
  });

  it("falls back to the running question confidence when undebated", () => {
    const state = stateOf({ questions: [q("q1", { confidence: 0.33 })], claims: [] });
    const report = synthesizeReport(state);
    expect(report.questions[0].confidence).toBeCloseTo(0.33, 5);
    expect(report.questions[0].claims).toHaveLength(0);
  });

  it("collects only unresolved questions", () => {
    const state = stateOf({
      questions: [q("q1", { resolved: true }), q("q2"), q("q3")],
    });
    const report = synthesizeReport(state);
    expect(report.unresolvedQuestions.map((x) => x.id)).toEqual(["q2", "q3"]);
  });

  it("passes evidence and claims through as the evidence graph", () => {
    const evidence: Evidence[] = [
      {
        id: "e1",
        url: "https://example.com",
        domain: "example.com",
        title: "t",
        snippet: "s",
        content: "",
        sourceQuery: "widgets",
        loopIteration: 0,
        contentHash: "h",
      },
    ];
    const claims = [claim("q1", 0.7)];
    const report = synthesizeReport(stateOf({ questions: [q("q1")], evidence, claims }));
    expect(report.evidence).toBe(evidence);
    expect(report.claims).toBe(claims);
    expect(report.topic).toBe("widgets market");
  });
});

describe("budget reducer (accumulate)", () => {
  it("seeds the initial budget as a delta onto the default of 0", () => {
    // runGraph invokes with { budgetRemaining: TOTAL_RETRIEVAL_BUDGET }; the reducer
    // treats that as a delta added to default() = 0, so the seed survives.
    expect(accumulate(0, 80)).toBe(80);
  });

  it("accumulates a spend delta from retrieve", () => {
    // retrieve returns budgetRemaining: -totalCredits, budgetSpent: +totalCredits.
    expect(accumulate(80, -25)).toBe(55); // remaining
    expect(accumulate(0, 25)).toBe(25); // spent
  });

  it("is order-independent — two same-superstep deltas can't lose an update", () => {
    // The whole point of the additive reducer: a replace reducer would drop one of
    // these (last-write-wins). Accumulation commutes, so order doesn't matter.
    const forward = accumulate(accumulate(80, -25), -30);
    const reverse = accumulate(accumulate(80, -30), -25);
    expect(forward).toBe(25);
    expect(reverse).toBe(25);
  });

  it("accumulates spend across multiple retrieve loops", () => {
    let spent = 0;
    for (const delta of [25, 12, 18]) spent = accumulate(spent, delta);
    expect(spent).toBe(55);
  });
});

describe("compileResearchGraph", () => {
  it("compiles to an invokable graph", () => {
    const graph = compileResearchGraph();
    expect(typeof graph.invoke).toBe("function");
    // A checkpointer is wired in, enabling state history / time-travel.
    expect(typeof graph.getState).toBe("function");
  });
});
