# Blindspot

> Scan any industry for structural bottlenecks, solution gaps, and founder-ready opportunities.
> Type an industry, get an evidence-backed report with scores, an actionable thesis, and
> concrete next steps — all grounded in real sources with direct quotes.

Two research arms run side-by-side for direct comparison:

- **Baseline** — single-prompt pipeline: search → triage → scrape → analyze (the original system)
- **Orchestrated** — multi-agent LangGraph loop: decompose → retrieve → debate → gate → recommend

The orchestrated arm decomposes a topic into questions, runs a four-agent committee (Historian,
Operator, Investor, Skeptic) that produces structured claims with calibrated confidence, then a
value-of-information gate allocates further retrieval budget only toward questions where more
evidence would change the recommendation. This loops until confidence converges or budget runs out.

---

## Quick start

```bash
npm install
cp .env.local.example .env.local   # then add your keys
npm run dev                        # http://localhost:3000
```

You need three keys in `.env.local`:

| Var | Where | Used for |
| --- | --- | --- |
| `FIRECRAWL_API_KEY` | https://firecrawl.dev | web `/search` + `/scrape` |
| `OPENAI_API_KEY` | https://platform.openai.com | baseline analysis, triage, skeptic agent |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com | manager, historian, operator, investor agents |

### Run the A/B comparison

```bash
npx tsx scripts/compare-arms.ts "freight brokerage"
```

Output lands in `compare-output/<topic>-<timestamp>.json` with both arms' reports, token usage,
Firecrawl costs, and wall-clock time side by side.

---

## Architecture

### Baseline pipeline

```
industry
   │
   ▼  ADAPT — makeIntents()                            src/lib/triage.ts
   │  gpt-4o-mini designs 8 search intents tailored to this industry, told the 7
   │  report sections so the intents aim at evidence the report actually needs.
   │
   ▼  SEARCH — searchAllIntents()                      src/lib/evidence/firecrawl.ts
   │  8 intents × 8 results each, in parallel via Firecrawl /search.
   │  Results cached (data/search-cache.json).
   │
   ▼  DEDUPE + FILTER — dedupeCandidates()             src/lib/evidence/firecrawl.ts
   │  Collapse to ~50–60 unique URLs, merging intent tags.
   │  Blocklisted domains and PDF URLs removed before triage.
   │
   ▼  TRIAGE — scoreCandidates()                       src/lib/triage.ts
   │  ONE gpt-4o-mini call scores all candidates 0–10.
   │
   ▼  SELECT — selectSources()                         src/lib/triage.ts
   │  Pure, deterministic. Quota floor (top-2 per intent) + merit fill to 22.
   │
   ▼  SCRAPE — scrapeSources()                         src/lib/evidence/firecrawl.ts
   │  Bounded concurrency (6 at a time). Cached (data/scrape-cache.json).
   │
   ▼  ANALYZE — callLLM()                              src/lib/analyze.ts
   │  gpt-4o reads full corpus. JSON output validated by zod.
   │
   ▼  ASSEMBLE + STREAM                                src/app/api/scan/route.ts
   Report + opportunity score streamed to browser via SSE.
```

### Orchestrated pipeline

```
topic
   │
   ▼  DECOMPOSE                                        src/lib/orchestration/graph.ts
   │  Manager (Claude Sonnet 5) breaks topic into 3–5 research questions.
   │
   ▼  RETRIEVE                                         src/lib/evidence/firecrawl.ts
   │  search() fetches web evidence for each unresolved question in parallel.
   │  Evidence is append-only across loops.
   │
   ▼  DEBATE                                           src/lib/orchestration/committee.ts
   │  Four role-agents each produce an independent Claim per question:
   │    Historian (Claude Sonnet 5) — wants precedent
   │    Operator  (Claude Sonnet 5) — wants friction
   │    Investor  (Claude Sonnet 5) — wants returns
   │    Skeptic   (GPT-4o)          — finds failure modes
   │  Confidence is calibrated identically across all four roles.
   │
   ▼  GATE                                             src/lib/orchestration/gate.ts
   │  Scores each question's value-of-information:
   │    VOI = disagreement × recommendation-sensitivity × tractability
   │  Questions below VOI_THRESHOLD are marked resolved. If any remain
   │  and budget > 0, loop back to RETRIEVE. Otherwise →
   │
   ▼  RECOMMEND                                        src/lib/orchestration/graph.ts
   Synthesize ResearchReport: per-question confidence, evidence graph,
   unresolved questions, budget spent.
```

The graph uses a LangGraph `MemorySaver` checkpointer — every super-step is persisted for
state history and time-travel debugging.

---

## Configuration

All tunables live in [`src/lib/params.ts`](src/lib/params.ts):

### Baseline

| Parameter | Default | What it does |
| --- | --- | --- |
| `ANALYSIS_MODEL` | `gpt-4o` | Analysis model |
| `TRIAGE_MODEL` | `gpt-4o-mini` | Intent adaptation + triage scoring |
| `SEARCH_INTENTS` | `8` | Number of search intents to generate |
| `RESULTS_PER_INTENT` | `8` | Search results per intent from Firecrawl |
| `MAX_SCRAPE` | `22` | Max pages to scrape after triage |
| `QUOTA_FLOOR` | `2` | Min sources per intent guaranteed before merit fill |
| `MAX_CHARS_PER_PAGE` | `4500` | Per-page markdown budget (chars) |
| `SCRAPE_TIMEOUT_MS` | `20000` | Per-page scrape timeout |
| `SCRAPE_CONCURRENCY` | `6` | Max simultaneous scrape requests |

