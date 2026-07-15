/**
 * researcher.test.ts — P3 acceptance tests for the agentic-retrieval researcher.
 *
 * The agent's model is mocked at the "ai" module boundary (only `generateText`; `tool` and
 * `stepCountIs` stay REAL via importActual). Each test SCRIPTS the "model": a per-step function
 * that inspects `opts.tools` and calls the real tool `execute(...)` closures, then returns a fake
 * generateText result (steps/totalUsage/response). The Firecrawl SDK and the P2 primitives' caches
 * / blocklist are module-mocked so `webSearchRaw`/`scrapeOneCached` run their real logic against a
 * controllable fake network. Rows map to spec §7.
 */
import { describe, it, expect, beforeAll, beforeEach, vi, type Mock } from "vitest";

// Mutable hooks the mocked modules read, so each test steers the fake network without re-mocking.
const h = vi.hoisted(() => ({
  searchCacheValue: null as { url: string; title: string; snippet: string }[] | null,
  scrapeCacheValue: null as string | null,
  blocklist: new Set<string>(),
  searchThrows: false,
  scrapeThrows: false,
  searchEmpty: false,
  searchCalls: 0,
  scrapeCalls: 0,
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn() };
});

vi.mock("@mendable/firecrawl-js", () => ({
  default: class MockFirecrawl {
    async search(query: string) {
      h.searchCalls++;
      if (h.searchThrows) throw new Error("search boom");
      if (h.searchEmpty) return { data: [] };
      return {
        data: [
          { url: `https://ex.com/${encodeURIComponent(query)}/a`, title: "Title A", description: "Snippet A" },
          { url: `https://ex.com/${encodeURIComponent(query)}/b`, title: "Title B", description: "Snippet B" },
        ],
      };
    }
    async scrapeUrl(url: string) {
      h.scrapeCalls++;
      if (h.scrapeThrows) throw new Error("scrape boom");
      // Two distinct urls that both contain "same" scrape to identical content (contentHash dedup).
      const body = url.includes("same") ? "SAME BODY" : `body of ${url}`;
      return { markdown: body };
    }
  },
}));

vi.mock("@/lib/search-cache", () => ({
  getSearchCache: async () => h.searchCacheValue,
  setSearchCache: async () => {},
}));
vi.mock("@/lib/scrape-cache", () => ({
  getCache: async () => h.scrapeCacheValue,
  setCache: async () => {},
}));
vi.mock("@/lib/blocklist", async () => {
  const actual = await vi.importActual<typeof import("@/lib/blocklist")>("@/lib/blocklist");
  return { ...actual, loadBlocklist: async () => h.blocklist, recordBlock: async () => {} };
});

import { generateText } from "ai";
import { runResearcher, PassPool } from "@/lib/orchestration/researcher";
import { runWithCostTracker, getActiveCostTracker, BudgetExceededError } from "@/lib/orchestration/cost-tracker";
import { MAX_AGENT_STEPS, MAX_SEARCHES_PER_PASS, RECON_FLOOR, RESEARCHER_MODEL_ID, resultsPerQuestionForLoop } from "@/lib/params";
import type { Question } from "@/lib/schemas/state";

const q = (id: string): Question => ({
  id,
  text: `question ${id}`,
  category: "market structure",
  confidence: 0,
  resolved: false,
});

// A tool-call context shaped like what generateText passes a tool's execute().
const ctx = { toolCallId: "tc", messages: [] as unknown[] };

/** One scripted model step: call whatever tools it wants, return whether it made a tool call. */
type StepFn = (tools: { webSearch: { execute: Function }; readSource: { execute: Function } }) => Promise<boolean>;

const webSearchStep = (query = "q"): StepFn => async (tools) => {
  await tools.webSearch.execute({ query }, ctx);
  return true;
};
const readStep = (urls: string[]): StepFn => async (tools) => {
  await tools.readSource.execute({ urls }, ctx);
  return true;
};
const stopStep: StepFn = async () => false;

/** Program the mocked generateText to play `fns` in order (repeating the last), with fixed usage. */
function scriptModel(fns: StepFn[], usage: { inputTokens: number; outputTokens: number } = { inputTokens: 10, outputTokens: 5 }) {
  let i = 0;
  (generateText as Mock).mockImplementation(async (opts: { tools: { webSearch: { execute: Function }; readSource: { execute: Function } } }) => {
    const fn = fns[Math.min(i, fns.length - 1)];
    i++;
    const madeToolCall = await fn(opts.tools);
    return {
      text: "step",
      steps: [{ toolCalls: madeToolCall ? [{ toolName: "t", toolCallId: "tc", input: {} }] : [], toolResults: [], usage }],
      totalUsage: usage,
      response: { messages: [] },
      finishReason: madeToolCall ? "tool-calls" : "stop",
    };
  });
}

