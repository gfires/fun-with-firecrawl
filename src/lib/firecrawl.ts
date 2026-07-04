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
 *      intent that surfaced it, emitting search:begin/done as they resolve.
 *   2. rankSources()     — dedupe by URL, prefer diversity across intents, cap the count.
 *   3. scrapeSources()   — scrape the chosen URLs in parallel with a per-page timeout, using
 *      Promise.allSettled so one slow/dead page can't sink the whole run.
 */
import FirecrawlApp from "@mendable/firecrawl-js";
import type { ScanEvent } from "./events";
import type { Source } from "./schema";
import type { Intent } from "./intents";
import { domainOf, truncate } from "./format";

/** Per-page markdown budget (chars). Keeps the LLM prompt within token limits. */
const MAX_CHARS_PER_PAGE = 3500;

/**
 * Per-page scrape timeout (ms). This is per REQUEST, not the whole phase.
 *
 * WHY 20s: pages that take 1–5s to scrape in isolation balloon to 8–15s when many scrape
 * requests contend for Firecrawl bandwidth at once. Measured directly (see git history / the
 * investigation): firing all sources simultaneously pushed healthy pages past a 15s timeout,
 * causing false failures. We solve the ROOT cause with bounded concurrency (SCRAPE_CONCURRENCY
 * below) and keep this timeout as a safety net for genuinely hung pages.
 */
const SCRAPE_TIMEOUT_MS = 20_000;

/**
 * Max simultaneous scrape requests. Bounded so each request gets enough Firecrawl bandwidth to
 * finish in its natural 2–5s instead of collapsing under congestion. 6 keeps the scrape phase
 * fast (~5 batches of 28 sources) while avoiding the timeout-inducing pile-up. Sites that
 * hard-block scrapers (Reddit/LinkedIn/Indeed → 403) still fail; that's correct and expected.
 */
const SCRAPE_CONCURRENCY = 6;

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

/** Read tuning knobs from env with sensible defaults. */
function config() {
  return {
    resultsPerIntent: Number(process.env.SCAN_RESULTS_PER_INTENT ?? 5),
    maxScrape: Number(process.env.SCAN_MAX_SCRAPE ?? 28),
  };
}

/** Construct the Firecrawl client. Throws a clear error if the key is missing. */
export function makeFirecrawl(): FirecrawlApp {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not set. Copy .env.local.example to .env.local.");
  return new FirecrawlApp({ apiKey });
}

/**
 * Run every intent's search query in parallel. Emits search:begin/done per intent.
 * Failures on individual intents are swallowed (that intent just contributes no hits).
 */
async function searchAllIntents(
  app: FirecrawlApp,
  intents: Intent[],
  onEvent: (e: ScanEvent) => void,
): Promise<SearchHit[]> {
  const { resultsPerIntent } = config();

  const perIntent = await Promise.all(
    intents.map(async (intent) => {
      onEvent({ type: "search:begin", intent: intent.label });
      try {
        const res = await app.search(intent.query, { limit: resultsPerIntent });
        const hits: SearchHit[] = (res.data ?? [])
          .filter((d) => d.url)
          .map((d) => ({
            url: d.url as string,
            title: d.metadata?.title || d.title || domainOf(d.url as string),
            snippet: d.description || d.metadata?.description || "",
            intent: intent.label,
          }));
        onEvent({ type: "search:done", intent: intent.label, count: hits.length });
        return hits;
      } catch {
        // One flaky intent shouldn't fail the scan. Report zero and move on.
        onEvent({ type: "search:done", intent: intent.label, count: 0 });
        return [];
      }
    }),
  );

  return perIntent.flat();
}

/**
 * Dedupe and rank search hits into the final citable Source list.
 *
 * Ranking goal: DIVERSITY across intents. We interleave hits round-robin by intent so the
 * scraped set represents software, jobs, complaints, forums, etc. rather than 28 pages that
 * all came from one dominant query. Sources are assigned stable [N] ids in final order.
 */
