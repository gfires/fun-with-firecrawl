import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import { gateShortCircuit, allocateBudget } from "@/lib/orchestration/gate";
import { MAX_LOOP_ITERATIONS } from "@/lib/params";
import type { ResearchStateT, Question } from "@/lib/schemas/state";
import { fakeGenResult, assertNoLlmCalls } from "../helpers/mock-ai";

// Only generateText is mocked — see test/helpers/mock-ai.ts. The no-progress path must
// NEVER reach it, so the mock is present purely to assert it stays uncalled.
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn() };
});

function q(id: string, overrides: Partial<Question> = {}): Question {
  return { id, text: `q ${id}`, category: "cat", confidence: 0, resolved: false, ...overrides };
}

/** Full ResearchStateT literal — the gate only reads a handful of fields. */
function stateOf(over: Partial<ResearchStateT>): ResearchStateT {
  return {
    topic: "widgets market",
    questions: [q("q1")],
    evidence: [],
    claims: [],
    loopIteration: 0,
    newEvidenceCount: -1,
    budgetRemaining: 50,
    budgetSpent: 0,
    firecrawlCalls: 0,
    firecrawlCredits: 0,
    converged: false,
    llmCalls: [],
    searchedQueries: [],
    gateScores: [],
    digests: {},
    ...over,
  };
}

describe("gateShortCircuit", () => {
  it("returns 'no-progress' when a past-loop-0 iteration added no evidence", () => {
    expect(gateShortCircuit(stateOf({ loopIteration: 2, newEvidenceCount: 0 }))).toBe("no-progress");
  });

  it("exempts loop 0 from the no-progress check (returns null)", () => {
    // newEvidenceCount is only meaningful once a retrieve has run; loop 0 is exempt.
    expect(gateShortCircuit(stateOf({ loopIteration: 0, newEvidenceCount: 0 }))).toBeNull();
  });

  it("returns 'budget' when no budget remains, taking priority over other checks", () => {
    expect(gateShortCircuit(stateOf({ budgetRemaining: 0, loopIteration: 2, newEvidenceCount: 0 }))).toBe("budget");
  });

  it("returns 'max-loops' at the loop-iteration cap", () => {
    expect(gateShortCircuit(stateOf({ loopIteration: MAX_LOOP_ITERATIONS, newEvidenceCount: 5 }))).toBe("max-loops");
  });

  it("returns null when there is budget, loops remain, and progress was made", () => {
    expect(gateShortCircuit(stateOf({ loopIteration: 1, newEvidenceCount: 4 }))).toBeNull();
  });
});

describe("allocateBudget — short-circuit before any LLM call", () => {
  it("a no-progress state converges with continueLoop:false and never calls the LLM", async () => {
    const { generateText } = await import("ai");
    (generateText as Mock).mockResolvedValue(fakeGenResult({ decisions: [] }));

    const result = await allocateBudget(stateOf({ loopIteration: 2, newEvidenceCount: 0 }));

    expect(result.continueLoop).toBe(false);
    expect(result.state.converged).toBe(true);
    expect(result.usage).toEqual([]);
    expect(result.gateScores).toEqual([]);
    assertNoLlmCalls();
  });
});
