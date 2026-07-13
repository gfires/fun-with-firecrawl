import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { runCommittee } from "@/lib/orchestration/committee";
import type { Question } from "@/lib/schemas/state";
import type { Evidence } from "@/lib/schemas/evidence";
import { fakeGenResult } from "../helpers/mock-ai";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn() };
});

function q(id: string): Question {
  return { id, text: `q ${id}`, category: "cat", confidence: 0, resolved: false };
}

function ev(id: string): Evidence {
  return {
    id,
    url: `https://example.com/${id}`,
    domain: "example.com",
    title: `title ${id}`,
    snippet: `snippet ${id}`,
    content: `content ${id}`,
    sourceQuery: "q q1",
    loopIteration: 0,
    contentHash: `h-${id}`,
  };
}

/** A schema-valid ClaimOutput the mocked generateText hands back for every role. */
const FAKE_OUTPUT = {
  conclusion: "c",
  confidence: 0.5,
  supportingEvidenceIds: ["e1"],
  contradictingEvidenceIds: [],
  missingEvidence: [],
};

describe("runCommittee → generateText call shape", () => {
  beforeEach(async () => {
    const { generateText } = await import("ai");
    (generateText as Mock).mockReset();
    (generateText as Mock).mockResolvedValue(fakeGenResult(FAKE_OUTPUT, { inputTokens: 10, outputTokens: 5 }));
  });

  it("passes allowSystemInMessages so the SDK accepts the cacheable system message", async () => {
    // Reproduces the AI_InvalidPromptError regression: buildCommitteeMessages emits a
    // `system` message, which generateText rejects unless allowSystemInMessages is set.
    const { generateText } = await import("ai");
    await runCommittee(q("q1"), [ev("e1")]);

    expect((generateText as Mock)).toHaveBeenCalledTimes(4); // one per role
    for (const call of (generateText as Mock).mock.calls) {
      const opts = call[0];
      expect(opts.allowSystemInMessages).toBe(true);
      expect(opts.messages[0].role).toBe("system");
      expect(opts.messages[1].role).toBe("user");
    }
  });
});