export function rankSources(hits: SearchHit[], maxScrape: number): Source[] {
  // Dedupe by normalized URL, keeping the first (highest-ranked) occurrence.
  const seen = new Set<string>();
  const byIntent = new Map<string, SearchHit[]>();
  for (const h of hits) {
    const key = h.url.replace(/[#?].*$/, "").replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byIntent.has(h.intent)) byIntent.set(h.intent, []);
    byIntent.get(h.intent)!.push(h);
  }

  // Round-robin interleave across intents for diversity.
  const buckets = [...byIntent.values()];
  const ordered: SearchHit[] = [];
  for (let i = 0; ordered.length < maxScrape; i++) {
    let advanced = false;
    for (const bucket of buckets) {
      if (bucket[i]) {
        ordered.push(bucket[i]);
        advanced = true;
        if (ordered.length >= maxScrape) break;
      }
    }
    if (!advanced) break; // all buckets exhausted
  }

  return ordered.map((h, idx) => ({
    id: idx + 1, // 1-based [N] citation ids
    url: h.url,
    domain: domainOf(h.url),
    title: h.title,
    intent: h.intent,
  }));
}

/** Wrap a promise with a timeout so a single hung scrape can't stall the pipeline. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("scrape timeout")), ms)),
  ]);
}

/** Scrape one source. Soft-fails (empty content) rather than throwing; emits begin/done. */
async function scrapeOne(
  app: FirecrawlApp,
  src: Source,
  onEvent: (e: ScanEvent) => void,
): Promise<ScrapedSource> {
  onEvent({ type: "scrape:begin", id: src.id, domain: src.domain });
  try {
    const res = await withTimeout(
      app.scrapeUrl(src.url, { formats: ["markdown"], onlyMainContent: true }),
      SCRAPE_TIMEOUT_MS,
    );
    const md = "markdown" in res ? (res.markdown ?? "") : "";
    const content = truncate(md, MAX_CHARS_PER_PAGE);
    onEvent({ type: "scrape:done", id: src.id, domain: src.domain, ok: content.length > 0, chars: content.length });
    return { ...src, content };
  } catch {
    // Common causes: 403 bot-blocks (Reddit/LinkedIn/Indeed) or a genuinely hung page.
    // Keep the source — it's still citable from its search snippet — with empty content.
    onEvent({ type: "scrape:done", id: src.id, domain: src.domain, ok: false, chars: 0 });
    return { ...src, content: "" };
  }
}

/**
 * Scrape the ranked sources with BOUNDED concurrency (SCRAPE_CONCURRENCY workers pulling from
 * a shared queue). This is the fix for congestion-induced false failures: firing all sources
 * at once made healthy pages exceed the timeout; a small worker pool lets each request finish
 * in its natural few seconds. Emits scrape:begin/done per page; never throws.
 */
async function scrapeSources(
  app: FirecrawlApp,
  sources: Source[],
  onEvent: (e: ScanEvent) => void,
): Promise<ScrapedSource[]> {
  const results: ScrapedSource[] = new Array(sources.length);
  let next = 0; // shared cursor into `sources`

  // Each worker repeatedly claims the next index until the queue is drained.
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= sources.length) return;
      results[i] = await scrapeOne(app, sources[i], onEvent);
    }
  };

  const workerCount = Math.min(SCRAPE_CONCURRENCY, sources.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/**
 * The full exploration step. Given intents, returns the scraped corpus + the Source list
 * (which is emitted mid-way via the `sources` event so the UI can render it before scraping).
 */
export async function explore(
  intents: Intent[],
  onEvent: (e: ScanEvent) => void,
): Promise<{ sources: Source[]; scraped: ScrapedSource[] }> {
  const app = makeFirecrawl();
  const { maxScrape } = config();

  const hits = await searchAllIntents(app, intents, onEvent);
  const sources = rankSources(hits, maxScrape);
  onEvent({ type: "sources", sources });

  const scraped = await scrapeSources(app, sources, onEvent);
  return { sources, scraped };
}
