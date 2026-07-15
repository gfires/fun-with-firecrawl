/**
 * scrape-cache.test.ts — locks in the cache KEY-NORMALIZATION contract for the agentic reader path.
 *
 * The agentic researcher invents/copies URLs straight out of search snippets, which frequently carry
 * a trailing slash, a `#fragment`, or `?utm=…` tracking params. If those variants didn't collapse to
 * the SAME cache key as the canonical URL, every such read would miss cache and burn a real Firecrawl
 * credit. These tests exercise the REAL `normalizeUrl` (via the real getCache/setCache) against an
 * in-memory Supabase so the round-trip — not a mocked cache — is what's under test. The search cache
 * is keyed by the EXACT query string (no normalization), so its round-trip is asserted exact-match.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Minimal in-memory Supabase: rows keyed by `${type}::${key}`, upsert overwrites, select→eq→eq→
// maybeSingle reads back. This is the layer BELOW normalizeUrl, so the real normalization runs.
const store = new Map<string, unknown>();

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from() {
      return {
        upsert(row: { type: string; key: string; value: unknown }) {
          store.set(`${row.type}::${row.key}`, row.value);
          return Promise.resolve({ error: null });
        },
        select() {
          const filters: Record<string, string> = {};
          const builder = {
            eq(col: string, val: string) {
              filters[col] = val;
              return builder;
            },
            maybeSingle() {
              const value = store.get(`${filters.type}::${filters.key}`);
              return Promise.resolve({ data: value === undefined ? null : { value }, error: null });
            },
          };
          return builder;
        },
      };
    },
  },
}));

import { getCache, setCache } from "@/lib/scrape-cache";
import { getSearchCache, setSearchCache } from "@/lib/search-cache";

beforeEach(() => {
  store.clear();
});

describe("scrape-cache normalizeUrl — variants that MUST collapse to one key (cache hit)", () => {
  it("trailing slash, #fragment, and ?query all resolve to the same cached content", async () => {
    await setCache("https://a.com/x", "PAGE BODY");

    // The canonical form, and each of the three variants the agent might present, must all hit.
    expect(await getCache("https://a.com/x")).toBe("PAGE BODY");
    expect(await getCache("https://a.com/x/")).toBe("PAGE BODY"); // trailing slash
    expect(await getCache("https://a.com/x#top")).toBe("PAGE BODY"); // fragment
    expect(await getCache("https://a.com/x?utm=1")).toBe("PAGE BODY"); // tracking query
    // The exact edge the task calls out: trailing slash + query + fragment together.
    expect(await getCache("https://a.com/x/?utm=1#top")).toBe("PAGE BODY");
  });

  it("is symmetric — writing the messy variant is readable by the canonical URL", async () => {
    await setCache("https://a.com/x/?ref=twitter#section", "BODY 2");
    expect(await getCache("https://a.com/x")).toBe("BODY 2");
  });
});

describe("scrape-cache normalizeUrl — KNOWN LIMITS (conservative; these are deliberate misses)", () => {
  // normalizeUrl only strips #…, ?…, and a trailing slash. It intentionally does NOT canonicalize
  // scheme or host, so the following do NOT collide. Widening would risk false collisions (an
  // http page and its https counterpart, or apex vs www, can serve different content), so we keep
  // the normalizer narrow and simply document the boundary here.
  it("http vs https do NOT share a key (miss)", async () => {
    await setCache("https://a.com/x", "SECURE");
    expect(await getCache("http://a.com/x")).toBeNull();
  });

  it("www vs apex do NOT share a key (miss)", async () => {
    await setCache("https://www.a.com/x", "WWW");
    expect(await getCache("https://a.com/x")).toBeNull();
  });

  it("distinct paths do NOT collide", async () => {
    await setCache("https://a.com/x", "X");
    expect(await getCache("https://a.com/y")).toBeNull();
  });
});

describe("search-cache — exact-query round-trip (keyed by the raw query string)", () => {
  it("a repeated identical query reads back the stored hits", async () => {
    const hits = [{ url: "https://a.com", title: "A", snippet: "s" }];
    await setSearchCache("freight brokerage churn", hits);

    expect(await getSearchCache("freight brokerage churn")).toEqual(hits);
  });

  it("search keys are NOT normalized — a query differing by whitespace/case misses (by design)", async () => {
    await setSearchCache("freight brokerage", [{ url: "https://a.com", title: "A", snippet: "s" }]);
    // The agent invents fresh queries each pass, so cross-pass search-cache hits are rare BY DESIGN.
    expect(await getSearchCache("freight  brokerage")).toBeNull(); // double space
    expect(await getSearchCache("Freight Brokerage")).toBeNull(); // case
  });
});
