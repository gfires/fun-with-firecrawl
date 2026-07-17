/**
 * evidence/config.ts — every search/scrape tunable in one place, provider-agnostic.
 *
 * These are retrieval MECHANICS (how many results per query, how deep to scrape, when to triage)
 * that any SearchProvider implementation should respect — they don't belong to Firecrawl or Exa
 * specifically. Provider SELECTION (which implementation is active) also lives here as
 * SEARCH_PROVIDER, so swapping providers is a one-line edit. Provider-specific account throttles
 * (rate limits) live in PROVIDER_CONCURRENCY, keyed by provider id, since different vendors have
 * different ceilings.
 *
 * Orchestration-level $-budget policy (MAX_RUN_COST_USD, TOTAL_FIRECRAWL_BUDGET,
 * MAX_LOOP_SPEND_FRACTION, etc.) stays in params.ts — that's gate/loop STRATEGY, not retrieval
 * mechanics, and doesn't change when the provider does.
 */

// -- Provider selection --------------------------------------------------------

export type SearchProviderId = "firecrawl" | "exa";

/** Which SearchProvider implementation (evidence/provider.ts) is active. Flip this one line to
 * swap Firecrawl for Exa — every call site resolves through evidence/provider.ts, not a direct
 * import of a specific provider's module, so nothing else needs to change. */
export const SEARCH_PROVIDER: SearchProviderId = "firecrawl";

/**
 * Global in-flight request cap per provider, keyed by provider id. Firecrawl throttles to ~2
 * simultaneous requests per account; funnelling every call (search AND scrape, across all
 * questions and both arms) through one shared FIFO queue of this size keeps runs under that
 * ceiling so bursts don't turn into 429s / timeouts that read as false scrape failures.
 * Exa's ceiling is unverified against a live account — 5 is a conservative placeholder; tune
 * after a real run reports 429s or comes back well under budget.
 */
export const PROVIDER_CONCURRENCY: Record<SearchProviderId, number> = {
  firecrawl: 2,
  exa: 5,
};

// -- Baseline arm: search ------------------------------------------------------

export const SEARCH_INTENTS        = 8;
export const RESULTS_PER_INTENT    = 8;

// -- Baseline arm: triage / selection -------------------------------------------

export const MAX_SCRAPE            = 22;
export const QUOTA_FLOOR           = 2;

// -- Baseline arm: scrape -------------------------------------------------------

// 4000 (down from 4500) — origin/main's "tokens in check" tuning, keeping per-page content
// within a tighter token budget downstream.
export const MAX_CHARS_PER_PAGE    = 4000;
export const SCRAPE_TIMEOUT_MS     = 20_000;
export const SCRAPE_CONCURRENCY    = 6;

// -- Orchestrated arm: decompose (query shape) ----------------------------------

// Keyword search queries decompose emits per question (used verbatim by retrieve instead of the
// full question sentence, which searches poorly). ONE broad query per question at loop 0 halves
// search spend; refine adds a sharper gap-targeted query on loop 1. Clamped in code (no schema max).
export const MAX_SEARCH_QUERIES_PER_QUESTION = 1;

// -- Orchestrated arm: retrieve --------------------------------------------------

export const RESULTS_PER_QUESTION  = 6;
// Loop-0 reconnaissance depth (layer 2): the broad first pass scrapes FEWER results per query than
// the later gap-targeted passes. Marginal value of evidence is inverted against depth — on loop 0 you
// don't yet know what's missing, so each page buys generic coverage; after a debate the committee has
// NAMED the gap, so a targeted scrape buys exactly what would move a position. Loop 0 is therefore
// reconnaissance: just enough to seed grounded round-0 claims and let the committee name its gaps.
// GROUNDING FLOOR — do NOT drop below 3: thin evidence historically caused a "historian confabulation"
// bug (roles claiming about evidence that isn't there and mis-calibrating their missingEvidence), so
// recon must stay deep enough that round-0 claims and their named gaps are trustworthy.
export const RECON_RESULTS_PER_QUESTION = 3;
export const SEARCH_CANDIDATES_PER_QUESTION = 10;

/**
 * Results scraped per query for a given outer loop (layer 2): shallow RECONNAISSANCE on loop 0
 * (RECON_RESULTS_PER_QUESTION), full depth (RESULTS_PER_QUESTION) on every later, gap-targeted pass.
 * Loop 0 doesn't yet know what's missing, so each page buys generic coverage — scrape just enough to
 * seed grounded round-0 claims and let the committee name its gaps; once a gap is named, the targeted
 * passes go deep where the marginal value is high. See RECON_RESULTS_PER_QUESTION for the grounding floor.
 *
 * Lives here (not in graph.ts) so the agentic researcher can import it for its per-pass evidence
 * CEILING without a circular import (graph.ts → researcher.ts); graph.ts re-exports it for callers.
 */
export function resultsPerQuestionForLoop(loopIteration: number): number {
  return loopIteration === 0 ? RECON_RESULTS_PER_QUESTION : RESULTS_PER_QUESTION;
}

// Relevance triage (orchestrated retrieve): one cheap LLM call scores every deduped search
// candidate 0–10 for relevance BEFORE scraping, so off-topic hits (a bad query's marketing/biotech
// junk) are dropped instead of scraped and fed to the committee. TRIAGE_ENABLED=false falls back to
// the rank-based per-query cap (capCandidatesPerQuery). MIN_TRIAGE_SCORE is the keep bar; it sits
// BELOW the UNSCORED default (5) so a triage failure degrades to pure rank-cap, never over-filters.
export const TRIAGE_ENABLED        = true;
export const MIN_TRIAGE_SCORE      = 4;
