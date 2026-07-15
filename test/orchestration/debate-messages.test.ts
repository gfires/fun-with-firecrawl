import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { buildDebateMessages, buildCommitteeMessages } from "@/lib/orchestration/committee";
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

/** The `system` messages (everything before the trailing `user` message). */
function systemMsgs(msgs: ModelMessage[]): ModelMessage[] {
  return msgs.slice(0, -1);
}
/** The full shared system prefix, concatenated across whatever cache blocks it was split into. */
function systemText(msgs: ModelMessage[]): string {
  return systemMsgs(msgs)
    .map((m) => m.content as string)
    .join("");
}
/** The per-role `user` message (always last). */
function userMsg(msgs: ModelMessage[]): ModelMessage {
  return msgs[msgs.length - 1];
}

describe("buildDebateMessages", () => {
  it("emits a byte-identical system prefix across the 3 Claude roles", () => {
    const h = buildDebateMessages("historian", q("q1"), BIG_BLOCK, transcript, undefined, 0);
    const o = buildDebateMessages("operator", q("q1"), BIG_BLOCK, transcript, undefined, 0);
    const i = buildDebateMessages("investor", q("q1"), BIG_BLOCK, transcript, undefined, 0);
    // Same cache-block structure AND byte-identical content/providerOptions across the 3 roles.
    expect(JSON.stringify(systemMsgs(h))).toBe(JSON.stringify(systemMsgs(o)));
    expect(JSON.stringify(systemMsgs(h))).toBe(JSON.stringify(systemMsgs(i)));
  });

  it("renders the prior transcript into the system prefix", () => {
    const msgs = buildDebateMessages("historian", q("q1"), BIG_BLOCK, transcript, undefined, 0);
    const sys = systemText(msgs);
    expect(sys).toContain("DEBATE SO FAR");
    expect(sys).toContain("Round 0:");
    expect(sys).toContain("Round 1:");
  });

  it("puts the challenges aimed at a role in the user message, not the system prefix", () => {
    const msgs = buildDebateMessages("historian", q("q1"), BIG_BLOCK, transcript, undefined, 0);
    const user = userMsg(msgs);
    // the investor's rebuttal targets the historian
    expect(user.content).toContain("CHALLENGES AIMED AT YOU");
    expect(user.content).toContain("survivorship-biased");
    expect(user.content).toContain("[investor]");
    // the transcript in the system prefix DOES restate the debate, but the directed
    // "CHALLENGES AIMED AT YOU" instruction block is user-only.
    expect(systemText(msgs)).not.toContain("CHALLENGES AIMED AT YOU");
  });

  it("notes when no peer challenged the role directly", () => {
    // the operator was targeted by nobody in the latest round
    const msgs = buildDebateMessages("operator", q("q1"), BIG_BLOCK, transcript, undefined, 0);
    expect(userMsg(msgs).content).toContain("No peer challenged you directly");
  });

  it("includes the role's own prior turn in the user message when provided", () => {
    const prior = claim("historian", { conclusion: "my earlier take", confidence: 0.55 });
    const msgs = buildDebateMessages("historian", q("q1"), BIG_BLOCK, transcript, prior, 0);
    expect(userMsg(msgs).content).toContain("YOUR PRIOR TURN");
    expect(userMsg(msgs).content).toContain("my earlier take");
    expect(systemText(msgs)).not.toContain("YOUR PRIOR TURN");
  });

  it("gives the skeptic no anthropic providerOptions (single un-cached system message)", () => {
    const msgs = buildDebateMessages("skeptic", q("q1"), BIG_BLOCK, transcript, undefined, 0);
    // Skeptic runs on OpenAI: the prefix stays one plain system message, no anthropic options.
    expect(systemMsgs(msgs)).toHaveLength(1);
    for (const m of systemMsgs(msgs)) expect(cacheControl(m)).toBeUndefined();
  });

  it("attaches cacheControl to every Claude system block only above the char threshold", () => {
    const big = buildDebateMessages("historian", q("q1"), BIG_BLOCK, transcript, undefined, 0);
    const small = buildDebateMessages("historian", q("q1"), SMALL_BLOCK, transcript, undefined, 0);

    // Big prefix: split into head + transcript, EACH carrying a cache breakpoint.
    expect(systemMsgs(big)).toHaveLength(2);
    expect(systemText(big).length).toBeGreaterThan(PROMPT_CACHE_MIN_CHARS);
    for (const m of systemMsgs(big)) expect(cacheControl(m)).toEqual({ type: "ephemeral" });

    // Small prefix: not worth caching — one plain system message, no breakpoints.
    expect(systemMsgs(small)).toHaveLength(1);
    expect(systemText(small).length).toBeLessThan(PROMPT_CACHE_MIN_CHARS);
    expect(cacheControl(systemMsgs(small)[0])).toBeUndefined();
  });

  const OBJECTIVE = "Adjudicate whether freight brokerage can support a venture outcome";

  it("prepends the RESEARCH OBJECTIVE to the system prefix, byte-identical across the 3 Claude roles", () => {
    const h = buildDebateMessages("historian", q("q1"), BIG_BLOCK, transcript, undefined, 0, OBJECTIVE);
    const o = buildDebateMessages("operator", q("q1"), BIG_BLOCK, transcript, undefined, 0, OBJECTIVE);
    const i = buildDebateMessages("investor", q("q1"), BIG_BLOCK, transcript, undefined, 0, OBJECTIVE);
    expect(systemText(h)).toContain("RESEARCH OBJECTIVE");
    expect(systemText(h)).toContain(OBJECTIVE);
    expect(systemText(h)).toBe(systemText(o));
    expect(systemText(h)).toBe(systemText(i));
  });

  it("omits the objective block when none is supplied (pre-A4 behavior)", () => {
    const msgs = buildDebateMessages("historian", q("q1"), BIG_BLOCK, transcript, undefined, 0);
    expect(systemText(msgs)).not.toContain("RESEARCH OBJECTIVE");
  });

  it("gives the skeptic no cacheControl even with an objective above threshold", () => {
    const msgs = buildDebateMessages("skeptic", q("q1"), BIG_BLOCK, transcript, undefined, 0, OBJECTIVE);
    for (const m of systemMsgs(msgs)) expect(cacheControl(m)).toBeUndefined();
  });

  it("leaves the role persona (ROLE_SYSTEM_PROMPTS) intact in the user message with an objective present", () => {
    const msgs = buildDebateMessages("skeptic", q("q1"), BIG_BLOCK, transcript, undefined, 0, OBJECTIVE);
    // The skeptic can now attack the actual bet — but its persona incentive is unchanged.
    expect(userMsg(msgs).content).toContain("Your incentive is DISCONFIRMATION.");
    expect(userMsg(msgs).content).not.toContain("RESEARCH OBJECTIVE");
  });
});

