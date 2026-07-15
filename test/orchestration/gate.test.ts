import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { generateText } from "ai";
import { gateShortCircuit, allocateBudget, questionRoute } from "@/lib/orchestration/gate";
import { routeAfterGate } from "@/lib/orchestration/graph";
import type { Contention } from "@/lib/orchestration/debate";
import { MAX_LOOP_ITERATIONS, MIN_LOOP_COST_HEADROOM_USD } from "@/lib/params";
import { runWithCostTracker, getActiveCostTracker } from "@/lib/orchestration/cost-tracker";
import type { AnnotatedUsage } from "@/lib/orchestration/eval";
import type { ResearchStateT, Question } from "@/lib/schemas/state";
import type { AgentRoleT, Claim, ClaimStanceT, DebateResponse } from "@/lib/schemas/claim";
import type { DebateRound } from "@/lib/orchestration/debate";
import { fallbackBrief } from "@/lib/schemas/brief";
import { fakeGenResult, assertNoLlmCalls } from "../helpers/mock-ai";

/**
 * Build an AnnotatedUsage whose gpt-4o completion tokens estimate to ~`costUsd` (output
 * bills at $10/M). `record()` recomputes the cost from these token fields, so this is
 * what actually moves `getRemaining()`.
 */
function spendUsage(costUsd: number): AnnotatedUsage {
  const completionTokens = Math.ceil((costUsd / 10) * 1_000_000);
  return { model: "gpt-4o", promptTokens: 0, completionTokens, label: "test", costUsd };
}

// Only generateText is mocked — see test/helpers/mock-ai.ts. The no-progress path must
// NEVER reach it, so the mock is present purely to assert it stays uncalled.
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn() };
});

// Reset the mock's call history between tests so per-test call-count assertions (assertNoLlmCalls,
// toHaveBeenCalledTimes) don't see a prior test's calls. Braced (see the run-debate learning): an
// arrow returning mockReset()'s value would be registered as a teardown hook.
beforeEach(() => {
  (generateText as unknown as Mock).mockReset();
});

function q(id: string, overrides: Partial<Question> = {}): Question {
  return { id, text: `q ${id}`, category: "cat", confidence: 0, resolved: false, ...overrides };
}

