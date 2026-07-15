import { describe, it, expect } from "vitest";
import {
  decisiveStances,
  hasGenuineDisagreement,
  committeeStance,
  debateMovement,
  directedChallenges,
  renderTranscript,
  extractContentions,
  type DebateRound,
} from "@/lib/orchestration/debate";
import { DEBATE_CONFIDENCE_EPSILON } from "@/lib/params";
import type { AgentRoleT, Claim, ClaimStanceT, DebateResponse } from "@/lib/schemas/claim";

function claim(role: AgentRoleT, overrides: Partial<Claim> = {}): Claim {
  return {
    id: `q1:${role}:0`,
    questionId: "q1",
    agentRole: role,
    conclusion: `${role} conclusion`,
    confidence: 0.7,
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

/** Build a claim carrying an ARBITRARY stance value — proves the detector is position-general. */
function stanced(role: AgentRoleT, stance: string): Claim {
  return claim(role, { stance: stance as ClaimStanceT });
}

function resp(targetRole: AgentRoleT, stance: DebateResponse["stance"], point = "p"): DebateResponse {
  return { targetRole, stance, point };
}

describe("decisiveStances", () => {
  it("returns the set of stances present, EXCLUDING the 'insufficient' abstention", () => {
    const claims = [
      stanced("historian", "supports"),
      stanced("operator", "opposes"),
      stanced("investor", "insufficient"),
      stanced("skeptic", "supports"),
    ];
    expect(decisiveStances(claims)).toEqual(new Set(["supports", "opposes"]));
  });

  it("is empty when every role abstains", () => {
    const claims = [stanced("historian", "insufficient"), stanced("operator", "insufficient")];
    expect(decisiveStances(claims).size).toBe(0);
  });

  it("is empty for no claims", () => {
    expect(decisiveStances([]).size).toBe(0);
  });
});

describe("hasGenuineDisagreement", () => {
  it("true when two decisive stances are present (supports + opposes)", () => {
    const claims = [
      stanced("historian", "supports"),
      stanced("operator", "opposes"),
      stanced("investor", "insufficient"),
      stanced("skeptic", "insufficient"),
    ];
    expect(hasGenuineDisagreement(claims)).toBe(true);
  });

  it("false when only one decisive stance is present, others abstain (decision 3)", () => {
    const claims = [
      stanced("historian", "supports"),
      stanced("operator", "supports"),
      stanced("investor", "insufficient"),
      stanced("skeptic", "insufficient"),
    ];
    expect(hasGenuineDisagreement(claims)).toBe(false);
  });

  it("false when all roles abstain (shared uncertainty, not disagreement)", () => {
    const claims = [
      stanced("historian", "insufficient"),
      stanced("operator", "insufficient"),
      stanced("investor", "insufficient"),
      stanced("skeptic", "insufficient"),
    ];
    expect(hasGenuineDisagreement(claims)).toBe(false);
  });

  it("false when the whole committee agrees on one decisive stance", () => {
    const claims = [
      stanced("historian", "supports"),
      stanced("operator", "supports"),
      stanced("investor", "supports"),
      stanced("skeptic", "supports"),
    ];
    expect(hasGenuineDisagreement(claims)).toBe(false);
  });

  it("true on an id-clash EVEN when stances agree (they read the same evidence oppositely)", () => {
    // Both 'supports', but the historian's supporting id is the skeptic's contradicting id.
    const claims = [
      claim("historian", { stance: "supports", supportingEvidenceIds: ["e5"] }),
      claim("skeptic", { stance: "supports", contradictingEvidenceIds: ["e5"] }),
    ];
    expect(decisiveStances(claims).size).toBe(1); // stances alone would say "no disagreement"
    expect(hasGenuineDisagreement(claims)).toBe(true); // …but the id-clash catches it
  });

  it("false with no claims", () => {
    expect(hasGenuineDisagreement([])).toBe(false);
  });

  it("generality: a 4-VALUE stance set with ≥2 decisive is disagreement (enum-agnostic)", () => {
    // A future richer taxonomy only GROWS the enum; the detector must need no edit.
    const claims = [
      stanced("historian", "strongly-supports"),
      stanced("operator", "leans-opposes"),
      stanced("investor", "insufficient"),
      stanced("skeptic", "neutral"),
    ];
    expect(hasGenuineDisagreement(claims)).toBe(true);
  });
});

describe("committeeStance", () => {
  it("'contested' when ≥2 decisive stances are present", () => {
    const claims = [
      stanced("historian", "supports"),
      stanced("operator", "opposes"),
      stanced("investor", "insufficient"),
      stanced("skeptic", "insufficient"),
    ];
    expect(committeeStance(claims)).toBe("contested");
  });

  it("'insufficient' when one lean plus any abstention — not enough to call (decision 3)", () => {
    expect(
      committeeStance([
        stanced("historian", "supports"),
        stanced("operator", "supports"),
        stanced("investor", "insufficient"),
        stanced("skeptic", "insufficient"),
      ]),
    ).toBe("insufficient");
    expect(
      committeeStance([
        stanced("historian", "opposes"),
        stanced("operator", "insufficient"),
      ]),
    ).toBe("insufficient");
  });

  it("the single decisive stance when the committee is UNANIMOUS with no abstention", () => {
    expect(
      committeeStance([
        stanced("historian", "supports"),
        stanced("operator", "supports"),
        stanced("investor", "supports"),
        stanced("skeptic", "supports"),
      ]),
    ).toBe("supports");
    expect(
      committeeStance([stanced("historian", "opposes"), stanced("operator", "opposes")]),
    ).toBe("opposes");
  });

  it("'insufficient' when every role abstains, or there are no claims", () => {
    expect(
      committeeStance([stanced("historian", "insufficient"), stanced("operator", "insufficient")]),
    ).toBe("insufficient");
    expect(committeeStance([])).toBe("insufficient");
  });
});

describe("debateMovement", () => {
  const round = (r: number, claims: Claim[]): DebateRound => ({ round: r, claims });

  it("converged when nothing moves and no fresh rebuttal appears", () => {
    const prev = round(1, [claim("historian", { confidence: 0.7, supportingEvidenceIds: ["e1"] })]);
    const next = round(2, [claim("historian", { confidence: 0.72, supportingEvidenceIds: ["e1"] })]);
    const m = debateMovement(prev, next, DEBATE_CONFIDENCE_EPSILON);
    expect(m).toEqual({ moved: 0, newRebuttals: 0, converged: true });
  });

  it("non-converged on a confidence jump beyond epsilon", () => {
    const prev = round(1, [claim("historian", { confidence: 0.5 })]);
    const next = round(2, [claim("historian", { confidence: 0.8 })]);
    const m = debateMovement(prev, next, DEBATE_CONFIDENCE_EPSILON);
    expect(m.moved).toBe(1);
    expect(m.converged).toBe(false);
  });

  it("non-converged on an evidence id-set change with flat confidence", () => {
    const prev = round(1, [claim("operator", { confidence: 0.7, supportingEvidenceIds: ["e1"] })]);
    const next = round(2, [claim("operator", { confidence: 0.7, supportingEvidenceIds: ["e1", "e2"] })]);
    const m = debateMovement(prev, next, DEBATE_CONFIDENCE_EPSILON);
    expect(m.moved).toBe(1);
    expect(m.converged).toBe(false);
  });

  it("counts a fresh rebuttal pair by pair identity, but a rebuttal WITHOUT movement still converges", () => {
    // A fresh rebuttal edge is reported in newRebuttals, but on its own (no confidence/id-set move)
    // it no longer keeps the debate alive: roles restating disagreement over frozen evidence is the
    // churn we exit on. Convergence keys on `moved`, not `newRebuttals`.
    const prev = round(1, [claim("investor", { confidence: 0.6, responses: [] })]);
    const next = round(2, [claim("investor", { confidence: 0.6, responses: [resp("skeptic", "rebut", "different words")] })]);
    const m = debateMovement(prev, next, DEBATE_CONFIDENCE_EPSILON);
    expect(m.newRebuttals).toBe(1);
    expect(m.moved).toBe(0);
    expect(m.converged).toBe(true);
  });

  it("does not count a rebuttal pair that already existed (ignores changed point text)", () => {
    const prev = round(1, [claim("investor", { responses: [resp("skeptic", "rebut", "old text")] })]);
    const next = round(2, [claim("investor", { responses: [resp("skeptic", "rebut", "reworded text")] })]);
    const m = debateMovement(prev, next, DEBATE_CONFIDENCE_EPSILON);
    expect(m.newRebuttals).toBe(0);
  });
});

describe("directedChallenges", () => {
  it("returns only the responses aimed at the given role", () => {
    const latest: DebateRound = {
      round: 1,
      claims: [
        claim("historian", { responses: [resp("skeptic", "rebut"), resp("investor", "extend")] }),
        claim("operator", { responses: [resp("skeptic", "concede")] }),
        claim("skeptic", { responses: [resp("historian", "rebut")] }),
      ],
    };
    const forSkeptic = directedChallenges(latest, "skeptic");
    expect(forSkeptic).toHaveLength(2);
    expect(forSkeptic.every((c) => c.response.targetRole === "skeptic")).toBe(true);
    // each challenge is tagged with the peer that raised it (historian rebut, operator concede)
    expect(forSkeptic.map((c) => c.from).sort()).toEqual(["historian", "operator"]);
  });
});

describe("renderTranscript", () => {
  it("renders rounds and claims deterministically in canonical role order", () => {
    const rounds: DebateRound[] = [
      {
        round: 0,
        claims: [
          // deliberately out of canonical order to prove sorting
          claim("skeptic", { confidence: 0.4, contradictingEvidenceIds: ["e2"] }),
          claim("historian", { confidence: 0.6, supportingEvidenceIds: ["e1"] }),
        ],
      },
      {
        round: 1,
        claims: [claim("historian", { confidence: 0.65, responses: [resp("skeptic", "rebut", "cite e1")] })],
      },
    ];
    const text = renderTranscript(rounds);
    expect(text).toContain("Round 0:");
    expect(text).toContain("Round 1:");
    // historian sorts before skeptic within round 0
    expect(text.indexOf("[historian]")).toBeLessThan(text.indexOf("[skeptic]"));
    expect(text).toContain("support[e1]/contra[]");
    expect(text).toContain("→ rebut @skeptic: cite e1");
    // byte-stable across calls
    expect(renderTranscript(rounds)).toBe(text);
  });
});

describe("extractContentions", () => {
  it("pairs an unresolved rebuttal and classifies it interpretive when no gap is named", () => {
    const finalClaims = [
      claim("historian", { responses: [resp("skeptic", "rebut", "precedent holds")] }),
      claim("skeptic", { responses: [] }), // no concede back → unresolved
    ];
    const cs = extractContentions("q1", finalClaims);
    expect(cs).toHaveLength(1);
    expect(cs[0].roles).toEqual(["historian", "skeptic"]);
    expect(cs[0].type).toBe("interpretive");
  });

  it("does not pair a rebuttal that the other role conceded", () => {
    const finalClaims = [
      claim("historian", { responses: [resp("skeptic", "rebut")] }),
      claim("skeptic", { responses: [resp("historian", "concede")] }),
    ];
    expect(extractContentions("q1", finalClaims)).toEqual([]);
  });

  it("pairs an evidence id-clash and marks it evidential when a gap is named", () => {
    const finalClaims = [
      claim("operator", { supportingEvidenceIds: ["e5"], missingEvidence: ["need vendor-independent source"] }),
      claim("investor", { contradictingEvidenceIds: ["e5"] }),
    ];
    const cs = extractContentions("q1", finalClaims);
    expect(cs).toHaveLength(1);
    expect(cs[0].roles).toEqual(["operator", "investor"]);
    expect(cs[0].type).toBe("evidential");
    expect(cs[0].note).toContain("e5");
  });

  it("returns nothing when the committee agrees", () => {
    const finalClaims = [
      claim("historian", { supportingEvidenceIds: ["e1"] }),
      claim("operator", { supportingEvidenceIds: ["e1"] }),
    ];
    expect(extractContentions("q1", finalClaims)).toEqual([]);
  });
});
