import { describe, it, expect } from "vitest";
import {
  reconCount,
  openingResolution,
  currentCommitteeClaims,
  latestGateScoreFor,
  gateVerdict,
  scopeGateDecisionsToQuestion,
  deliberationLabel,
} from "@/lib/research/board";
import type { Claim } from "@/lib/schemas/claim";
import type { Evidence } from "@/lib/schemas/evidence";
import type { GateDecision } from "@/lib/useResearchStream";

function makeClaim(overrides: Partial<Claim> & { agentRole: Claim["agentRole"] }): Claim {
  return {
    id: `claim-${overrides.agentRole}`,
    questionId: "q1",
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

function makeEvidence(id: string, loopIteration: number): Evidence {
  return {
    id,
    url: `https://example.com/${id}`,
    domain: "example.com",
    title: id,
    snippet: "snippet",
    content: "content",
    contentHash: `hash-${id}`,
    sourceQuery: "query",
    loopIteration,
  };
}

describe("reconCount", () => {
  it("counts only loop-0 evidence", () => {
    const evidence = [makeEvidence("a", 0), makeEvidence("b", 0), makeEvidence("c", 1)];
    expect(reconCount(evidence)).toBe(2);
  });

  it("is zero for no evidence", () => {
    expect(reconCount([])).toBe(0);
  });
});

describe("openingResolution", () => {
  it("is pending with no claims", () => {
    expect(openingResolution([])).toBe("pending");
  });

  it("is agree when the committee unanimously leans one way", () => {
    const claims = [
      makeClaim({ agentRole: "historian", stance: "supports" }),
      makeClaim({ agentRole: "operator", stance: "supports" }),
    ];
    expect(openingResolution(claims)).toBe("agree");
  });

  it("is split on a genuine disagreement (2+ decisive stances)", () => {
    const claims = [
      makeClaim({ agentRole: "historian", stance: "supports" }),
      makeClaim({ agentRole: "skeptic", stance: "opposes" }),
    ];
    expect(openingResolution(claims)).toBe("split");
  });
});

describe("latestGateScoreFor / gateVerdict", () => {
  const decisions: GateDecision[] = [
    {
      loopIteration: 0,
      gateScores: [{ questionId: "q1", retrieve: true, gapCount: 1, confidenceSpread: 0.1, reason: "needs more" }],
      resolvedIds: [],
      unresolvedIds: ["q1"],
      continueLoop: true,
    },
    {
      loopIteration: 1,
      gateScores: [{ questionId: "q1", retrieve: false, gapCount: 0, confidenceSpread: 0, reason: "settled" }],
      resolvedIds: ["q1"],
      unresolvedIds: [],
      continueLoop: false,
    },
  ];

  it("finds the most recent score for a question", () => {
    const score = latestGateScoreFor(decisions, "q1");
    expect(score?.reason).toBe("settled");
  });

  it("returns undefined for a question with no score", () => {
    expect(latestGateScoreFor(decisions, "q9")).toBeUndefined();
  });

  it("verdict is pending with no score", () => {
    expect(gateVerdict(undefined, "supports")).toBe("pending");
  });

  it("verdict is retrieve when the gate wants more evidence", () => {
    expect(gateVerdict({ questionId: "q1", retrieve: true, gapCount: 1, confidenceSpread: 0, reason: "" }, "insufficient")).toBe(
      "retrieve",
    );
  });

  it("verdict is fault-line for a resolved but contested stance", () => {
    expect(gateVerdict({ questionId: "q1", retrieve: false, gapCount: 0, confidenceSpread: 0, reason: "" }, "contested")).toBe(
      "fault-line",
    );
  });

  it("verdict is settled for a resolved unanimous stance", () => {
    expect(gateVerdict({ questionId: "q1", retrieve: false, gapCount: 0, confidenceSpread: 0, reason: "" }, "supports")).toBe(
      "settled",
    );
  });

  it("verdict is limitation (not settled) for a resolved insufficient stance — no confident call was made", () => {
    expect(
      gateVerdict({ questionId: "q1", retrieve: false, gapCount: 0, confidenceSpread: 0, reason: "" }, "insufficient"),
    ).toBe("limitation");
  });

  it("verdict is truncated (NOT fault-line) when a contested question wanted retrieval but the run converged", () => {
    // The exact bug this fixes: a budget-truncated contested question must not read as a settled
    // fault line. `truncated` is checked before stance, so this returns "truncated", not "fault-line".
    expect(
      gateVerdict(
        { questionId: "q1", retrieve: false, truncated: true, gapCount: 3, confidenceSpread: 0, reason: "would retrieve, but converged (cost-headroom)" },
        "contested",
      ),
    ).toBe("truncated");
  });

  it("verdict is truncated for an insufficient question clamped for budget too", () => {
    expect(
      gateVerdict(
        { questionId: "q1", retrieve: false, truncated: true, gapCount: 2, confidenceSpread: 0, reason: "clamped — budget insufficient" },
        "insufficient",
      ),
    ).toBe("truncated");
  });
});

describe("deliberationLabel", () => {
  it("is a dash before the first debate:begin", () => {
    expect(deliberationLabel({ debateOutcome: "pending", debateRounds: 0, status: "pending" })).toBe("—");
  });

  it("reads as reused (not agreement) when the graph didn't re-run this loop", () => {
    expect(deliberationLabel({ debateOutcome: "skipped", debateRounds: 0, status: "looping" })).toMatch(/reused/);
  });

  it("reads as still-opening while the committee is mid-run with no rounds yet", () => {
    expect(deliberationLabel({ debateOutcome: "debated", debateRounds: 0, status: "debating" })).toMatch(/opening/);
  });

  it("reads as the hero 'skipped on agreement' case once the committee has finished with 0 rounds", () => {
    const label = deliberationLabel({ debateOutcome: "debated", debateRounds: 0, status: "resolved" });
    expect(label).toMatch(/unanimous/);
  });

  it("does NOT read as agreement when the unanimous skip is everyone abstaining (insufficient) — that's a gap, not a settled answer", () => {
    const label = deliberationLabel(
      { debateOutcome: "debated", debateRounds: 0, status: "resolved" },
      "insufficient",
    );
    expect(label).toMatch(/insufficient/);
    expect(label).not.toMatch(/no genuine disagreement/);
  });

  it("reads as debated N rounds once conversational rounds ran", () => {
    expect(deliberationLabel({ debateOutcome: "debated", debateRounds: 2, status: "debating" })).toBe("🗣 debated 2 rounds");
  });
});

describe("currentCommitteeClaims", () => {
  it("picks each role's latest (highest loopIteration) claim, not the full history", () => {
    const claims = [
      makeClaim({ agentRole: "historian", stance: "opposes", loopIteration: 0 }),
      makeClaim({ agentRole: "skeptic", stance: "supports", loopIteration: 0 }),
      // loop 1: the committee converged — historian flipped to agree with the skeptic
      makeClaim({ agentRole: "historian", stance: "supports", loopIteration: 1 }),
    ];
    const current = currentCommitteeClaims(claims, "q1");
    expect(current).toHaveLength(2);
    expect(current.every((c) => c.stance === "supports")).toBe(true);
  });
});

describe("scopeGateDecisionsToQuestion", () => {
  it("filters gateScores/resolvedIds/unresolvedIds down to one question", () => {
    const decisions: GateDecision[] = [
      {
        loopIteration: 0,
        gateScores: [
          { questionId: "q1", retrieve: true, gapCount: 1, confidenceSpread: 0, reason: "a" },
          { questionId: "q2", retrieve: false, gapCount: 0, confidenceSpread: 0, reason: "b" },
        ],
        resolvedIds: ["q2"],
        unresolvedIds: ["q1"],
        continueLoop: true,
      },
    ];
    const scoped = scopeGateDecisionsToQuestion(decisions, "q1");
    expect(scoped[0].gateScores).toHaveLength(1);
    expect(scoped[0].gateScores[0].questionId).toBe("q1");
    expect(scoped[0].resolvedIds).toEqual([]);
    expect(scoped[0].unresolvedIds).toEqual(["q1"]);
  });
});