/** Full ResearchStateT literal — the gate only reads a handful of fields. */
function stateOf(over: Partial<ResearchStateT>): ResearchStateT {
  return {
    topic: "widgets market",
    researchBrief: fallbackBrief("widgets market"),
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
    debateTranscripts: {},
    retrievalMode: "coded",
    answer: "",
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

  // A state that would otherwise CONTINUE: Firecrawl budget remains, under the loop cap, and the
  // last loop added evidence. Only the cost-headroom guard should stop it.
  const continuableState = stateOf({ loopIteration: 1, newEvidenceCount: 4, budgetRemaining: 50 });

  it("returns 'cost-headroom' when remaining LLM headroom is below the minimum", async () => {
    await runWithCostTracker(async () => {
      // Spend down to $0.10 remaining under a $1.00 cap — below the headroom floor.
      getActiveCostTracker()!.record(spendUsage(0.9));
      expect(getActiveCostTracker()!.getRemaining()).toBeLessThan(MIN_LOOP_COST_HEADROOM_USD);
      expect(gateShortCircuit(continuableState)).toBe("cost-headroom");
    }, 1.0);
  });

  it("does NOT fire cost-headroom when ample LLM headroom remains", async () => {
    await runWithCostTracker(async () => {
      getActiveCostTracker()!.record(spendUsage(0.1)); // $0.90 remaining under a $1.00 cap
      expect(getActiveCostTracker()!.getRemaining()).toBeGreaterThan(MIN_LOOP_COST_HEADROOM_USD);
      expect(gateShortCircuit(continuableState)).toBeNull();
    }, 1.0);
  });

  it("treats a missing tracker as infinite headroom (guard inert, no active tracker)", () => {
    // No runWithCostTracker wrapper → getActiveCostTracker() is null → remaining is undefined →
    // the guard must NOT fire. This is exactly how the pure tests above call gateShortCircuit.
    expect(gateShortCircuit(continuableState)).toBeNull();
  });

  it("Firecrawl 'budget' still wins over 'cost-headroom' when both hold", async () => {
    await runWithCostTracker(async () => {
      getActiveCostTracker()!.record(spendUsage(0.9)); // low headroom
      expect(gateShortCircuit(stateOf({ budgetRemaining: 0, loopIteration: 1, newEvidenceCount: 4 }))).toBe("budget");
    }, 1.0);
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

  it("a cost-headroom short-circuit converges (converged:true) → routeAfterGate returns 'recommend'", async () => {
    const { generateText } = await import("ai");
    (generateText as Mock).mockResolvedValue(fakeGenResult({ decisions: [] }));

    await runWithCostTracker(async () => {
      getActiveCostTracker()!.record(spendUsage(0.9)); // remaining $0.10 < headroom floor
      // State would otherwise continue: Firecrawl budget remains, under the loop cap, evidence added.
      const result = await allocateBudget(
        stateOf({ loopIteration: 1, newEvidenceCount: 4, budgetRemaining: 50 }),
      );

      expect(result.continueLoop).toBe(false);
      expect(result.state.converged).toBe(true);
      // routeAfterGate reads `converged` — the new reason sets it, so the run heads to recommend.
      expect(routeAfterGate(result.state)).toBe("recommend");
      assertNoLlmCalls();
    }, 1.0);
  });
});

// ---------------------------------------------------------------------------
// Phase B — route on committeeStance + named gap
// ---------------------------------------------------------------------------

function contention(type: Contention["type"]): Contention {
  return { questionId: "q1", roles: ["historian", "skeptic"], type, note: "n" };
}

describe("questionRoute", () => {
  it("contested with an evidential contention → retrieve (a named gap could settle it)", () => {
    expect(
      questionRoute({ stance: "contested", contentions: [contention("evidential")], hasNamedGap: true }),
    ).toBe("retrieve");
  });

  it("contested with interpretive-only contentions → resolve (report the fault line)", () => {
    expect(
      questionRoute({ stance: "contested", contentions: [contention("interpretive")], hasNamedGap: false }),
    ).toBe("resolve");
  });

  it("contested with NO surviving contention → resolve", () => {
    expect(questionRoute({ stance: "contested", contentions: [], hasNamedGap: true })).toBe("resolve");
  });

  it("a unanimous decisive lean (supports / opposes) → resolve (settled), gap or not", () => {
    expect(questionRoute({ stance: "supports", contentions: [], hasNamedGap: true })).toBe("resolve");
    expect(questionRoute({ stance: "opposes", contentions: [], hasNamedGap: false })).toBe("resolve");
  });

  it("insufficient WITH a named gap → retrieve (go get it — patience is enforced upstream)", () => {
    expect(questionRoute({ stance: "insufficient", contentions: [], hasNamedGap: true })).toBe("retrieve");
  });

  it("insufficient with NO named gap → resolve (nothing to fetch)", () => {
    expect(questionRoute({ stance: "insufficient", contentions: [], hasNamedGap: false })).toBe("resolve");
  });
});

// --- allocateBudget integration: stance-driven routing of skipped questions ---

function claim(
  role: AgentRoleT,
  stance: ClaimStanceT,
  overrides: Partial<Claim> = {},
): Claim {
  return {
    id: `q1:${role}:${overrides.loopIteration ?? 0}`,
    questionId: "q1",
    agentRole: role,
    conclusion: `${role} take`,
    confidence: 0.4,
    stance,
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingEvidence: [],
    loopIteration: 0,
    debateRound: 0,
    responses: [],
    ...overrides,
  };
}

function resp(targetRole: AgentRoleT, stance: DebateResponse["stance"]): DebateResponse {
  return { targetRole, stance, point: "p" };
}

const round0 = (claims: Claim[]): DebateRound => ({ round: 0, claims });

describe("allocateBudget — Phase B stance routing", () => {
  it("a SKIPPED insufficient question with a fresh named gap (loop 0) routes to retrieve — reaches the LLM gate", async () => {
    const { generateText } = await import("ai");
    (generateText as Mock).mockResolvedValue(
      fakeGenResult({ decisions: [{ questionId: "q1", retrieve: true, reason: "gap worth chasing" }] }),
    );

    // Blind openings all abstain, one names a gap → committeeStance "insufficient" + hasNamedGap.
    const transcript = round0([
      claim("historian", "insufficient", { missingEvidence: ["need TAM figure"] }),
      claim("operator", "insufficient"),
      claim("investor", "insufficient"),
      claim("skeptic", "insufficient"),
    ]);

    const result = await allocateBudget(
      stateOf({
        loopIteration: 0,
        questions: [q("q1")],
        claims: transcript.claims,
        debateTranscripts: { q1: [transcript] },
      }),
    );

    // NOT resolved at zero cost — it reached the LLM gate, which chose to retrieve.
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result.continueLoop).toBe(true);
    expect(result.state.questions.find((qq) => qq.id === "q1")?.resolved).toBe(false);
  });

  it("a unanimous 'supports' with no gap → resolved at zero LLM cost (settled)", async () => {
    const { generateText } = await import("ai");
    (generateText as Mock).mockResolvedValue(fakeGenResult({ decisions: [] }));

    const transcript = round0([
      claim("historian", "supports"),
      claim("operator", "supports"),
      claim("investor", "supports"),
      claim("skeptic", "supports"),
    ]);

    const result = await allocateBudget(
      stateOf({
        loopIteration: 0,
        questions: [q("q1")],
        claims: transcript.claims,
        debateTranscripts: { q1: [transcript] },
      }),
    );

    expect(result.continueLoop).toBe(false);
    expect(result.state.converged).toBe(true);
    expect(result.gateScores.find((s) => s.questionId === "q1")?.retrieve).toBe(false);
    assertNoLlmCalls();
  });

  it("a contested INTERPRETIVE split (no gap) → resolved at zero cost and reported as a fault line", async () => {
    const { generateText } = await import("ai");
    (generateText as Mock).mockResolvedValue(fakeGenResult({ decisions: [] }));

    // supports vs opposes (contested), with an unresolved rebuttal and NO named gap → interpretive.
    const finalRound: DebateRound = {
      round: 1,
      claims: [
        claim("historian", "supports", { debateRound: 1, responses: [resp("skeptic", "rebut")] }),
        claim("skeptic", "opposes", { debateRound: 1, responses: [] }),
      ],
    };

    const result = await allocateBudget(
      stateOf({
        loopIteration: 0,
        questions: [q("q1")],
        claims: finalRound.claims,
        debateTranscripts: { q1: [round0(finalRound.claims), finalRound] },
      }),
    );

    expect(result.continueLoop).toBe(false);
    const score = result.gateScores.find((s) => s.questionId === "q1");
    expect(score?.retrieve).toBe(false);
    expect(score?.reason).toMatch(/fault line|interpretive/i);
    assertNoLlmCalls();
  });

  it("an insufficient gap that survived one loop with no progress → structural resolve (patience=1), no LLM call", async () => {
    const { generateText } = await import("ai");
    (generateText as Mock).mockResolvedValue(fakeGenResult({ decisions: [] }));

    // Two debated loops, same confidence + same gap count → diminishingReturns → structural resolve.
    const claimsAcrossLoops: Claim[] = [
      claim("historian", "insufficient", { loopIteration: 0, confidence: 0.3, missingEvidence: ["g"] }),
      claim("historian", "insufficient", { loopIteration: 1, confidence: 0.3, missingEvidence: ["g"] }),
    ];
    const finalRound = round0([claimsAcrossLoops[1]]);

    const result = await allocateBudget(
      stateOf({
        loopIteration: 1,
        newEvidenceCount: 2,
        questions: [q("q1")],
        claims: claimsAcrossLoops,
        debateTranscripts: { q1: [finalRound] },
      }),
    );

    expect(result.continueLoop).toBe(false);
    const score = result.gateScores.find((s) => s.questionId === "q1");
    expect(score?.retrieve).toBe(false);
    expect(score?.reason).toMatch(/diminishing/i);
    assertNoLlmCalls();
  });

  it("regression: routing does NOT depend on retrievalMode — coded and agentic decide identically", async () => {
    const { generateText } = await import("ai");
    (generateText as Mock).mockResolvedValue(fakeGenResult({ decisions: [] }));

    const transcript = round0([
      claim("historian", "supports"),
      claim("operator", "supports"),
      claim("investor", "supports"),
      claim("skeptic", "supports"),
    ]);
    const base = {
      loopIteration: 0,
      questions: [q("q1")],
      claims: transcript.claims,
      debateTranscripts: { q1: [transcript] },
    };

    const coded = await allocateBudget(stateOf({ ...base, retrievalMode: "coded" }));
    const agentic = await allocateBudget(stateOf({ ...base, retrievalMode: "agentic" }));

    const decide = (r: Awaited<ReturnType<typeof allocateBudget>>) => ({
      continueLoop: r.continueLoop,
      resolved: r.state.questions.map((qq) => qq.resolved),
      retrieves: r.gateScores.map((s) => [s.questionId, s.retrieve]),
    });
    expect(decide(coded)).toEqual(decide(agentic));
  });
});
