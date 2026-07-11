import { describe, it, expect } from "vitest";
import {
  latestClaimsByRole,
  buildArenaGraph,
  swimlaneCells,
} from "@/lib/research/arena";
import type { Claim } from "@/lib/schemas/claim";
import type { Evidence } from "@/lib/schemas/evidence";

function makeClaim(overrides: Partial<Claim> & { agentRole: Claim["agentRole"]; questionId: string }): Claim {
  return {
    id: `claim-${overrides.agentRole}-${overrides.questionId}-L${overrides.loopIteration ?? 0}`,
    conclusion: overrides.conclusion ?? "test conclusion",
    confidence: overrides.confidence ?? 0.5,
    supportingEvidenceIds: overrides.supportingEvidenceIds ?? [],
    contradictingEvidenceIds: overrides.contradictingEvidenceIds ?? [],
    missingEvidence: overrides.missingEvidence ?? [],
    loopIteration: overrides.loopIteration ?? 0,
    ...overrides,
  };
}

function makeEvidence(id: string, overrides: Partial<Evidence> = {}): Evidence {
  return {
    id,
    url: `https://example.com/${id}`,
    domain: overrides.domain ?? "example.com",
    title: overrides.title ?? `Evidence ${id}`,
    snippet: "snippet",
    content: "content",
    contentHash: `hash-${id}`,
    sourceQuery: overrides.sourceQuery ?? "query",
    loopIteration: overrides.loopIteration ?? 0,
  };
}

describe("latestClaimsByRole", () => {
  it("returns one claim per role, choosing highest loopIteration", () => {
    const claims = [
      makeClaim({ agentRole: "historian", questionId: "q1", loopIteration: 0, confidence: 0.3 }),
      makeClaim({ agentRole: "historian", questionId: "q1", loopIteration: 1, confidence: 0.8 }),
      makeClaim({ agentRole: "skeptic", questionId: "q1", loopIteration: 0, confidence: 0.4 }),
    ];
    const result = latestClaimsByRole(claims, "q1");
    expect(result.historian?.confidence).toBe(0.8);
    expect(result.historian?.loopIteration).toBe(1);
    expect(result.skeptic?.confidence).toBe(0.4);
    expect(result.operator).toBeUndefined();
    expect(result.investor).toBeUndefined();
  });

  it("ignores claims from other questions", () => {
    const claims = [
      makeClaim({ agentRole: "historian", questionId: "q1", confidence: 0.5 }),
      makeClaim({ agentRole: "historian", questionId: "q2", confidence: 0.9 }),
    ];
    const result = latestClaimsByRole(claims, "q1");
    expect(result.historian?.confidence).toBe(0.5);
  });

  it("returns empty for no matching claims", () => {
    const result = latestClaimsByRole([], "q1");
    expect(Object.keys(result)).toHaveLength(0);
  });
});

describe("buildArenaGraph", () => {
  it("builds agents, evidence nodes, and edges", () => {
    const claims = [
      makeClaim({
        agentRole: "historian",
        questionId: "q1",
        supportingEvidenceIds: ["e1"],
        contradictingEvidenceIds: ["e2"],
      }),
      makeClaim({
        agentRole: "skeptic",
        questionId: "q1",
        supportingEvidenceIds: ["e2"],
        contradictingEvidenceIds: [],
      }),
    ];
    const evidence = [makeEvidence("e1"), makeEvidence("e2")];

    const graph = buildArenaGraph(claims, evidence, "q1");
    expect(graph.agents).toHaveLength(2);
    expect(graph.evidence).toHaveLength(2);

    const supportEdges = graph.edges.filter(e => e.kind === "support");
    const contradictEdges = graph.edges.filter(e => e.kind === "contradict");
    expect(supportEdges).toHaveLength(2); // historian->e1, skeptic->e2
    expect(contradictEdges).toHaveLength(1); // historian->e2
  });

  it("marks contested evidence (both support and contradict edges)", () => {
    const claims = [
      makeClaim({
        agentRole: "historian",
        questionId: "q1",
        supportingEvidenceIds: ["e1"],
        contradictingEvidenceIds: [],
      }),
      makeClaim({
        agentRole: "skeptic",
        questionId: "q1",
        supportingEvidenceIds: [],
        contradictingEvidenceIds: ["e1"],
      }),
    ];
    const evidence = [makeEvidence("e1")];

    const graph = buildArenaGraph(claims, evidence, "q1");
    const e1Node = graph.evidence.find(e => e.id === "e1");
    expect(e1Node?.contested).toBe(true);
  });

  it("uncontested evidence has contested=false", () => {
    const claims = [
      makeClaim({
        agentRole: "historian",
        questionId: "q1",
        supportingEvidenceIds: ["e1"],
        contradictingEvidenceIds: [],
      }),
    ];
    const evidence = [makeEvidence("e1")];

    const graph = buildArenaGraph(claims, evidence, "q1");
    expect(graph.evidence[0].contested).toBe(false);
  });

  it("handles unresolved evidence id with fallback label", () => {
    const claims = [
      makeClaim({
        agentRole: "historian",
        questionId: "q1",
        supportingEvidenceIds: ["missing-ev"],
        contradictingEvidenceIds: [],
      }),
    ];

    const graph = buildArenaGraph(claims, [], "q1");
    expect(graph.evidence).toHaveLength(1);
    expect(graph.evidence[0].id).toBe("missing-ev");
    expect(graph.evidence[0].label).toBeTruthy();
  });

  it("empty claims produce empty graph", () => {
    const graph = buildArenaGraph([], [], "q1");
    expect(graph.agents).toHaveLength(0);
    expect(graph.evidence).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });

  it("claims with zero evidence ids produce agents but no evidence or edges", () => {
    const claims = [
      makeClaim({ agentRole: "historian", questionId: "q1" }),
    ];
    const graph = buildArenaGraph(claims, [], "q1");
    expect(graph.agents).toHaveLength(1);
    expect(graph.evidence).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });
});

