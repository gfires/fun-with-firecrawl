import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import {
  clampDigest,
  buildDigestPrompt,
  formatDigestForCommittee,
  digestEvidence,
  type DigestItem,
} from "@/lib/orchestration/digest";
import { mergeDigests } from "@/lib/schemas/state";
import { MAX_DIGEST_SUMMARY_CHARS, MAX_EVIDENCE_CHARS_PER_AGENT } from "@/lib/params";
import type { Question } from "@/lib/schemas/state";
import type { Evidence } from "@/lib/schemas/evidence";
import { fakeGenResult } from "../helpers/mock-ai";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn() };
});

function q(id: string, overrides: Partial<Question> = {}): Question {
  return { id, text: `q ${id}`, category: "cat", confidence: 0, resolved: false, ...overrides };
}

function ev(id: string, overrides: Partial<Evidence> = {}): Evidence {
  return {
    id,
    url: `https://example.com/${id}`,
    domain: "example.com",
    title: `title ${id}`,
    snippet: `snippet ${id}`,
    content: `content ${id}`,
    sourceQuery: "q",
    loopIteration: 0,
    contentHash: `h-${id}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// clampDigest
// ---------------------------------------------------------------------------

describe("clampDigest", () => {
  it("drops items whose id was invented (not in validIds)", () => {
    const raw: DigestItem[] = [
      { evidenceId: "e1", summary: "real" },
      { evidenceId: "ghost", summary: "invented" },
    ];
    const out = clampDigest(raw, new Set(["e1"]));
    expect(out.map((i) => i.evidenceId)).toEqual(["e1"]);
  });

  it("truncates summaries to MAX_DIGEST_SUMMARY_CHARS", () => {
    const raw: DigestItem[] = [{ evidenceId: "e1", summary: "x".repeat(MAX_DIGEST_SUMMARY_CHARS + 250) }];
    const out = clampDigest(raw, new Set(["e1"]));
    expect(out[0].summary).toHaveLength(MAX_DIGEST_SUMMARY_CHARS);
  });

  it("dedupes by id, keeping the first occurrence", () => {
    const raw: DigestItem[] = [
      { evidenceId: "e1", summary: "first" },
      { evidenceId: "e1", summary: "second" },
    ];
    const out = clampDigest(raw, new Set(["e1"]));
    expect(out).toHaveLength(1);
    expect(out[0].summary).toBe("first");
  });

  // Regression: Haiku echoes the id WITH the brackets it saw in the prompt
  // (evidenceId: "[e1]"). Those items must still match the bare evidence id, and the
  // returned id must be bare so formatDigestForCommittee can look it up by e.id.
  it("normalizes a bracket-wrapped id and keeps the item", () => {
    const out = clampDigest([{ evidenceId: "[e1]", summary: "real" }], new Set(["e1"]));
    expect(out).toEqual([{ evidenceId: "e1", summary: "real" }]);
  });

  it("still drops a bracket-wrapped id that isn't a real evidence id", () => {
    const out = clampDigest([{ evidenceId: "[ghost]", summary: "invented" }], new Set(["e1"]));
    expect(out).toEqual([]);
  });

  it("treats the bracketed and bare forms of the same id as one (dedupe after normalize)", () => {
    const raw: DigestItem[] = [
      { evidenceId: "[e1]", summary: "first" },
      { evidenceId: "e1", summary: "second" },
    ];
    const out = clampDigest(raw, new Set(["e1"]));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ evidenceId: "e1", summary: "first" });
  });
});

// ---------------------------------------------------------------------------
// buildDigestPrompt
// ---------------------------------------------------------------------------

describe("buildDigestPrompt", () => {
  it("includes every evidence id exactly once", () => {
    const evidence = [ev("e1"), ev("e2"), ev("e3")];
    const prompt = buildDigestPrompt(q("q1"), evidence);
    for (const e of evidence) {
      const occurrences = prompt.split(`[${e.id}]`).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it("carries the question text so the model can flag off-topic sources", () => {
    const prompt = buildDigestPrompt(q("q1", { text: "how big is the market" }), [ev("e1")]);
    expect(prompt).toContain("how big is the market");
  });
});

// ---------------------------------------------------------------------------
// formatDigestForCommittee
// ---------------------------------------------------------------------------

describe("formatDigestForCommittee", () => {
  it("renders every evidence id with a [id] title (domain) header", () => {
    const evidence = [ev("e1"), ev("e2")];
    const items: DigestItem[] = [
      { evidenceId: "e1", summary: "digest one" },
      { evidenceId: "e2", summary: "digest two" },
    ];
    const out = formatDigestForCommittee(evidence, items);
    expect(out).toContain("[e1] title e1 (example.com)");
    expect(out).toContain("digest one");
    expect(out).toContain("[e2] title e2 (example.com)");
    expect(out).toContain("digest two");
  });

  it("falls back to the raw snippet for an id the digest didn't cover", () => {
    const evidence = [ev("e1"), ev("e2")];
    const items: DigestItem[] = [{ evidenceId: "e1", summary: "digest one" }];
    const out = formatDigestForCommittee(evidence, items);
    expect(out).toContain("digest one");
    // e2 was not digested — its snippet stands in, and its id is still present/citable.
    expect(out).toContain("[e2]");
    expect(out).toContain("snippet e2");
  });

  it("caps the total block at MAX_EVIDENCE_CHARS_PER_AGENT (mirrors the raw-evidence path)", () => {
    // Many large digest items — an evidence-heavy multi-loop run. Without a cap the block the whole
    // committee re-reads every call grows unbounded; cap it like formatEvidence so deliberation input
    // stays bounded. Uniform across roles (still byte-identical), so the L3 shared-prefix cache holds.
    const big = "x".repeat(MAX_DIGEST_SUMMARY_CHARS);
    const evidence = Array.from({ length: 200 }, (_, i) => ev(`e${i}`));
    const items: DigestItem[] = evidence.map((e) => ({ evidenceId: e.id, summary: big }));
    const out = formatDigestForCommittee(evidence, items);
    // 200 × ~400-char summaries ≈ 80k chars uncapped; the cap keeps it near the ceiling.
    expect(out.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS_PER_AGENT + big.length);
    expect(out.length).toBeLessThan(200 * big.length);
    expect(out).toContain("[e0]"); // keeps the earliest sources
  });

  it("always keeps at least the first source even if it alone exceeds the cap", () => {
    const huge = "y".repeat(MAX_EVIDENCE_CHARS_PER_AGENT * 2);
    const evidence = [ev("e1"), ev("e2")];
    const items: DigestItem[] = [{ evidenceId: "e1", summary: huge }, { evidenceId: "e2", summary: "two" }];
    const out = formatDigestForCommittee(evidence, items);
    expect(out).toContain("[e1]"); // never returns an empty block
  });
});

// ---------------------------------------------------------------------------
// mergeDigests
// ---------------------------------------------------------------------------

describe("mergeDigests", () => {
  it("appends per questionId without dropping other questions", () => {
    const prev = { q1: [{ evidenceId: "e1", summary: "a" }], q2: [{ evidenceId: "e9", summary: "z" }] };
    const next = { q1: [{ evidenceId: "e2", summary: "b" }] };
    const merged = mergeDigests(prev, next);
    expect(merged.q1.map((i) => i.evidenceId)).toEqual(["e1", "e2"]);
    expect(merged.q2.map((i) => i.evidenceId)).toEqual(["e9"]); // untouched
  });

  it("seeds a new question that had no prior digest", () => {
    const merged = mergeDigests({}, { q1: [{ evidenceId: "e1", summary: "a" }] });
    expect(merged.q1).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// digestEvidence (mocked LLM)
// ---------------------------------------------------------------------------

describe("digestEvidence", () => {
  it("happy path: returns clamped items + usage for the question", async () => {
    const { generateText } = await import("ai");
    (generateText as Mock).mockResolvedValue(
      fakeGenResult(
        {
          items: [
            { evidenceId: "e1", summary: "fact one" },
            { evidenceId: "ghost", summary: "invented — should be dropped" },
          ],
        },
        { inputTokens: 100, outputTokens: 20 },
      ),
    );

    const result = await digestEvidence(q("q1"), [ev("e1")]);
    expect(result.questionId).toBe("q1");
    expect(result.items.map((i) => i.evidenceId)).toEqual(["e1"]); // ghost dropped by clamp
    expect(result.usage?.label).toBe("digest:q1");
  });

  it("returns an empty digest (no throw) when generation fails", async () => {
    const { generateText } = await import("ai");
    (generateText as Mock).mockRejectedValue(new Error("model exploded"));

    const result = await digestEvidence(q("q1"), [ev("e1")]);
    expect(result.items).toEqual([]);
    expect(result.usage).toBeUndefined();
  });

  it("short-circuits with no items and no LLM call when there is no fresh evidence", async () => {
    const { generateText } = await import("ai");
    (generateText as Mock).mockClear();
    const result = await digestEvidence(q("q1"), []);
    expect(result.items).toEqual([]);
    expect(generateText).not.toHaveBeenCalled();
  });
});