beforeAll(() => {
  process.env.FIRECRAWL_API_KEY = "test-key";
});

beforeEach(() => {
  h.searchCacheValue = null;
  h.scrapeCacheValue = null;
  h.blocklist = new Set<string>();
  h.searchThrows = false;
  h.scrapeThrows = false;
  h.searchEmpty = false;
  h.searchCalls = 0;
  h.scrapeCalls = 0;
  (generateText as Mock).mockReset();
});

describe("runResearcher — recon floor (loop 0)", () => {
  it("re-drives a model that tries to stop early until collected >= RECON_FLOOR", async () => {
    // The model reads one NEW source, then tries to stop; the code nudges it back until the floor.
    scriptModel([
      webSearchStep(),
      readStep(["https://ex.com/1"]),
      stopStep,
      readStep(["https://ex.com/2"]),
      stopStep,
      readStep(["https://ex.com/3"]),
      stopStep,
    ]);

    const { evidence } = await runResearcher(q("q1"), "recon mission", 0, new Set(), new PassPool(100));

    expect(evidence.length).toBe(RECON_FLOOR);
    expect(evidence.every((e) => e.questionId === "q1")).toBe(true);
  });

  it("does NOT deadlock when there are genuinely no sources (model never gathers)", async () => {
    scriptModel([stopStep, stopStep, stopStep]);

    const { evidence } = await runResearcher(q("q1"), "recon", 0, new Set(), new PassPool(100));

    expect(evidence).toEqual([]);
    // one nudge, then a second no-tool-call step → stop. Bounded well under MAX_AGENT_STEPS.
    expect((generateText as Mock).mock.calls.length).toBeLessThan(MAX_AGENT_STEPS);
  });

  it("does NOT deadlock when searches return zero hits", async () => {
    h.searchEmpty = true;
    scriptModel([webSearchStep(), stopStep, stopStep]);

    const { evidence } = await runResearcher(q("q1"), "recon", 0, new Set(), new PassPool(100));

    expect(evidence).toEqual([]);
  });
});

describe("runResearcher — loop >= 1 (no recon floor)", () => {
  it("lets the agent stop after one source once its mission is addressed", async () => {
    scriptModel([webSearchStep(), readStep(["https://ex.com/1"]), stopStep]);

    const { evidence } = await runResearcher(q("q2"), "targeted gap", 1, new Set(), new PassPool(100));

    expect(evidence.length).toBe(1);
    expect(evidence[0].loopIteration).toBe(1);
  });
});

describe("runResearcher — per-pass evidence ceiling (eval parity)", () => {
  it("caps stored evidence at resultsPerQuestionForLoop(0)=3 on loop 0; further reads store nothing + return the 'enough' note", async () => {
    // Offer 5 urls in one read: the ceiling (3) stores only 3. A subsequent read, already at the cap,
    // stores nothing and returns a short note telling the model it has read enough this pass.
    const returns: unknown[] = [];
    const probe: StepFn = async (tools) => {
      await tools.readSource.execute(
        { urls: ["https://ex.com/1", "https://ex.com/2", "https://ex.com/3", "https://ex.com/4", "https://ex.com/5"] },
        ctx,
      );
      returns.push(await tools.readSource.execute({ urls: ["https://ex.com/6"] }, ctx)); // already capped
      return true;
    };
    scriptModel([probe, stopStep]);

    const { evidence } = await runResearcher(q("q1"), "recon", 0, new Set(), new PassPool(100));

    expect(evidence.length).toBe(resultsPerQuestionForLoop(0)); // 3
    const memos = returns[0] as Array<Record<string, unknown>>;
    expect(memos.some((m) => "head" in m)).toBe(false); // nothing stored on the post-cap read
    expect(JSON.stringify(memos)).toMatch(/enough|finish/i); // the 'enough' note
  });

  it("caps stored evidence at resultsPerQuestionForLoop(1)=6 on a gap pass (loop >= 1)", async () => {
    const urls = Array.from({ length: 9 }, (_, i) => `https://ex.com/g${i}`);
    scriptModel([readStep(urls), stopStep]);

    const { evidence } = await runResearcher(q("q2"), "gap", 1, new Set(), new PassPool(100));

    expect(evidence.length).toBe(resultsPerQuestionForLoop(1)); // 6
  });

  it("honors an explicit maxReads override via opts", async () => {
    const urls = Array.from({ length: 5 }, (_, i) => `https://ex.com/o${i}`);
    scriptModel([readStep(urls), stopStep]);

    const { evidence } = await runResearcher(q("q3"), "m", 1, new Set(), new PassPool(100), { maxReads: 2 });

    expect(evidence.length).toBe(2);
  });

  it("floor==ceiling on loop 0: 3 relevant reads satisfy the floor and stop without over-reading or endless nudging", async () => {
    scriptModel([readStep(["https://ex.com/a", "https://ex.com/b", "https://ex.com/c"]), stopStep]);

    const { evidence } = await runResearcher(q("q4"), "recon", 0, new Set(), new PassPool(100));

    expect(evidence.length).toBe(3); // floor (3) met and ceiling (3) never exceeded
    // Read step + the stop step only — no nudge, since the floor was already satisfied.
    expect((generateText as Mock).mock.calls.length).toBe(2);
  });
});

