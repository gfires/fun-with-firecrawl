import { describe, it, expect } from "vitest";
import { buildDebateMessages } from "@/lib/orchestration/committee";
import { PROMPT_CACHE_MIN_CHARS } from "@/lib/params";
import type { DebateRound } from "@/lib/orchestration/debate";
import type { Question } from "@/lib/schemas/state";
import type { AgentRoleT, Claim, DebateResponse } from "@/lib/schemas/claim";

function q(id: string, overrides: Partial<Question> = {}): Question {
  return { id, text: `q ${id}`, category: "cat", confidence: 0, resolved: false, ...overrides };
}

function claim(role: AgentRoleT, overrides: Partial<Claim> = {}): Claim {
  return {
    id: `q1:${role}:0`,
    questionId: "q1",
    agentRole: role,
    conclusion: `${role} conclusion`,
    confidence: 0.6,
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingEvidence: [],
    loopIteration: 0,
    debateRound: 0,
    responses: [],
    ...overrides,
  };
}

function resp(targetRole: AgentRoleT, stance: DebateResponse["stance"], point: string): DebateResponse {
  return { targetRole, stance, point };
}

/** A big evidence block that pushes the shared system prefix past the cache threshold. */
const BIG_BLOCK = "[e1] " + "evidence ".repeat(800);
const SMALL_BLOCK = "[e1] tiny";

/** Latest round in which the investor rebuts the historian with a distinctive point. */
const transcript: DebateRound[] = [
  {
    round: 0,
    claims: [claim("historian", { confidence: 0.7 }), claim("investor", { confidence: 0.5 })],
  },
  {
    round: 1,
    claims: [
      claim("investor", {
        responses: [resp("historian", "rebut", "the precedent is survivorship-biased, cite [e1]")],
      }),
    ],
  },
];

function cacheControl(msg: unknown): unknown {
  const opts = (msg as { providerOptions?: { anthropic?: { cacheControl?: unknown } } }).providerOptions;
  return opts?.anthropic?.cacheControl;
}

describe("buildDebateMessages", () => {
  it("emits a byte-identical system prefix across the 3 Claude roles", () => {
    const [h] = buildDebateMessages("historian", q("q1"), BIG_BLOCK, transcript, undefined, 0);
    const [o] = buildDebateMessages("operator", q("q1"), BIG_BLOCK, transcript, undefined, 0);
    const [i] = buildDebateMessages("investor", q("q1"), BIG_BLOCK, transcript, undefined, 0);
    expect(h.content).toBe(o.content);
    expect(h.content).toBe(i.content);
  });

  it("renders the prior transcript into the system message", () => {
    const [system] = buildDebateMessages("historian", q("q1"), BIG_BLOCK, transcript, undefined, 0);
    expect(system.content).toContain("DEBATE SO FAR");
    expect(system.content).toContain("Round 0:");
    expect(system.content).toContain("Round 1:");
  });

  it("puts the challenges aimed at a role in the user message, not the system message", () => {
    const [system, user] = buildDebateMessages("historian", q("q1"), BIG_BLOCK, transcript, undefined, 0);
    // the investor's rebuttal targets the historian
    expect(user.content).toContain("CHALLENGES AIMED AT YOU");
    expect(user.content).toContain("survivorship-biased");
    expect(user.content).toContain("[investor]");
    // the transcript in the system message DOES restate the debate, but the directed
    // "CHALLENGES AIMED AT YOU" instruction block is user-only.
    expect(system.content).not.toContain("CHALLENGES AIMED AT YOU");
  });

  it("notes when no peer challenged the role directly", () => {
    // the operator was targeted by nobody in the latest round
    const [, user] = buildDebateMessages("operator", q("q1"), BIG_BLOCK, transcript, undefined, 0);
    expect(user.content).toContain("No peer challenged you directly");
  });

  it("includes the role's own prior turn in the user message when provided", () => {
    const prior = claim("historian", { conclusion: "my earlier take", confidence: 0.55 });
    const [system, user] = buildDebateMessages("historian", q("q1"), BIG_BLOCK, transcript, prior, 0);
    expect(user.content).toContain("YOUR PRIOR TURN");
    expect(user.content).toContain("my earlier take");
    expect(system.content).not.toContain("YOUR PRIOR TURN");
  });

  it("gives the skeptic no anthropic providerOptions", () => {
    const [system] = buildDebateMessages("skeptic", q("q1"), BIG_BLOCK, transcript, undefined, 0);
    expect(cacheControl(system)).toBeUndefined();
  });

  it("attaches cacheControl to a Claude role only above the char threshold", () => {
    const [big] = buildDebateMessages("historian", q("q1"), BIG_BLOCK, transcript, undefined, 0);
    const [small] = buildDebateMessages("historian", q("q1"), SMALL_BLOCK, transcript, undefined, 0);
    expect((big.content as string).length).toBeGreaterThan(PROMPT_CACHE_MIN_CHARS);
    expect(cacheControl(big)).toEqual({ type: "ephemeral" });
    expect((small.content as string).length).toBeLessThan(PROMPT_CACHE_MIN_CHARS);
    expect(cacheControl(small)).toBeUndefined();
  });
});
