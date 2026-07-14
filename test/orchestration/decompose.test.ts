import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { generateText } from "ai";
import { decompose } from "@/lib/orchestration/graph";
import { fallbackBrief, type ResearchBrief } from "@/lib/schemas/brief";
import { MAX_QUESTIONS, MAX_SEARCH_QUERIES_PER_QUESTION } from "@/lib/params";
import type { ResearchStateT } from "@/lib/schemas/state";
import { fakeGenResult } from "../helpers/mock-ai";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn() };
});

/** decompose reads only state.researchBrief; a partial cast is enough to drive it. */
function stateOf(researchBrief: ResearchBrief): ResearchStateT {
  return { topic: researchBrief.subject, researchBrief } as ResearchStateT;
}

/** The prompt string handed to the (mocked) manager LLM on the most recent call. */
function lastPrompt(): string {
  return (generateText as Mock).mock.calls[0][0].prompt as string;
}

/** Program the manager to return N generic questions so decompose resolves. */
function mockQuestions(n = 3, extra: Record<string, unknown> = {}) {
  (generateText as Mock).mockResolvedValue(
    fakeGenResult({
      questions: Array.from({ length: n }, (_, i) => ({ text: `q${i}`, category: `cat${i}`, ...extra })),
    }),
  );
}

beforeEach(() => {
  (generateText as Mock).mockReset();
});

describe("decompose (objective-driven)", () => {
  it("threads the objective and constraints into the manager prompt", async () => {
    mockQuestions();
    const brief: ResearchBrief = {
      subject: "AI contract review",
      objective: "Decide go/no-go on AI-native contract review for mid-market law firms",
      constraints: ["mid-market only", "US jurisdictions"],
    };
    await decompose(stateOf(brief));

    const prompt = lastPrompt();
    expect(prompt).toContain(brief.objective);
    expect(prompt).toContain("mid-market only");
    expect(prompt).toContain("US jurisdictions");
    expect(prompt).toContain(brief.subject);
  });

  it("passes a decision-shaped objective through verbatim (no generic rewrite)", async () => {
    mockQuestions();
    const objective = "Adjudicate whether freight brokerage margins can support a venture outcome";
    await decompose(stateOf({ subject: "freight brokerage", objective, constraints: [] }));
    expect(lastPrompt()).toContain(objective);
  });

  it("keeps the industry-coverage facet hint for a bare survey objective (regression guard)", async () => {
    mockQuestions();
    // fallbackBrief is exactly the bare-phrase shape intake emits for "freight brokerage".
    await decompose(stateOf(fallbackBrief("freight brokerage")));

    const prompt = lastPrompt();
    // The bare-survey fallback still steers toward the same core facets it did before A3.
    for (const facet of ["market", "customers", "competition", "economics", "risks"]) {
      expect(prompt).toContain(facet);
    }
    expect(prompt).toContain("Assess the opportunity in freight brokerage");
    expect(prompt).toContain("(none stated)"); // empty constraints render explicitly
  });

  it("asks for keyword search queries and threads them onto each question", async () => {
    // #2: retrieve prefers Question.searchQueries over the verbose question sentence (which searches
    // poorly). decompose now emits a keyword query per question in the same LLM call, clamped to
    // MAX_SEARCH_QUERIES_PER_QUESTION (1 — one broad query at loop 0; refine adds a sharper one later).
    mockQuestions(2, { searchQueries: ["mid-market law firm AI review pricing", "legal AI cost per seat"] });
    const out = await decompose(stateOf(fallbackBrief("legal AI")));

    expect(lastPrompt()).toContain("keyword search query");
    expect(out.questions![0].searchQueries).toEqual(
      ["mid-market law firm AI review pricing", "legal AI cost per seat"].slice(0, MAX_SEARCH_QUERIES_PER_QUESTION),
    );
  });

  it("clamps searchQueries per question to MAX_SEARCH_QUERIES_PER_QUESTION", async () => {
    const many = Array.from({ length: MAX_SEARCH_QUERIES_PER_QUESTION + 4 }, (_, i) => `kw${i}`);
    mockQuestions(1, { searchQueries: many });
    const out = await decompose(stateOf(fallbackBrief("x")));
    expect(out.questions![0].searchQueries).toHaveLength(MAX_SEARCH_QUERIES_PER_QUESTION);
  });

  it("omits searchQueries when the manager gives none (retrieve falls back to the question text)", async () => {
    mockQuestions(1); // no searchQueries in the mock output
    const out = await decompose(stateOf(fallbackBrief("x")));
    expect(out.questions![0].searchQueries).toBeUndefined();
  });

  it("clamps the returned question count to MAX_QUESTIONS", async () => {
    mockQuestions(MAX_QUESTIONS + 3);
    const out = await decompose(stateOf(fallbackBrief("widgets")));
    expect(out.questions).toHaveLength(MAX_QUESTIONS);
    expect(out.questions!.every((q) => q.confidence === 0 && !q.resolved)).toBe(true);
    expect(out.questions!.map((q) => q.id)).toEqual(
      Array.from({ length: MAX_QUESTIONS }, (_, i) => `q${i + 1}`),
    );
  });
});
