# Opportunity MRI

> Scan any industry for structural inefficiencies, labor shortages, software gaps, and AI-native
> business opportunities. A playful exploration engine that makes you feel like you're seeing the
> hidden shape of a market.

Type an industry — `college athletics`, `construction permitting`, `insurance claims`,
`industrial ergonomics` — and watch Opportunity MRI fan out across the web, read the results live,
and render a Bloomberg-terminal-style diagnostic: pain scores, software maturity, labor scarcity,
AI opportunities, underserved niches, and a set of tongue-in-cheek stats. **Every score and claim
cites its sources.**

This is a **fun exploration tool**, not lead-gen and not a research assistant. **All scores are
heuristic.**

---

## Quick start

```bash
npm install
cp .env.local.example .env.local   # then add your keys
npm run dev                        # http://localhost:3000
```

You need two keys in `.env.local`:

| Var | Where | Used for |
| --- | --- | --- |
| `FIRECRAWL_API_KEY` | https://firecrawl.dev | web `/search` + `/scrape` |
| `OPENAI_API_KEY` | https://platform.openai.com | the inference / scoring step |

Optional overrides (defaults in parentheses): `OPENAI_MODEL` (`gpt-4o`),
`SCAN_MAX_SCRAPE` (`28`), `SCAN_RESULTS_PER_INTENT` (`5`).

---

## How it works

One page, one server entry point, no database, no auth, no persistence — one-shot execution.

```
industry
   │
   ▼  buildIntents()                        src/lib/intents.ts
10 search intents  ── "{industry} software", "… labor shortage", "… complaints" …
   │
   ▼  explore()                             src/lib/firecrawl.ts
Firecrawl /search  ×10 (parallel)  →  dedupe + diversity-rank  →  scrape ~28 pages (parallel)
   │
   ▼  callLLM()                             src/lib/analyze.ts
OpenAI reads the cited corpus  →  five 0–10 scores + sections + evidence (validated by zod)
   │
   ▼  assembleReport()                      src/lib/analyze.ts + scoring.ts
computed 0–100 Opportunity Score, playful stats, source appendix
   │
   ▼  Server-Sent Events                    src/app/api/scan/route.ts
every step streamed live to the browser  →  the exploration visualization
```

### The live exploration view

The scan runs inside a **streaming route handler** (`src/app/api/scan/route.ts`) that emits an
event for every step — intents generated, each search firing/returning, each page being scraped,
the analyze phase — as Server-Sent Events. The client (`src/lib/useScanStream.ts`) folds those
into UI state that `ScanProgress` renders: you literally watch intents fan out, sources stream in,
and pages get read, under a sweeping "MRI" scan-line. A server action wasn't used because actions
can't stream incremental progress.

### Scoring

The **five sub-scores** (Pain, Software Maturity, Labor Scarcity, AI Suitability, Budget Signal)
come from the LLM, each grounded in cited sources. The **headline 0–100 Opportunity Score** is
computed deterministically in `src/lib/scoring.ts` from those sub-scores — so the big number is
explainable, not a black box. Software maturity is *inverted* (mature software → less opportunity).

---

## Prompt transparency

The entire prompt lives, readable, in [`src/lib/analyze.ts`](src/lib/analyze.ts) —
`SYSTEM_PROMPT`, `buildPrompt()`, and the shared `SCORE_DEFINITIONS`. The same definitions are
shown to the user under **Method & assumptions** in the report. Nothing is hidden.

---

## Project map

```
src/
  app/
    layout.tsx            fonts + metadata
    page.tsx              the single page: idle → scanning → report
    globals.css           theme + terminal chrome
    api/scan/route.ts     streaming orchestrator (SSE)
  lib/
    intents.ts            buildIntents(industry) — the 10 search angles
    firecrawl.ts          explore(): search + rank + scrape (emits progress events)
    analyze.ts            prompt + LLM call + report assembly (transparent)
    scoring.ts            deterministic 0–100 score + playful stats
    schema.ts             zod schemas / types — the source of truth for report shape
    events.ts             the SSE event union (server↔client contract)
    useScanStream.ts      client hook: consume SSE, reduce into UI state
    format.ts             small pure helpers
  components/             ScanInput, ScanProgress, ReportView, Gauge, OpportunityMeter, …
test/                     vitest unit tests for the pure logic
```

Every module has a header comment written **for future agents** explaining its role and the
contracts it participates in. Start with `schema.ts` (report shape) and `events.ts` (wire
protocol) — everything else hangs off those two.

---

## Testing

```bash
npm test          # vitest — pure-logic units (intents, scoring, schema)
npx tsc --noEmit  # typecheck
npm run build     # production build
```

The Firecrawl/OpenAI calls are live and one-shot, so they're covered by manual end-to-end runs
rather than unit tests. `buildPrompt()` and the scoring/schema logic are pure and unit-tested.

---

## Assumptions & limitations

- Firecrawl `/search` returns usable titles/snippets; scraping adds depth on the best URLs.
- ~28 scraped pages (truncated per page) fit the token budget and the ~30–60s target.
- `gpt-4o` + JSON mode + zod validation is reliable; there's one repair retry then a clear error.
- **Scores are heuristic and playful.** This is a provocation to explore an industry, not a
  verdict on it.
```
