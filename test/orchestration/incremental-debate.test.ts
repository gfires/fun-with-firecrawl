import { describe, it, expect } from "vitest";
import { questionsNeedingDebate } from "@/lib/orchestration/graph";
import { splitEvidence } from "@/lib/orchestration/committee";
import type { Question } from "@/lib/schemas/state";
import type { Evidence } from "@/lib/schemas/evidence";
import type { Claim } from "@/lib/schemas/claim";

function q(id: string, overrides: Partial<Question> = {}): Question {
  return { id, text: `q ${id}`, category: "cat", confidence: 0, resolved: false, ...overrides };
}

function ev(sourceQuery: string, loopIteration = 0, id?: string): Evidence {
  return {
    id: id ?? `e-${sourceQuery}-${loopIteration}`,
    url: "https://example.com",
    domain: "example.com",
    title: `title ${sourceQuery}`,
    snippet: `snippet ${sourceQuery}`,
    content: `FULL CONTENT for ${sourceQuery} — should not appear in a re-debate index`,
    sourceQuery,
    loopIteration,
    contentHash: `h-${sourceQuery}-${loopIteration}`,
  };
}

function claim(questionId: string, overrides: Partial<Claim> = {}): Claim {
  return {
    id: `${questionId}:c`,
    questionId,
    agentRole: "historian",
    conclusion: "prior conclusion text",
    confidence: 0.42,
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingEvidence: ["need pricing data"],
    loopIteration: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// questionsNeedingDebate
// ---------------------------------------------------------------------------

describe("questionsNeedingDebate", () => {
  it("includes a never-debated question (no claims yet)", () => {
    const questions = [q("q1")];
    const result = questionsNeedingDebate(questions, new Map(), [], 0);
    expect(result.map((x) => x.id)).toEqual(["q1"]);
  });

  it("includes a claimed question that gained fresh evidence this loop", () => {
    const questions = [q("q1")];
    const byQ = new Map<string, Evidence[]>([["q1", [ev("a", 0), ev("b", 1)]]]);
    const result = questionsNeedingDebate(questions, byQ, [claim("q1")], 1);
    expect(result.map((x) => x.id)).toEqual(["q1"]);
  });

  it("excludes a claimed question whose evidence is all stale (no fresh this loop)", () => {
    const questions = [q("q1")];
    const byQ = new Map<string, Evidence[]>([["q1", [ev("a", 0)]]]);
    const result = questionsNeedingDebate(questions, byQ, [claim("q1")], 1);
    expect(result).toEqual([]);
  });

  it("excludes a resolved question even if it has fresh evidence", () => {
    const questions = [q("q1", { resolved: true })];
    const byQ = new Map<string, Evidence[]>([["q1", [ev("a", 1)]]]);
    const result = questionsNeedingDebate(questions, byQ, [claim("q1")], 1);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// splitEvidence
// ---------------------------------------------------------------------------

describe("splitEvidence", () => {
  it("partitions by loopIteration relative to the current loop", () => {
    const evidence = [ev("a", 0), ev("b", 1), ev("c", 1), ev("d", 2)];
    const { fresh, prior } = splitEvidence(evidence, 1);
    expect(fresh.map((e) => e.sourceQuery)).toEqual(["b", "c"]);
    expect(prior.map((e) => e.sourceQuery)).toEqual(["a", "d"]);
  });

  it("puts everything in fresh at loop 0 when all evidence is loop 0", () => {
    const evidence = [ev("a", 0), ev("b", 0)];
    const { fresh, prior } = splitEvidence(evidence, 0);
    expect(fresh).toHaveLength(2);
    expect(prior).toHaveLength(0);
  });
});

// buildUserPrompt was superseded by buildCommitteeMessages in Phase 4b — its prior-claim
// and evidence-block behavior is now covered in committee-messages.test.ts.
