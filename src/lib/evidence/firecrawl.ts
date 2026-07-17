/**
 * firecrawl.ts — the exploration layer: search across intents, then scrape the best pages.
 *
 * FOR FUTURE AGENTS: This module talks to Firecrawl and is the source of the live-progress
 * events. It does NOT know about SSE — instead it takes an `onEvent(ScanEvent)` callback, so
 * the transport (app/api/scan/route.ts) owns streaming while this module owns exploration.
 * That separation keeps this unit-testable and lets you reuse it from a script or a test.
 *
 * Pipeline:
 *   1. searchAllIntents() — fire all intent queries in parallel, tagging each result with the
 *      intent that surfaced it, emitting search:begin/done (with per-intent latency) as they resolve.
 *   2. rankSources()     — dedupe by URL, prefer diversity across intents, cap the count, and
 *      flag any source whose domain is on the known-blocker list (lib/blocklist.ts).
 *   3. scrapeSources()   — scrape via a BOUNDED worker pool (see SCRAPE_CONCURRENCY). Blocklisted
 *      domains are skipped without a request; hard-block failures (403/etc.) are recorded back to
 *      the blocklist so we never repeat them. Timing is emitted for every page.
 *
 * Timing: latency is measured with an injected `now()` clock (defaults to Date.now) so the
 * module stays deterministic under test.
 */
import FirecrawlApp from "@mendable/firecrawl-js";
import type { ScanEvent, TokenUsage } from "../events";
import type { Source } from "../schema";
import type { Intent } from "../intents";
import { domainOf, truncate } from "../format";
import { loadBlocklist, blocklistKey, isHardBlock, recordBlock } from "../blocklist";
import { getCache, setCache } from "../scrape-cache";
import { getSearchCache, setSearchCache } from "../search-cache";
import {
  MAX_CHARS_PER_PAGE,
  SCRAPE_TIMEOUT_MS,
  SCRAPE_CONCURRENCY,
  RESULTS_PER_INTENT,
  MAX_SCRAPE,
  QUOTA_FLOOR,
  SEARCH_CANDIDATES_PER_QUESTION,
  PROVIDER_CONCURRENCY,
  TRIAGE_ENABLED,
  MIN_TRIAGE_SCORE,
} from "./config";
import { makeIntents, scoreCandidates, selectSources, triageModel, UNSCORED, type Candidate, type TriageScore } from "../triage";
import { type Evidence, contentHash } from "./store";
import { getActiveTrace } from "../orchestration/trace";
import { createLimiter } from "../orchestration/limiter";

/**
 * One shared FIFO queue for EVERY Firecrawl network call — searches and scrapes alike,
 * across all questions and both arms. Firecrawl throttles to ~PROVIDER_CONCURRENCY.firecrawl
 * simultaneous requests per account; funnelling every call through this limiter keeps us
 * under that ceiling so bursts don't turn into 429s / timeouts. Module-level so concurrent
 * runs (e.g. compare-arms running both arms) still share the one account-wide budget.
 */
const firecrawlLimiter = createLimiter(PROVIDER_CONCURRENCY.firecrawl);


/** A search hit before it's promoted to a citable Source. */
interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  intent: string; // the intent label that surfaced this hit
}

/** A scraped source: a Source plus the page text we'll feed the model. */
export interface ScrapedSource extends Source {
  content: string;
}


/** Construct the Firecrawl client. Throws a clear error if the key is missing. */
export function makeFirecrawl(): FirecrawlApp {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not set. Copy .env.local.example to .env.local.");
  return new FirecrawlApp({ apiKey });
}

/** Monotonic clock injected for testability. Defaults to Date.now in production. */
type Clock = () => number;

/**
 * Run every intent's search query in parallel. Emits search:begin/done per intent, each
 * carrying that intent's latency (ms). Failures on individual intents are swallowed (that
 * intent contributes no hits) so one flaky query can't fail the whole scan.
 */
