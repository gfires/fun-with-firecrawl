import { describe, it, expect, vi, type Mock } from "vitest";
import { contentionRoute } from "@/lib/orchestration/debate";
import { allocateBudget } from "@/lib/orchestration/gate";
import { fakeGenResult, assertNoLlmCalls } from "../helpers/mock-ai";
import type { Contention, DebateRound } from "@/lib/orchestration/debate";
import type { ResearchStateT, Question } from "@/lib/schemas/state";
import { fallbackBrief } from "@/lib/schemas/brief";
import type { AgentRoleT, Claim, DebateResponse } from "@/lib/schemas/claim";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn() };
});

function contention(type: Contention["type"]): Contention {
  return { questionId: "q1", roles: ["historian", "skeptic"], type, note: "n" };
}

describe("contentionRoute", () => {
  it("routes any evidential contention to retrieve", () => {
    expect(contentionRoute([contention("interpretive"), contention("evidential")])).toBe("retrieve");
  });

  it("routes an interpretive-only set to resolve", () => {
    expect(contentionRoute([contention("interpretive")])).toBe("resolve");
  });

  it("routes an empty set (committee agreed) to resolve", () => {
    expect(contentionRoute([])).toBe("resolve");
  });

  it("returns null when there is no transcript signal at all", () => {
    expect(contentionRoute(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// gate resolve short-circuit — an interpretive-only question never calls the LLM
// ---------------------------------------------------------------------------

function q(id: string, overrides: Partial<Question> = {}): Question {
  return { id, text: `q ${id}`, category: "cat", confidence: 0, resolved: false, ...overrides };
}

function claim(role: AgentRoleT, overrides: Partial<Claim> = {}): Claim {
  return {
    id: `q1:${role}:0`,
    questionId: "q1",
    agentRole: role,
    conclusion: `${role} take`,
    confidence: 0.6,
    stance: "insufficient",
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingEvidence: [],
    loopIteration: 0,
    debateRound: 1,
    responses: [],
    ...overrides,
  };
}

function resp(targetRole: AgentRoleT, stance: DebateResponse["stance"]): DebateResponse {
  return { targetRole, stance, point: "p" };
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

describe("allocateBudget — contention resolve short-circuit", () => {
  it("resolves an interpretive-only question with no LLM gate call", async () => {
    const { generateText } = await import("ai");
    (generateText as Mock).mockReset();
    (generateText as Mock).mockResolvedValue(fakeGenResult({ decisions: [] }));

    // historian rebuts skeptic, nobody concedes, no named gap → an interpretive contention.
    const finalRound: DebateRound = {
      round: 1,
      claims: [
        claim("historian", { responses: [resp("skeptic", "rebut")] }),
        claim("skeptic", { responses: [] }),
      ],
    };
    const result = await allocateBudget(
      stateOf({ debateTranscripts: { q1: [{ round: 0, claims: [] }, finalRound] } }),
    );

    expect(result.continueLoop).toBe(false);
    expect(result.state.converged).toBe(true);
    expect(result.usage).toEqual([]);
    expect(result.gateScores).toHaveLength(1);
    expect(result.gateScores[0].retrieve).toBe(false);
    assertNoLlmCalls();
  });
});
