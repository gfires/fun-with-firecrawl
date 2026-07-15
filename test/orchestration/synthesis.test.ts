import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { generateText } from "ai";
import { answerObjective, ensureAnswer, recommend, synthesizeReport } from "@/lib/orchestration/graph";
import type { ResearchBrief } from "@/lib/schemas/brief";
import type { ResearchStateT, Question } from "@/lib/schemas/state";
import type { AgentRoleT, Claim, DebateResponse } from "@/lib/schemas/claim";
import type { DebateRound } from "@/lib/orchestration/debate";
import { fakeGenResult, assertNoLlmCalls } from "../helpers/mock-ai";
import { SYNTHESIS_ANSWER_MAX_TOKENS } from "@/lib/params";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn() };
});

function q(id: string, overrides: Partial<Question> = {}): Question {
  return { id, text: `q ${id}`, category: "cat", confidence: 0, resolved: false, ...overrides };
}

function resp(targetRole: AgentRoleT, stance: DebateResponse["stance"], point = "p"): DebateResponse {
  return { targetRole, stance, point };
}

function claim(role: AgentRoleT, overrides: Partial<Claim> = {}): Claim {
  return {
    id: `q1:${role}:0`,
    questionId: "q1",
    agentRole: role,
    conclusion: `${role} conclusion`,
    confidence: 0.5,
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

// A final round where the historian rebuts the investor and the investor does not concede, with no
// named missingEvidence → an unresolved INTERPRETIVE contention (a committee split retrieval can't fix).
const historian = claim("historian", {
  conclusion: "prior entrants all died on distribution",
  responses: [resp("investor", "rebut", "the precedent is survivorship-biased")],
});
const investor = claim("investor", { conclusion: "the margin profile can support a venture return" });
const finalRound: DebateRound = { round: 1, claims: [historian, investor] };

function stateOf(over: Partial<ResearchStateT> = {}): ResearchStateT {
  const researchBrief: ResearchBrief = {
    subject: "freight brokerage",
    objective: "Decide go/no-go on a venture-scale freight brokerage bet",
    constraints: ["US market"],
  };
  return {
    topic: "freight brokerage",
    researchBrief,
    questions: [q("q1")],
    claims: [historian, investor],
    debateTranscripts: { q1: [{ round: 0, claims: [historian, investor] }, finalRound] },
    evidence: [],
    answer: "",
    ...over,
  } as ResearchStateT;
}

beforeEach(() => {
  (generateText as Mock).mockReset();
});

describe("answerObjective (A5)", () => {
  it("grounds the answer prompt in the objective, the committee claims, and the surviving contention", async () => {
    (generateText as Mock).mockResolvedValue(
      fakeGenResult({ answer: "Lean no-go: distribution is the fault line." }, { inputTokens: 80, outputTokens: 40 }),
    );

    const out = await answerObjective(stateOf());
    expect(out.answer).toBe("Lean no-go: distribution is the fault line.");
    expect(out.usage?.label).toBe("synthesis:answer");

    const prompt = (generateText as Mock).mock.calls[0][0].prompt as string;
    expect(prompt).toContain("Decide go/no-go on a venture-scale freight brokerage bet");
    expect(prompt).toContain("prior entrants all died on distribution"); // a committee claim
    expect(prompt).toContain("SPLIT (interpretive)"); // the surviving contention, classified
    expect(prompt).toContain("US market"); // constraint carried through
    // Grounded + traceable: the prompt requires citing [S#] and forbids inventing sources.
    expect(prompt).toContain("CITE specific evidence by");
    expect(prompt).toContain("NEVER cite an [S#] that is not listed");
    // Authoritative voice (A): lead with a verdict and reason from best-available evidence, not hedge.
    expect(prompt).toContain("WRITE WITH THE AUTHORITY");
    expect(prompt).toContain("BEST AVAILABLE evidence");
    expect(prompt).toContain("DECISIVE read beats");
  });

  it("threads the CITED evidence into the prompt as [S#] sources and tags each claim with its sources", async () => {
    (generateText as Mock).mockResolvedValue(fakeGenResult({ answer: "Lean no-go [S1]." }));
    const ev = {
      id: "ev-abc",
      url: "https://example.com/report",
      domain: "example.com",
      title: "Freight margins report",
      snippet: "gross margins run 3-5% for brokerages",
      content: "full content",
      sourceQuery: "freight",
      loopIteration: 0,
      contentHash: "h",
    };
    const cited = claim("operator", { conclusion: "margins are thin", supportingEvidenceIds: ["ev-abc"] });
    const state = stateOf({
      questions: [q("q1")],
      claims: [cited],
      debateTranscripts: { q1: [{ round: 0, claims: [cited] }, { round: 1, claims: [cited] }] },
      evidence: [ev],
      digests: { q1: [{ evidenceId: "ev-abc", summary: "brokerage gross margins 3-5%, high fragmentation" }] },
    } as never);

    await answerObjective(state);
    const prompt = (generateText as Mock).mock.calls[0][0].prompt as string;
    // A SOURCES block with the source labelled [S1], its distilled digest facts, and its url.
    expect(prompt).toContain("SOURCES (cite these by [S#]");
    expect(prompt).toContain("[S1] Freight margins report");
    expect(prompt).toContain("brokerage gross margins 3-5%"); // distilled facts, not just the paraphrase
    expect(prompt).toContain("https://example.com/report"); // traceable url
    // The claim line is tagged with the source it rests on.
    expect(prompt).toContain("[cites S1]");
  });

  it("never mints a label for an evidence id the state does not actually hold (no hallucinated sources)", async () => {
    (generateText as Mock).mockResolvedValue(fakeGenResult({ answer: "no-go" }));
    // Claim cites an id with NO matching evidence in state → no [S#], tagged as uncited.
    const dangling = claim("skeptic", { conclusion: "no demand", supportingEvidenceIds: ["ghost-id"] });
    const state = stateOf({
      questions: [q("q1")],
      claims: [dangling],
      debateTranscripts: { q1: [{ round: 0, claims: [dangling] }, { round: 1, claims: [dangling] }] },
      evidence: [],
    } as never);

    await answerObjective(state);
    const prompt = (generateText as Mock).mock.calls[0][0].prompt as string;
    expect(prompt).not.toContain("[S1]");
    expect(prompt).toContain("[no source cited]");
  });

  it("bounds the deliverable with an explicit output-token ceiling (anti-truncation)", async () => {
    (generateText as Mock).mockResolvedValue(fakeGenResult({ answer: "Lean no-go." }));
    await answerObjective(stateOf());
    // The 128k default max_tokens is the non-streaming truncation trap — the answer call must cap it.
    expect((generateText as Mock).mock.calls[0][0].maxOutputTokens).toBe(SYNTHESIS_ANSWER_MAX_TOKENS);
  });

  it("retries once and returns the COMPLETE answer when the first attempt is length-truncated", async () => {
    // The deliverable is non-negotiable: a finishReason "length" cut must not ship.
    (generateText as Mock)
      .mockResolvedValueOnce({ ...fakeGenResult({ answer: "VERDICT: NOT YET. Fault line 1 is" }), finishReason: "length" })
      .mockResolvedValueOnce({ ...fakeGenResult({ answer: "VERDICT: NOT YET. Full adjudication, all four fault lines." }), finishReason: "stop" });

    const out = await answerObjective(stateOf());
    expect((generateText as Mock)).toHaveBeenCalledTimes(2);
    expect(out.answer).toBe("VERDICT: NOT YET. Full adjudication, all four fault lines.");
  });

  it("keeps the fuller partial if BOTH attempts truncate (best effort, never blank)", async () => {
    (generateText as Mock)
      .mockResolvedValueOnce({ ...fakeGenResult({ answer: "short partial" }), finishReason: "length" })
      .mockResolvedValueOnce({ ...fakeGenResult({ answer: "a noticeably longer partial answer" }), finishReason: "length" });

    const out = await answerObjective(stateOf());
    expect((generateText as Mock)).toHaveBeenCalledTimes(2);
    expect(out.answer).toBe("a noticeably longer partial answer");
  });

  it("skips the call and returns an empty answer when the objective is empty", async () => {
    const out = await answerObjective(
      stateOf({ researchBrief: { subject: "", objective: "", constraints: [] } }),
    );
    expect(out.answer).toBe("");
    assertNoLlmCalls(); // no objective → nothing to adjudicate → no LLM spend
  });

  it("degrades to an empty answer on a thrown LLM error (run survives, no throw)", async () => {
    (generateText as Mock).mockRejectedValue(new Error("provider 500"));
    const out = await answerObjective(stateOf());
    expect(out.answer).toBe("");
    expect(out.usage).toBeUndefined();
  });
});

describe("recommend node (A5)", () => {
  it("attaches the generated answer to state and threads the call usage", async () => {
    (generateText as Mock).mockResolvedValue(fakeGenResult({ answer: "Landscape: fragmented, low-margin." }));
    const out = await recommend(stateOf());
    expect(out.answer).toBe("Landscape: fragmented, low-margin.");
    expect(out.converged).toBe(true);
    expect(out.llmCalls).toHaveLength(1);
    expect(out.llmCalls![0].label).toBe("synthesis:answer");
  });

  it("still returns a converged state (answer empty) when the answer call fails", async () => {
    (generateText as Mock).mockRejectedValue(new Error("boom"));
    const out = await recommend(stateOf());
    expect(out.answer).toBe("");
    expect(out.converged).toBe(true);
    expect(out.llmCalls).toBeUndefined(); // no usage to account for
  });
});

describe("ensureAnswer — the run always gets an answer (A5)", () => {
  it("generates the answer when the report has none (degraded before recommend), returning its usage", async () => {
    (generateText as Mock).mockResolvedValue(fakeGenResult({ answer: "produced on the degrade path" }));
    const state = stateOf({ answer: "" });
    const { report, usage } = await ensureAnswer(state, synthesizeReport(state));
    expect(report.answer).toBe("produced on the degrade path");
    // Usage is returned (not on state.llmCalls) so the runner can fold it into the token rollup.
    expect(usage).toHaveLength(1);
    expect(usage[0].label).toBe("synthesis:answer");
  });

  it("no-ops (no LLM call, no usage) when recommend already wrote the answer", async () => {
    const state = stateOf({ answer: "already adjudicated" });
    const { report, usage } = await ensureAnswer(state, synthesizeReport(state));
    expect(report.answer).toBe("already adjudicated");
    expect(usage).toEqual([]);
    assertNoLlmCalls();
  });
});

describe("synthesizeReport stays pure (A5)", () => {
  it("attaches objective + answer from state without any LLM call", () => {
    const report = synthesizeReport(stateOf({ answer: "the final answer" }));
    expect(report.objective).toBe("Decide go/no-go on a venture-scale freight brokerage bet");
    expect(report.answer).toBe("the final answer");
    // The load-bearing purity guarantee: synthesizeReport must never call the model.
    assertNoLlmCalls();
  });
});
