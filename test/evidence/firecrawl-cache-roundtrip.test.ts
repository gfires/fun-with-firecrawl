/**
 * firecrawl-cache-roundtrip.test.ts — proves the reader PRIMITIVES write-then-read their own cache.
 *
 * firecrawl-tools.test.ts drives cache hit/miss with STATIC mock values (the cache never actually
 * stores). This file makes the search/scrape caches STATEFUL in-memory maps, so a second identical
 * call reads back exactly what the first call wrote: repeat = 0 credits and NO extra network call.
 * That is the end-to-end guarantee that the agent's repeated reads/queries within a run are free.
 * (Cross-PASS search-cache hits are rare BY DESIGN — the agent invents a fresh query each pass — so
 * this asserts the write→read mechanism, which fires whenever a query/URL does repeat.)
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  searchStore: new Map<string, unknown>(),
  scrapeStore: new Map<string, string>(),
  blocklist: new Set<string>(),
  searchCalls: 0,
  scrapeCalls: 0,
}));

vi.mock("@mendable/firecrawl-js", () => ({
  default: class MockFirecrawl {
    async search(query: string) {
      h.searchCalls++;
      return {
        data: [
          { url: `https://ex.com/${encodeURIComponent(query)}/a`, title: "Title A", description: "Snippet A" },
        ],
      };
    }
    async scrapeUrl(url: string) {
      h.scrapeCalls++;
      return { markdown: `body of ${url}` };
    }
  },
}));

// Stateful caches (keyed exactly like production: search by raw query, scrape by raw url — the reader
// primitives don't pre-normalize; scrape normalization lives in scrape-cache.ts, covered separately).
vi.mock("@/lib/search-cache", () => ({
  getSearchCache: async (query: string) => h.searchStore.get(query) ?? null,
  setSearchCache: async (query: string, results: unknown) => {
    h.searchStore.set(query, results);
  },
}));
vi.mock("@/lib/scrape-cache", () => ({
  getCache: async (url: string) => h.scrapeStore.get(url) ?? null,
  setCache: async (url: string, content: string) => {
    h.scrapeStore.set(url, content);
  },
}));
vi.mock("@/lib/blocklist", async () => {
  const actual = await vi.importActual<typeof import("@/lib/blocklist")>("@/lib/blocklist");
  return { ...actual, loadBlocklist: async () => h.blocklist, recordBlock: async () => {} };
});

import { webSearchRaw, scrapeOneCached } from "@/lib/evidence/firecrawl";

beforeAll(() => {
  process.env.FIRECRAWL_API_KEY = "test-key";
});

beforeEach(() => {
  h.searchStore.clear();
  h.scrapeStore.clear();
  h.blocklist = new Set<string>();
  h.searchCalls = 0;
  h.scrapeCalls = 0;
});

describe("webSearchRaw — write-then-read round-trip", () => {
  it("first query charges 2 + hits network; the SAME query again charges 0 + no second network call", async () => {
    const first = await webSearchRaw("freight brokerage");
    expect(first.credits).toBe(2);
    expect(h.searchCalls).toBe(1);

    const second = await webSearchRaw("freight brokerage");
    expect(second.credits).toBe(0);
    expect(h.searchCalls).toBe(1); // no additional network call — served from cache
    expect(second.hits).toEqual(first.hits); // identical hits round-tripped through the cache
  });
});

describe("scrapeOneCached — write-then-read round-trip", () => {
  it("first read charges 1 + hits network; the SAME url again charges 0 + no second network call", async () => {
    const url = "https://ex.com/page";
    const first = await scrapeOneCached(url);
    expect(first.credits).toBe(1);
    expect(h.scrapeCalls).toBe(1);
    expect(first.content).toBe(`body of ${url}`);

    const second = await scrapeOneCached(url);
    expect(second.credits).toBe(0);
    expect(h.scrapeCalls).toBe(1); // no additional network call — served from cache
    expect(second.content).toBe(`body of ${url}`); // same content round-tripped through the cache
  });
});
