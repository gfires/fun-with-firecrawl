import { describe, it, expect } from "vitest";
import {
  computeRunMechanics,
  formatMechanicsReport,
} from "../../src/lib/orchestration/mechanics";
import { toAnnotatedUsage, type ArmTokens } from "../../src/lib/orchestration/eval";
import { MAX_RUN_COST_USD } from "../../src/lib/params";
import type { TraceEntry } from "../../src/lib/orchestration/trace";
import type { ResearchStateT, Question } from "../../src/lib/schemas/state";
import type { Claim, AgentRoleT, ClaimStanceT, DebateResponse } from "../../src/lib/schemas/claim";
import type { Evidence } from "../../src/lib/schemas/evidence";
import type { DebateRound } from "../../src/lib/orchestration/debate";
import { fallbackBrief } from "../../src/lib/schemas/brief";

// --- fixture builders -------------------------------------------------------

function entry(type: string, data: unknown): TraceEntry {
  return { timestamp: new Date().toISOString(), elapsed_ms: 0, type, data };
}

function ev(
  id: string,
  questionId: string,
  loopIteration: number,
): Evidence {
  return {
    id,
    url: `https://example.com/${id}`,
    domain: "example.com",
    title: id,
    snippet: "",
    content: "",
    contentHash: id,
    sourceQuery: "q",
    loopIteration,
    questionId,
  };
}

function resp(targetRole: AgentRoleT, stance: DebateResponse["stance"]): DebateResponse {
  return { targetRole, stance, point: "p" };
}

function claim(
  agentRole: AgentRoleT,
  confidence: number,
  opts: {
    supporting?: string[];
    contradicting?: string[];
    missing?: string[];
    responses?: DebateResponse[];
    round?: number;
    stance?: ClaimStanceT;
  } = {},
): Claim {
  return {
    id: `${agentRole}-c`,
    questionId: "unused",
    agentRole,
    conclusion: "c",
    confidence,
    stance: opts.stance ?? "insufficient",
    supportingEvidenceIds: opts.supporting ?? [],
    contradictingEvidenceIds: opts.contradicting ?? [],
    missingEvidence: opts.missing ?? [],
    loopIteration: 0,
    debateRound: opts.round ?? 0,
    responses: opts.responses ?? [],
  };
}

function q(id: string): Question {
  return { id, text: id, category: "c", confidence: 0.5, resolved: false };
}

function makeState(overrides: Partial<ResearchStateT> = {}): ResearchStateT {
  const base: ResearchStateT = {
    topic: "t",
    researchBrief: fallbackBrief("t"),
    questions: [],
    evidence: [],
    claims: [],
    loopIteration: 0,
    newEvidenceCount: -1,
    budgetRemaining: 0,
    budgetSpent: 0,
    firecrawlCalls: 0,
    firecrawlCredits: 0,
    converged: false,
    llmCalls: [],
    searchedQueries: [],
    gateScores: [],
    digests: {},
    debateTranscripts: {},
    answer: "",
    retrievalMode: "agentic",
  };
  return { ...base, ...overrides };
}

function makeTokens(totalCostUsd: number): ArmTokens {
  return {
    calls: [],
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCostUsd,
  };
}

// A full synthetic run's transcripts. q1 debates 3 rounds and ends with two
// contentions (one evidential, one interpretive); q2 debates 2 rounds and agrees.
function fixtureTranscripts(): Record<string, DebateRound[]> {
  const q1Final: DebateRound = {
    round: 2,
    claims: [
      claim("historian", 0.8, {
        supporting: ["e1"],
        responses: [resp("operator", "rebut")],
        round: 2,
      }),
      claim("operator", 0.6, { missing: ["need X"], round: 2 }),
      claim("investor", 0.7, {
        supporting: ["e2"],
        responses: [resp("skeptic", "concede")],
        round: 2,
      }),
      claim("skeptic", 0.5, {
        contradicting: ["e2"],
        responses: [resp("investor", "rebut")],
        round: 2,
      }),
    ],
  };
  const q2Final: DebateRound = {
    round: 1,
    claims: [
      claim("historian", 0.6, { supporting: ["e3"], round: 1 }),
      claim("operator", 0.65, { round: 1 }),
    ],
  };
  return {
    q1: [{ round: 0, claims: [] }, { round: 1, claims: [] }, q1Final],
    q2: [{ round: 0, claims: [] }, q2Final],
  };
}