### Orchestration

| Parameter | Default | What it does |
| --- | --- | --- |
| `MIN_QUESTIONS` | `3` | Minimum questions from decomposition |
| `MAX_QUESTIONS` | `5` | Maximum questions from decomposition |
| `RESULTS_PER_QUESTION` | `6` | Web results fetched per question per loop |
| `MAX_LOOP_ITERATIONS` | `2` | Hard cap on retrieve→debate→gate loops |
| `TOTAL_FIRECRAWL_BUDGET` | `32` | Hard cap on total Firecrawl calls |
| `VOI_THRESHOLD` | `0.15` | Minimum VOI score to justify another retrieval |

Model assignments for committee roles are in [`src/lib/models/provider.ts`](src/lib/models/provider.ts).

---

## Scoring

The **five sub-scores** come from the LLM (baseline arm), each calibrated with anchored examples:

| Score | What it measures |
| --- | --- |
| **Pain** | Frustration, friction, unmet need (10 = severe) |
| **Existing Solution Maturity** | How modern existing solutions are (10 = mature market) |
| **Founder Accessibility** | How easy it is for an outsider founder to break in (10 = accessible) |
| **AI Suitability** | How well manual work maps to what AI can automate (10 = automatable) |
| **Budget Signal** | Evidence that buyers have money and will pay (10 = strong budgets) |

The **0–100 Opportunity Score** is computed deterministically in `src/lib/scoring.ts` from
sub-scores. Solution maturity is inverted (mature = less opportunity).

---

## Project map

```
src/
  app/
    layout.tsx                    fonts + metadata
    page.tsx                      single page: idle → scanning → report
    globals.css                   theme + terminal chrome
    api/
      scan/route.ts               baseline SSE streaming orchestrator
      research/baseline/route.ts  baseline API endpoint
  lib/
    params.ts                     all tunable parameters (baseline + orchestration)
    schemas/
      state.ts                    ResearchState (LangGraph Annotation)
      evidence.ts                 Evidence zod schema
      claim.ts                    Claim zod schema
    models/
      provider.ts                 model assignments per agent role
    evidence/
      firecrawl.ts                search() + explore() — Firecrawl search/scrape
      store.ts                    in-memory Evidence store + contentHash
    orchestration/
      graph.ts                    LangGraph StateGraph + runGraph() + synthesizeReport()
      committee.ts                runCommittee() — four-role deliberation
      gate.ts                     allocateBudget() — VOI scoring + loop control
      eval.ts                     ArmResult types + runBaseline()
    triage.ts                     intent adaptation + triage scoring + selection
    analyze.ts                    analysis prompt + LLM call + report assembly
    scoring.ts                    deterministic 0–100 score from sub-scores
    schema.ts                     ScanReport zod schema (baseline report shape)
    events.ts                     SSE event union + TokenUsage type
    useScanStream.ts              client hook: consume SSE → UI state
    intents.ts                    static intent templates (fallback)
    blocklist.ts                  persistent scrape-hostile domain list
    scrape-cache.ts               persistent URL→content cache
    search-cache.ts               persistent query→results cache
    format.ts                     small pure helpers
    exportPdf.ts                  client-side PDF export
  components/                     ScanInput, ScanProgress, ReportView, Gauge, ...
scripts/
  compare-arms.ts                 A/B comparison harness (accepts --budget)
  run-arm.ts                      single-arm runner (baseline or orchestrated, accepts --budget)
test/                             vitest unit tests
data/
  blocklist.json                  domains that block scrapers
  scrape-cache.json               cached scrape results (gitignored)
  search-cache.json               cached search results (gitignored)
```

---

## Testing

```bash
npx tsc --noEmit       # typecheck
npx vitest run         # unit tests
npm run dev            # dev server at http://localhost:3000
npm run compare -- "freight brokerage"   # A/B comparison
npx tsx scripts/run-arm.ts orchestrated "freight brokerage"  # single arm
npx tsx scripts/run-arm.ts baseline "topic" --budget 20      # with budget override
```

---

## Caching

Two persistent caches eliminate redundant Firecrawl API calls:

- **`data/search-cache.json`** — maps search query → results. Repeated queries skip Firecrawl.
- **`data/scrape-cache.json`** — maps URL → raw page markdown. Pages seen before are never re-scraped.

Both are gitignored. No TTL — entries persist until manually deleted.

---

## Credit management

- Search and scrape results are cached — repeated scans consume zero credits.
- PDF URLs filtered before triage — they burn credits for content rarely better than the snippet.
- Each scrape uses `onlyMainContent: true`, truncated to `MAX_CHARS_PER_PAGE` chars.
- Blocked domains (401/403/429/451) are auto-added to the blocklist for future scans.
- Firecrawl credits tracked per-call: 1/search, 2/scrape. Shown in the report.
