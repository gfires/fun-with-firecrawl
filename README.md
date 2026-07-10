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
   │  Manager (Haiku 4.5) breaks topic into 3–5 research questions.
   │
   ▼  RETRIEVE                                         src/lib/evidence/firecrawl.ts
   │  search() fetches web evidence for each unresolved question in parallel.
   │  Evidence is append-only across loops. Query count capped to ¼ remaining budget.
   │
   ▼  DEBATE                                           src/lib/orchestration/committee.ts
   │  Four role-agents each produce an independent Claim per question:
   │    Historian (Claude Sonnet 5) — wants precedent
   │    Operator  (Claude Sonnet 5) — wants friction
   │    Investor  (Claude Sonnet 5) — wants returns
   │    Skeptic   (GPT-4o)          — finds failure modes
   │  Each agent receives full scraped page content, not just snippets.
   │  Confidence is calibrated identically across all four roles.
   │
   ▼  GATE                                             src/lib/orchestration/gate.ts
   │  LLM classifier (GPT-4o-mini) decides per-question whether to retrieve more.
   │  Uses computed signals (gapCount, confidenceSpread) + claim summaries.
   │  Decision rules are rule-based in the prompt (not vibe floats):
   │    - First pass defaults YES unless agents agree and no gaps named
   │    - 3+ overlapping gaps → YES, opposing conclusions → YES
   │    - Agreement with vague gaps → NO
   │    - Low budget (≤2) → only highest-gap question
   │  If retrieve count exceeds remaining budget, clamped to top-N by gapCount.
   │
   ▼  REFINE (loop only)                               src/lib/orchestration/graph.ts
   │  Manager (Haiku 4.5) generates 1–3 targeted search queries per unresolved
   │  question from the committee's missingEvidence gaps. Skips if no gaps identified.
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
| `SEARCH_CANDIDATES_PER_QUESTION` | `10` | Raw search hits fetched per query before filtering |
| `MAX_LOOP_ITERATIONS` | `5` | Hard cap on retrieve→debate→gate loops |
| `TOTAL_FIRECRAWL_BUDGET` | `80` | Hard cap on total Firecrawl credits |
| `MAX_RUN_COST_USD` | `2.00` | Global LLM cost cap — run halts and synthesizes partial report |
| `MAX_EVIDENCE_CHARS_PER_AGENT` | `30000` | Per-agent evidence context window cap (chars) |
| `MAX_CONCLUSION_CHARS` | `400` | Max length for committee claim conclusions |

Model assignments for committee roles are in [`src/lib/models/provider.ts`](src/lib/models/provider.ts).

### Budget model

Two independent budget systems keep runs in check:

**Firecrawl credits** (`TOTAL_FIRECRAWL_BUDGET`, default 80) — denominated in Firecrawl credits
(search = 2 credits, scrape = 1 credit per page):
- `budgetRemaining` / `budgetSpent` tracked in `ResearchState`, decremented by the `retrieve` node.
- Both use **additive reducers**: nodes return a signed *delta*, not an absolute, and the reducer
  accumulates. This is order-independent, so two nodes updating budget in the same LangGraph
  super-step can't lose an update the way a last-write-wins replace reducer would. `retrieve` is
  the sole writer (`budgetRemaining: -credits`, `budgetSpent: +credits`); `gate` never touches
  budget. The initial budget is seeded as a delta onto the default of 0.
- `retrieve` caps query count to `floor(budgetRemaining / 4)` so search alone doesn't blow the budget.
- `gate` clamps: if the LLM requests more retrievals than budget allows, only top-N by `gapCount` proceed.