// These verify the STRUCTURAL preconditions for Anthropic CROSS-ROUND prompt caching: the stable
// head must be its OWN cache block, byte-identical every round (and identical to the opening
// committee round), so Anthropic serves it from cache instead of re-writing it each round. (Actual
// cache HITS need live calls — see scripts/cache-probe.ts; what we assert offline is the structure.)
describe("buildDebateMessages — cross-round cache structure", () => {
  const OBJ = "Adjudicate the freight brokerage bet";
  const r0: DebateRound = transcript[0];
  const r1: DebateRound = transcript[1];
  const build = (rounds: DebateRound[]) =>
    buildDebateMessages("historian", q("q1"), BIG_BLOCK, rounds, undefined, 0, OBJ);

  it("splits the prefix into a stable HEAD block and a TRANSCRIPT block, each with its own breakpoint", () => {
    const sys = systemMsgs(build([r0, r1]));
    expect(sys).toHaveLength(2);
    const [head, tail] = sys;
    // The head holds objective + question + evidence + calibration, and NOT the transcript.
    expect(head.content).toContain("CONFIDENCE CALIBRATION");
    expect(head.content).not.toContain("DEBATE SO FAR");
    // The transcript is its own block after the head.
    expect(tail.content).toContain("DEBATE SO FAR");
    // Both carry a cache breakpoint (head → cross-round reuse, tail → within-round reuse).
    expect(cacheControl(head)).toEqual({ type: "ephemeral" });
    expect(cacheControl(tail)).toEqual({ type: "ephemeral" });
  });

  it("keeps the HEAD block byte-identical as the transcript grows (this is the cross-round cache key)", () => {
    const head1 = systemMsgs(build([r0]))[0].content as string;
    const head2 = systemMsgs(build([r0, r1]))[0].content as string;
    // The head does not change round-to-round → Anthropic serves it from cache every round.
    expect(head2).toBe(head1);
  });

  it("places the confidence calibration BEFORE the transcript (head precedes the growing transcript)", () => {
    const sys = systemText(build([r0, r1]));
    expect(sys.indexOf("CONFIDENCE CALIBRATION")).toBeGreaterThanOrEqual(0);
    expect(sys.indexOf("CONFIDENCE CALIBRATION")).toBeLessThan(sys.indexOf("DEBATE SO FAR"));
  });

  it("is append-only across rounds: round N's system prefix is a byte-prefix of round N+1's", () => {
    const sys1 = systemText(build([r0])); // rounds 0
    const sys2 = systemText(build([r0, r1])); // rounds 0..1
    expect(sys2.startsWith(sys1)).toBe(true);
    expect(sys2.length).toBeGreaterThan(sys1.length); // the newest round is the only delta
  });

  it("shares the HEAD block with the opening committee round, so its evidence + calibration is cached across phases", () => {
    // Same objective/question/evidence → the committee's stable head IS the debate's head block,
    // so Anthropic serves the opening round's evidence + calibration from cache in the debate too.
    const committeeHead = buildCommitteeMessages("historian", q("q1"), BIG_BLOCK, 0, undefined, OBJ)[0]
      .content as string;
    const debateHead = systemMsgs(build([r0]))[0].content as string;
    expect(debateHead).toBe(committeeHead);
  });
});
