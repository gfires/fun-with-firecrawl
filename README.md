# Blindspot

> Attention is all you need. But what evidence is worth your attention?

Ask an LLM "is there a business here?" and you get a clean, generic, unfalsifiable answer with no
sourcing, no acknowledgment of what it doesn't know, and no mechanism to disagree with itself.
Blindspot answers the same question with **empirical, cited, and adversarially-tested** evidence
instead: it finds and reads real sources, runs a committee that argues about what they
mean, and spends a hard-capped budget only where more evidence could change the answer. Input an industry,
idea, or full investment thesis; get back a verdict you can trace claim-by-claim back to a URL plus 
an honest account of what remains unsettled.

---

## Why this exists

### A single LLM call can't tell you what it doesn't know

A transformer's whole computation is "which tokens deserve attention, given what I've already
seen." That's great for quick comprehension, not so much for getting the full, messy picture. 
A single-shot answer surfaces what's already latent in model weights, buries uncertainty instead of surfacing it,
and optimizes output tokens for plausibility. You can't audit a paragraph of confident
prose against sources it didn't cite, and a question of venture-scale viability certainly isn't latent in any weights.
Instead, it depends on precedent (has this been tried, how did it die), operational reality (what actually breaks day to day), market structure (is there a fundable venture, not just a real pain point), and the single strongest reason it fails. Each of those lives in a different corner of the web, phrased differently, buried among many competing signals.

Thus, instead of asking a model to *recall* an answer, Blindspot asks: **out
of everything findable on the open web, what specific evidence is worth our time, and what does
it actually establish?** This approach properly treats market or thesis assessment as a retrieval-and-allocation problem, not a lookup. Source breadth is virtually infinite; the scarce resources are attention and budget. So retrieval, triage, and allocation are first-class system components with guarantees (budgets, citations, adversarial checks, and a record of both what was read and why), not an afterthought for a single LLM call.

### Disagreement is signal, not noise

A panel that's told to agree will agree — and that agreement is worthless, because you can't tell if it's real consensus or four models converging on the same plausible-sounding guess. Blindspot's committee forms opinions *blind*, independently, before anyone sees anyone else's view. This way, cross-role agreement is a genuine signal and disagreement is investigated rather than smoothed away. From here, roles actively debate with each other and fetch new evidence as necessary to resolve remaining disagreements (and when the committee can't agree because two readings of the evidence are both defensible, the report says so too). Blindspot was designed with the philosophy that surfacing such disagreement is far more useful to a reader than forcing consensus at the expense of real-world nuance.

---

## Does it actually work?

Modern LLMs can use search the web, so one real test is whether the process actually catches its own unexamined inferential leaps. We ran the same question through Blindspot's orchestrated arm and through a single continuous Claude Sonnet 5 session at high reasoning effort, web search on, explicitly told to cite in-text and return a decisive verdict — the same model family and tier as Blindspot's own strongest committee seat, not a strawman:

*the AI agent ecosystem is fragmented across orchestration frameworks, memory systems, eval platforms, tool-use infra, and observability. Is there venture-scale opportunity in agent infra, or will these capabilities become commoditized by frontier model providers?*

Both arms landed on the same shape: durable, stateful layers (memory, execution, eval / observability, governance) look investable; generic orchestration and connector layers are commoditizing under frontier-lab and hyperscaler pressure. Both independently reached for the same four companies as central evidence — Temporal, Braintrust, Arize, Mem0. The difference wasn't the verdict, but what each process did with its own load-bearing assumption. The single agent presented the raises as decisive:

*That's a real moat mechanism (switching cost via accumulated state), not a narrative one, and it explains why capital is concentrating exactly where you'd predict.*

Blindspot's committee reasoned from the identical four raises, but its adversarial structure surfaced the leap the single agent never examined: raised money and has a durable moat are not the same claim. The gate refused to settle the question and logged it as a fault line instead:

*the skeptic and investor demand proof of >$100M ARR, gross retention, and NRR that simply is not in the public record; the historian and operator treat the Temporal / Braintrust / Arize / Mem0 raises as sufficient directional signal. Neither side has evidence the other lacks — this is a threshold-of-proof disagreement.*

The single agent did with a real hedge, flagging demand-side production adoption as the biggest variable in the thesis. But that was the wrong doubt: a generic risk surfaced, while the sharp, load-bearing leap in its own argument (and the one an investment committee would actually attack) passed without a flag. Confidence checked only by the process that produced it doesn't reliably know where to look.

