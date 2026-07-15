import { describe, it, expect } from "vitest";
import { buildCommitteeMessages } from "@/lib/orchestration/committee";
import { PROMPT_CACHE_MIN_CHARS } from "@/lib/params";
import type { Question } from "@/lib/schemas/state";
import type { Claim } from "@/lib/schemas/claim";

function q(id: string, overrides: Partial<Question> = {}): Question {
  return { id, text: `q ${id}`, category: "cat", confidence: 0, resolved: false, ...overrides };
}

/** An evidence block long enough to push the shared system prefix past the cache threshold. */
const BIG_BLOCK = "[e1] " + "evidence ".repeat(800); // ~6.4k chars
const SMALL_BLOCK = "[e1] tiny";

/** Read a message's anthropic cacheControl, if present (union type — cast for the probe). */
function cacheControl(msg: unknown): unknown {
  const opts = (msg as { providerOptions?: { anthropic?: { cacheControl?: unknown } } }).providerOptions;
  return opts?.anthropic?.cacheControl;
}

describe("buildCommitteeMessages", () => {
  it("emits a byte-identical system prefix across the 3 Claude roles", () => {
    const [hSys] = buildCommitteeMessages("historian", q("q1"), BIG_BLOCK, 0);
    const [oSys] = buildCommitteeMessages("operator", q("q1"), BIG_BLOCK, 0);
    const [iSys] = buildCommitteeMessages("investor", q("q1"), BIG_BLOCK, 0);
    expect(hSys.content).toBe(oSys.content);
    expect(hSys.content).toBe(iSys.content);
  });

  it("puts the role persona in the user message, never in the system message", () => {
    const [system, user] = buildCommitteeMessages("historian", q("q1"), BIG_BLOCK, 0);
    // ROLE_SYSTEM_PROMPTS.historian opens with "You are the HISTORIAN".
    expect(user.content).toContain("HISTORIAN");
    expect(system.content).not.toContain("HISTORIAN");
  });

  it("anchors every role's user message to the evidence in the system message", () => {
    // The L3 cache split moved QUESTION + EVIDENCE into the system message. Without an explicit
    // pointer from the user message, a role can confabulate that no evidence was supplied (the
    // historian did exactly this in a real run). The anchor prevents that, and — because it lives
    // in the per-role user message — it must NOT disturb the shared, cacheable system prefix.
    for (const role of ["historian", "operator", "investor", "skeptic"] as const) {
      const [system, user] = buildCommitteeMessages(role, q("q1"), BIG_BLOCK, 0);
      expect(user.content).toContain("system message above");
      expect(system.content).not.toContain("system message above");
    }
  });

  it("tells the historian to distinguish 'no precedent' from 'no evidence'", () => {
    // The historian persona used to license "absence of history is itself a finding", which Sonnet
    // over-generalized into "no evidence was supplied at all". The guard forbids that specific move.
    const [, user] = buildCommitteeMessages("historian", q("q1"), BIG_BLOCK, 0);
    expect(user.content).toContain("NEVER claim you were given no evidence");
  });

  it("attaches anthropic cacheControl to a Claude role only above the char threshold", () => {
    const [bigSys] = buildCommitteeMessages("historian", q("q1"), BIG_BLOCK, 0);
    const [smallSys] = buildCommitteeMessages("historian", q("q1"), SMALL_BLOCK, 0);
    expect((bigSys.content as string).length).toBeGreaterThan(PROMPT_CACHE_MIN_CHARS);
    expect(cacheControl(bigSys)).toEqual({ type: "ephemeral" });
    expect(cacheControl(smallSys)).toBeUndefined();
  });

  it("never attaches anthropic cacheControl for the skeptic (OpenAI), even above threshold", () => {
    const [skepticSys] = buildCommitteeMessages("skeptic", q("q1"), BIG_BLOCK, 0);
    expect(cacheControl(skepticSys)).toBeUndefined();
  });

  const OBJECTIVE = "Decide go/no-go on AI-native contract review for mid-market law firms";

  it("prepends the RESEARCH OBJECTIVE to the system prefix, byte-identical across the 3 Claude roles", () => {
    const [hSys] = buildCommitteeMessages("historian", q("q1"), BIG_BLOCK, 0, undefined, OBJECTIVE);
    const [oSys] = buildCommitteeMessages("operator", q("q1"), BIG_BLOCK, 0, undefined, OBJECTIVE);
    const [iSys] = buildCommitteeMessages("investor", q("q1"), BIG_BLOCK, 0, undefined, OBJECTIVE);
    // In the SHARED system prefix (L3), and identical across roles → cache invariant holds.
    expect(hSys.content).toContain("RESEARCH OBJECTIVE");
    expect(hSys.content).toContain(OBJECTIVE);
    expect(hSys.content).toBe(oSys.content);
    expect(hSys.content).toBe(iSys.content);
  });

  it("omits the objective block entirely when no objective is supplied (pre-A4 behavior)", () => {
    const [sys] = buildCommitteeMessages("historian", q("q1"), BIG_BLOCK, 0);
    expect(sys.content).not.toContain("RESEARCH OBJECTIVE");
  });

  it("keeps the objective out of the per-role user message (it's shared context, not a persona)", () => {
    const [, user] = buildCommitteeMessages("historian", q("q1"), BIG_BLOCK, 0, undefined, OBJECTIVE);
    expect(user.content).not.toContain("RESEARCH OBJECTIVE");
    expect(user.content).not.toContain(OBJECTIVE);
  });

  it("still gives the skeptic no cacheControl even with an objective above the char threshold", () => {
    const [sys] = buildCommitteeMessages("skeptic", q("q1"), BIG_BLOCK, 0, undefined, OBJECTIVE);
    expect(cacheControl(sys)).toBeUndefined();
  });

  it("leaves ROLE_SYSTEM_PROMPTS untouched — each role's signature incentive is verbatim in the user message", () => {
    // Guard the invariant: threading the objective must NOT rewrite or soften a persona. Each
    // role's distinctive incentive line must still appear byte-for-byte in its user message,
    // whether or not an objective is present.
    const incentives: Record<string, string> = {
      historian: "Your incentive is PRECEDENT.",
      operator: "Your incentive is REALITY ON THE GROUND.",
      investor: "Your incentive is RETURN.",
      skeptic: "Your incentive is DISCONFIRMATION.",
    };
    for (const [role, line] of Object.entries(incentives)) {
      const [, withObj] = buildCommitteeMessages(role as never, q("q1"), BIG_BLOCK, 0, undefined, OBJECTIVE);
      const [, without] = buildCommitteeMessages(role as never, q("q1"), BIG_BLOCK, 0);
      expect(withObj.content).toContain(line);
      expect(without.content).toContain(line);
    }
  });

  it("adds the role's prior claim with an update instruction on a re-debate", () => {
    const prior: Claim = {
      id: "q1:historian:0",
      questionId: "q1",
      agentRole: "historian",
      conclusion: "prior conclusion text",
      confidence: 0.42,
      stance: "insufficient",
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      missingEvidence: ["need pricing data"],
      loopIteration: 0,
      debateRound: 0,
      responses: [],
    };
    const [system, user] = buildCommitteeMessages("historian", q("q1"), BIG_BLOCK, 1, prior);
    expect(user.content).toContain("YOUR PRIOR CLAIM");
    expect(user.content).toContain("prior conclusion text");
    expect(user.content).toContain("need pricing data");
    expect(user.content).toContain("Render your UPDATED Claim now");
    // Prior claim varies per role — it must stay OUT of the shared (cacheable) system prefix.
    expect(system.content).not.toContain("prior conclusion text");
  });
});
