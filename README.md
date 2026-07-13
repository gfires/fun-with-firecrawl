# Blindspot

> Scan any industry for structural bottlenecks, solution gaps, and founder-ready opportunities.
> Type an industry, get an evidence-backed report with scores, an actionable thesis, and
> concrete next steps — all grounded in real sources with direct quotes.

Two research arms run side-by-side for direct comparison:

- **Baseline** — single-prompt pipeline: search → triage → scrape → analyze (the original system)
- **Orchestrated** — multi-agent LangGraph loop: decompose → retrieve → digest → debate → gate → recommend

The orchestrated arm decomposes a topic into questions, then runs **two nested loops**:

- **Debate loop (inner)** — for each question a four-agent committee (Historian, Operator, Investor,
  Skeptic) deliberates over a *frozen* evidence snapshot. Round 0 is the **blind opening**: each role
  renders one independent, calibrated claim without seeing the others, so cross-role agreement is real
  signal and not herding. If the openings genuinely agree, the debate stops there. Otherwise the roles
  read the full transcript and the challenges aimed at them and **revise across conversational rounds**
  — rebutting, conceding, extending — conceding only to evidence, never to consensus. The loop stops
  the moment a round moves no position and opens no new rebuttal, or at a hard round cap.
- **Retrieval loop (outer)** — the only thing that adds evidence. A value-of-information gate reads the
  disagreements that survived the debate and spends retrieval budget only where a *named evidence gap*
  could actually settle a dispute. A disagreement with no such gap is interpretive (the roles read the
  same evidence differently), so it is reported as a fault line rather than chased. This loops until
  positions converge, no new evidence arrives, or budget runs out.

Preserved disagreement is a first-class output: a committee that "could not agree, and here is the
exact fault line" is more honest than a forced consensus.

> **Status:** the debate mechanics (Wave 3, phases D1–D5) are implemented and unit-tested (175 tests
> green), but the live A/B run that quantifies debate-vs-poll is still pending a paid run (see
> [STATUS.md](STATUS.md)). The debate-arena UI that renders the back-and-forth is tracked separately;
> today's live visualization still shows each role's round-0 claim, not the full transcript.

---

## Quick start

```bash
npm install
cp .env.local.example .env.local   # then add your keys
npm run dev                        # http://localhost:3000
```

You need these keys in `.env.local`:

| Var | Where | Used for |
| --- | --- | --- |
| `FIRECRAWL_API_KEY` | https://firecrawl.dev | web `/search` + `/scrape` |
| `OPENAI_API_KEY` | https://platform.openai.com | baseline analysis, triage, skeptic agent |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com | manager, historian, operator, investor, digest agents |
| `SUPABASE_URL` | Supabase project settings → API | search/scrape/blocklist cache host |
| `SUPABASE_ANON_KEY` | Supabase project settings → API | cache access (legacy anon JWT `eyJ…`, not a `sb_publishable_…` key) |