Attention over evidence isn't free, and knowing what deserves scrutiny is a different skill than knowing what to search for. A single agent, however good its tools, gets one pass of attention, spent by one process, checked by nothing but itself. Blindspot spends it twice: once to find the evidence, once, adversarially, to ask what it actually proves. And because every step of that second pass is threaded to a source and replayable byte-for-byte at /replay, you can verify the fault line was real and trace it back to the original sources. This is the point of making the reasoning auditable rather than taking a confident paragraph on faith.

Reproduce: npm run compare -- "<topic>" writes every arm's verdict, cost, and timing to compare-output/<topic>-<timestamp>.json.

## How it works

### The committee — adversarial debate, not a poll

Four role-agents, each with their own incentives:

| Role | Incentive | Model (opening → re-debate) |
| --- | --- | --- |
| **Historian** | Precedent — has this been tried, and how did it die? | gpt-5.4-mini |
| **Operator** | Reality on the ground — what actually breaks day to day? | gpt-5.4-mini |
| **Investor** | Return — is there a fundable business, not just a real pain point? | Claude Sonnet 5 → Haiku 4.5 |
| **Skeptic** | Disconfirmation — actively hunts for the strongest reason this fails | Gemini 3.1 Flash-Lite |

**Blind openings.** Round 0 shows every role the *same* evidence but not each other's answers.
Working off the overarching research question, each states a claim: a conclusion, a calibrated confidence, 
and a categorical **stance** (`supports` / `opposes` / `insufficient`).

**Debate only when it's genuine.** Conversational rounds run only when the openings show real disagreement — at least two conflicting stances, or two roles citing the same source to opposite conclusions. A unanimous opening skips straight to the gate at zero extra cost, as further discussing agreement eats tokens that have far better marginal utility elsewhere. When rounds do run, each role sees the full transcript and the challenges aimed at it, and may rebut, concede, or extend — conceding only when a cited source forces it, never to consensus. Every role is explicitly instructed that agreement is not evidence. The debate stops the instant a round moves no position (confidence shift below DEBATE_CONFIDENCE_EPSILON = 0.05 and no new cited-id changes count as no movement) or hits the MAX_DEBATE_ROUNDS = 2 cap.

### Preserve disagreement; retrieve only where it pays

A gate reads the committee's verdict on every question and routes it, with **no LLM call at
all** for most cases:

- **Unanimous lean** (`supports`/`opposes`) → settled. Done.
- **Contested, interpretive** (both sides argue from the *same* evidence, no one names a missing
  fact) → resolved as a reported **fault line**. More retrieval can't fix a disagreement about
  what evidence *means* — spending budget chasing it would be pure waste, so the system doesn't.
- **Contested or unresolved, with a named evidential gap** → this is where retrieval earns its
  keep. Only a *specific, named* missing fact routes back to the retrieval loop, targeted at that
  gap specifically. This is retrieval-on-value-of-information: the system doesn't search more
  because it's uncertain in general, it searches more because a role named the exact fact that
  would change the answer.
- A gap that survives one more retrieval pass without narrowing is noted as a **structural
  limitation** in the final report, not chased a third time (patience = 1) — some data (private
  ARR figures, internal churn) is genuinely not on the public web, and the system says so instead
  of burning budget pretending otherwise.

Only after this zero-cost routing does a cheap LLM classifier (`gpt-4o-mini`) score any
remaining ambiguous questions on computed signals — named-gap count, confidence spread — never a
vibe-check. If it asks for more retrieval than the remaining budget allows, the system clamps to
the highest-value questions by gap count rather than either overspending or picking arbitrarily.

### Agent orchestration

Orchestration is a [LangGraph.js](https://langchain-ai.github.io/langgraphjs/) `StateGraph`, not
an open-ended agent loop:

```
topic
   │
   ▼ DECOMPOSE     manager breaks the topic into 3–4 concrete research questions + a search query each
   ▼ RETRIEVE       search + scrape for each open question (agentic researcher swarm)
   ▼ DIGEST         compress each fresh source into a short evidence item before the committee reads it
   ▼ DEBATE         blind opening → conversational rounds only on disagreement OR insufficient evidence
   ▼ GATE           route each question: settle / report fault line / retrieve the named gap
   ├─(gap named, budget left)─► back to RETRIEVE
   ▼ ANSWER         cited, per-question report — exempt from the cost cap so it always completes
```

State moves through the graph via reducers. Budget is
tracked as `budgetRemaining`/`budgetSpent`, and every node that touches it returns a *signed
delta* that an additive reducer accumulates (preventing clobbering). Debate transcripts use a replace-per-question reducer instead, and every graph
run also checkpoints its full state history (LangGraph `MemorySaver`) so runs are fully inspectable

The graph loops back to `RETRIEVE` only when the gate found a named gap *and* budget remains —
capped independently by a hard iteration ceiling, a zero-new-evidence kill switch (a pass that
retrieves nothing new can't possibly change the debate, so the loop ends instead of re-running an
identical argument), and the cost cap below.

### Budget is a hard constraint

Every run is capped on two independent axes, checked before every spend:

- **Retrieval credits** (`TOTAL_RETRIEVAL_BUDGET = ...`) — one combined search+scrape credit pool.
  No single retrieval pass may spend more than half of it (`MAX_LOOP_SPEND_FRACTION = 0.5`), so
  an early broad pass can't drain the pool before the gap-targeted passes ever get to run.
- **LLM spend** (`MAX_RUN_COST_USD = ...`) — a real-time USD ceiling checked before every gated
  call via an `AsyncLocalStorage`-scoped cost tracker. Before starting a fresh retrieve+debate cycle, the gate also checks it can
  *finish* the cycle it's about to start (`LOOP_COST_PER_QUESTION_USD × unresolved-question-count`
  of headroom required), as a mid-debate cap hit renders the whole round effectively useless. If the cap is still hit, the run
  degrades gracefully: it synthesizes a partial report from whatever the committee had already
  settled. The final answer call itself is **exempt** from the cap — the deliverable always
  completes, even on a run that otherwise blew its budget.

