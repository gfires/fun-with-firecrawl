# Blindspot

> Scan any industry for structural bottlenecks, solution gaps, and founder-ready opportunities.
> Type an industry, get an evidence-backed report with scores, an actionable thesis, and
> concrete next steps — all grounded in real sources with direct quotes.

Three research arms run side-by-side for direct comparison:

- **Baseline** — single-prompt pipeline: search → triage → scrape → analyze (the original system)
- **Orchestrated** — multi-agent LangGraph loop with **coded** retrieval (the deterministic
  search → triage → scrape workflow): decompose → retrieve → digest → debate → gate → recommend.
  This is `retrievalMode: "coded"`, the permanent eval **control** arm.
- **Agentic** — the **same graph**, but `retrievalMode: "agentic"`: the `retrieve` node becomes one
  bounded Haiku **researcher agent per unresolved question**. Everything else (decompose, digest,
  debate, gate, recommend) is byte-identical to the orchestrated arm — only *retrieval* became agentic.

Both graph arms decompose a topic into questions, then run **two nested loops**:

- **Debate loop (inner)** — for each question a four-agent committee (Historian, Operator, Investor,
  Skeptic) deliberates over a *frozen* evidence snapshot. Round 0 is the **blind opening**: each role
  renders one independent, calibrated claim without seeing the others, so cross-role agreement is real
  signal and not herding. Each claim states a categorical **stance** (`supports` / `opposes` /
  `insufficient`). Conversational rounds run **only when the openings genuinely disagree** — two distinct
  decisive stances, or a clash over the same evidence id; otherwise the debate stops at the opening.
  When they do run, the roles read the full transcript and the challenges aimed at them and **revise**
  — rebutting, conceding, extending — conceding only to evidence, never to consensus. The loop stops
  the moment a round moves no position and opens no new rebuttal, or at a hard round cap.
- **Retrieval loop (outer)** — the only thing that adds evidence. The committee debates to *resolve*
  disagreement; agreement is a trigger to **act**, not a dead end. A gate routes each question on its
  committee stance: a unanimous decisive lean is a settled answer; a *contested* split spends retrieval
  budget only where a *named evidence gap* could settle it (an interpretive split with no gap is reported
  as a fault line, not chased); an *insufficient* verdict with a named gap goes back to retrieval to go
  get it — and if one no-progress loop can't close that gap, it's noted as a limitation. This loops until
  positions converge, no new evidence arrives, or budget runs out.

Preserved disagreement is a first-class output: a committee that "could not agree, and here is the
exact fault line" is more honest than a forced consensus.

