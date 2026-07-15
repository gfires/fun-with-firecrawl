import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { runDebate } from "@/lib/orchestration/committee";
import { MAX_DEBATE_ROUNDS } from "@/lib/params";
import { generateText } from "ai";
import { fakeGenResult } from "../helpers/mock-ai";
import type { Question } from "@/lib/schemas/state";
import type { Evidence } from "@/lib/schemas/evidence";
import type { AgentRoleT, ClaimStanceT } from "@/lib/schemas/claim";

// Only generateText is replaced; Output.object stays real (schema wiring still validates).
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn() };
});

const gen = generateText as unknown as Mock;

function q(): Question {
  return { id: "q1", text: "does it work", category: "cat", confidence: 0, resolved: false };
}

function ev(id: string): Evidence {
  return {
    id,
    url: "https://example.com",
    domain: "example.com",
    title: `title ${id}`,
    snippet: `snippet ${id}`,
    content: `content ${id}`,
    sourceQuery: "does it work",
    loopIteration: 0,
    contentHash: `h-${id}`,
  };
}

/** Which role a mocked call is for, read from the persona in its user message. */
function roleOf(messages: { role: string; content: string }[]): AgentRoleT {
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  if (user.includes("You are the HISTORIAN")) return "historian";
  if (user.includes("You are the OPERATOR")) return "operator";
  if (user.includes("You are the INVESTOR")) return "investor";
  return "skeptic";
}

/** True for a conversational turn (round >=1) — its system prefix carries the transcript. */
function isDebateTurn(messages: { role: string; content: string }[]): boolean {
  const sys = messages.find((m) => m.role === "system")?.content ?? "";
  return sys.includes("DEBATE SO FAR");
}

/** The round being built = how many "Round N:" blocks the prior transcript already holds. */
function roundBeingBuilt(messages: { role: string; content: string }[]): number {
  const sys = messages.find((m) => m.role === "system")?.content ?? "";
  return (sys.match(/Round \d+:/g) ?? []).length;
}

/** Round-0 opening confidences — a WIDE spread, kept for the movement-based stop tests. */
const OPENING_CONF: Record<AgentRoleT, number> = {
  historian: 0.85,
  operator: 0.8,
  investor: 0.82,
  skeptic: 0.45,
};

/**
 * Round-0 opening STANCES with a genuine split (three support, the skeptic opposes) so
 * hasGenuineDisagreement fires and the conversational rounds RUN — the debate decision now keys
 * on stance, not confidence spread.
 */
const OPENING_STANCE: Record<AgentRoleT, ClaimStanceT> = {
  historian: "supports",
  operator: "supports",
  investor: "supports",
  skeptic: "opposes",
};

function openingOutput(role: AgentRoleT) {
  return {
    conclusion: `${role} opening`,
    confidence: OPENING_CONF[role],
    stance: OPENING_STANCE[role],
    supportingEvidenceIds: ["e1"],
    contradictingEvidenceIds: [],
    missingEvidence: [],
    responses: [],
  };
}

// Brace the body: an arrow that *returns* mockReset()'s value (the mock itself) would be
// registered by Vitest as a cleanup hook and invoked with no args during teardown.
beforeEach(() => {
  gen.mockReset();
});