describe("runResearcher — budget exhaustion", () => {
  it("keeps partial evidence when the pool exhausts mid-loop (no throw)", async () => {
    // Seed 1 credit: the first live scrape (1 credit) exhausts the pool; the loop then exits.
    scriptModel([readStep(["https://ex.com/1"]), readStep(["https://ex.com/2"]), stopStep]);

    const pool = new PassPool(1);
    const { evidence } = await runResearcher(q("q3"), "m", 1, new Set(), pool);

    expect(evidence.length).toBe(1);
    expect(pool.exhausted).toBe(true);
    expect(pool.spent).toBe(1);
  });

  it("partial multi-URL read: readSource stores until the cap, then breaks", async () => {
    // A single readSource of three urls with only 1 credit → reads url1, breaks before url2/url3.
    scriptModel([readStep(["https://ex.com/1", "https://ex.com/2", "https://ex.com/3"]), stopStep]);

    const pool = new PassPool(1);
    const { evidence } = await runResearcher(q("q3"), "m", 1, new Set(), pool);

    expect(evidence.map((e) => e.url)).toEqual(["https://ex.com/1"]);
    expect(pool.spent).toBe(1);
  });

  it("webSearch returns the budget-exhausted message (no throw) when the pool drains mid-step", async () => {
    // Within one step: a read exhausts the seed-1 pool, then a webSearch must return the graceful
    // string and never hit the network — NOT throw. (Mirrors a concurrent agent draining the pool.)
    const returns: unknown[] = [];
    const probe: StepFn = async (tools) => {
      await tools.readSource.execute({ urls: ["https://ex.com/1"] }, ctx); // charges 1 → exhausts
      returns.push(await tools.webSearch.execute({ query: "a" }, ctx)); // exhausted → graceful
      return true;
    };
    scriptModel([probe, stopStep]);

    await runResearcher(q("q3"), "m", 1, new Set(), new PassPool(1));

    expect(typeof returns[0]).toBe("string");
    expect(returns[0] as string).toContain("exhausted");
    expect(h.searchCalls).toBe(0); // webSearch refused before any network call
  });
});

describe("runResearcher — search cap (MAX_SEARCHES_PER_PASS)", () => {
  it("refuses a SECOND web search — the agent must read its hits, not reformulate", async () => {
    // The coded arm's 1-query-per-question discipline: one search, then read. A second search this
    // pass is refused in code (default cap 1), charges nothing, and never touches the network.
    const returns: unknown[] = [];
    const probe: StepFn = async (tools) => {
      returns.push(await tools.webSearch.execute({ query: "a" }, ctx)); // 1st: real search
      returns.push(await tools.webSearch.execute({ query: "b" }, ctx)); // 2nd: capped
      return true;
    };
    scriptModel([probe, stopStep]);

    const pool = new PassPool(100);
    await runResearcher(q("q1"), "m", 1, new Set(), pool);

    expect(Array.isArray(returns[0])).toBe(true);          // first search returned hits
    expect(typeof returns[1]).toBe("string");              // second was refused
    expect(returns[1] as string).toMatch(/one web search|read/i);
    expect(h.searchCalls).toBe(MAX_SEARCHES_PER_PASS);     // exactly the cap (1) hit the network
    expect(pool.spent).toBe(2);                            // only the one real search charged (2 credits)
  });
});

describe("runResearcher — step cap", () => {
  it("stops at MAX_AGENT_STEPS when the model calls a tool every step", async () => {
    scriptModel([webSearchStep()]); // repeats forever → never a no-tool-call stop

    await runResearcher(q("q4"), "m", 1, new Set(), new PassPool(1000));

    expect((generateText as Mock).mock.calls.length).toBe(MAX_AGENT_STEPS);
  });
});