### Knowing what deserves attention

Retrieval finds far more candidate pages than are worth reading, and every source that does get
read costs both a scrape credit and committee context. Two layers decide what actually earns
attention:

- **Triage before scrape.** A cheap relevance-scoring pass ranks every deduplicated search hit
  before anything is scraped, so an off-topic result never costs a scrape credit or reaches the
  committee.
- **Digest before debate.** A per-question compression pass turns each fresh source into a short,
  id-keyed evidence item before the committee fans out — the four roles reason over compact
  digests, not raw page text, which keeps a wall of scraped HTML out of every role's context
  while preserving exactly enough for a role to cite a specific source.

Together with the VOI-driven gate above (retrieve only for a *named* gap), this is the same idea
applied at every layer: don't spend retrieval, context, or reasoning budget on evidence that
isn't going to move the answer.

### Traceability and citations

Every claim in the final answer is threaded back to a `[S#]` citation tag mapped to a real
evidence id — an earlier version let the answer prose float free of its sources, and it cited
nothing despite the committee having sourced most of its claims; the answer builder now requires
citation and tags each claim with the sources that support it.

Beyond the final report, every orchestrated run writes an exhaustive trace file: every prompt and
response (with cache read/write token counts), every search and scrape call (live vs. cache hit),
every debate round's transcript, and the exact reason the run stopped when it did
(`budget` / `cost-headroom` / `max-loops` / `no-progress` / a converged committee). The frontend
**question board** renders a live run as one swimlane per question — recon, opening stances,
debate, gate decision, retrieval — over SSE, and any saved run can be replayed byte-for-byte from
its event log at `/replay`, scrubbable, with no API keys and no cost. Nothing about the reasoning
is a black box.

### Configurability — swap providers and models without touching call sites

Search and scrape are **independently** selectable operations (`SEARCH_PROVIDER` / `SCRAPE_PROVIDER`
in `src/lib/evidence/config.ts` — defaults: Exa for search, Firecrawl for scrape), resolved
through one provider-agnostic pipeline in `evidence/provider.ts`. Every call site imports from
that seam, never a specific vendor's module, so adding a third search or scrape provider is a
matter of implementing `SearchOps`/`ScrapeOps` once, not hunting down every caller.

Every model assignment is equally centralized and swappable: each committee role's model (both
its round-0 and re-debate tier) lives in `src/lib/roles.ts` alongside its persona, and every
non-committee model (manager, gate classifier, digest, researcher agent, final answer) is a named
constant in `src/lib/params.ts`. Pricing for every model and provider lives in one catalog
(`src/lib/pricing.ts`), which cost tracking and the frontend cost display both read from — change
a model id in one place and correctness, cost accounting, and the UI all follow automatically.

### Caching and convergence

- **Result caching.** Search results, scraped pages, and a scraper blocklist, cached in Supabase and shared across processes and both arms: a repeat query or URL is free on a later run, and an unreachable Supabase degrades to uncached rather than failing. Setup: Caching.
- **Prompt caching.** The three Claude roles share a byte-identical system-prefix (question + evidence + calibration) per round, above PROMPT_CACHE_MIN_CHARS = 4500, so Anthropic serves repeat reads from its prompt cache instead of re-billing.
- **Convergence thresholds, not open-ended looping.** a debate round counts as "moved" only if a role's confidence shifts past DEBATE_CONFIDENCE_EPSILON = 0.05 or its cited set changes; a retrieval loop is "diminishing" once it raises mean confidence by < LOOP_CONFIDENCE_EPSILON = 0.05 and closes no named gap. The system stops arguing/searching the moment it stops learning, rather than running to a hard cap by default.

