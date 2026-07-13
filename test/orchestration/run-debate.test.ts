import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { runDebate } from "@/lib/orchestration/committee";
import { MAX_DEBATE_ROUNDS } from "@/lib/params";
import { generateText } from "ai";
import { fakeGenResult } from "../helpers/mock-ai";
import type { Question } from "@/lib/schemas/state";
import type { Evidence } from "@/lib/schemas/evidence";
import type { AgentRoleT } from "@/lib/schemas/claim";

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

/** Round-0 opening confidences — a WIDE spread so the consensus fast-path never fires. */
const OPENING_CONF: Record<AgentRoleT, number> = {
  historian: 0.85,
  operator: 0.8,
  investor: 0.82,
  skeptic: 0.45,
};

function openingOutput(role: AgentRoleT) {
  return {
    conclusion: `${role} opening`,
    confidence: OPENING_CONF[role],
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
  it("skips the debate on round-0 consensus — exactly 4 calls, one round", async () => {
    // Tight, high, contradiction-free openings → genuine consensus → no conversational rounds.
    gen.mockImplementation(async (args: { messages: { role: string; content: string }[] }) => {
      const role = roleOf(args.messages);
      return fakeGenResult({
        conclusion: `${role} agrees`,
        confidence: 0.75,
        supportingEvidenceIds: ["e1"],
        contradictingEvidenceIds: [],
        missingEvidence: [],
        responses: [],
      });
    });

    const result = await runDebate(q(), [ev("e1")]);
    expect(gen).toHaveBeenCalledTimes(4);
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0].round).toBe(0);
    expect(result.claims).toHaveLength(4);
    expect(result.claims.every((c) => c.debateRound === 0)).toBe(true);
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
