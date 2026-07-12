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

  it("adds the role's prior claim with an update instruction on a re-debate", () => {
    const prior: Claim = {
      id: "q1:historian:0",
      questionId: "q1",
      agentRole: "historian",
      conclusion: "prior conclusion text",
      confidence: 0.42,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      missingEvidence: ["need pricing data"],
      loopIteration: 0,
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
