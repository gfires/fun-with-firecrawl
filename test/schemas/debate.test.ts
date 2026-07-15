import { describe, it, expect } from "vitest";
import {
  ClaimSchema,
  DebateResponseSchema,
  DebateTurnOutputSchema,
} from "@/lib/schemas/claim";
import { mergeTranscripts } from "@/lib/schemas/state";
import type { DebateRound } from "@/lib/orchestration/debate";

describe("DebateResponseSchema", () => {
  it("accepts a valid directed response", () => {
    const r = DebateResponseSchema.parse({
      targetRole: "investor",
      stance: "rebut",
      point: "the market-size figure is vendor marketing, cite [abc]",
    });
    expect(r.stance).toBe("rebut");
  });

  it("rejects a stance outside the enum", () => {
    expect(() =>
      DebateResponseSchema.parse({ targetRole: "investor", stance: "agree", point: "x" }),
    ).toThrow();
  });
});

describe("DebateTurnOutputSchema", () => {
  it("parses a revised claim plus structured responses", () => {
    const turn = DebateTurnOutputSchema.parse({
      conclusion: "revised in light of the skeptic",
      confidence: 0.55,
      stance: "opposes",
      supportingEvidenceIds: ["e1"],
      contradictingEvidenceIds: [],
      missingEvidence: [],
      responses: [{ targetRole: "skeptic", stance: "concede", point: "conceding on churn, cite [e2]" }],
    });
    expect(turn.responses).toHaveLength(1);
  });

  it("accepts an empty responses array (a turn that engaged no one)", () => {
    const turn = DebateTurnOutputSchema.parse({
      conclusion: "unchanged",
      confidence: 0.5,
      stance: "insufficient",
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      missingEvidence: [],
      responses: [],
    });
    expect(turn.responses).toEqual([]);
  });

  it("carries no length caps that could crash generation (long point, many responses)", () => {
    // No .min()/.max() may reach an LLM output schema — a slightly-long response must still parse.
    const many = Array.from({ length: 12 }, () => ({
      targetRole: "operator" as const,
      stance: "extend" as const,
      point: "x".repeat(5000),
    }));
    expect(() =>
      DebateTurnOutputSchema.parse({
        conclusion: "c".repeat(5000),
        confidence: 0.5,
        stance: "supports",
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        missingEvidence: [],
        responses: many,
      }),
    ).not.toThrow();
  });
});

describe("ClaimSchema debate dimension", () => {
  it("round-trips an opening claim (debateRound 0, no responses)", () => {
    const claim = ClaimSchema.parse({
      id: "q1:historian:0",
      questionId: "q1",
      agentRole: "historian",
      conclusion: "opening",
      confidence: 0.3,
      stance: "supports",
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      missingEvidence: [],
      loopIteration: 0,
      debateRound: 0,
      responses: [],
    });
    expect(claim.debateRound).toBe(0);
    expect(claim.responses).toEqual([]);
    expect(claim.stance).toBe("supports");
  });

  it("requires stance and rejects a value outside the enum", () => {
    const base = {
      id: "q1:historian:0",
      questionId: "q1",
      agentRole: "historian" as const,
      conclusion: "opening",
      confidence: 0.3,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      missingEvidence: [],
      loopIteration: 0,
      debateRound: 0,
      responses: [],
    };
    expect(() => ClaimSchema.parse({ ...base, stance: "maybe" })).toThrow();
    expect(() => ClaimSchema.parse(base)).toThrow(); // stance omitted
  });

  it("requires the debate fields (a pre-Wave-3 claim shape is rejected)", () => {
    expect(() =>
      ClaimSchema.parse({
        id: "x",
        questionId: "q1",
        agentRole: "operator",
        conclusion: "c",
        confidence: 0.5,
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        missingEvidence: [],
        loopIteration: 0,
      }),
    ).toThrow();
  });
});

describe("mergeTranscripts", () => {
  const round = (r: number): DebateRound => ({ round: r, claims: [] });

  it("replaces a question's rounds wholesale and leaves other questions untouched", () => {
    const prev = { q1: [round(0), round(1)], q2: [round(0)] };
    const next = { q1: [round(0)] }; // a fresh debate on q1 — its old transcript is discarded
    const merged = mergeTranscripts(prev, next);
    expect(merged.q1).toHaveLength(1); // replaced, not appended
    expect(merged.q2).toHaveLength(1); // untouched
  });

  it("adds a new question's transcript without disturbing existing ones", () => {
    const merged = mergeTranscripts({ q1: [round(0)] }, { q2: [round(0)] });
    expect(Object.keys(merged).sort()).toEqual(["q1", "q2"]);
  });
});
