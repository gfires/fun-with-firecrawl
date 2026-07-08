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
import type { ScanEvent } from "../events";
import type { Source } from "../schema";
import type { Intent } from "../intents";
import { domainOf, truncate } from "../format";
import { loadBlocklist, blocklistKey, isHardBlock, recordBlock } from "../blocklist";
import { getCache, setCache } from "../scrape-cache";
import { getSearchCache, setSearchCache } from "../search-cache";
import { MAX_CHARS_PER_PAGE, SCRAPE_TIMEOUT_MS, SCRAPE_CONCURRENCY, RESULTS_PER_INTENT, MAX_SCRAPE, QUOTA_FLOOR } from "../params";
import { makeIntents, scoreCandidates, selectSources, triageModel, type Candidate } from "../triage";
import { type Evidence, contentHash } from "./store";


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
        const res = await app.search(intent.query, { limit: resultsPerIntent });
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
    onEvent({ type: "scrape:done", id: src.id, domain: src.domain, status: "cached", chars: content.length, ms: 0 });
    return { ...src, content };
  }

  onEvent({ type: "scrape:begin", id: src.id, domain: src.domain });
  const t0 = now();
  try {
    const res = await withTimeout(
      app.scrapeUrl(src.url, { formats: ["markdown"], onlyMainContent: true, parsePDF: false }),
      SCRAPE_TIMEOUT_MS,
    );
    const md = "markdown" in res ? (res.markdown ?? "") : "";
    const content = truncate(md, MAX_CHARS_PER_PAGE);
    if (content.length > 0) void setCache(src.url, md);
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
 * SCRAPE_TIMEOUT_MS). Instead, exactly SCRAPE_CONCURRENCY workers pull from a shared cursor
 * (`next`) into the `ranked` array; each worker grabs the next index, scrapes it to completion,
 * then grabs another, until the queue drains. That caps in-flight requests at SCRAPE_CONCURRENCY
 * so each gets enough bandwidth to finish in its natural time, while still overlapping work.
 * Total scrape wall-clock ≈ ceil(N / SCRAPE_CONCURRENCY) × typical-page-latency.
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
export async function search(
  queries: string[],
  k: number,
  loopIteration: number,
): Promise<Evidence[]> {
  const app = makeFirecrawl();
  const now: Clock = () => Date.now();
  const nowIso = new Date().toISOString();
  const noop = () => {};

  // Track per-URL snippet and the query that surfaced each URL first.
  const metaByUrl = new Map<string, { snippet: string; sourceQuery: string }>();

  const perQuery = await Promise.all(
    queries.map(async (query) => {
      try {
        const cached = await getSearchCache(query);
        const raw = cached
          ? cached
          : await (async () => {
              const res = await app.search(query, { limit: k });
              const hits = (res.data ?? [])
                .filter((d) => d.url)
                .map((d) => ({
                  url: d.url as string,
                  title: d.metadata?.title || d.title || domainOf(d.url as string),
                  snippet: d.description || d.metadata?.description || "",
                }));
              void setSearchCache(query, hits);
              return hits;
            })();
        return raw.map((h) => ({ ...h, intent: query }));
      } catch {
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

  const candidates = dedupeCandidates(hits);
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

  const { scraped } = await scrapeSources(app, ranked, noop, now, nowIso);

  return scraped.map((s) => {
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
}