describe("runResearcher — zero-result pass", () => {
  it("returns [] when a search yields no hits and nothing is read", async () => {
    h.searchEmpty = true;
    scriptModel([webSearchStep(), stopStep]);

    const { evidence, usage } = await runResearcher(q("q5"), "m", 1, new Set(), new PassPool(100));

    expect(evidence).toEqual([]);
    expect(usage.label).toBe("researcher:q5");
  });
});

describe("runResearcher — real-credit charge", () => {
  it("charges 2 for a live search and 1 for a live scrape", async () => {
    scriptModel([webSearchStep(), readStep(["https://ex.com/1"]), stopStep]);

    const pool = new PassPool(100);
    await runResearcher(q("q6"), "m", 1, new Set(), pool);

    expect(pool.spent).toBe(3); // 2 (search) + 1 (scrape)
  });

  it("charges 0 for a cache-hit search", async () => {
    h.searchCacheValue = [{ url: "https://cached.com/x", title: "C", snippet: "s" }];
    scriptModel([webSearchStep(), stopStep]);

    const pool = new PassPool(100);
    await runResearcher(q("q6"), "m", 1, new Set(), pool);

    expect(pool.spent).toBe(0);
  });

  it("charges 0 for a cache-hit scrape", async () => {
    h.scrapeCacheValue = "cached body";
    scriptModel([readStep(["https://ex.com/1"]), stopStep]);

    const pool = new PassPool(100);
    const { evidence } = await runResearcher(q("q6"), "m", 1, new Set(), pool);

    expect(pool.spent).toBe(0);
    expect(evidence[0].content).toBe("cached body");
  });
});

describe("runResearcher — reader path honors the cache end-to-end (0 credits, no network)", () => {
  // These prove the AGENT benefits from the cache through the whole tool-loop — not just the
  // primitives in isolation. A populated scrape/search cache means a run over the same URLs/queries
  // charges the PassPool 0 and never issues a Firecrawl network call (h.scrapeCalls/h.searchCalls
  // stay 0). This is the guarantee that made the live run bill 0 credits on its 7 cache hits.
  it("readSource of a scrape-cached URL stores the evidence but charges 0 and makes no scrapeUrl call", async () => {
    h.scrapeCacheValue = "cached page body";
    scriptModel([readStep(["https://ex.com/cached-1", "https://ex.com/cached-2"]), stopStep]);

    const pool = new PassPool(100);
    const { evidence } = await runResearcher(q("qc"), "m", 1, new Set(), pool);

    expect(evidence).toHaveLength(1); // both urls scrape to identical cached content → one Evidence
    expect(evidence[0].content).toBe("cached page body");
    expect(pool.spent).toBe(0); // cache hit → no real credit charged
    expect(pool.calls).toBe(0); // no billable Firecrawl call recorded
    expect(h.scrapeCalls).toBe(0); // the SDK scrapeUrl was never invoked
  });

  it("webSearch of a query-cached query returns hits but charges 0 and makes no search call", async () => {
    h.searchCacheValue = [{ url: "https://cached.com/x", title: "C", snippet: "s" }];
    const returns: unknown[] = [];
    const probe: StepFn = async (tools) => {
      returns.push(await tools.webSearch.execute({ query: "anything" }, ctx));
      return true;
    };
    scriptModel([probe, stopStep]);

    const pool = new PassPool(100);
    await runResearcher(q("qc"), "m", 1, new Set(), pool);

    expect(Array.isArray(returns[0])).toBe(true);
    expect((returns[0] as unknown[]).length).toBe(1); // the cached hit surfaced to the agent
    expect(pool.spent).toBe(0);
    expect(pool.calls).toBe(0);
    expect(h.searchCalls).toBe(0); // the SDK search was never invoked
  });

  it("search THEN read of the same cached URL: whole pass bills 0 and touches no network", async () => {
    // End-to-end: a cached search surfaces a hit whose URL is also scrape-cached — the agent reads it
    // and the entire pass costs nothing. This is the compound cache-hit path a warm run walks.
    h.searchCacheValue = [{ url: "https://cached.com/read-me", title: "C", snippet: "s" }];
    h.scrapeCacheValue = "warm content";
    scriptModel([webSearchStep(), readStep(["https://cached.com/read-me"]), stopStep]);

    const pool = new PassPool(100);
    const { evidence } = await runResearcher(q("qc"), "m", 1, new Set(), pool);

    expect(evidence).toHaveLength(1);
    expect(evidence[0].content).toBe("warm content");
    expect(pool.spent).toBe(0);
    expect(pool.calls).toBe(0);
    expect(h.searchCalls).toBe(0);
    expect(h.scrapeCalls).toBe(0);
  });
});