**LLM cost cap** (`MAX_RUN_COST_USD`, default $2.00) — a per-run USD ceiling enforced by a
`CostTracker` (`cost-tracker.ts`). The tracker lives in `AsyncLocalStorage` keyed to each run's
async call-tree (via `runWithCostTracker`), **not** a module global — so two concurrent runs (two
browser tabs, or compare-arms running both arms) each see their own tracker and never clobber each
other's spend. Every `generateObject` call checks the cap before executing and records its *exact*
cost (from the call's real `usage`) after — no pre-call cost estimation. Because the graph fans out
~20 committee calls at once, a single fan-out wave can overshoot the cap by up to one super-step's
spend before any call settles; the next `check()` then halts the run. We accept that bounded, fully
accounted overshoot rather than reserve against a guessed pre-call cost. If the cap is hit mid-run, a
`BudgetExceededError` is caught — the run immediately synthesizes a partial report from whatever
state has accumulated, writes the trace, and returns results to the UI.

**Token efficiency** — output tokens are the expensive side ($15/M for Sonnet 5, $10/M for GPT-4o):
- Committee agents use `ClaimOutputSchema` (5 fields) instead of the full `ClaimSchema` (9 fields),
  eliminating system-owned fields (`id`, `questionId`, `agentRole`, `loopIteration`) from output.
- Conclusions capped at 400 chars; `missingEvidence` capped at 3 items of 100 chars each.
- Evidence content truncated to 2000 chars per source, total capped at `MAX_EVIDENCE_CHARS_PER_AGENT`
  (30k chars) per agent call — prevents ballooning input on evidence-rich questions.

Hard stops: `MAX_LOOP_ITERATIONS` (5), Firecrawl budget exhaustion, or LLM cost cap — whichever hits first.

### Real-time visualization

The orchestrated arm streams `ResearchEvent`s over SSE from `/api/research/orchestrated`.
The frontend `useResearchStream` hook feeds a pure reducer that builds up the full UI state.
Live components show:

- **Pipeline graph** — SVG node graph with loop arc, active/completed node highlighting
- **Question tracker** — per-question status (pending → retrieving → debating → resolved/looping) with confidence bars
- **Agent panel** — 4-agent debate claims as they arrive
- **Evidence feed** — streaming source URLs with titles
- **Gate decision panel** — per-question retrieve/resolve decisions with gapCount and confidenceSpread
- **Cost counter** — running LLM token costs and Firecrawl credit spend

### Trace logging

Every orchestrated run writes an exhaustive trace file to `trace-output/<topic>-<timestamp>.trace.json`.
The trace captures everything that happened during the run:

- **Every LLM call** — exact prompts (system + user), full structured responses, token usage
- **Every Firecrawl call** — query, parameters, result count
- **Every SSE event** — the complete event stream as sent to the frontend
- **State snapshots** — node-level snapshots of question/evidence/claim counts, budget, loop iteration
- **Final state summary** — total counts, duration, budget spent/remaining, convergence status
- **Timestamps** — absolute ISO timestamps and elapsed-ms on every entry

Trace files can be large (tens of MB for multi-loop runs). They are gitignored.

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
    page.tsx                      mode toggle (scan vs research), idle → progress → report
    globals.css                   theme + terminal chrome
    api/
      scan/route.ts               baseline SSE streaming orchestrator
      research/
        orchestrated/route.ts     orchestrated SSE endpoint (POST, streams ResearchEvents)
  lib/
    params.ts                     all tunable parameters (baseline + orchestration)
    research-events.ts            ResearchEvent union type (SSE wire protocol)
    useResearchStream.ts          client hook + pure reducer for orchestrated research SSE
    schemas/
      state.ts                    ResearchState (LangGraph Annotation) + Question type
      evidence.ts                 Evidence zod schema
      claim.ts                    Claim zod schema + AgentRole enum
    models/
      provider.ts                 model assignments per agent role
    evidence/
      firecrawl.ts                search() + explore() — Firecrawl search/scrape
      store.ts                    in-memory Evidence store + contentHash
    orchestration/
      graph.ts                    StateGraph (decompose→retrieve→debate→gate→refine→recommend)
      graph-stream.ts             runGraphStreaming() — streams ResearchEvents from graph nodes
      committee.ts                runCommittee() — four-role deliberation with full content
      gate.ts                     allocateBudget() — LLM classifier + budget clamping
      eval.ts                     ArmResult types + runBaseline() + token tracking
      trace.ts                    TraceLogger — exhaustive run trace (prompts, responses, state)
    triage.ts                     intent adaptation + triage scoring + selection
    analyze.ts                    analysis prompt + LLM call + report assembly
    scoring.ts                    deterministic 0–100 score from sub-scores
    schema.ts                     ScanReport zod schema (baseline report shape)
    events.ts                     SSE event union + TokenUsage type (baseline)
    useScanStream.ts              client hook: consume SSE → UI state (baseline)
    intents.ts                    static intent templates (fallback)
    blocklist.ts                  persistent scrape-hostile domain list
    scrape-cache.ts               persistent URL→content cache
    search-cache.ts               persistent query→results cache
    format.ts                     small pure helpers
    exportPdf.ts                  client-side PDF export
  components/
    research/
      ResearchProgress.tsx        orchestrated run progress container
      PipelineGraph.tsx           SVG pipeline graph with loop arc
      QuestionTracker.tsx         per-question status + confidence bars
      AgentPanel.tsx              4-agent debate claims display
      EvidenceFeed.tsx            streaming evidence source feed
      GateDecisionPanel.tsx       gate decision table with scores
      CostCounter.tsx             live LLM + Firecrawl cost counter
      ResearchReportView.tsx      final research report display
    ScanInput.tsx, ScanProgress.tsx, ReportView.tsx, Gauge.tsx, ...
scripts/
  compare-arms.ts                 A/B comparison harness (accepts --budget)
  run-arm.ts                      single-arm runner (baseline or orchestrated, accepts --budget)
test/                             vitest unit tests
trace-output/                     exhaustive trace JSON files from orchestrated runs (gitignored)
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