Supabase is optional-but-recommended: without it the app still runs, just uncached at full Firecrawl
price. Create the schema from [`supabase/schema.sql`](supabase/schema.sql) and add `blindspot` to the
project's **Exposed schemas**, then confirm with `npm run smoke:supabase`.

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
   │  Results cached in Supabase (blindspot.cache).
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
   │  Bounded concurrency (6 at a time). Cached in Supabase (blindspot.cache).
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
   ▼  DIGEST                                           src/lib/orchestration/digest.ts
   │  One cheap Haiku pass (L2) compresses each fresh source into a single ≤400-char item
   │  keyed by its exact evidence id, so the committee reasons over a compact digest
   │  instead of full page content. Falls back to raw evidence if disabled or on failure.
   │
   ▼  DEBATE   (inner debate loop)                     src/lib/orchestration/committee.ts
   │  runDebate() deliberates each unresolved question over a FROZEN evidence snapshot:
   │    Round 0 — blind opening: four independent Claims, no role sees another
   │      Historian (Sonnet 5) precedent · Operator (Sonnet 5) friction ·
   │      Investor  (Sonnet 5) returns   · Skeptic  (GPT-4o) failure modes
   │    Consensus fast-path — if the openings genuinely agree, stop here (no debate)
   │    Rounds 1..MAX_DEBATE_ROUNDS — each role sees the full transcript + the challenges
   │      aimed at it and revises (rebut / concede / extend), conceding only to evidence.
   │      Constructive roles drop to Haiku; the skeptic holds gpt-4o then gpt-4o-mini
   │      (modelForDebateRound). The debate stops the moment a round moves nothing.
   │  Movement, consensus, and contention are computed MECHANICALLY (debate.ts) from the
   │  committee's own confidences, cited-id sets, and response stances — never a self-
   │  reported score. Each round the 3 Claude roles share a byte-identical system prefix
   │  (L3 cache); gpt-4o is concurrency-capped (L6). Evidence never changes mid-debate.
   │
   ▼  GATE    (contention routing + VOI)               src/lib/orchestration/gate.ts
   │  First, per question, read the disagreements that SURVIVED the debate (extractContentions):
   │    - all-interpretive, or none → RESOLVE here at zero LLM cost, report the fault line
   │    - any evidential (a named gap that could settle it) → hand to the LLM gate under budget
   │  The LLM classifier (GPT-4o-mini) then scores the still-open questions on computed signals
   │  (gapCount, confidenceSpread) + claim summaries. Rule-based, not vibe floats:
   │    - First pass defaults YES unless agents agree and no gaps named
   │    - 3+ overlapping gaps → YES, opposing conclusions → YES
   │    - Agreement with vague gaps → NO;  Low budget (≤2) → only highest-gap question
   │  If retrieve count exceeds remaining budget, clamped to top-N by gapCount.
   │
   ▼  REFINE (loop only)                               src/lib/orchestration/graph.ts
   │  Manager (Haiku 4.5) turns the CONTESTED gaps — the missingEvidence named by the roles on
   │  either side of an evidential contention — into 1–3 targeted queries per question, aiming
   │  the next retrieval at the actual fault line (falls back to all gaps when none is specifically
   │  contested; skips if no gaps at all). The next loop re-digests only fresh evidence and
   │  re-debates only questions with new evidence; those re-debates drop the 3 Claude roles to
   │  Haiku (L4) and seed each role with its OWN final claim from the prior snapshot. A loop that
   │  retrieves zero new evidence short-circuits the gate (no-progress).
   │
   ▼  RECOMMEND                                        src/lib/orchestration/graph.ts
   Synthesize ResearchReport: per-question confidence, evidence graph,
   unresolved questions, budget spent.
```

The graph uses a LangGraph `MemorySaver` checkpointer — every super-step is persisted for
state history and time-travel debugging.

### Token efficiency & loop control (Wave 2)

The orchestrated loop is engineered to spend as few output tokens as possible without losing
signal. The mechanisms, in the order they fire:

- **L2 — per-question digest** (`digest.ts`): before the committee fans out, one Haiku call
  compresses each fresh source into a single ≤400-char item keyed by its exact evidence id. The
  four roles then reason over that compact digest instead of full page content — cutting committee
  input tokens dramatically and keeping tens of thousands of characters of raw content out of the
  gpt-4o skeptic's context. A digest failure never kills a run: it falls back to raw evidence.
- **L3 — prompt-cache split** (`committee.ts` `buildCommitteeMessages`): the QUESTION + evidence
  block + confidence calibration live in a **system** message that is byte-identical across the
  three Claude roles, so Anthropic serves it from its prompt cache (read ≈0.1× a fresh write). The
  historian runs first and writes the cache; operator and investor read it. Role persona and task
  instructions live in the **user** message, where they vary per role without disturbing the cache.
- **L4 — loop-aware model mix** (`params.ts` `ROLE_MODEL_IDS` / `REDEBATE_ROLE_MODEL_IDS`): loop 0
  (the deepest debate) runs the analytical roles on Sonnet 5; re-debates (loop > 0), which only
  revise a prior claim against a small evidence delta, drop them to Haiku. The skeptic stays on
  gpt-4o everywhere — a genuinely different model family is the point of the adversarial check.
- **L6 — per-model concurrency + retries** (`limiter.ts`, `params.ts` `MODEL_CONCURRENCY`): a FIFO
  semaphore caps in-flight calls per model id (gpt-4o → 2) so a committee fan-out can't trip the TPM
  ceiling; every `generateText` call retries transient 429/5xx up to `LLM_MAX_RETRIES`.
- **L1 — incremental re-debate + zero-progress kill** (`graph.ts`, `gate.ts` `gateShortCircuit`):
  each loop re-digests only fresh evidence and re-debates only questions that received new evidence;
  a role revises its own prior claim rather than starting over. If a loop retrieves zero new
  evidence, `gateShortCircuit` returns `no-progress` and the loop ends instead of re-running the
  same debate. Hard stops are budget exhaustion, `MAX_LOOP_ITERATIONS`, and no-progress.

### Real committee debate (Wave 3)

Wave 3 turns the committee from a parallel poll of four monologues into a real debate. A poll doesn't
earn four agents; the synthesis-through-disagreement is the product. The whole thing is **two nested
loops, with evidence FROZEN during a debate** — only the outer retrieval loop ever changes it:

```
RETRIEVE ─► DIGEST ─► DEBATE ─► GATE ─► (REFINE ─► RETRIEVE) ─► …
                      └── inner debate loop lives entirely inside the DEBATE node ──┘