describe("swimlaneCells", () => {
  it("builds role × loop grid with confidence and deltas", () => {
    const claims = [
      makeClaim({ agentRole: "historian", questionId: "q1", loopIteration: 0, confidence: 0.3 }),
      makeClaim({ agentRole: "historian", questionId: "q1", loopIteration: 1, confidence: 0.7 }),
      makeClaim({ agentRole: "skeptic", questionId: "q1", loopIteration: 0, confidence: 0.5 }),
      makeClaim({ agentRole: "skeptic", questionId: "q1", loopIteration: 1, confidence: 0.5 }),
    ];

    const result = swimlaneCells(claims, "q1");
    expect(result.maxLoop).toBe(1);

    expect(result.rows.historian[0].confidence).toBe(0.3);
    expect(result.rows.historian[0].delta).toBeNull(); // first loop, no prior
    expect(result.rows.historian[1].confidence).toBe(0.7);
    expect(result.rows.historian[1].delta).toBe("up");

    expect(result.rows.skeptic[1].delta).toBe("flat");
  });

  it("null cell when role did not debate that loop", () => {
    const claims = [
      makeClaim({ agentRole: "historian", questionId: "q1", loopIteration: 0, confidence: 0.5 }),
      makeClaim({ agentRole: "historian", questionId: "q1", loopIteration: 2, confidence: 0.8 }),
    ];

    const result = swimlaneCells(claims, "q1");
    expect(result.maxLoop).toBe(2);
    expect(result.rows.historian[1].confidence).toBeNull();
    expect(result.rows.historian[2].delta).toBe("up"); // compared to loop 0 (last non-null)
  });

  it("delta down when confidence decreases", () => {
    const claims = [
      makeClaim({ agentRole: "investor", questionId: "q1", loopIteration: 0, confidence: 0.8 }),
      makeClaim({ agentRole: "investor", questionId: "q1", loopIteration: 1, confidence: 0.4 }),
    ];
    const result = swimlaneCells(claims, "q1");
    expect(result.rows.investor[1].delta).toBe("down");
  });

  it("empty claims produce maxLoop 0 and empty rows", () => {
    const result = swimlaneCells([], "q1");
    expect(result.maxLoop).toBe(0);
    for (const role of ["historian", "operator", "investor", "skeptic"] as const) {
      expect(result.rows[role]).toHaveLength(0);
    }
  });

  it("multiple claims per role per loop averages confidence", () => {
    const claims = [
      makeClaim({ agentRole: "historian", questionId: "q1", loopIteration: 0, confidence: 0.4, id: "c1" }),
      makeClaim({ agentRole: "historian", questionId: "q1", loopIteration: 0, confidence: 0.6, id: "c2" }),
    ];
    const result = swimlaneCells(claims, "q1");
    expect(result.rows.historian[0].confidence).toBe(0.5);
  });
});