### The runnable arms

npm run compare runs all three on one topic, writing cost/quality/timing side by side. They serve different purposes — only the coded-vs-agentic pair is a controlled comparison:

Baseline — a fast, cheap, fully-traceable single pass: search → triage → scrape → one LLM analysis call, no debate. This is the quick-scan mode, not a control for the orchestrated arm's value-add — that comparison is against a full-power single agent (see Does it actually work? above), not baseline.
Orchestrated (LangGraph) — the full system described above. Two retrieval strategies plug into the same graph:
coded — deterministic search → triage → scrape, tuned per question.
agentic — a bounded researcher agent (Haiku) per open question, searching and reading for itself instead of following a fixed pipeline. Evidence volume per question is pinned equal to coded by construction, so coded vs agentic is an apples-to-apples eval of retrieval judgment, not quantity.

---

## Quick start

```bash
npm install
cp .env.local.example .env.local   # then add your keys
npm run dev                        # http://localhost:3000
```

Keys needed in `.env.local`:

| Var | Used for |
| --- | --- |
| `EXA_API_KEY` | web search (default search provider) |
| `FIRECRAWL_API_KEY` | scrape (default scrape provider) — needed alongside Exa, not instead of it |
| `OPENAI_API_KEY` | historian + operator committee roles |
| `ANTHROPIC_API_KEY` | manager, investor committee role, digest, researcher agent, final answer |
| `GOOGLE_GENERATIVE_AI_API_KEY` | skeptic committee role — a free-tier AI Studio key works ($0, rate-limited) |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | search/scrape/blocklist cache (optional but recommended — see [Caching](#caching)) |

```bash
npm run compare -- "freight brokerage"                       # all three arms, side by side
npm run run-arm agentic "freight brokerage"                  # one arm: baseline | orchestrated | agentic
npm run run-arm agentic "freight brokerage" --budget=50 --usd-budget=0.25   # override both budgets ($flag=N, not a space)
```

`--budget` (retrieval credits) and `--usd-budget` (LLM dollars) are two independent caps — either
can run out first. Neither applies to `baseline` (no graph, no cost tracker). `compare` lands
output in `compare-output/<topic>-<timestamp>.json`.

---

## Project map

```
src/lib/
  roles.ts                 committee role catalog — persona + model, per role, single source of truth
  pricing.ts                model $/1M pricing + search/scrape credit rates
  params.ts                  orchestration tunables (budgets, loop caps, debate rounds, epsilons)
  prompts.ts                  all non-persona LLM prompt wording
  evidence/
    provider.ts               provider-agnostic search/scrape pipeline (dedupe, triage, cache, scrape pool)
    config.ts                  SEARCH_PROVIDER (Exa) / SCRAPE_PROVIDER (Firecrawl) + retrieval tunables
    firecrawl.ts / exa.ts       the two vendor implementations
  orchestration/
    graph.ts                   LangGraph StateGraph: decompose → retrieve → debate → gate → answer
    committee.ts                blind opening + full debate loop
    debate.ts                   pure debate logic: disagreement, movement, contention — no LLM calls
    researcher.ts                agentic retrieve: the researcher agent + shared credit pool
    gate.ts                      stance routing + VOI retrieval gate
    cost-tracker.ts               per-run USD cap
    trace.ts                     exhaustive run trace writer
  research/
    board.ts, arena.ts            pure data helpers for the live question-board UI
src/components/research/
  QuestionBoard.tsx              swimlane-per-question live UI, drill-down router
  DebateArena.tsx, AgentSwimlane.tsx   deliberation drill-downs
scripts/
  compare-arms.ts / run-arm.ts    A/B/C comparison harness + single-arm runner
supabase/schema.sql               cache + blocklist schema
```

Full file-by-file reference: [CLAUDE.md](CLAUDE.md). Changelog and current status: [STATUS.md](STATUS.md).

---

## Testing

Zero-cost checks (no API spend):

```bash
npx tsc --noEmit         # typecheck
npx vitest run            # unit tests
npm run smoke:supabase   # verify the Supabase cache round-trips (live but free)
```

Paid/live checks (spend API credits — the real functional test of the pipeline):

```bash
npm run run-arm agentic "freight brokerage"
npm run compare -- "freight brokerage"
```

---

## Caching

Setup only — behavior is described under Caching and convergence. Create the blindspot schema from supabase/schema.sql, add it to the project's Exposed schemas, then verify with npm run smoke:supabase. Optional: without it, runs proceed uncached.

---

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, the project's
design principles, and how to open a PR.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
