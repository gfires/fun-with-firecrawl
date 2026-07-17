/**
 * replay-slim.test.ts — locks in the evidence-content trim contract shared by the fixture
 * extraction script and the live run-persistence write path.
 */
import { describe, it, expect } from "vitest";
import { slimReplayEvent, EVIDENCE_CONTENT_CAP } from "@/lib/orchestration/replay-slim";
import type { ResearchEvent } from "@/lib/research-events";
import type { Evidence } from "@/lib/schemas/evidence";

function makeEvidence(content: string): Evidence {
  return {
    url: "https://a.com/x",
    title: "A title",
    snippet: "a snippet",
    content,
    contentHash: "hash1",
    sourceQuery: "some query",
    questionId: "q1",
  } as Evidence;
}

describe("slimReplayEvent", () => {
  it("trims retrieve:evidence content longer than the cap", () => {
    const longContent = "x".repeat(EVIDENCE_CONTENT_CAP + 500);
    const event: ResearchEvent = { type: "retrieve:evidence", evidence: makeEvidence(longContent), questionId: "q1" };

    const slimmed = slimReplayEvent(event) as Extract<ResearchEvent, { type: "retrieve:evidence" }>;

    expect(slimmed.evidence.content).toHaveLength(EVIDENCE_CONTENT_CAP);
    expect(slimmed.evidence.content).toBe(longContent.slice(0, EVIDENCE_CONTENT_CAP));
  });

  it("leaves retrieve:evidence content that's already under the cap unchanged (no padding)", () => {
    const shortContent = "short content";
    const event: ResearchEvent = { type: "retrieve:evidence", evidence: makeEvidence(shortContent), questionId: "q1" };

    const slimmed = slimReplayEvent(event) as Extract<ResearchEvent, { type: "retrieve:evidence" }>;

    expect(slimmed.evidence.content).toBe(shortContent);
  });

  it("passes through non-evidence events unchanged", () => {
    const event: ResearchEvent = { type: "research:start", topic: "freight brokerage" };
    expect(slimReplayEvent(event)).toEqual(event);

    const doneEvent: ResearchEvent = {
      type: "retrieve:done",
      loopIteration: 0,
      evidenceCount: 3,
      firecrawlCalls: 2,
    };
    expect(slimReplayEvent(doneEvent)).toEqual(doneEvent);
  });
});