```

- **Debate loop** (`committee.ts` `runDebate`, `debate.ts`): round 0 is today's independent blind
  opening (which preserves the historian-confabulation fix — a role can't herd toward a claim it never
  saw). Rounds 1..`MAX_DEBATE_ROUNDS` each show a role the full prior transcript plus the challenges
  aimed at it, and it revises — `rebut` / `concede` / `extend` — emitting a `DebateResponse` per peer
  it engages. The loop **skips entirely on round-0 consensus** and otherwise stops as soon as a round
  stops moving.
- **Every debate signal is mechanical, not a vibe float** (`debate.ts`, all pure + unit-tested):
  `roundOneConsensus` (tight confidence spread, above a floor, no contradiction — genuine agreement,
  not shared uncertainty), `debateMovement` (a role moved if its confidence shifted past an epsilon or
  its cited-id set changed; a rebuttal is "new" only by `from→target` pair identity, never by matching
  the free-text point), and `extractContentions` (a surviving disagreement is `evidential` if either
  side names a `missingEvidence` gap, else `interpretive`). Nothing casts a qualitative judgment into
  a made-up 0–1 score.
- **Marginal-utility shut-offs, enforced in code:** the debate exits on low round-over-round movement,
  a hard `MAX_DEBATE_ROUNDS` cap, or round-0 consensus. At the gate, `contentionRoute` sends
  interpretive-only (or agreed) questions straight to *resolve* at **zero LLM cost** — retrieving
  can't settle a difference of interpretation — and only evidential contentions plus budget trigger
  another retrieval, whose queries `refine` draws from the *contested* gaps specifically.
- **Model mix — heavy models spent sparingly** (`provider.ts` `modelForDebateRound`): round 0 is the
  Sonnet trio + gpt-4o skeptic; conversational rounds drop the constructive roles to Haiku (declining
  marginal value), and the skeptic holds gpt-4o through `DEBATE_SKEPTIC_STRONG_ROUNDS` then drops to
  gpt-4o-mini. Movement/contention detection is pure code, so it's free.
- **Anti-sycophancy guard:** three roles share Sonnet, so peer views can induce agreement. Every role
  is instructed to **concede only to evidence, never to consensus — if you move, cite the id that
  moved you**, and the skeptic stays cross-family (OpenAI) throughout. The `final_state` trace records
  concession counts so a flip that cites no new id is measurable.
- **What crosses the retrieval boundary:** within a debate the full transcript is live context; across
  loops only each role's FINAL claim survives (its `priorClaim` seed). The transcript is ephemeral to
  one evidence snapshot (`debateTranscripts` replaces per question via `mergeTranscripts`); the durable
  Claims are the carrier. The L3 prompt cache is preserved throughout — the shared system prefix
  (including the rendered transcript) stays byte-identical across the three Claude roles in a round.

Out of scope in this wave and tracked separately: the debate-arena UI, the SSE `debate:round` events,
and the poll-vs-debate eval harness (D6). The live visualization still renders each role's round-0
claim, not the transcript.

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
| `FIRECRAWL_CONCURRENCY` | `2` | Shared FIFO cap on all Firecrawl calls (Firecrawl throttles to ~2/account) |

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
| `MAX_EVIDENCE_CHARS_PER_AGENT` | `30000` | Per-agent raw-evidence cap (chars), used only when the digest is off/failed |
| `MAX_CONCLUSION_CHARS` | `400` | Steering hint for committee conclusion length (a `.describe()` target, not a hard cap) |

### Orchestration — token efficiency (Wave 2)

| Parameter | Default | What it does |
| --- | --- | --- |
| `DIGEST_ENABLED` | `true` | L2: run the per-question Haiku digest before the committee (`false` → raw evidence) |
| `MAX_DIGEST_SUMMARY_CHARS` | `400` | Truncation cap applied in code to each digest item |
| `PROMPT_CACHE_MIN_CHARS` | `4500` | L3: only attach Anthropic `cacheControl` when the shared system prefix exceeds this |
| `ROLE_MODEL_IDS` | Sonnet×3 + gpt-4o | L4: per-role models on loop 0 (the deep debate) |
| `REDEBATE_ROLE_MODEL_IDS` | Haiku×3 + gpt-4o | L4: per-role models on re-debates (loop > 0) |
| `MODEL_CONCURRENCY` | `{ "gpt-4o": 2 }` | L6: global in-flight cap per model id (models absent → unlimited) |
| `LLM_MAX_RETRIES` | `4` | L6: retries per `generateText` call on transient 429/5xx |

### Orchestration — debate (Wave 3)

| Parameter | Default | What it does |
| --- | --- | --- |
| `MAX_DEBATE_ROUNDS` | `3` | Hard cap on conversational rounds per question (round 0 opening excluded) |
| `DEBATE_SKEPTIC_STRONG_ROUNDS` | `2` | Skeptic stays gpt-4o through this round, then drops to gpt-4o-mini |
| `DEBATE_CONSENSUS_SPREAD` | `0.2` | Round-0 fast-path: max−min confidence must be under this to count as agreement |
| `DEBATE_CONSENSUS_MIN_CONFIDENCE` | `0.6` | Round-0 fast-path: every role must be at/above this (rules out shared uncertainty) |
| `DEBATE_CONFIDENCE_EPSILON` | `0.05` | A confidence move at or below this counts as "no movement" for convergence |

Model assignments for committee roles are in [`src/lib/models/provider.ts`](src/lib/models/provider.ts)
(`modelForRole` for the opening, `modelForDebateRound` for conversational rounds).

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
other's spend. Every structured-output LLM call checks the cap before executing and records its *exact*
cost (from the call's real `usage`) after — no pre-call cost estimation. Because the graph fans out
~20 committee calls at once, a single fan-out wave can overshoot the cap by up to one super-step's
spend before any call settles; the next `check()` then halts the run. We accept that bounded, fully
accounted overshoot rather than reserve against a guessed pre-call cost. If the cap is hit mid-run, a
`BudgetExceededError` is caught — the run immediately synthesizes a partial report from whatever
state has accumulated, writes the trace, and returns results to the UI.

**Token efficiency** — both sides of the bill are engineered down (see "Token efficiency & loop
control" above for the full mechanism list). In short:
- **Input tokens**: the L2 digest replaces full page content with ≤400-char per-source summaries, and
  the L3 prompt-cache split lets the 3 Claude roles read a shared system prefix from cache. When the
  digest is off/failed, raw evidence is capped at `MAX_EVIDENCE_CHARS_PER_AGENT` (30k) per agent.
- **Output tokens** (the expensive side — $15/M Sonnet 5, $10/M gpt-4o): committee agents emit
  `ClaimOutputSchema` (5 fields), not the full 9-field `ClaimSchema` — the system-owned fields (`id`,
  `questionId`, `agentRole`, `loopIteration`) are attached in code, never generated. `missingEvidence`
  is clamped to 3 items in code; conclusion length is steered by a `.describe()` hint, not a hard cap
  (per the "no hard caps in LLM output schemas" principle — providers strip them and a slightly-long
  response would otherwise crash the run).
- **Per-loop work**: re-debates run on Haiku (L4) and only touch questions with fresh evidence (L1).

Hard stops: `MAX_LOOP_ITERATIONS` (5), Firecrawl budget exhaustion, LLM cost cap, or a zero-progress
loop — whichever hits first.

### Real-time visualization

The orchestrated arm streams `ResearchEvent`s over SSE from `/api/research/orchestrated`.
The frontend `useResearchStream` hook feeds a pure reducer that builds up the full UI state.
Live components show:

- **Pipeline graph** — SVG node graph with loop arc, active/completed node highlighting
- **Question tracker** — per-question status (pending → retrieving → debating → resolved/looping) with confidence bars
- **Agent panel** — the 4 roles' claims as they arrive
- **Evidence feed** — streaming source URLs with titles
- **Gate decision panel** — per-question retrieve/resolve decisions with gapCount and confidenceSpread
- **Cost counter** — running LLM token costs and Firecrawl credit spend

> The agent panel currently renders each role's **round-0 opening claim**. Streaming the full debate
> transcript (who-challenged-whom, concede/hold across rounds) is the debate-arena UI tracked with D6;
> until it lands, the back-and-forth lives in the trace file, not the live view.

### Trace logging

Every orchestrated run writes an exhaustive trace file to `trace-output/<topic>-<timestamp>.trace.json`.
The trace captures everything that happened during the run:

- **Every LLM call** — exact prompts (system + user), full structured responses, token usage
  (including cache read/write token counts), and the `loopIteration` the call belongs to
- **Every Firecrawl call** — query/params, result count, and cache outcome: `search`/`scrape` (live)
  vs `search-cache-hit`/`scrape-cache-hit`, plus a live scrape's `ok`/`empty`/`blocked` status
- **Every SSE event** — the complete event stream as sent to the frontend (streaming runs)
- **State snapshots** — node-level snapshots of question/evidence/claim counts, budget, loop iteration
  (streaming runs only)
- **Debate** — `debate:round` per conversational round (round number + mechanical movement:
  `moved` / `newRebuttals` / `converged`) and `debate:contentions` per question (evidential vs
  interpretive counts, and whether the gate resolved it without an LLM call)
- **Convergence** — `gate:converged` records why the loop stopped: `budget` / `max-loops` /
  `no-progress` / `contention-resolved` / gate-decided
- **Final state summary** (`final_state`) — total counts, loop iterations, converged flag, budget
  spent/remaining, Firecrawl calls/credits, and a `debate` rollup (questions debated, conversational
  rounds, evidential/interpretive contention counts, total concessions)
- **Timestamps** — absolute ISO timestamps and elapsed-ms on every entry

Together these let a single trace file answer reasoning quality, cache hit-ratio, retrieval health,
and loop/convergence behavior without re-running. Trace files can be large (tens of MB for multi-loop
runs) and are gitignored.

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
      state.ts                    ResearchState (Annotation) + Question + debateTranscripts channel
      evidence.ts                 Evidence zod schema
      claim.ts                    Claim + DebateResponse/DebateTurnOutput schemas + AgentRole enum
    models/
      provider.ts                 model assignments per agent role
    evidence/
      firecrawl.ts                search() + explore() — Firecrawl search/scrape
      store.ts                    in-memory Evidence store + contentHash
    orchestration/
      graph.ts                    StateGraph (decompose→retrieve→digest→debate→gate→refine→recommend)
      graph-stream.ts             runGraphStreaming() — streams ResearchEvents from graph nodes
      committee.ts                runCommittee() (blind opening) + runDebate() (full debate) + message builders
      debate.ts                   debate types + pure logic (consensus, movement, contentions, transcript)
      digest.ts                   per-question Haiku evidence digest (L2) + prompt/clamp/format helpers
      gate.ts                     allocateBudget() + gateShortCircuit() + contention routing — LLM gate + clamps
      limiter.ts                  createLimiter() — per-model + Firecrawl FIFO concurrency caps (L6)
      cost-tracker.ts             per-run USD cost cap via AsyncLocalStorage (runWithCostTracker)
      eval.ts                     ArmResult types + runBaseline() + toAnnotatedUsage() token tracking
      trace.ts                    TraceLogger — exhaustive run trace (prompts, responses, state)
    triage.ts                     intent adaptation + triage scoring + selection
    analyze.ts                    analysis prompt + LLM call + report assembly
    scoring.ts                    deterministic 0–100 score from sub-scores
    schema.ts                     ScanReport zod schema (baseline report shape)
    events.ts                     SSE event union + TokenUsage type (baseline)
    useScanStream.ts              client hook: consume SSE → UI state (baseline)
    intents.ts                    static intent templates (fallback)
    supabase.ts                   Supabase client (blindspot schema) backing the caches + blocklist
    warn-once.ts                  dedupe repeated warnings (e.g. "supabase unreachable")
    blocklist.ts                  scrape-hostile domain list (Supabase-backed)
    scrape-cache.ts               URL→content cache (Supabase-backed)
    search-cache.ts               query→results cache (Supabase-backed)
    format.ts                     small pure helpers
    exportPdf.ts                  client-side PDF export
  components/
    research/
      ResearchProgress.tsx        orchestrated run progress container
      PipelineGraph.tsx           SVG pipeline graph with loop arc
      QuestionTracker.tsx         per-question status + confidence bars
      AgentPanel.tsx              the 4 roles' independent claims display
      EvidenceFeed.tsx            streaming evidence source feed
      GateDecisionPanel.tsx       gate decision table with scores
      CostCounter.tsx             live LLM + Firecrawl cost counter
      ResearchReportView.tsx      final research report display
    ScanInput.tsx, ScanProgress.tsx, ReportView.tsx, Gauge.tsx, ...
scripts/
  compare-arms.ts                 A/B comparison harness (accepts --budget)
  run-arm.ts                      single-arm runner (baseline or orchestrated, accepts --budget)
  supabase-smoke.ts               live (free) round-trip check of the Supabase cache
  migrate-caches.mjs              one-time seed of Supabase from the legacy data/*.json files
supabase/
  schema.sql                      blindspot schema: cache + blocklist tables, grants, RLS
  migrations/                     versioned schema migrations
test/                             vitest unit tests
trace-output/                     exhaustive trace JSON files from orchestrated runs (gitignored)
data/
  blocklist.json                  legacy blocklist seed (runtime now reads Supabase; used only by migrate-caches.mjs)
```