async function searchAllIntents(
  app: FirecrawlApp,
  intents: Intent[],
  onEvent: (e: ScanEvent) => void,
  now: Clock,
): Promise<{ hits: SearchHit[]; apiCalls: number }> {
  const resultsPerIntent = RESULTS_PER_INTENT;
  let apiCalls = 0;

  const perIntent = await Promise.all(
    intents.map(async (intent) => {
      onEvent({ type: "search:begin", intent: intent.label });
      const t0 = now();
      try {
        const cached = await getSearchCache(intent.query);
        if (cached) {
          const hits: SearchHit[] = cached.map((d) => ({ ...d, intent: intent.label }));
          onEvent({ type: "search:done", intent: intent.label, count: hits.length, ms: now() - t0 });
          return hits;
        }

        apiCalls++;
        const res = await firecrawlLimiter(() => app.search(intent.query, { limit: resultsPerIntent }));
        const hits: SearchHit[] = (res.data ?? [])
          .filter((d) => d.url)
          .map((d) => ({
            url: d.url as string,
            title: d.metadata?.title || d.title || domainOf(d.url as string),
            snippet: d.description || d.metadata?.description || "",
            intent: intent.label,
          }));
        void setSearchCache(intent.query, hits.map(({ url, title, snippet }) => ({ url, title, snippet })));
        onEvent({ type: "search:done", intent: intent.label, count: hits.length, ms: now() - t0 });
        return hits;
      } catch {
        onEvent({ type: "search:done", intent: intent.label, count: 0, ms: now() - t0 });
        return [];
      }
    }),
  );

  return { hits: perIntent.flat(), apiCalls };
}

/**
 * Dedupe search hits into unique triage candidates, MERGING the intents that surfaced each URL.
 *
 * A URL found by both "complaints" and "forum" becomes one candidate tagged with both intents —
 * that intent-count is a centrality signal the triage LLM sees (triage.ts). Selection (which used
 * to be blind round-robin here) now happens downstream in `selectSources` using triage scores.
 */
