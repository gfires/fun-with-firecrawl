import { describe, it, expect, vi, type Mock } from "vitest";
import { diminishingReturns, allocateBudget } from "@/lib/orchestration/gate";
import { LOOP_CONFIDENCE_EPSILON } from "@/lib/params";
import { fakeGenResult, assertNoLlmCalls } from "../helpers/mock-ai";
import type { ResearchStateT, Question } from "@/lib/schemas/state";
import { fallbackBrief } from "@/lib/schemas/brief";
import type { AgentRoleT, Claim } from "@/lib/schemas/claim";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn() };
});

function q(id: string, overrides: Partial<Question> = {}): Question {
  return { id, text: `q ${id}`, category: "cat", confidence: 0, resolved: false, ...overrides };
}

function claim(
  role: AgentRoleT,
  loopIteration: number,
  confidence: number,
  gaps: number,
  overrides: Partial<Claim> = {},
): Claim {
  return {
    id: `q1:${role}:${loopIteration}`,
    questionId: "q1",
    agentRole: role,
    conclusion: `${role} take`,
    confidence,
    stance: "insufficient",
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingEvidence: Array.from({ length: gaps }, (_, i) => `gap ${i}`),
    loopIteration,
    debateRound: 1,
    responses: [],
    ...overrides,
  };
}

function stateOf(over: Partial<ResearchStateT>): ResearchStateT {
  return {
    topic: "widgets",
    researchBrief: fallbackBrief("widgets"),
    questions: [q("q1")],
    evidence: [],
    claims: [],
    loopIteration: 1,
    newEvidenceCount: 5,
    budgetRemaining: 50,
    budgetSpent: 0,
    firecrawlCalls: 0,
    firecrawlCredits: 0,
    converged: false,
    llmCalls: [],
    searchedQueries: [],
    gateScores: [],
    digests: {},
    debateTranscripts: {},
    retrievalMode: "coded",
    answer: "",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Pure diminishingReturns helper
// ---------------------------------------------------------------------------

describe("diminishingReturns", () => {
  it("flat confidence (< epsilon) and same/greater gap count → true", () => {
    const claims = [
      claim("historian", 0, 0.6, 3),
      claim("historian", 1, 0.62, 3),
    ];
    expect(diminishingReturns(claims, LOOP_CONFIDENCE_EPSILON)).toBe(true);
  });

  it("confidence rose by more than epsilon → false (retrieval helped)", () => {
    const claims = [
      claim("historian", 0, 0.6, 3),
      claim("historian", 1, 0.8, 3),
    ];
    expect(diminishingReturns(claims, LOOP_CONFIDENCE_EPSILON)).toBe(false);
  });

  it("gap count strictly decreased → false, even if confidence is flat", () => {
    const claims = [
      claim("historian", 0, 0.6, 3),
      claim("historian", 1, 0.6, 2),
    ];
    expect(diminishingReturns(claims, LOOP_CONFIDENCE_EPSILON)).toBe(false);
  });

  it("fewer than two debated loops → false", () => {
    const claims = [
      claim("historian", 0, 0.6, 3),
      claim("operator", 0, 0.7, 2),
    ];
    expect(diminishingReturns(claims, LOOP_CONFIDENCE_EPSILON)).toBe(false);
  });

  it("confidence dropped and gaps unchanged → true", () => {
    const claims = [
      claim("historian", 0, 0.7, 3),
      claim("historian", 1, 0.5, 3),
    ];
    expect(diminishingReturns(claims, LOOP_CONFIDENCE_EPSILON)).toBe(true);
  });

  it("uses the two most recent loops when a loop was skipped (2 vs 0)", () => {
    // Loop 2 improved sharply over loop 0; if the helper compared 2 vs a phantom loop 1
    // it could misfire. Only loops 0 and 2 have claims → compare those.
    const claims = [
      claim("historian", 0, 0.5, 3),
      claim("historian", 2, 0.9, 3),
    ];
    expect(diminishingReturns(claims, LOOP_CONFIDENCE_EPSILON)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration in allocateBudget (mocked, zero-LLM path)
// ---------------------------------------------------------------------------

describe("allocateBudget — diminishing-returns shut-off", () => {
  it("resolves a flat/persistent-gap question with no LLM call and converges", async () => {
    const { generateText } = await import("ai");
    (generateText as Mock).mockReset();
    (generateText as Mock).mockResolvedValue(fakeGenResult({ decisions: [] }));

    const result = await allocateBudget(
      stateOf({
        loopIteration: 1,
        claims: [
          claim("historian", 0, 0.6, 2),
          claim("historian", 1, 0.62, 2),
        ],
      }),
    );

    expect(result.continueLoop).toBe(false);
    expect(result.state.converged).toBe(true);
    expect(result.usage).toEqual([]);
    expect(result.gateScores).toHaveLength(1);
    expect(result.gateScores[0].questionId).toBe("q1");
    expect(result.gateScores[0].retrieve).toBe(false);
    expect(result.gateScores[0].reason).toContain("diminishing returns");
    assertNoLlmCalls();
  });

  it("a still-improving question is NOT short-circuited and reaches the LLM gate", async () => {
    const { generateText } = await import("ai");
    (generateText as Mock).mockReset();
    (generateText as Mock).mockResolvedValue(
      fakeGenResult({ decisions: [{ questionId: "q1", retrieve: true, reason: "still gappy" }] }),
    );

    const result = await allocateBudget(
      stateOf({
        loopIteration: 1,
        claims: [
          claim("historian", 0, 0.5, 3),
          claim("historian", 1, 0.8, 3),
        ],
      }),
    );

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result.continueLoop).toBe(true);
    expect(result.gateScores.some(s => s.questionId === "q1" && s.retrieve)).toBe(true);
  });

  it("loop 0 (first pass) never fires diminishing even with one loop of claims", async () => {
    const { generateText } = await import("ai");
    (generateText as Mock).mockReset();
    (generateText as Mock).mockResolvedValue(
      fakeGenResult({ decisions: [{ questionId: "q1", retrieve: true, reason: "first pass" }] }),
    );

    const result = await allocateBudget(
      stateOf({
        loopIteration: 0,
        claims: [claim("historian", 0, 0.6, 2)],
      }),
    );

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result.continueLoop).toBe(true);
  });
});