> **Status:** the debate mechanics (Wave 3, phases D1–D5) and the **agentic retrieval** migration
> (the `agentic` arm) are both implemented and unit-tested (287 tests green). The live A/B runs that
> quantify debate-vs-poll and agentic-vs-orchestrated retrieval are still pending a paid run (see
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

### Run the A/B/C comparison

```bash
npm run compare -- "freight brokerage"                # all three arms
npx tsx scripts/compare-arms.ts "freight brokerage"   # equivalent

npm run run-arm agentic "freight brokerage"           # one arm: baseline | orchestrated | agentic
npm run run-arm agentic "freight brokerage" --budget=50   # optional Firecrawl-budget override
```

`compare` runs all **three** arms (baseline, orchestrated, agentic) and lands the output in
`compare-output/<topic>-<timestamp>.json` as `{ topic, runAt, arms: ArmResult[] }` — each arm's
report, token usage, Firecrawl costs, and wall-clock time side by side. Everything is fully
standalone (tsx scripts, no Next.js UI needed). Note: the live SSE UI runs only the coded/orchestrated
arm; agentic live-streaming is out of scope, so the agentic arm is measured via these scripts.

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

### Orchestrated / agentic pipeline

The two graph arms share this pipeline; only the **RETRIEVE** node differs (chosen by
`retrievalMode`). The diagram shows the coded (orchestrated) retrieve; the agentic retrieve is
detailed in the next section.

```
topic
   │
   ▼  DECOMPOSE                                        src/lib/orchestration/graph.ts
   │  Manager (Haiku 4.5) breaks topic into 3–4 research questions + one keyword query each.
   │
   ▼  RETRIEVE  (retrievalMode: "coded")               src/lib/orchestration/graph.ts
   │  Coded body: search() fetches web evidence for each unresolved question in parallel,
   │  triages, and scrapes. Evidence is append-only across loops. Per-pass spend is reserved
   │  to MAX_LOOP_SPEND_FRACTION of the initial budget so a broad first pass can't starve the
   │  gap-targeted passes. (retrievalMode "agentic" swaps this node — see "Agentic retrieval".)
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
   │    Each claim states a stance (supports/opposes/insufficient)
   │    Disagreement gate — run rounds only if openings genuinely disagree (hasGenuineDisagreement:
   │      ≥2 decisive stances OR an id-clash); else stop at the opening
   │    Rounds 1..MAX_DEBATE_ROUNDS — each role sees the full transcript + the challenges
   │      aimed at it and revises (rebut / concede / extend), conceding only to evidence.
   │      Constructive roles drop to Haiku; the skeptic holds gpt-4o then gpt-4o-mini
   │      (modelForDebateRound). The debate stops the moment a round moves nothing.
   │  Movement, disagreement, and contention are computed MECHANICALLY (debate.ts) from the
   │  committee's own confidences, cited-id sets, and response stances — never a self-
   │  reported score. Each round the 3 Claude roles share a byte-identical system prefix
   │  (L3 cache); gpt-4o is concurrency-capped (L6). Evidence never changes mid-debate.
   │
   ▼  GATE    (stance routing + VOI)                   src/lib/orchestration/gate.ts
   │  First, per question, route on the committee STANCE + named gap (questionRoute), zero LLM cost:
   │    - unanimous supports/opposes → RESOLVE (a settled answer)
   │    - contested → by contention: interpretive/none → RESOLVE + fault line; evidential → LLM gate
   │    - insufficient + named gap → RETRIEVE (go get it); no gap → RESOLVE
   │    - patience=1: an insufficient gap unmoved after one loop (diminishingReturns) → RESOLVE (noted)
   │  The LLM classifier (GPT-4o-mini) then scores the still-open questions on computed signals
   │  (gapCount, confidenceSpread) + claim summaries. Rule-based, not vibe floats:
   │    - First pass defaults YES unless agents agree and no gaps named
   │    - 3+ overlapping gaps → YES, opposing conclusions → YES
   │    - Agreement with vague gaps → NO;  Low budget (≤2) → only highest-gap question
   │  If retrieve count exceeds remaining budget, clamped to top-N by gapCount.
   │
   ├─(continue)─► RETRIEVE                             loop back while the gate wants more
   │  When the gate continues AND budget remains (routeAfterGate), loop straight back to
   │  RETRIEVE — there is no separate refine node. The next retrieval targets the CONTESTED
   │  evidential gaps: the coded path derives gap queries; the agentic path builds them into each
   │  researcher's loop-≥1 mission (missionForQuestion). The next loop re-digests only fresh
   │  evidence and re-debates only questions with new evidence, dropping the 3 Claude roles to
   │  Haiku (L4) and seeding each with its OWN final claim. A loop that retrieves zero new
   │  evidence short-circuits the gate (no-progress).
   │
   ▼  RECOMMEND  (stop)                                src/lib/orchestration/graph.ts
   Synthesize ResearchReport: per-question confidence, evidence graph,
   unresolved questions, budget spent, and a cited objective-level answer.
```

The graph uses a LangGraph `MemorySaver` checkpointer — every super-step is persisted for
state history and time-travel debugging. `refine` (a former query-generation node) was removed
in the agentic-retrieval migration; the gate now loops directly to `retrieve`.

### Agentic retrieval (`retrievalMode: "agentic"`)

The agentic arm replaces the coded retrieve node with a swarm of bounded **researcher agents** —
one per unresolved question, run concurrently, all drawing first-come-first-served from **one shared
`PassPool`** of Firecrawl credits (`researcher.ts`). Everything upstream and downstream is unchanged;
the committee still deliberates over a frozen snapshot.

```
retrieve (agentic)                                    src/lib/orchestration/researcher.ts
   │  For each unresolved question, runResearcher() runs a Haiku tool-loop:
   │
   │   mission (missionForQuestion, graph.ts):
   │     loop 0   → reconnaissance from the question's decompose keyword queries
   │                (code-enforced RECON_FLOOR minimum sources before it may stop)
   │     loop ≥1  → the CONTESTED EVIDENTIAL gaps + the titles/urls already gathered
   │                (so it doesn't re-chase); "" when no gap → the question is skipped
   │   │
   │   ▼  one model step per generateText (stepCountIs(1)) so the interior $-cap is
   │      checked before EVERY step:
   │        getActiveCostTracker()?.check()            ← throws → whole run degrades
   │        webSearch(query)   → snippet hits — ONE search per pass (MAX_SEARCHES_PER_PASS);
   │                             judging the snippets IS the triage, then it must READ, not re-search
   │        readSource(urls)   → reads full pages (multi-URL); ALWAYS stores each as full
   │                             Evidence tagged questionId; returns a ~600-char head memo
   │        every tool charges REAL post-cache credits to the shared PassPool
   │        (cache hit = 0, live search = 2, live scrape = 1)
   │   │
   │   ▼  stops on the FIRST of: MAX_AGENT_STEPS · PassPool exhausted · check() throws ·
   │      the model has enough (subject to the loop-0 RECON_FLOOR)
   │
   ▼  node reconciles: dedupe by contentHash across agents → sum the pool's REAL credits →
     ONE signed budget delta + newEvidenceCount + a totalUsage rollup (retrieve stays the
     SOLE budget writer, exactly like the coded body).
```

**Evidence scoping.** Each stored Evidence carries `questionId` (the agent that produced it owns
exactly one question). `scopeEvidenceToQuestions` prefers `questionId`, so an agent's *self-invented*
queries still reach the committee — the coded arm continues to scope by `sourceQuery`, byte-identical.

**Why the roles stay non-agentic.** Only retrieval — a genuine search problem — became an agent.
The committee runs where the guarantees live (a frozen evidence snapshot, bounded cost, deterministic
convergence), so the four roles remain single-shot, tool-less LLM calls. Agency where it helps,
determinism where it must hold.

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
RETRIEVE ─► DIGEST ─► DEBATE ─► GATE ─►(continue: loop back to)─► RETRIEVE ─► …
                      └── inner debate loop lives entirely inside the DEBATE node ──┘
```

- **Debate loop** (`committee.ts` `runDebate`, `debate.ts`): round 0 is today's independent blind
  opening (which preserves the historian-confabulation fix — a role can't herd toward a claim it never
  saw). Rounds 1..`MAX_DEBATE_ROUNDS` each show a role the full prior transcript plus the challenges
  aimed at it, and it revises — `rebut` / `concede` / `extend` — emitting a `DebateResponse` per peer
  it engages. The loop **skips entirely when the openings show no genuine disagreement** and otherwise
  stops as soon as a round stops moving.
- **Every debate signal is mechanical, not a vibe float** (`debate.ts`, all pure + unit-tested):
  `hasGenuineDisagreement` (≥2 distinct decisive stances, or a clash over the same evidence id — reads
  direction, not a confidence spread, so a same-confidence supports-vs-opposes split is caught),
  `committeeStance` (the committee's overall position: contested / supports / opposes / insufficient),
  `debateMovement` (a role moved if its confidence shifted past an epsilon or
  its cited-id set changed; a rebuttal is "new" only by `from→target` pair identity, never by matching
  the free-text point), and `extractContentions` (a surviving disagreement is `evidential` if either
  side names a `missingEvidence` gap, else `interpretive`). Nothing casts a qualitative judgment into
  a made-up 0–1 score.
- **Marginal-utility shut-offs, enforced in code:** the debate exits on low round-over-round movement,
  a hard `MAX_DEBATE_ROUNDS` cap, or round-0 consensus. At the gate, `contentionRoute` sends
  interpretive-only (or agreed) questions straight to *resolve* at **zero LLM cost** — retrieving
  can't settle a difference of interpretation — and only evidential contentions plus budget trigger
  another retrieval, aimed at the *contested* gaps specifically (the coded retrieve derives gap
  queries; the agentic retrieve builds them into each researcher's loop-≥1 mission).
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

All tunables live in [`src/lib/params.ts`](src/lib/params.ts); all LLM **prompt wording** (the
personas, the confidence calibration, and every node's prompt) lives in one readable file,
[`src/lib/prompts.ts`](src/lib/prompts.ts) — the orchestration nodes keep only the state-shaping.

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
| `MAX_QUESTIONS` | `4` | Maximum questions from decomposition |
| `MAX_SEARCH_QUERIES_PER_QUESTION` | `1` | Keyword queries decompose emits per question (clamped in code) |
| `RESULTS_PER_QUESTION` | `6` | Web results per query on the gap-targeted (loop ≥1) passes |
| `RECON_RESULTS_PER_QUESTION` | `3` | Shallower results per query on the loop-0 reconnaissance pass (grounding floor: ≥3) |
| `SEARCH_CANDIDATES_PER_QUESTION` | `10` | Raw search hits fetched per query before filtering |
| `TRIAGE_ENABLED` | `true` | Coded retrieve: gpt-4o-mini relevance-scores candidates before scraping (`false` → rank cap) |
| `MIN_TRIAGE_SCORE` | `4` | Keep bar for triaged candidates (below the unscored default so a triage failure never over-filters) |
| `MAX_LOOP_ITERATIONS` | `5` | Hard cap on retrieve→debate→gate loops |
| `TOTAL_FIRECRAWL_BUDGET` | `80` | Hard cap on total Firecrawl credits |
| `MAX_LOOP_SPEND_FRACTION` | `0.5` | No single retrieval pass may spend more than this fraction of the initial Firecrawl budget |
| `LOOP_CONFIDENCE_EPSILON` | `0.05` | Diminishing-returns threshold: a loop that lifts mean confidence by ≤ this and cuts no gaps is futile |
| `MAX_RUN_COST_USD` | `0.75` | Global LLM cost cap — run halts and synthesizes a partial report (the final answer is exempt) |
| `MIN_LOOP_COST_HEADROOM_USD` | `0.25` | Gate affordability guard: converge rather than START a retrieve+debate cycle when LLM-cost headroom is below this (avoids a super-step that would blow the cap mid-flight and roll back) |
| `SYNTHESIS_ANSWER_MAX_TOKENS` | `16000` | Output ceiling for the final answer so it never truncates mid-adjudication |
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
| `MAX_DEBATE_ROUNDS` | `2` | Hard cap on conversational rounds per question (round 0 opening excluded) |
| `DEBATE_SKEPTIC_STRONG_ROUNDS` | `2` | Skeptic stays gpt-4o through this round, then drops to gpt-4o-mini |
| `DEBATE_CONFIDENCE_EPSILON` | `0.05` | A confidence move at or below this counts as "no movement" for convergence |
| `LOOP_CONFIDENCE_EPSILON` | `0.05` | Outer-loop patience: a retrieval that raises mean confidence by ≤ this AND closes no gap is diminishing (→ resolve) |

(Whether to run conversational rounds is a stance decision — `hasGenuineDisagreement` — not a confidence-spread threshold; the old `DEBATE_CONSENSUS_SPREAD` / `DEBATE_CONSENSUS_MIN_CONFIDENCE` knobs were removed.)

Model assignments for committee roles are in [`src/lib/models/provider.ts`](src/lib/models/provider.ts)
(`modelForRole` for the opening, `modelForDebateRound` for conversational rounds).

### Orchestration — agentic retrieval (`retrievalMode: "agentic"`)

| Parameter | Default | What it does |
| --- | --- | --- |
| `RESEARCHER_MODEL_ID` | `claude-haiku-4-5-20251001` | The researcher agent's model — search planning, not deep reasoning |
| `MAX_SEARCHES_PER_PASS` | `1` | Web searches a researcher may run per pass — the analogue of the coded arm's 1-query-per-question; forces the agent to READ its hits instead of a query-refinement treadmill (the outer loop re-searches with a gap-informed query later) |
| `MAX_AGENT_STEPS` | `8` | Per-agent model-step cap; a never-converging agent can't burn unbounded Haiku calls |
| `RECON_FLOOR` | `3` | Loop-0 minimum sources an agent must gather before it may stop (code-enforced, never deadlocks) |
| `READSOURCE_HEAD_CHARS` | `600` | Working-memo head the agent sees per read source (the full page is still stored as Evidence) |

**Evidence volume is pinned to the coded arm.** The reader's per-pass ceiling reuses
`resultsPerQuestionForLoop(loop)` — **3 on recon, 6 on gap passes**, the coded arm's exact `k` — so the
committee sees the same evidence *volume* both ways and deliberation cost matches by construction. On
loop 0, floor == ceiling (`min(RECON_FLOOR, 3) = 3`), so each question gets exactly 3 grounded sources.
The only thing that differs between the arms is source *quality* (agent judgment vs mechanical triage) —
which is the eval variable. (This is what keeps the USD-per-Firecrawl-credit ratio in line: LLM cost is
driven by evidence volume into the committee, not by retrieval mechanics, so volume must match.)

The researcher model is deliberately **not** in `MODEL_CONCURRENCY` — it's shared with the committee's
redebate Haiku, the per-pass fan-out is already ≤ `MAX_QUESTIONS`, and every Firecrawl call is globally
capped by `FIRECRAWL_CONCURRENCY`.

### Budget model

Two independent budget systems keep runs in check:

**Firecrawl credits** (`TOTAL_FIRECRAWL_BUDGET`, default 80) — denominated in Firecrawl credits
(search = 2 credits, scrape = 1 credit per page):
- `budgetRemaining` / `budgetSpent` tracked in `ResearchState`, decremented by the `retrieve` node.
- Both use **additive reducers**: nodes return a signed *delta*, not an absolute, and the reducer
  accumulates. This is order-independent, so two nodes updating budget in the same LangGraph
  super-step can't lose an update the way a last-write-wins replace reducer would. `retrieve` is
  the sole writer (`budgetRemaining: -credits`, `budgetSpent: +credits`); `gate` never touches
  budget. The initial budget is seeded as a delta onto the default of 0. This holds for BOTH retrieve
  bodies — the agentic node reconciles its shared `PassPool`'s real credits into the same single delta.
- **Per-pass reservation** (`MAX_LOOP_SPEND_FRACTION`): no single retrieval pass may spend more than
  half the initial budget, so a broad first pass can't drain the pool and starve the gap-targeted
  passes. Coded caps its query count to fit; agentic seeds the pass `PassPool` with the same clamp.
- **Agentic pass pool** (`researcher.ts`): all of a pass's researcher agents draw first-come-first-
  served from one pool, charging REAL post-cache credits (cache hit = 0, live search = 2, live scrape
  = 1). Once exhausted, tools refuse further calls gracefully (a message / a partial read), so a pass
  never runs away.
- `gate` clamps: if the LLM requests more retrievals than budget allows, only top-N by `gapCount` proceed.

**LLM cost cap** (`MAX_RUN_COST_USD`, default $0.75) — a per-run USD ceiling enforced by a
`CostTracker` (`cost-tracker.ts`). The tracker lives in `AsyncLocalStorage` keyed to each run's
async call-tree (via `runWithCostTracker`), **not** a module global — so concurrent runs (browser
tabs, or compare-arms running all three arms) each see their own tracker and never clobber each
other's spend. Every gated LLM call checks the cap before executing and records its *exact* cost
(from the call's real `usage`) after — no pre-call cost estimation. In the **agentic** arm the check
runs *inside* each researcher's tool-loop (before every model step), because one super-step can bill a
whole Haiku swarm; a thrown `BudgetExceededError` rejects the pass and propagates to the same degrade
path. Because the graph fans out ~20 committee calls at once, a single fan-out wave can overshoot the
cap by up to one super-step's spend before any call settles; the next `check()` then halts the run.
We accept that bounded, fully accounted overshoot rather than reserve against a guessed pre-call cost.
If the cap is hit mid-run, a `BudgetExceededError` is caught — the run immediately synthesizes a
partial report from whatever state has accumulated, writes the trace, and returns results. The final
objective-level answer is **exempt** from the cap (it records cost but never gates), so the deliverable
always completes even on a run that otherwise blew its budget.

Two guarantees keep this honest and rare:
- **Affordability guard** (`MIN_LOOP_COST_HEADROOM_USD`): the gate converges *before* starting a
  retrieve+debate cycle it can't afford, so we don't spend on a super-step that LangGraph would then
  roll back mid-flight — the last *complete* loop's claims feed the answer instead.
- **True-spend accounting**: the `CostTracker` retains every billed call, and the report rolls up *from
  the tracker* (not `state.llmCalls`). A rolled-back super-step drops its calls from graph state but
  they were still billed — so without this the reported cost undercounts (a real degraded run showed
  $0.61 reported vs $0.75 billed). Reporting from the tracker makes the number match what actually ran.

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

**Stopping conditions** — layered and code-enforced, so no phase runs away on time or money:
- *Outer retrieval loop*: `MAX_LOOP_ITERATIONS` (5), Firecrawl budget exhaustion, the LLM cost cap, or
  a zero-progress loop (`newEvidenceCount === 0` → `gateShortCircuit` no-progress) — plus the
  `routeAfterGate` `budgetRemaining > 0` guard. Whichever hits first.
- *Debate loop*: the openings show no genuine disagreement (`hasGenuineDisagreement` false → skip the
  rounds), movement-based early stop (a round that moves no position is terminal), or the
  `MAX_DEBATE_ROUNDS` cap.
- *Each researcher agent* (agentic arm): `MAX_AGENT_STEPS`, the shared `PassPool` exhausting, the
  interior cost check throwing, or the model deciding it has enough — subject to the loop-0
  `RECON_FLOOR` minimum (which re-drives an early stop once but is itself bounded by the three above,
  so a source-less question never deadlocks).

### Real-time visualization — the question board

The orchestrated arm streams `ResearchEvent`s over SSE from `/api/research/orchestrated`.
The frontend `useResearchStream` hook feeds a pure reducer that builds up the full UI state.
`QuestionBoard` renders it as a **question-centric swimlane grid** (`docs/question-board-spec.md`):
one row per research question, five lifecycle-stage columns flowing left→right, click-to-drill-down.

- **Header** — topic, cost/time/loop counter, and a one-line `PipelineMinimap` ("you are here")
- **Recon** — source count gathered on loop 0; drills into the per-question evidence feed
- **Openings** — four `StanceDots` colored by each role's round-0 stance (green supports / red
  opposes / grey insufficient), resolving to `agree` or `split`; drills into the fanned-out opening
  claims (role, conclusion, confidence, stance)
- **Deliberation** — `⚡ skipped — unanimous, no genuine disagreement` or `🗣 debated N rounds`;
  drills into `DebateArena` (force-directed claim/evidence graph) + `AgentSwimlane` (a
  round-by-round confidence timeline, fed by the real `debate:opening`/`debate:round` events —
  the debate-arena work formerly tracked as D6)
- **Gate** — committee stance chip + route verdict (`settled` / `fault-line` / `limitation` /
  `retrieve +gap`), mirroring gate.ts's own routing reasoning; drills into `GateDecisionPanel`
- **Loop** — `↻ retrieve loop K` with a `WindowShopStrip` mini-viz (🔍 query (hits) → 🚫 capped →
  📄 read stored/requested ⛔ceiling); drills into the full per-question researcher trace

**Replay**: `useResearchReplay` drives the SAME reducer over a pre-recorded event array
(`/api/research/replay` serves the committed `test/fixtures/replay-events.json`) behind a
play/pause/scrub/speed controller at `/replay` — no live run, no keys, no cost.

**Run-mechanics receipt**: at run end, `RunMechanicsReceipt` renders the terminal
`research:mechanics` event — debated/skipped/productive, effort split (search vs analyze),
cost vs cap, convergence reason.

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
- **Convergence** — `gate:converged` records why the loop stopped: `budget` / `cost-headroom` /
  `max-loops` / `no-progress` / `contention-resolved` / gate-decided
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
    replay/page.tsx               /replay — QuestionBoard driven by useResearchReplay + play/pause/scrub UI
    api/
      scan/route.ts               baseline SSE streaming orchestrator
      research/
        orchestrated/route.ts     orchestrated SSE endpoint (POST, streams ResearchEvents)
        replay/route.ts           serves the committed replay fixture (test/fixtures/replay-events.json)
  lib/
    params.ts                     all tunable parameters (baseline + orchestration)
    prompts.ts                    all LLM prompt wording (personas, calibration, node prompts)
    research-events.ts            ResearchEvent union type (SSE wire protocol) — incl. debate:opening/
                                  debate:round/research:mechanics for the question board
    useResearchStream.ts          client hook + pure reducer for orchestrated research SSE
    useResearchReplay.ts          drives the SAME reducer over a static event array (play/pause/scrub/speed)
    research/
      board.ts                    pure cell-derivation helpers for QuestionBoard (stance, verdicts, scoping)
      arena.ts                    DebateArena/AgentSwimlane pure graph + swimlane-cell builders
    schemas/
      state.ts                    ResearchState (Annotation) + Question + debateTranscripts + retrievalMode channel
      evidence.ts                 Evidence zod schema (+ optional questionId for identity scoping)
      claim.ts                    Claim + DebateResponse/DebateTurnOutput schemas + AgentRole enum
    models/
      provider.ts                 model assignments per agent role
    evidence/
      firecrawl.ts                search() + explore() — Firecrawl search/scrape
      store.ts                    in-memory Evidence store + contentHash
    orchestration/
      graph.ts                    StateGraph (decompose→retrieve→debate→gate→recommend); retrieve dispatches on
                                  retrievalMode (coded body vs retrieveAgentic); missionForQuestion; runGraph()
      researcher.ts               agentic retrieve: runResearcher() (Haiku tool-loop) + PassPool + webSearch/readSource tools
      graph-stream.ts             runGraphStreaming() — streams ResearchEvents from graph nodes (defaults to
                                  the agentic arm on the live/streaming surface); transcriptToEvents() emits
                                  debate:opening/debate:round from the debate node's per-loop transcripts
      committee.ts                runCommittee() (blind opening) + runDebate() (full debate) + message builders
      debate.ts                   debate types + pure logic (consensus, movement, contentions, transcript)
      digest.ts                   per-question Haiku evidence digest (L2) + prompt/clamp/format helpers
      gate.ts                     allocateBudget() + gateShortCircuit() + contention routing — LLM gate + clamps
      mechanics.ts                computeRunMechanics()/formatMechanicsReport() — RUN MECHANICS report,
                                  streamed as the terminal research:mechanics event for the question board
      limiter.ts                  createLimiter() — per-model + Firecrawl FIFO concurrency caps (L6)
      cost-tracker.ts             per-run USD cost cap via AsyncLocalStorage (runWithCostTracker)
      eval.ts                     ArmResult + ComparisonResult (arms[]) + runBaseline() + toAnnotatedUsage() token tracking
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
      QuestionBoard.tsx           question-centric swimlane grid + drill-down router (top-level)
      StanceDots.tsx              Openings-cell four-dot stance indicator
      PipelineMinimap.tsx         one-line "you are here" pipeline strip (header)
      WindowShopStrip.tsx         Loop-cell mini-viz + researcher-trace drill-down
      RunMechanicsReceipt.tsx     run-end debated/skipped/productive + effort-split card
      DebateArena.tsx             deliberation drill-down: force-directed claim/evidence graph
      AgentSwimlane.tsx           deliberation drill-down: round-by-round confidence timeline
      EvidenceFeed.tsx            Recon/Loop drill-down: per-question evidence feed
      GateDecisionPanel.tsx       Gate drill-down: retrieve/resolve decisions with gapCount/spread
      CostCounter.tsx             live LLM + Firecrawl cost counter (header)
      ResearchReportView.tsx      final research report + run-mechanics receipt display
      PipelineGraph.tsx           unshrunk pipeline graph (superseded by PipelineMinimap, kept)
      QuestionTracker.tsx         per-question status card (absorbed into QuestionBoard's row header, kept)
    ScanInput.tsx, ScanProgress.tsx, ReportView.tsx, Gauge.tsx, ...
scripts/
  compare-arms.ts                 A/B/C comparison harness — baseline + orchestrated + agentic (accepts --budget)
  run-arm.ts                      single-arm runner (baseline | orchestrated | agentic, accepts --budget)
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

Zero-cost checks (no API credits — run these to confirm the build):

```bash
npx tsc --noEmit       # typecheck
npx vitest run         # unit tests (420 green)
npm run smoke:supabase # verify the Supabase cache round-trips (live but free)
```

Paid / live runs (spend API credits — the real functional check of the pipeline):

```bash
npm run dev                                     # dev server at http://localhost:3000 (coded arm in the UI)
npm run run-arm agentic "freight brokerage"     # one arm: baseline | orchestrated | agentic
npm run run-arm agentic "freight brokerage" --budget=50   # Firecrawl-budget override (--budget=N, not a space)
npm run compare -- "freight brokerage"          # all three arms → compare-output/<topic>-<ts>.json
```

The agentic-vs-orchestrated `compare` run is the end-to-end functional + cost/quality check for the
agentic-retrieval migration; a run writes a full trace to `trace-output/` for inspection.

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
- Firecrawl credits tracked per-call: **2/search, 1/scrape** (cache hits = 0). Shown in the report.