---

## Testing

```bash
npx tsc --noEmit       # typecheck (zero-cost)
npx vitest run         # unit tests (zero-cost)
npm run smoke:supabase # verify the Supabase cache round-trips (live but free)
npm run dev            # dev server at http://localhost:3000
npm run compare -- "freight brokerage"   # A/B comparison
npx tsx scripts/run-arm.ts orchestrated "freight brokerage"  # single arm
npx tsx scripts/run-arm.ts baseline "topic" --budget=50      # budget override (use --budget=N, not a space)
```

---

## Caching

Two caches, plus the scraper blocklist, live in **Supabase** under the `blindspot` schema — shared
across processes and both arms, so a cache written by one run (or the compare harness) is seen by the
next. Backed by `src/lib/supabase.ts`; DDL in [`supabase/schema.sql`](supabase/schema.sql).

- **`blindspot.cache`** (`type='search'`) — maps search query → results. Repeated queries skip Firecrawl.
- **`blindspot.cache`** (`type='scrape'`) — maps URL → raw page markdown. Pages seen before are never re-scraped.
- **`blindspot.blocklist`** — domains that block scrapers (401/403/429/451), auto-added on hard blocks.

No TTL — entries persist until manually deleted. If Supabase is unreachable a run degrades gracefully:
it warns once (`warn-once.ts`) and proceeds uncached at full Firecrawl price rather than failing.
`npm run smoke:supabase` verifies the round-trip; the schema must be created and `blindspot` added to
the project's **Exposed schemas** first (see `supabase/schema.sql`).

---

## Credit management

- Search and scrape results are cached — repeated scans consume zero credits.
- PDF URLs filtered before triage — they burn credits for content rarely better than the snippet.
- Each scrape uses `onlyMainContent: true`, truncated to `MAX_CHARS_PER_PAGE` chars.
- Blocked domains (401/403/429/451) are auto-added to the blocklist for future scans.
- Firecrawl credits tracked per-call: 1/search, 2/scrape. Shown in the report.
