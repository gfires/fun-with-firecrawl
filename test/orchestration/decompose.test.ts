import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { generateText } from "ai";
import { decompose } from "@/lib/orchestration/graph";
import { fallbackBrief, type ResearchBrief } from "@/lib/schemas/brief";
import { MAX_QUESTIONS } from "@/lib/params";
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
function mockQuestions(n = 3) {
  (generateText as Mock).mockResolvedValue(
    fakeGenResult({
      questions: Array.from({ length: n }, (_, i) => ({ text: `q${i}`, category: `cat${i}` })),
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

  it("clamps the returned question count to MAX_QUESTIONS", async () => {
    mockQuestions(MAX_QUESTIONS + 3);
    const out = await decompose(stateOf(fallbackBrief("widgets")));
    expect(out.questions).toHaveLength(MAX_QUESTIONS);
    expect(out.questions!.every((q) => q.confidence === 0 && !q.resolved)).toBe(true);
    expect(out.questions!.map((q) => q.id)).toEqual(["q1", "q2", "q3", "q4", "q5"]);
  });
});