describe("runDebate", () => {
  it("skips the rounds when the openings show NO genuine disagreement — 4 calls, one round", async () => {
    // Every role opens with the SAME decisive stance ("supports") and no id-clash → agreement →
    // no conversational rounds. The decision keys on stance, not confidence.
    gen.mockImplementation(async (args: { messages: { role: string; content: string }[] }) => {
      const role = roleOf(args.messages);
      return fakeGenResult({
        conclusion: `${role} agrees`,
        confidence: 0.75,
        stance: "supports",
        supportingEvidenceIds: ["e1"],
        contradictingEvidenceIds: [],
        missingEvidence: [],
        responses: [],
      });
    });

    const result = await runDebate(q(), [ev("e1")]);
    // Round-0 openings only — the model is NOT called for any conversational round.
    expect(gen).toHaveBeenCalledTimes(4);
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0].round).toBe(0);
    expect(result.claims).toHaveLength(4);
    expect(result.claims.every((c) => c.debateRound === 0)).toBe(true);
  });

  it("skips the rounds when every role ABSTAINS (all 'insufficient') — shared uncertainty is not debate", async () => {
    gen.mockImplementation(async (args: { messages: { role: string; content: string }[] }) => {
      const role = roleOf(args.messages);
      return fakeGenResult({
        conclusion: `${role} can't tell`,
        confidence: 0.2,
        stance: "insufficient",
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        missingEvidence: ["no data"],
        responses: [],
      });
    });

    const result = await runDebate(q(), [ev("e1")]);
    expect(gen).toHaveBeenCalledTimes(4);
    expect(result.rounds).toHaveLength(1);
    expect(result.claims.every((c) => c.stance === "insufficient")).toBe(true);
  });

  it("RUNS the rounds on a supports+opposes split — the model IS called past round 0", async () => {
    // Three roles support, the skeptic opposes → genuine disagreement → conversational rounds run.
    // Each debate turn restates the opening (flat) so it converges after one round.
    gen.mockImplementation(async (args: { messages: { role: string; content: string }[] }) => {
      const role = roleOf(args.messages);
      if (!isDebateTurn(args.messages)) return fakeGenResult(openingOutput(role));
      return fakeGenResult({ ...openingOutput(role), responses: [] });
    });

    const result = await runDebate(q(), [ev("e1")]);
    expect(gen.mock.calls.some((c) => isDebateTurn(c[0].messages))).toBe(true);
    expect(result.rounds.map((r) => r.round)).toEqual([0, 1]);
  });

  it("threads each role's stance from the LLM onto the returned Claim", async () => {
    gen.mockImplementation(async (args: { messages: { role: string; content: string }[] }) => {
      const role = roleOf(args.messages);
      return fakeGenResult({ ...openingOutput(role), responses: [] });
    });
    const result = await runDebate(q(), [ev("e1")]);
    const byRole = Object.fromEntries(result.claims.map((c) => [c.agentRole, c.stance]));
    expect(byRole).toMatchObject(OPENING_STANCE);
  });

  it("clamps a missing or invalid stance from the LLM to 'insufficient'", async () => {
    // A drifting model that omits stance on one role and emits garbage on another must not throw;
    // the assembly coerces both to the abstention value.
    gen.mockImplementation(async (args: { messages: { role: string; content: string }[] }) => {
      const role = roleOf(args.messages);
      const base = { ...openingOutput(role), responses: [] } as Record<string, unknown>;
      if (role === "historian") delete base.stance; // missing
      if (role === "operator") base.stance = "maybe"; // invalid enum value
      return fakeGenResult(base);
    });
    const result = await runDebate(q(), [ev("e1")]);
    const byRole = Object.fromEntries(result.claims.map((c) => [c.agentRole, c.stance]));
    expect(byRole.historian).toBe("insufficient");
    expect(byRole.operator).toBe("insufficient");
  });

  it("stops early when a conversational round produces no movement", async () => {
    // Round 0 = wide spread (debates). Each debate turn simply RESTATES the role's opening
    // (same confidence, same ids, no rebuttals) → round 1 == round 0 → converged → stop.
    gen.mockImplementation(async (args: { messages: { role: string; content: string }[] }) => {
      const role = roleOf(args.messages);
      if (!isDebateTurn(args.messages)) return fakeGenResult(openingOutput(role));
      return fakeGenResult({ ...openingOutput(role), responses: [] });
    });

    const result = await runDebate(q(), [ev("e1")]);
    // 4 opening + 4 round-1 turns, then convergence stops it.
    expect(gen).toHaveBeenCalledTimes(8);
    expect(result.rounds.map((r) => r.round)).toEqual([0, 1]);
    expect(result.claims.every((c) => c.debateRound === 1)).toBe(true);
  });

  it("stops after one rebuttal round when roles keep rebutting but no position moves", async () => {
    // The churn case: round 0 = wide spread (debates). Every conversational turn RESTATES the
    // role's opening (flat confidence + ids) but the investor keeps firing a fresh rebuttal at the
    // skeptic. Old convergence (moved===0 && newRebuttals===0) let that rebuttal drag the debate to
    // the cap; now a round that moves NO position converges, so the debate exits after round 1 and
    // hands the surviving (evidential) gap to the gate instead of re-arguing frozen evidence.
    gen.mockImplementation(async (args: { messages: { role: string; content: string }[] }) => {
      const role = roleOf(args.messages);
      if (!isDebateTurn(args.messages)) return fakeGenResult(openingOutput(role));
      return fakeGenResult({
        ...openingOutput(role), // flat: same confidence + ids as the opening → moved === 0
        responses:
          role === "investor"
            ? [{ targetRole: "skeptic", stance: "rebut", point: "still unconvinced" }]
            : [],
      });
    });

    const result = await runDebate(q(), [ev("e1")]);
    // 4 opening + 4 round-1 turns, then convergence stops it — NOT dragged to the cap by rebuttals.
    expect(gen).toHaveBeenCalledTimes(8);
    expect(result.rounds.map((r) => r.round)).toEqual([0, 1]);
  });

  it("caps at MAX_DEBATE_ROUNDS when positions keep moving", async () => {
    // Confidence shifts by 0.1 (> epsilon) every conversational round → never converges.
    gen.mockImplementation(async (args: { messages: { role: string; content: string }[] }) => {
      const role = roleOf(args.messages);
      if (!isDebateTurn(args.messages)) return fakeGenResult(openingOutput(role));
      const round = roundBeingBuilt(args.messages);
      return fakeGenResult({
        ...openingOutput(role),
        confidence: Math.min(0.95, OPENING_CONF[role] + 0.1 * round),
        responses: [],
      });
    });

    const result = await runDebate(q(), [ev("e1")]);
    // 4 opening + 4 per conversational round, capped at MAX_DEBATE_ROUNDS.
    expect(gen).toHaveBeenCalledTimes(4 + 4 * MAX_DEBATE_ROUNDS);
    expect(result.rounds).toHaveLength(1 + MAX_DEBATE_ROUNDS);
    expect(result.rounds[result.rounds.length - 1].round).toBe(MAX_DEBATE_ROUNDS);
    expect(result.claims.every((c) => c.debateRound === MAX_DEBATE_ROUNDS)).toBe(true);
  });

  it("uses the round-0 model mix for openings and Haiku for round-1 constructive roles", async () => {
    gen.mockImplementation(async (args: { messages: { role: string; content: string }[] }) => {
      const role = roleOf(args.messages);
      if (!isDebateTurn(args.messages)) return fakeGenResult(openingOutput(role));
      return fakeGenResult({ ...openingOutput(role), responses: [] });
    });

    await runDebate(q(), [ev("e1")]);

    const modelIdByCall = gen.mock.calls.map((c) => ({
      debate: isDebateTurn(c[0].messages),
      role: roleOf(c[0].messages),
      modelId: c[0].model.modelId as string,
    }));
    // Round 0 constructive roles ran on Sonnet.
    const openHistorian = modelIdByCall.find((m) => !m.debate && m.role === "historian");
    expect(openHistorian?.modelId).toBe("claude-sonnet-5");
    // Round 1 constructive roles dropped to Haiku.
    const debateConstructive = modelIdByCall.filter(
      (m) => m.debate && m.role !== "skeptic",
    );
    expect(debateConstructive.length).toBeGreaterThan(0);
    expect(debateConstructive.every((m) => m.modelId.includes("haiku"))).toBe(true);
  });

  it("returns the final round's claims plus the full transcript", async () => {
    gen.mockImplementation(async (args: { messages: { role: string; content: string }[] }) => {
      const role = roleOf(args.messages);
      if (!isDebateTurn(args.messages)) return fakeGenResult(openingOutput(role));
      const round = roundBeingBuilt(args.messages);
      return fakeGenResult({
        ...openingOutput(role),
        confidence: Math.min(0.95, OPENING_CONF[role] + 0.1 * round),
        responses: [{ targetRole: "skeptic", stance: "rebut", point: "cite [e1]" }],
      });
    });

    const result = await runDebate(q(), [ev("e1")]);
    const lastRound = result.rounds[result.rounds.length - 1];
    // The durable claims ARE the final round's claims.
    expect(result.claims).toEqual(lastRound.claims);
    // Transcript carries every round in order.
    expect(result.rounds.map((r) => r.round)).toEqual(
      Array.from({ length: result.rounds.length }, (_, i) => i),
    );
  });
});
