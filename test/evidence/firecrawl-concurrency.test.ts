import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { FIRECRAWL_CONCURRENCY } from "@/lib/params";

// Shared in-flight counter the mocked Firecrawl client updates on every network call.
const h = vi.hoisted(() => ({ inFlight: 0, maxInFlight: 0, searches: 0, scrapes: 0 }));

// Mock the Firecrawl SDK: search() and scrapeUrl() each hold a "slot" for ~10ms so
// overlap is observable, tracking the peak number of simultaneous calls.
vi.mock("@mendable/firecrawl-js", () => {
  async function slot() {
    h.inFlight++;
    h.maxInFlight = Math.max(h.maxInFlight, h.inFlight);
    await new Promise((r) => setTimeout(r, 10));
    h.inFlight--;
  }
  return {
    default: class MockFirecrawl {
      async search(query: string) {
        h.searches++;
        await slot();
        return {
          data: [
            { url: `https://ex.com/${encodeURIComponent(query)}/a`, title: "t", description: "d" },
            { url: `https://ex.com/${encodeURIComponent(query)}/b`, title: "t", description: "d" },
          ],
        };
      }
      async scrapeUrl(url: string) {
        h.scrapes++;
        await slot();
        return { markdown: `body of ${url}` };
      }
    },
  };
});

// Force the network path (no supabase in tests): caches return null, blocklist is empty.
vi.mock("@/lib/search-cache", () => ({ getSearchCache: async () => null, setSearchCache: async () => {} }));
vi.mock("@/lib/scrape-cache", () => ({ getCache: async () => null, setCache: async () => {} }));
vi.mock("@/lib/blocklist", async () => {
  const actual = await vi.importActual<typeof import("@/lib/blocklist")>("@/lib/blocklist");
  return { ...actual, loadBlocklist: async () => new Set<string>(), recordBlock: async () => {} };
});

import { search } from "@/lib/evidence/firecrawl";

beforeAll(() => {
  process.env.FIRECRAWL_API_KEY = "test-key";
});

beforeEach(() => {
  h.inFlight = 0;
  h.maxInFlight = 0;
  h.searches = 0;
  h.scrapes = 0;
});

describe("firecrawl search() concurrency", () => {
  it("never exceeds FIRECRAWL_CONCURRENCY simultaneous Firecrawl calls", async () => {
    // 5 queries × 2 hits = 10 URLs to scrape — far more than the cap, so an unbounded
    // fan-out would peak well above FIRECRAWL_CONCURRENCY.
    await search(["q1", "q2", "q3", "q4", "q5"], 6, 0);

    expect(h.searches).toBe(5); // all searches ran…
    expect(h.scrapes).toBeGreaterThan(0); // …and scrapes happened
    expect(h.maxInFlight).toBeGreaterThan(0);
    expect(h.maxInFlight).toBeLessThanOrEqual(FIRECRAWL_CONCURRENCY);
  });
});