function fixtureEntries(): TraceEntry[] {
  return [
    // firecrawl ops
    entry("firecrawl:call", { operation: "search" }),
    entry("firecrawl:call", { operation: "scrape" }),
    entry("firecrawl:call", { operation: "search-cache-hit" }),
    entry("firecrawl:call", { operation: "scrape-cache-hit" }),
    // researcher (agentic)
    entry("researcher:webSearch", { questionId: "q1", hits: 10 }),
    entry("researcher:webSearch", { questionId: "q1", hits: 10 }),
    entry("researcher:webSearch", { questionId: "q2", hits: 10 }),
    entry("researcher:readSource", { questionId: "q1", stored: 1 }),
    // debate rounds
    entry("debate:round", { questionId: "q1", round: 1, moved: 2, newRebuttals: 1, converged: false }),
    entry("debate:round", { questionId: "q1", round: 2, moved: 0, newRebuttals: 0, converged: true }),
    entry("debate:round", { questionId: "q2", round: 1, moved: 1, newRebuttals: 2, converged: false }),
    // llm calls (effort split)
    entry("llm:call", {
      label: "committee:historian",
      request: { model: "claude-sonnet-5", loopIteration: 0 },
      usage: { inputTokens: 1000, outputTokens: 500 },
    }),
    entry("llm:call", {
      label: "debate:skeptic",
      request: { model: "gpt-4o", loopIteration: 1 },
      usage: { inputTokens: 2000, outputTokens: 1000 },
    }),
    entry("llm:call", {
      label: "researcher:q1",
      request: { model: "claude-haiku-4-5-20251001", loopIteration: 0 },
      usage: { inputTokens: 4000, outputTokens: 100 },
    }),
    entry("llm:call", {
      label: "triage",
      request: { model: "gpt-4o-mini" },
      usage: { inputTokens: 500, outputTokens: 50 },
    }),
    entry("llm:call", {
      label: "digest:q1",
      request: { model: "claude-haiku-4-5-20251001", loopIteration: 0 },
      usage: { inputTokens: 300, outputTokens: 30 },
    }),
    entry("llm:call", {
      label: "synthesis:answer",
      request: { model: "claude-sonnet-5" },
      usage: { inputTokens: 1000, outputTokens: 2000 },
    }),
    entry("llm:call", {
      label: "intake",
      request: { model: "claude-haiku-4-5-20251001" },
      usage: { inputTokens: 200, outputTokens: 20 },
    }),
    // convergence
    entry("gate:converged", { reason: "zero-cost-resolved" }),
    entry("gate:converged", { reason: "gate-decided-no-retrieve" }),
    entry("budget_exceeded", { message: "cap hit" }),
  ];
}

function fixtureState(): ResearchStateT {
  return makeState({
    questions: [q("q1"), q("q2"), q("q3")],
    evidence: [ev("e1", "q1", 0), ev("e2", "q1", 1), ev("e3", "q2", 0)],
    loopIteration: 2,
    firecrawlCalls: 5,
    firecrawlCredits: 10,
    converged: true,
    debateTranscripts: fixtureTranscripts(),
  });
}

// --- tests ------------------------------------------------------------------