export function dedupeCandidates(hits: SearchHit[]): Candidate[] {
  const byUrl = new Map<string, Candidate>();
  for (const h of hits) {
    // Normalize away fragments/queries/trailing slash so near-identical URLs collapse.
    const key = h.url.replace(/[#?].*$/, "").replace(/\/$/, "");
    const existing = byUrl.get(key);
    if (existing) {
      if (!existing.intents.includes(h.intent)) existing.intents.push(h.intent);
      // Prefer a non-empty snippet/title if the first occurrence lacked one.
      if (!existing.snippet && h.snippet) existing.snippet = h.snippet;
      continue;
    }
    byUrl.set(key, { url: h.url, title: h.title, snippet: h.snippet, intents: [h.intent] });
  }
  return [...byUrl.values()];
}

/**
 * Cap candidates to the top `perQuery` per source query BEFORE scraping, so we don't pay to scrape
 * pages we would only discard afterwards. The old flow scraped EVERY deduped candidate and then kept
 * just the top-k per query (a POST-scrape cap), wasting up to one scrape per dropped candidate. Order
 * is preserved (search rank), and each candidate is grouped under its FIRST intent — the query that
 * surfaced it — matching the downstream per-sourceQuery evidence cap. Pure/deterministic; exported
 * for testing. (Selection by RANK here; task C replaces this criterion with triage relevance.)
 */
export function capCandidatesPerQuery(candidates: Candidate[], perQuery: number): Candidate[] {
  const seen = new Map<string, number>();
  const out: Candidate[] = [];
  for (const c of candidates) {
    const q = c.intents[0] ?? "";
    const n = seen.get(q) ?? 0;
    if (n >= perQuery) continue;
    seen.set(q, n + 1);
    out.push(c);
  }
  return out;
}

/**
 * Choose which scored candidates to scrape: per source query, the top `perQuery` by triage score,
 * DROPPING any below `minScore` (so a query that surfaced only off-topic junk scrapes fewer — or none
 * — rather than filling its quota with low-relevance pages the committee would read as "no evidence").
 * Grouped by first intent, like capCandidatesPerQuery; ties break by original (rank) order. When triage
 * is unavailable every candidate is UNSCORED (score 5), so with minScore below that this degrades to
 * the pure rank-based top-k. Pure/deterministic; exported for testing.
 */
export function selectCandidatesByScore(
  candidates: Candidate[],
  scores: Map<string, TriageScore>,
  perQuery: number,
  minScore: number,
): Candidate[] {
  const scoreOf = (c: Candidate) => scores.get(c.url)?.score ?? UNSCORED.score;
  const byQuery = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const q = c.intents[0] ?? "";
    const arr = byQuery.get(q);
    if (arr) arr.push(c);
    else byQuery.set(q, [c]);
  }
  const out: Candidate[] = [];
  const chosen = new Set<string>();
  for (const list of byQuery.values()) {
    // Stable sort by score desc — preserve encounter (rank) order within equal scores.
    const ranked = list
      .map((c, i) => ({ c, i }))
      .sort((a, b) => scoreOf(b.c) - scoreOf(a.c) || a.i - b.i)
      .map((x) => x.c);
    let taken = 0;
    for (const c of ranked) {
      if (taken >= perQuery) break;
      if (scoreOf(c) < minScore) break; // sorted desc → everything after is also below the bar
      if (chosen.has(c.url)) continue;
      chosen.add(c.url);
      out.push(c);
      taken += 1;
    }
  }
  return out;
}

/** Wrap a promise with a timeout so a single hung scrape can't stall the pipeline. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("scrape timeout")), ms)),
  ]);
}

/**
 * Scrape one source. Never throws — always resolves to a ScrapedSource (empty content on
 * failure, since the source is still citable from its search snippet). Emits scrape:begin and a
 * scrape:done whose `status` distinguishes the four outcomes (ok/blocked/skipped/empty) and
 * carries latency. On a HARD block (403/etc.) it records the domain to the running blocklist via
 * `recordBlock`, so subsequent scans skip it — this is the "learn from failures" loop.
 *
 * @param blocked  Whether this domain was already on the blocklist at rank time (→ skip, no request).
 * @param now      Monotonic clock for latency.
 * @param nowIso   ISO timestamp used when recording a newly-discovered blocker.
 */
async function scrapeOne(
  app: FirecrawlApp,
  src: Source,
  blocked: boolean,
  onEvent: (e: ScanEvent) => void,
  now: Clock,
  nowIso: string,
): Promise<ScrapedSource> {
  // Proactive skip: don't spend a request on a domain we already know blocks scrapers.
  if (blocked) {
    onEvent({ type: "scrape:done", id: src.id, domain: src.domain, status: "skipped", chars: 0, ms: 0 });
    return { ...src, content: "" };
  }

  if (/\.pdf(\?|#|$)/i.test(src.url)) {
    onEvent({ type: "scrape:done", id: src.id, domain: src.domain, status: "skipped", chars: 0, ms: 0 });
    return { ...src, content: "" };
  }

  // Cache hit — skip the Firecrawl call entirely.
  const cached = await getCache(src.url);
  if (cached !== null) {
    const content = truncate(cached, MAX_CHARS_PER_PAGE);
    getActiveTrace()?.logFirecrawlCall("scrape-cache-hit", { url: src.url }, content.length);
    onEvent({ type: "scrape:done", id: src.id, domain: src.domain, status: "cached", chars: content.length, ms: 0 });
    return { ...src, content };
  }

  onEvent({ type: "scrape:begin", id: src.id, domain: src.domain });
  const t0 = now();
  try {
    // Timeout lives INSIDE the limiter task so it clocks the actual scrape, not time spent
    // waiting in the shared Firecrawl queue behind other requests. onlyMainContent:false +
    // waitFor/timeout (origin/main "wait for js") let JS-rendered pages finish rendering before
    // Firecrawl scrapes them, instead of capturing an empty/incomplete shell.
    const res = await firecrawlLimiter(() =>
      withTimeout(
        app.scrapeUrl(src.url, {
          formats: ["markdown"],
          onlyMainContent: false,
          parsePDF: false,
          waitFor: 2000,
          timeout: 15000,
        }),
        SCRAPE_TIMEOUT_MS,
      ),
    );
    const md = "markdown" in res ? (res.markdown ?? "") : "";
    const content = truncate(md, MAX_CHARS_PER_PAGE);
    if (content.length > 0) void setCache(src.url, md);
    getActiveTrace()?.logFirecrawlCall("scrape", { url: src.url, status: content.length > 0 ? "ok" : "empty" }, content.length);
    onEvent({
      type: "scrape:done",
      id: src.id,
      domain: src.domain,
      status: content.length > 0 ? "ok" : "empty",
      chars: content.length,
      ms: now() - t0,
    });
    return { ...src, content };
  } catch (err) {
    // Distinguish a hard anti-scraping block (→ remember it) from a transient failure (→ don't).
    const e = err as { statusCode?: number; message?: string };
    const hardBlock = isHardBlock(e.statusCode, e.message);
    if (hardBlock) {
      // Fire-and-forget: recording must not delay or fail the scan.
      void recordBlock(src.domain, `auto: hard-block (${e.statusCode ?? "?"}) scraping ${src.url}`, nowIso);
    }
    getActiveTrace()?.logFirecrawlCall("scrape", { url: src.url, status: hardBlock ? "blocked" : "empty" }, 0);
    onEvent({
      type: "scrape:done",
      id: src.id,
      domain: src.domain,
      status: hardBlock ? "blocked" : "empty",
      chars: 0,
      ms: now() - t0,
    });
    return { ...src, content: "" };
  }
}

/** A ranked source paired with whether its domain is currently blocklisted. */
interface RankedSource {
  source: Source;
  blocked: boolean;
}

/**
 * Scrape the ranked sources with BOUNDED concurrency.
 *
 * WHY A WORKER POOL (not Promise.all over everything): Firecrawl throttles concurrent requests,
 * so firing all ~28 scrapes at once makes each one contend for bandwidth — pages that scrape in
 * 2–5s alone balloon to 10–15s and cross the timeout, producing FALSE failures (measured; see
 * SCRAPE_TIMEOUT_MS). SCRAPE_CONCURRENCY workers pull from a shared cursor (`next`) into `ranked`;
 * each worker grabs the next index, scrapes it to completion, then grabs another until the queue
 * drains. The true network cap is now the shared `firecrawlLimiter` (PROVIDER_CONCURRENCY.firecrawl) that
 * wraps the scrapeUrl call itself — the worker pool just overlaps cache lookups and setup ahead of
 * it, so no scrape sits idle. Total scrape wall-clock ≈ ceil(N / PROVIDER_CONCURRENCY.firecrawl) × page-latency.
 *
 * Never throws; results preserve input order (worker writes to results[i]).
 */
async function scrapeSources(
  app: FirecrawlApp,
  ranked: RankedSource[],
  onEvent: (e: ScanEvent) => void,
  now: Clock,
  nowIso: string,
): Promise<{ scraped: ScrapedSource[]; apiCalls: number }> {
  const results: ScrapedSource[] = new Array(ranked.length);
  let next = 0;
  let apiCalls = 0;

  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= ranked.length) return;
      const src = ranked[i];
      const isLive = !src.blocked && !/\.pdf(\?|#|$)/i.test(src.source.url) && (await getCache(src.source.url)) === null;
      results[i] = await scrapeOne(app, src.source, src.blocked, onEvent, now, nowIso);
      if (isLive) apiCalls++;
    }
  };

  const workerCount = Math.min(SCRAPE_CONCURRENCY, ranked.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return { scraped: results, apiCalls };
}

/**
 * The full exploration step, now with LLM judgment in the loop:
 *
 *   (a) ADAPT  — makeIntents(industry) designs industry-specific search intents (fallback: static).
 *       SEARCH — run all intents (8 results each) in parallel; emit per-intent timing.
 *       DEDUPE — collapse to unique candidates, merging the intents that found each URL.
 *   (c) TRIAGE — scoreCandidates() scores each candidate 0–10 before we spend any scrape.
 *       SELECT — selectSources() picks the final set (per-intent quota floor + merit fill), each
 *                carrying its relevanceScore + reason.
 *       SCRAPE — bounded concurrency + blocklist skip (unchanged).
 *
 * Every source is cross-referenced against the running blocklist (lib/blocklist.ts) and flagged
 * `blocked` so the UI shows it as intentionally skipped. Both LLM steps fall back gracefully — a
 * failure never throws, it degrades to today's behavior. Emits phase timings for the UI.
 *
 * @param industry  the raw industry string (intent generation happens here now).
 * @param now       Monotonic clock (defaults to Date.now); injected for deterministic tests.
 * @param nowIso    ISO time used when a newly-discovered blocker is recorded.
 */
export async function explore(
  industry: string,
  onEvent: (e: ScanEvent) => void,
  now: Clock = () => Date.now(),
  nowIso: string = new Date().toISOString(),
): Promise<{ sources: Source[]; scraped: ScrapedSource[]; searchMs: number; scrapeMs: number; firecrawlCalls: number; firecrawlCredits: number }> {
  const app = makeFirecrawl();
  const maxScrape = MAX_SCRAPE;
  const quotaFloor = QUOTA_FLOOR;

  // --- (a) Adapt intents ---
  const adaptStart = now();
  onEvent({ type: "adapt:begin", model: triageModel() });
  const { intents, adapted, usage: adaptUsage } = await makeIntents(industry);
  onEvent({
    type: "intents",
    intents: intents.map((i) => ({ label: i.label, query: i.query })),
    adapted,
    ms: now() - adaptStart,
    usage: adaptUsage,
  });

  // --- Search + dedupe (blocklist loads in parallel — it's just a file read) ---
  const searchStart = now();
  const [searchResult, blockset] = await Promise.all([
    searchAllIntents(app, intents, onEvent, now),
    loadBlocklist(),
  ]);
  const allCandidates = dedupeCandidates(searchResult.hits);
  const searchMs = now() - searchStart;
  const blocked: Candidate[] = [];
  const candidates: Candidate[] = [];
  for (const c of allCandidates) {
    if (blockset.has(blocklistKey(domainOf(c.url))) || /\.pdf(\?|#|$)/i.test(c.url)) blocked.push(c);
    else candidates.push(c);
  }

  // --- (c) Triage: score candidates before scraping ---
  const triageStart = now();
  onEvent({ type: "triage:begin", model: triageModel(), candidates: candidates.length, blocked: blocked.length });
  const { scores, usage: triageUsage } = await scoreCandidates(industry, candidates);
  const sources = selectSources(candidates, scores, maxScrape, quotaFloor);
  onEvent({
    type: "triage:done",
    candidates: candidates.length,
    selected: sources.length,
    blocked: blocked.length,
    adapted,
    ms: now() - triageStart,
    usage: triageUsage,
  });

  const ranked: RankedSource[] = sources.map((source) => ({
    source,
    blocked: false,
  }));

  onEvent({
    type: "sources",
    searchMs,
    sources: ranked.map((r) => ({ ...r.source, blocked: r.blocked })),
  });

  // --- Scrape phase (bounded concurrency; skips blocked domains) ---
  const scrapeStart = now();
  const { scraped, apiCalls: scrapeApiCalls } = await scrapeSources(app, ranked, onEvent, now, nowIso);
  const scrapeMs = now() - scrapeStart;

  // Credit math: 2 credits per search, 1 per scrape (cached/skipped don't count).
  const firecrawlCalls = searchResult.apiCalls + scrapeApiCalls;
  const firecrawlCredits = searchResult.apiCalls * 2 + scrapeApiCalls * 1;

  return { sources, scraped, searchMs, scrapeMs, firecrawlCalls, firecrawlCredits };
}

/**
 * Search for evidence across multiple queries, scrape results, and return typed Evidence[].
 * Wraps the existing Firecrawl search+scrape pipeline without LLM triage.
 * Each result is tagged with sourceQuery (the query that surfaced it) and loopIteration.
 */
export interface SearchResult {
  evidence: Evidence[];
  searchCredits: number;
  scrapeCredits: number;
  /** The relevance-triage LLM call's usage, when triage ran (the caller books its cost). */
  triageUsage?: TokenUsage;
}

/**
 * Live progress from inside `search()` — lets a streaming transport show motion
 * during the minutes-long search+scrape phase. Purely observational: emission
 * order and content never affect the returned SearchResult.
 */
export type SearchProgress =
  | { kind: "search"; query: string; hits: number; cached: boolean }
  | { kind: "scrape"; done: number; total: number };

export async function search(
  queries: string[],
  k: number,
  loopIteration: number,
  onProgress?: (p: SearchProgress) => void,
  context = "",
): Promise<SearchResult> {
  const app = makeFirecrawl();
  const now: Clock = () => Date.now();
  const nowIso = new Date().toISOString();
  const noop = () => {};

  // Track per-URL snippet and the query that surfaced each URL first.
  const metaByUrl = new Map<string, { snippet: string; sourceQuery: string }>();

  const fetchLimit = SEARCH_CANDIDATES_PER_QUESTION;
  let searchCredits = 0;

  const perQuery = await Promise.all(
    queries.map(async (query) => {
      try {
        const cached = await getSearchCache(query);
        if (cached) getActiveTrace()?.logFirecrawlCall("search-cache-hit", { query }, cached.length);
        const raw = cached
          ? cached
          : await (async () => {
              searchCredits += 2;
              const res = await firecrawlLimiter(() => app.search(query, { limit: fetchLimit }));
              const hits = (res.data ?? [])
                .filter((d) => d.url)
                .map((d) => ({
                  url: d.url as string,
                  title: d.metadata?.title || d.title || domainOf(d.url as string),
                  snippet: d.description || d.metadata?.description || "",
                }));
              const trace = getActiveTrace();
              if (trace) {
                trace.logFirecrawlCall("search", { query, limit: fetchLimit }, hits.length);
              }
              void setSearchCache(query, hits);
              return hits;
            })();
        onProgress?.({ kind: "search", query, hits: raw.length, cached: !!cached });
        return raw.map((h) => ({ ...h, intent: query }));
      } catch {
        onProgress?.({ kind: "search", query, hits: 0, cached: false });
        return [];
      }
    }),
  );

  const hits: SearchHit[] = perQuery.flat();
  for (const h of hits) {
    if (!metaByUrl.has(h.url)) {
      metaByUrl.set(h.url, { snippet: h.snippet, sourceQuery: h.intent });
    }
  }

  // Select which candidates to scrape BEFORE scraping (was: scrape all, then keep top-k), so we only
  // pay to scrape pages we'll use. With triage on, one cheap gpt-4o-mini call scores every deduped
  // candidate for relevance to `context` and we keep the top-k per query above MIN_TRIAGE_SCORE
  // (dropping off-topic junk a bad query surfaced); off, we fall back to the rank-based per-query cap.
  const deduped = dedupeCandidates(hits);
  let candidates: Candidate[];
  let triageUsage: TokenUsage | undefined;
  if (TRIAGE_ENABLED && deduped.length > 0) {
    const { scores, usage } = await scoreCandidates(context, deduped);
    triageUsage = usage;
    candidates = selectCandidatesByScore(deduped, scores, k, MIN_TRIAGE_SCORE);
    getActiveTrace()?.log("triage", { context, scored: deduped.length, selected: candidates.length });
  } else {
    candidates = capCandidatesPerQuery(deduped, k);
  }
  const blockset = await loadBlocklist();

  const ranked: RankedSource[] = candidates.map((c, i) => ({
    source: {
      id: i,
      url: c.url,
      domain: domainOf(c.url),
      title: c.title,
      intent: c.intents[0] ?? "",
    },
    blocked: blockset.has(blocklistKey(domainOf(c.url))),
  }));

  // Count scrape completions (any status) for live progress; scrapeSources itself
  // already reports every outcome through its ScanEvent callback.
  let scrapesDone = 0;
  const scrapeProgress = onProgress
    ? (e: ScanEvent) => {
        if (e.type === "scrape:done") {
          onProgress({ kind: "scrape", done: ++scrapesDone, total: ranked.length });
        }
      }
    : noop;
  const { scraped, apiCalls: scrapeCredits } = await scrapeSources(app, ranked, scrapeProgress, now, nowIso);

  const withContent = scraped.filter((s) => s.content.length > 0);

  // Cap per source query so each question gets up to k usable sources.
  const seen = new Map<string, number>();
  const capped = withContent.filter((s) => {
    const query = metaByUrl.get(s.url)?.sourceQuery ?? s.intent;
    const count = seen.get(query) ?? 0;
    if (count >= k) return false;
    seen.set(query, count + 1);
    return true;
  });

  const evidence = capped
    .map((s) => {
      const meta = metaByUrl.get(s.url) ?? { snippet: "", sourceQuery: s.intent };
      const hash = contentHash(s.content || s.url);
      return {
        id: hash,
        url: s.url,
        domain: s.domain,
        title: s.title,
        snippet: meta.snippet,
        content: s.content,
        contentHash: hash,
        sourceQuery: meta.sourceQuery,
        loopIteration,
      };
    });

  return { evidence, searchCredits, scrapeCredits, triageUsage };
}

/**
 * Snippet-only web search for the researcher agent's `webSearch` tool (P3). Returns the raw
 * search hits WITHOUT scraping any page — the agent decides what to read via `scrapeOneCached`.
 *
 * Credit accounting mirrors `search()`'s exactly: a live (cache-miss) query bills 2 REAL Firecrawl
 * credits, and Firecrawl charges for the request whether it succeeds or throws — so we report
 * `credits: 2` even on error (the live attempt was made). A cache hit costs 0. Never throws.
 *
 * `app` is injectable (default `makeFirecrawl()`) mirroring the injected clock elsewhere in this
 * module, so tests can supply a stub client without module-mocking the SDK.
 */
export async function webSearchRaw(
  query: string,
  app: FirecrawlApp = makeFirecrawl(),
): Promise<{ hits: { title: string; url: string; snippet: string }[]; credits: number }> {
  const cached = await getSearchCache(query);
  if (cached) {
    getActiveTrace()?.logFirecrawlCall("search-cache-hit", { query }, cached.length);
    return {
      hits: cached.map((d) => ({ title: d.title, url: d.url, snippet: d.snippet })),
      credits: 0,
    };
  }

  try {
    const res = await firecrawlLimiter(() => app.search(query, { limit: SEARCH_CANDIDATES_PER_QUESTION }));
    const hits = (res.data ?? [])
      .filter((d) => d.url)
      .map((d) => ({
        url: d.url as string,
        title: d.metadata?.title || d.title || domainOf(d.url as string),
        snippet: d.description || d.metadata?.description || "",
      }));
    getActiveTrace()?.logFirecrawlCall("search", { query, limit: SEARCH_CANDIDATES_PER_QUESTION }, hits.length);
    void setSearchCache(query, hits);
    return { hits, credits: 2 };
  } catch {
    // Firecrawl billed the request even though it failed — report the live credit, no hits.
    return { hits: [], credits: 2 };
  }
}

/**
 * Scrape a single URL for the researcher agent's `readSource` tool (P3), cache-aware and reporting
 * REAL post-cache credits. Delegates to the private `scrapeOne` helper (blocklist skip, PDF skip,
 * cache hit, timeout, `setCache`, errors → empty content — all handled there; never throws).
 *
 * Credit accounting replicates `scrapeSources()`'s `isLive` rule exactly:
 *   `isLive = !blocked && !isPdf && (await getCache(url)) === null`  → 1 credit; otherwise 0.
 * So a cache hit, a PDF, a blocklisted domain, or any skip costs 0; only a genuine live scrape
 * bills 1 credit. `content` is the full scraped page (already truncated to MAX_CHARS_PER_PAGE).
 */
export async function scrapeOneCached(
  url: string,
  app: FirecrawlApp = makeFirecrawl(),
): Promise<{ url: string; domain: string; content: string; credits: number }> {
  const domain = domainOf(url);
  const src: Source = { id: 0, url, domain, title: domain, intent: "" };
  const blockset = await loadBlocklist();
  const blocked = blockset.has(blocklistKey(domain));

  // Determine liveness BEFORE scraping (scrapeOne populates the cache on success, which would
  // otherwise flip this to a false cache-hit). Mirrors scrapeSources()'s exact rule.
  const isPdf = /\.pdf(\?|#|$)/i.test(url);
  const isLive = !blocked && !isPdf && (await getCache(url)) === null;

  const scraped = await scrapeOne(app, src, blocked, () => {}, () => Date.now(), new Date().toISOString());
  return { url, domain, content: scraped.content, credits: isLive ? 1 : 0 };
}
