/**
 * params.ts — every tunable parameter in one place.
 *
 * Baseline pipeline params (search → triage → scrape → analyze) are at the top.
 * Orchestration params (decompose → retrieve → debate → gate loop) are below.
 */

// -- Baseline: models --------------------------------------------------------

export const ANALYSIS_MODEL        = "gpt-4o";
export const TRIAGE_MODEL          = "gpt-4o-mini";

// -- Baseline: search --------------------------------------------------------

export const SEARCH_INTENTS        = 8;
export const RESULTS_PER_INTENT    = 8;

// -- Baseline: triage / selection --------------------------------------------

export const MAX_SCRAPE            = 22;
export const QUOTA_FLOOR           = 2;

// -- Baseline: scrape --------------------------------------------------------

export const MAX_CHARS_PER_PAGE    = 4500;
export const SCRAPE_TIMEOUT_MS     = 20_000;
export const SCRAPE_CONCURRENCY    = 6;

// -- Orchestration: decompose ------------------------------------------------

export const MIN_QUESTIONS         = 3;
export const MAX_QUESTIONS         = 5;

// -- Orchestration: retrieve -------------------------------------------------

export const RESULTS_PER_QUESTION  = 6;
export const SEARCH_CANDIDATES_PER_QUESTION = 10;

// -- Orchestration: gate / budget --------------------------------------------

export const MAX_LOOP_ITERATIONS   = 5;
export const TOTAL_FIRECRAWL_BUDGET = 80;
export const MAX_RUN_COST_USD      = 2.00;

// -- Orchestration: token efficiency -----------------------------------------

export const MAX_EVIDENCE_CHARS_PER_AGENT = 30_000;
export const MAX_CONCLUSION_CHARS    = 400;

// Per-question evidence digest (L2): a Haiku pass compresses each source to one
// short item before the committee fans out, so each role sees a compact digest
// instead of full page content. DIGEST_ENABLED=false falls back to raw evidence.
export const DIGEST_ENABLED          = true;
export const MAX_DIGEST_SUMMARY_CHARS = 400;

// Committee cache-hit restructure (L3): the 3 Claude roles share a byte-identical system
// prefix so Anthropic can serve it from its prompt cache. cacheControl is only worth
// attaching when the prefix is large enough to matter — below this many chars, skip it.
export const PROMPT_CACHE_MIN_CHARS  = 4500;