describe("computeRunMechanics — retrieval", () => {
  const m = computeRunMechanics(fixtureEntries(), fixtureState(), makeTokens(1.0));

  it("tallies evidence per question and total", () => {
    expect(m.retrieval.evidenceTotal).toBe(3);
    expect(m.retrieval.evidencePerQuestion).toEqual({ q1: 2, q2: 1, q3: 0 });
  });

  it("detects starved questions", () => {
    expect(m.retrieval.starvedQuestions).toEqual(["q3"]);
  });

  it("groups evidence by loop", () => {
    expect(m.retrieval.evidenceByLoop).toEqual({ "0": 2, "1": 1 });
  });

  it("counts firecrawl ops and cache hits", () => {
    expect(m.retrieval.cacheHits).toBe(2);
    expect(m.retrieval.searchOps).toBe(1);
    expect(m.retrieval.scrapeOps).toBe(1);
    expect(m.retrieval.firecrawlCalls).toBe(5);
    expect(m.retrieval.firecrawlCredits).toBe(10);
  });

  it("counts agent searches/reads and the search:read ratio", () => {
    expect(m.retrieval.agentSearches).toBe(3);
    expect(m.retrieval.agentReads).toBe(1);
    expect(m.retrieval.searchToReadRatio).toBe(3);
  });

  it("computes evidence per credit", () => {
    expect(m.retrieval.evidencePerCredit).toBeCloseTo(0.3, 5);
  });
});

describe("computeRunMechanics — deliberation", () => {
  const m = computeRunMechanics(fixtureEntries(), fixtureState(), makeTokens(1.0));

  it("counts questions debated and conversational rounds", () => {
    expect(m.deliberation.questionsDebated).toBe(2);
    expect(m.deliberation.conversationalRounds).toBe(3); // (3-1) + (2-1)
    expect(m.deliberation.avgRoundsPerQuestion).toBeCloseTo(1.5, 5);
  });

  it("sums moved and newRebuttals from debate:round entries", () => {
    expect(m.deliberation.moved).toBe(3);
    expect(m.deliberation.newRebuttals).toBe(3);
  });

  it("classifies contentions from the final round", () => {
    expect(m.deliberation.contentions).toEqual({ evidential: 1, interpretive: 1 });
  });

  it("computes confidence mean and per-question spread", () => {
    expect(m.deliberation.confidence.mean).toBeCloseTo(3.85 / 6, 5);
    expect(m.deliberation.confidence.perQuestionSpread.q1).toBeCloseTo(0.3, 5);
    expect(m.deliberation.confidence.perQuestionSpread.q2).toBeCloseTo(0.05, 5);
  });

  it("tallies the stance mix and concessions over final rounds", () => {
    expect(m.deliberation.stanceMix).toEqual({ rebut: 2, concede: 1, extend: 0 });
    expect(m.deliberation.concessions).toBe(1);
  });
});

