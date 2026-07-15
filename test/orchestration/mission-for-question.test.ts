/**
 * mission-for-question.test.ts — P4 coverage for missionForQuestion, re-covering the landmine the
 * deleted refine.test.ts guarded: the gate increments loopIteration BEFORE the loop-back, so
 * final-round claims carry the PRE-increment loop, and missionForQuestion must NOT filter claims by
 * `=== state.loopIteration` (§7: "does NOT filter claims by loopIteration; empty when no evidential
 * contention"). Fixtures are lifted from the old refine.test.ts.
 */
import { describe, it, expect } from "vitest";
import { missionForQuestion } from "@/lib/orchestration/graph";
import { fallbackBrief } from "@/lib/schemas/brief";
import type { ResearchStateT, Question } from "@/lib/schemas/state";
import type { AgentRoleT, Claim, DebateResponse } from "@/lib/schemas/claim";
import type { DebateRound } from "@/lib/orchestration/debate";

function q(id: string, o: Partial<Question> = {}): Question {
  return { id, text: `q ${id}`, category: "cat", confidence: 0, resolved: false, ...o };
}
function resp(targetRole: AgentRoleT, stance: DebateResponse["stance"]): DebateResponse {
  return { targetRole, stance, point: "p" };
}
function claim(role: AgentRoleT, o: Partial<Claim> = {}): Claim {
  return {
    id: `q1:${role}:0`, questionId: "q1", agentRole: role, conclusion: `${role} take`,
    confidence: 0.4, stance: "insufficient", supportingEvidenceIds: [], contradictingEvidenceIds: [], missingEvidence: [],
    loopIteration: 0, debateRound: 1, responses: [], ...o,
  };
}

// Final debate round with an unresolved evidential contention: historian rebuts investor (who does
// not concede back) and the historian names a missing-evidence gap → an EVIDENTIAL fault line.
const historian = claim("historian", {
  responses: [resp("investor", "rebut")],
  missingEvidence: ["mid-market deal sizes / annual spend per firm"],
});
const investor = claim("investor");
const finalRound: DebateRound = { round: 1, claims: [historian, investor] };

function stateOf(over: Partial<ResearchStateT> = {}): ResearchStateT {
  return {
    topic: "t",
    researchBrief: fallbackBrief("t"),
    questions: [q("q1")],
    // The claims carry loopIteration 0 (the loop they were debated in); the gate has since
    // incremented state.loopIteration to 1 — the exact condition that used to make refine no-op.
    claims: [historian, investor],
    debateTranscripts: { q1: [{ round: 0, claims: [historian, investor] }, finalRound] },
    loopIteration: 1,
    evidence: [],
    answer: "",
    searchedQueries: [],
    ...over,
  } as ResearchStateT;
}

describe("missionForQuestion — loop >= 1 (off-by-one regression)", () => {
  it("[landmine 2] surfaces the named gap even though the claims carry loop 0 while state is loop 1", () => {
    const mission = missionForQuestion(stateOf(), q("q1"));
    // Regression: refine used to filter claims by === state.loopIteration (=1) while the claims were
    // tagged loop 0, found no gaps, and no-op'd. The gap must reach the mission.
    expect(mission).toContain("mid-market deal sizes / annual spend per firm");
    expect(mission.trim().length).toBeGreaterThan(0);
  });

  it("returns '' when there is no evidential contention (aligned committee)", () => {
    const noGap: DebateRound = { round: 1, claims: [claim("historian"), claim("investor")] };
    const mission = missionForQuestion(
      stateOf({ debateTranscripts: { q1: [noGap] }, claims: noGap.claims }),
      q("q1"),
    );
    expect(mission).toBe("");
  });
});

describe("missionForQuestion — loop 0", () => {
  it("returns a non-empty recon mission that mentions the question's keyword queries", () => {
    const question = q("q1", { searchQueries: ["mid-market law firm AI contract review pricing"] });
    const mission = missionForQuestion(
      stateOf({ loopIteration: 0, questions: [question], claims: [], debateTranscripts: {} }),
      question,
    );
    expect(mission.trim().length).toBeGreaterThan(0);
    expect(mission).toContain("mid-market law firm AI contract review pricing");
  });

  it("falls back to the question text when no keyword queries are set", () => {
    const question = q("qX", { text: "how big is the widget market" });
    const mission = missionForQuestion(
      stateOf({ loopIteration: 0, questions: [question], claims: [], debateTranscripts: {} }),
      question,
    );
    expect(mission).toContain("how big is the widget market");
  });
});