describe("runResearcher — interior $-cap propagation", () => {
  it("rejects with BudgetExceededError when spend is already over the cap (node-entry check)", async () => {
    scriptModel([webSearchStep(), stopStep]);

    await expect(
      runWithCostTracker(async () => {
        // Pre-spend far over the tiny cap; the loop-top check() must throw before any step.
        getActiveCostTracker()!.record({ model: RESEARCHER_MODEL_ID, promptTokens: 100_000_000, completionTokens: 0 });
        return runResearcher(q("q7"), "m", 1, new Set(), new PassPool(100));
      }, 0.5),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("aborts on the NEXT step's check() when a mid-loop record() pushes over the cap", async () => {
    // Each step bills 1M Haiku input tokens = $1.00 > cap 0.5; step 1 records, step 2's check throws.
    scriptModel([webSearchStep(), stopStep], { inputTokens: 1_000_000, outputTokens: 0 });

    await expect(
      runWithCostTracker(() => runResearcher(q("q7"), "m", 1, new Set(), new PassPool(100)), 0.5),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    // Exactly one step ran (recorded) before the second step's check() aborted.
    expect((generateText as Mock).mock.calls.length).toBe(1);
  });
});

describe("runResearcher — evidence tagging & no cross-contamination", () => {
  it("tags every Evidence with its own questionId and loopIteration; two agents don't collide", async () => {
    // Both agents read the SAME url (same content) but belong to different questions.
    scriptModel([readStep(["https://ex.com/shared"]), stopStep]);
    const a = await runResearcher(q("qA"), "same query", 2, new Set(), new PassPool(100));

    scriptModel([readStep(["https://ex.com/shared"]), stopStep]);
    const b = await runResearcher(q("qB"), "same query", 2, new Set(), new PassPool(100));

    expect(a.evidence).toHaveLength(1);
    expect(b.evidence).toHaveLength(1);
    expect(a.evidence[0].questionId).toBe("qA");
    expect(b.evidence[0].questionId).toBe("qB");
    expect(a.evidence[0].loopIteration).toBe(2);
    // Same content → same contentHash, but the identity tag keeps them scoped to different questions.
    expect(a.evidence[0].contentHash).toBe(b.evidence[0].contentHash);
  });
});

describe("runResearcher — dedup", () => {
  it("collapses two distinct urls with identical content to one Evidence (contentHash)", async () => {
    scriptModel([readStep(["https://ex.com/same-1", "https://ex.com/same-2"]), stopStep]);

    const { evidence } = await runResearcher(q("q9"), "m", 1, new Set(), new PassPool(100));

    expect(evidence).toHaveLength(1);
  });

  it("skips a url already gathered (readUrls seeded from seenUrls)", async () => {
    scriptModel([readStep(["https://ex.com/seen"]), stopStep]);

    const { evidence } = await runResearcher(
      q("q9"),
      "m",
      1,
      new Set(["https://ex.com/seen"]),
      new PassPool(100),
    );

    expect(evidence).toEqual([]);
    expect(h.scrapeCalls).toBe(0); // never re-scraped
  });
});

describe("runResearcher — failure modes", () => {
  it("firecrawl search error → no hits, no throw", async () => {
    h.searchThrows = true;
    scriptModel([webSearchStep(), stopStep]);

    const { evidence } = await runResearcher(q("q10"), "m", 1, new Set(), new PassPool(100));

    expect(evidence).toEqual([]);
  });

  it("PDF url → empty content, still stored as citable Evidence", async () => {
    scriptModel([readStep(["https://ex.com/report.pdf"]), stopStep]);

    const { evidence } = await runResearcher(q("q10"), "m", 1, new Set(), new PassPool(100));

    expect(evidence).toHaveLength(1);
    expect(evidence[0].content).toBe("");
    expect(evidence[0].url).toBe("https://ex.com/report.pdf");
    expect(h.scrapeCalls).toBe(0); // PDF is skipped without a request
  });

  it("scrape error → empty content, still stored, no throw", async () => {
    h.scrapeThrows = true;
    scriptModel([readStep(["https://ex.com/x"]), stopStep]);

    const { evidence } = await runResearcher(q("q10"), "m", 1, new Set(), new PassPool(100));

    expect(evidence).toHaveLength(1);
    expect(evidence[0].content).toBe("");
  });
});