describe("computeRunMechanics — effortSplit", () => {
  const m = computeRunMechanics(fixtureEntries(), fixtureState(), makeTokens(1.0));

  const cost = (model: string, label: string, inTok: number, outTok: number) =>
    toAnnotatedUsage({ inputTokens: inTok, outputTokens: outTok }, model, label).costUsd;

  it("groups retrieval cost (researcher + triage)", () => {
    const expected =
      cost("claude-haiku-4-5-20251001", "researcher:q1", 4000, 100) +
      cost("gpt-4o-mini", "triage", 500, 50);
    expect(m.effortSplit.costByGroup.retrieval).toBeCloseTo(expected, 6);
  });

  it("groups deliberation cost (committee + debate)", () => {
    const expected =
      cost("claude-sonnet-5", "committee:historian", 1000, 500) +
      cost("gpt-4o", "debate:skeptic", 2000, 1000);
    expect(m.effortSplit.costByGroup.deliberation).toBeCloseTo(expected, 6);
  });

  it("percentages sum to ~100", () => {
    const sum = Object.values(m.effortSplit.pctByGroup).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(100, 3);
  });

  it("buckets cost by loop with a '-' bucket for loopless calls", () => {
    expect(Object.keys(m.effortSplit.costByLoop).sort()).toEqual(["-", "0", "1"]);
    expect(m.effortSplit.costByLoop["-"]).toBeGreaterThan(0);
  });

  it("computes usd per credit from tokens", () => {
    expect(m.effortSplit.usdPerCredit).toBeCloseTo(1.0 / 10, 6);
  });

  it("reports token totals per group", () => {
    expect(m.effortSplit.tokensByGroup.deliberation.in).toBe(3000);
    expect(m.effortSplit.tokensByGroup.deliberation.out).toBe(1500);
  });

  it("discounts cache-read tokens in the split (cache-aware, reconciles to the real cost path)", () => {
    // The AI SDK reports the cache breakdown under inputTokenDetails.{cacheReadTokens,cacheWriteTokens}
    // — NOT the legacy top-level cachedInputTokens. The split must forward it so 9k cached tokens bill
    // at the read rate, not full price (otherwise the report over-states deliberation cost).
    const usage = {
      inputTokens: 10000,
      outputTokens: 100,
      inputTokenDetails: { cacheReadTokens: 9000, cacheWriteTokens: 0, noCacheTokens: 1000 },
    };
    const entries: TraceEntry[] = [
      entry("llm:call", { label: "debate:historian", request: { model: "claude-sonnet-5", loopIteration: 1 }, usage }),
    ];
    const m2 = computeRunMechanics(entries, makeState(), makeTokens(0));
    const expected = toAnnotatedUsage(usage, "claude-sonnet-5", "debate:historian").costUsd;
    expect(m2.effortSplit.costByGroup.deliberation).toBeCloseTo(expected, 8);
    // …and that is strictly cheaper than billing all 10k input at the full rate.
    const fullPrice = toAnnotatedUsage(
      { inputTokens: 10000, outputTokens: 100 },
      "claude-sonnet-5",
      "debate:historian",
    ).costUsd;
    expect(m2.effortSplit.costByGroup.deliberation).toBeLessThan(fullPrice);
  });
});

describe("computeRunMechanics — convergence", () => {
  const m = computeRunMechanics(fixtureEntries(), fixtureState(), makeTokens(1.0));

  it("reports loop iterations and the last gate reason", () => {
    expect(m.convergence.loopIterations).toBe(2);
    expect(m.convergence.reason).toBe("gate-decided-no-retrieve");
  });

  it("flags degraded when a budget_exceeded entry is present", () => {
    expect(m.convergence.degraded).toBe(true);
  });

  it("reports cost and over-cap", () => {
    expect(m.convergence.totalCostUsd).toBe(1.0);
    expect(m.convergence.capUsd).toBe(MAX_RUN_COST_USD);
    expect(m.convergence.overCap).toBe(true);
  });
});

describe("computeRunMechanics — absent agentic signals", () => {
  it("leaves agent counts undefined when no researcher entries", () => {
    const entries = fixtureEntries().filter((e) => !e.type.startsWith("researcher:"));
    const m = computeRunMechanics(entries, fixtureState(), makeTokens(1.0));
    expect(m.retrieval.agentSearches).toBeUndefined();
    expect(m.retrieval.agentReads).toBeUndefined();
    expect(m.retrieval.searchToReadRatio).toBeUndefined();
  });
});

// A run that mixes debated and skipped questions (Phase C):
// - qA: DEBATED and productive (the historian's stance moved supports→opposes round0→final)
// - qB: DEBATED but unproductive (identical stances round0→final, no concession) → ⚠
// - qC: SKIPPED on shared uncertainty (only the blind opening; all 'insufficient')
// - qD: SKIPPED on agreement (only the blind opening; unanimous 'supports')
function phaseCTranscripts(): Record<string, DebateRound[]> {
  const round = (r: number, claims: Claim[]): DebateRound => ({ round: r, claims });
  return {
    qA: [
      round(0, [claim("historian", 0.5, { stance: "supports" }), claim("skeptic", 0.5, { stance: "opposes" })]),
      round(1, [
        claim("historian", 0.6, { stance: "opposes", round: 1 }), // stance MOVED → productive
        claim("skeptic", 0.5, { stance: "opposes", round: 1 }),
      ]),
    ],
    qB: [
      round(0, [claim("historian", 0.5, { stance: "supports" }), claim("skeptic", 0.5, { stance: "opposes" })]),
      round(1, [
        claim("historian", 0.5, { stance: "supports", round: 1 }), // no move, no concede → unproductive
        claim("skeptic", 0.5, { stance: "opposes", round: 1 }),
      ]),
    ],
    qC: [round(0, [claim("historian", 0.2, { stance: "insufficient" }), claim("skeptic", 0.2, { stance: "insufficient" })])],
    qD: [round(0, [claim("historian", 0.8, { stance: "supports" }), claim("skeptic", 0.8, { stance: "supports" })])],
  };
}

describe("computeRunMechanics — debated vs skipped (Phase C)", () => {
  const m = computeRunMechanics([], makeState({ debateTranscripts: phaseCTranscripts() }), makeTokens(0));

  it("counts questions whose conversational rounds RAN vs those skipped on agreement", () => {
    expect(m.deliberation.questionsDebated).toBe(2); // qA, qB
    expect(m.deliberation.questionsSkipped).toBe(2); // qC, qD
  });

  it("breaks the skipped questions down by committeeStance", () => {
    expect(m.deliberation.skippedByStance.insufficient).toBe(1); // qC
    expect(m.deliberation.skippedByStance.supports).toBe(1); // qD
    expect(m.deliberation.skippedByStance.opposes ?? 0).toBe(0);
  });

  it("counts a debated question productive only when a stance moved or a contention resolved", () => {
    expect(m.deliberation.productiveQuestions).toBe(1); // qA moved; qB did not
  });

  it("formats the debated/skipped headline and flags debated-but-unanimous", () => {
    const out = formatMechanicsReport(m);
    expect(out).toContain("debated 2 · skipped 2 (1 insufficient→retrieve, 1 agreed)");
    expect(out).toMatch(/debated but unanimous/);
  });

  it("does NOT flag debated-but-unanimous when every debated question was productive", () => {
    const productiveOnly = computeRunMechanics(
      [],
      makeState({ debateTranscripts: { qA: phaseCTranscripts().qA } }),
      makeTokens(0),
    );
    expect(productiveOnly.deliberation.productiveQuestions).toBe(1);
    expect(formatMechanicsReport(productiveOnly)).not.toMatch(/debated but unanimous/);
  });

  it("empty inputs yield zero debated/skipped/productive and do not throw", () => {
    const empty = computeRunMechanics([], makeState(), makeTokens(0));
    expect(empty.deliberation.questionsDebated).toBe(0);
    expect(empty.deliberation.questionsSkipped).toBe(0);
    expect(empty.deliberation.productiveQuestions).toBe(0);
    expect(() => formatMechanicsReport(empty)).not.toThrow();
  });
});

describe("formatMechanicsReport", () => {
  it("contains section headers and key figures", () => {
    const m = computeRunMechanics(fixtureEntries(), fixtureState(), makeTokens(1.0));
    const out = formatMechanicsReport(m);
    expect(out).toContain("RETRIEVAL");
    expect(out).toContain("DELIBERATION");
    expect(out).toContain("EFFORT SPLIT");
    expect(out).toContain("CONVERGENCE");
  });

  it("flags a starved question, a reading-starved ratio, and degradation", () => {
    const out = formatMechanicsReport(
      computeRunMechanics(fixtureEntries(), fixtureState(), makeTokens(1.0)),
    );
    expect(out).toContain("⚠");
    expect(out).toMatch(/starved/i);
    expect(out).toMatch(/degraded/i);
  });

  it("does not throw on empty inputs", () => {
    const m = computeRunMechanics([], makeState(), makeTokens(0));
    expect(() => formatMechanicsReport(m)).not.toThrow();
    expect(m.retrieval.evidenceTotal).toBe(0);
    expect(m.deliberation.questionsDebated).toBe(0);
  });
});
