# Replay browser, frontend budget controls, and auto-growing query input — spec

Status: **not implemented — spec only.** Three independent, separately-shippable pieces of work.

## Decisions (confirmed)

1. **Replay persistence is Supabase-backed, not filesystem-based.** Runs are cached in the
   `blindspot` Supabase schema (same project already backing the search/scrape/blocklist cache and
   the leaderboard — `src/lib/supabase.ts`), not read from local `trace-output/`. This is real
   persistence that survives across deploys/instances, not a local-dev convenience. See §1 below.
2. **Budget UI scope: Research mode only.** Only "Deep Research" (orchestrated) mode has
   budget-override params plumbed on the backend at all (`budgetOverride` for retrieval credits,
   `usdBudgetOverride` for LLM $ spend — both already accepted by `runGraphStreaming()`/
   `runGraph()`). The baseline "Scan" mode has no per-request override mechanism (its tunables are
   static `SCAN_*` env vars only) and is explicitly out of scope for this pass.

---

## 1. Replay browser for real prior runs (Supabase-backed)

### Current state

- `/replay` (page) + `/api/research/replay` (route) + `useResearchReplay` (hook) are fully built —
  play/pause/scrub/speed controls driving the same `QuestionBoard` a live run uses.
- The API route is hardcoded to one file: `test/fixtures/replay-events.json`, a committed test
  fixture. No concept of "which run."
- Every Research run's `graph-stream.ts` `send()` wrapper already sees every `ResearchEvent` as it's
  emitted (that's the SSE mechanism itself) and separately logs it into the local
  `TraceLogger`/`trace-output/*.trace.json` — that local trace write is a distinct, unrelated
  debugging artifact (full LLM/Firecrawl call detail) and is untouched by this spec; it keeps
  working exactly as it does today.
- `/replay` is not linked from anywhere in the app (`src/app/page.tsx` has no nav to it).
- Existing Supabase conventions to follow (`src/lib/supabase.ts`, `src/lib/leaderboard.ts`,
  `supabase/schema.sql`): a `blindspot` Postgres schema, tables created via a committed, manually-
  applied DDL file, a lazy-proxy client (`supabase.from(...)`), permissive anon-role RLS (this is a
  single-operator app, not multi-tenant), and `{ error } → return [] / null` graceful degradation —
  a Supabase outage must never fail or block an actual research run.

### Schema — `supabase/schema.sql` addition

```sql
create table if not exists blindspot.research_runs (
  id                uuid primary key default gen_random_uuid(),
  topic             text not null,
  status            text not null check (status in ('completed', 'errored')),
  started_at        timestamptz not null,
  finished_at       timestamptz not null default now(),
  budget            integer,   -- retrieval credit override actually applied; null = server default
  usd_budget        numeric,   -- LLM $ cap override actually applied; null = server default
  total_cost_usd    numeric,   -- actual $ spent (from the cost tracker / RunMechanics)
  firecrawl_credits integer,   -- actual retrieval credits spent
  events            jsonb not null,  -- ResearchEvent[] — everything the replay UI needs to scrub/play
  mechanics         jsonb            -- RunMechanics snapshot, for a list view without loading `events`
);

create index if not exists research_runs_started_at_idx
  on blindspot.research_runs (started_at desc);

alter table blindspot.research_runs enable row level security;
drop policy if exists "research_runs anon rw" on blindspot.research_runs;
create policy "research_runs anon rw" on blindspot.research_runs
  for all to anon, authenticated using (true) with check (true);
```

(Schema-level `grant usage`/`grant all` from the existing `schema.sql` already covers new tables
via `alter default privileges` — no additional grant needed.) `mode` is deliberately omitted: this
table is Research-mode only per the confirmed scope (§ Decisions) — add it later only if Scan-mode
runs ever need the same treatment.

### App-side module — `src/lib/runs.ts` (new, mirrors `leaderboard.ts`'s shape)

```ts
export interface RunSummary {
  id: string;
  topic: string;
  status: "completed" | "errored";
  startedAt: string;
  finishedAt: string;
  totalCostUsd: number | null;
  firecrawlCredits: number | null;
}

export async function saveRun(run: {
  topic: string;
  status: "completed" | "errored";
  startedAt: string;
  budget?: number;
  usdBudget?: number;
  totalCostUsd?: number;
  firecrawlCredits?: number;
  events: ResearchEvent[];
  mechanics?: RunMechanics;
}): Promise<string | null> { /* returns new row id, or null on failure — never throws */ }

export async function listRuns(limit = 20): Promise<RunSummary[]> { /* [] on error */ }

export async function getRun(id: string): Promise<{ events: ResearchEvent[] } | null> { /* null on error/missing */ }
```

`saveRun` must never throw or reject in a way that can fail the actual research run — wrap the
Supabase call, log-and-swallow on error, exactly like `getCache`/`setCache`'s existing
loud-once-then-degrade pattern (`src/lib/warn-once.ts`).

### Write point — `graph-stream.ts`

In `runGraphStreamingInner`, the `send` wrapper already intercepts every emitted event
(`trace.logEvent(event); originalSend(event);`) — add a third line accumulating into a local
`const allEvents: ResearchEvent[] = []` array. At the end of the run (both the success path and the
`catch` that emits `research:error`), call `saveRun({ topic, status, startedAt, budget,
usdBudget, totalCostUsd, firecrawlCredits, events: allEvents, mechanics })` — `status` is
`"errored"` in the catch branch, `"completed"` otherwise, so failed runs are persisted too (useful
for exactly the kind of "why did this run degrade" investigation that motivated the 529 fix). Apply
the same evidence-content trimming `extract-replay-fixture.ts`'s `slim()` already does before
persisting, to keep each row's `events` payload reasonably small — pull `slim()` out into a shared
helper (e.g. `src/lib/research-events.ts` or a small new `src/lib/orchestration/replay-slim.ts`) so
the fixture-extraction script and this write path share one implementation, not two copies.

This covers both the web route (`orchestrated/route.ts` → `runGraphStreaming`) and CLI streaming
runs (`run-arm.ts ... --stream`) automatically, since both funnel through the same
`runGraphStreamingInner`. Non-streaming batch runs (`compare-arms.ts`, eval scripts via `graph.ts`'s
plain `runGraph()`) are NOT persisted — they have no live per-event stream to accumulate, and
aren't meant for visual replay (they're for numeric A/B comparison).

### New API surface

**`GET /api/research/runs`** — list past runs.

```ts
// Response
{ runs: RunSummary[] }  // listRuns(), newest-first, limit 20 for v1 (add pagination only if needed)
```

**`GET /api/research/replay?id=<uuid>`** — replaces the current hardcoded route.

- `id` present → `getRun(id)` from Supabase, return its `events` directly (already the right shape —
  no server-side extraction/derivation step needed at read time, unlike the old trace-file design).
  Missing/errored lookup → `404` with a clear message, not a silent empty replay.
- `id` absent (or `id=fixture`) → falls back to the committed `test/fixtures/replay-events.json`,
  preserving today's zero-setup demo path (works with no Supabase runs yet, no keys, no cost) as
  the default when nothing else is picked.

### UI changes

- `/replay` gets a picker: fetch `/api/research/runs` on mount, render a list (topic, status,
  relative timestamp, cost — newest first) above the existing playback controls. Selecting one
  refetches `/api/research/replay?id=...` and resets the `useResearchReplay` hook's `events`. Keep
  the bundled fixture as a selectable/default entry (label it distinctly, e.g. "Demo run" — the one
  item guaranteed to work even with zero real runs saved yet). Errored runs should be visibly
  marked (not hidden) — that's real debugging value.
- Link `/replay` from the main app. Simplest: a small "Past runs" link/button near the mode toggle
  in `ScanInput`, or in the idle/landing state of `src/app/page.tsx` alongside `Leaderboard`.

### Explicitly out of scope for this pass

- Deleting/managing saved runs from the UI (a `DELETE` endpoint is trivial to add later if wanted).
- Any change to the local `trace-output/`/`TraceLogger` debugging mechanism — untouched, orthogonal.
- Multi-user / auth around whose runs are visible — this app has one operator, same as the existing
  cache/leaderboard tables' permissive RLS.
- Migrating `scripts/extract-replay-fixture.ts` itself off local trace files — it stays as the tool
  for regenerating the *committed test fixture* specifically (a build-time/demo artifact), which is
  a different concern from the live "past runs" list this section adds.

---

## 2. Frontend budget controls (retrieval credits + LLM $ cap)

### Current state

Backend already has both knobs, independently:

| Param | Meaning | Default | Where |
|---|---|---|---|
| `budgetOverride` | Retrieval credit pool (search + scrape combined) | `TOTAL_RETRIEVAL_BUDGET = 80` (params.ts) | Already threaded: `POST /api/research/orchestrated` destructures `budget` from the body today and passes it through. |
| `usdBudgetOverride` | LLM $ spend cap for the run | `MAX_RUN_COST_USD = 0.75` (params.ts) | **Not threaded on the web path at all** — `runGraphStreaming()`/`runGraph()` both accept it as a parameter, but `orchestrated/route.ts` never destructures or forwards a `usdBudget` field, and `useResearchStream.ts`'s `start(topic, budget?)` has no second budget parameter for it. Only reachable via the CLI (`--usd-budget`). |

Neither is exposed in any UI control today — `useResearchStream.ts`'s `start()` already accepts an
optional retrieval `budget`, but nothing in `page.tsx`/`ScanInput` ever supplies one, so it's always
`undefined` (server default) in practice.

### Backend changes needed

1. `src/app/api/research/orchestrated/route.ts` — destructure `usdBudget` alongside the existing
   `budget`, validate both as positive numbers when present, pass `usdBudget` as
   `runGraphStreaming()`'s 5th argument (`usdBudgetOverride`).
2. `src/lib/useResearchStream.ts` — extend `start(topic: string, budget?: number)` to
   `start(topic: string, budget?: number, usdBudget?: number)`, include `usdBudget` in the POST body.

### UI changes

- Add two optional numeric inputs to `ScanInput`, visible **only in Research mode** (per the scoped
  decision above) — e.g. behind a collapsed "Advanced" disclosure so the default landing experience
  stays as clean as it is today (this app's whole framing is "paste a topic, go" — don't clutter
  the primary flow with budget knobs most users will never touch):
  - **Retrieval budget** (credits) — placeholder/default hint showing `80` (the server default),
    empty = use server default.
  - **LLM budget** ($) — placeholder/default hint showing `0.75`, empty = use server default.
- Validate client-side: positive numbers only, reasonable upper bounds to prevent a fat-fingered
  `999999` from triggering a runaway-cost run — no server-side ceiling currently caps an override,
  so the client input is the only guard unless a server-side sanity cap is added too (worth
  flagging to whoever implements: consider clamping `usdBudget` server-side to something like 5–10×
  the default as a blast-radius limit, independent of this UI work).
- Thread both values from `page.tsx`'s `handleRun` through to `research.start(topic, budget,
  usdBudget)`.
- **Nice-to-have, not required for v1:** echo the caps actually applied back to the client so a
  user can confirm what ran, especially on a degraded/capped run. Today's `research:start`
  SSE event only carries `{ type: "research:start"; topic: string }` — extending it to include the
  resolved `budget`/`usdBudget` (server defaults substituted in) would close that loop, but this
  touches `research-events.ts`, `graph-stream.ts`'s emission site, and the reducer in
  `useResearchStream.ts`. Call out separately if wanted; not required for the controls to work.

---

## 3. Auto-growing query input

### Current state

`src/components/ScanInput.tsx` uses a single-line `<input type="text">` (not a `<textarea>`) for
the topic/query field — hard height, no wrapping, long queries scroll horizontally inside the box
instead of growing.

### Change

Replace the `<input>` with a `<textarea>` that auto-grows with content, capped at a reasonable max
height (e.g. ~6-8 lines) beyond which it scrolls internally rather than pushing the whole page
layout around indefinitely. Two implementation options, pick one:

- **CSS-only (simplest, no JS):** a hidden-grid auto-size trick (wrapper `div` with matching
  `::after` content via a data attribute mirroring the value, `grid` with both rows on the same
  cell) — zero extra state, works with React by keeping a `data-value` attr in sync with `value`.
- **JS resize-to-scrollHeight:** on every `onChange`, set `textarea.style.height = "auto"` then
  `textarea.style.height = `${e.target.scrollHeight}px``, clamped with a `max-height` CSS rule.
  Simpler to reason about, one extra ref, negligible cost given this is a single low-frequency input.

Preserve existing behavior that must carry over:
- `autoFocus`, `disabled`, `placeholder` (mode-dependent text), the `>` prompt-glyph prefix
  currently absolutely-positioned via `pointer-events-none` (needs top-alignment instead of
  vertical-centering once the box can be multi-line).
- **Enter-to-submit currently fires on every Enter keystroke** (`onKeyDown={(e) => e.key ===
  "Enter" && run()}`) — this breaks multi-line input entirely (a user could never type a second
  line). Change to `Enter` submits, **`Shift+Enter` inserts a newline** (the standard chat-input
  convention) — `e.key === "Enter" && !e.shiftKey` guards the submit, and add
  `e.preventDefault()` on the submit path so a bare Enter doesn't also insert a newline before
  `run()` clears/navigates away.
- The submit button and example-topic chips (`EXAMPLES`) are unaffected — they already call
  `onRun`/`setValue` directly, not keyboard-dependent.

No backend/type changes — `onRun(topic: string)` stays a plain string; multi-line input just means
that string can now contain `\n`. Confirm downstream consumers (the `topic.trim()` call in
`orchestrated/route.ts`, `normalizeIndustry()` for the baseline arm) tolerate embedded newlines
reasonably — `trim()` only strips leading/trailing whitespace, so an interior newline survives into
the topic string as-is. That's almost certainly fine (LLM prompts handle newlines natively) but
worth a quick look before shipping, not a blocking redesign.

---

## Summary — file-by-file touch list

| File | Change |
|---|---|
| `supabase/schema.sql` | Add `blindspot.research_runs` table + index + RLS policy |
| `src/lib/runs.ts` (new) | `saveRun()` / `listRuns()` / `getRun()` — mirrors `leaderboard.ts` |
| `src/lib/orchestration/replay-slim.ts` (new, or fold into `research-events.ts`) | Shared evidence-trimming helper, used by both the write path and the fixture-extraction script |
| `scripts/extract-replay-fixture.ts` | Use the shared slim helper instead of its own inline copy (otherwise unchanged — still trace-file-based, still only for regenerating the committed test fixture) |
| `src/lib/orchestration/graph-stream.ts` | Accumulate emitted events per run; call `saveRun()` on both the success and `research:error` paths |
| `src/app/api/research/runs/route.ts` (new) | `GET` — `listRuns()` |
| `src/app/api/research/replay/route.ts` | Accept `?id=<uuid>`, serve via `getRun()`, fall back to the bundled fixture |
| `src/app/replay/page.tsx` | Add the run picker |
| `src/app/page.tsx` | Link to `/replay` |
| `src/app/api/research/orchestrated/route.ts` | Destructure/forward `usdBudget` |
| `src/lib/useResearchStream.ts` | `start()` gains a `usdBudget` param |
| `src/components/ScanInput.tsx` | Advanced-disclosure budget inputs (Research mode only) + `<input>` → auto-growing `<textarea>` + Shift+Enter handling |

## Verification checklist (for whoever implements)

- `npx tsc --noEmit` / `npx vitest run` clean, as always.
- Apply the `research_runs` DDL to the Supabase project (Dashboard → SQL Editor, same manual process
  as the existing `schema.sql`), confirm `npm run smoke:supabase`-style connectivity still works.
- Manually: run a real Research query, confirm a row lands in `blindspot.research_runs` and shows up
  in the `/replay` picker, confirm scrub/play work against it exactly like the bundled fixture.
- Manually: force a run to error (e.g. an invalid topic or a tiny `usdBudget`), confirm it's still
  saved with `status: "errored"` and is visibly marked as such in the picker.
- Manually: submit a Research run with a custom retrieval budget and a custom $ budget, confirm
  (via the saved row's `budget`/`usd_budget` columns, or the mechanics report) both were actually
  applied, not silently ignored.
- Manually: paste a 5+ line query into the textarea, confirm it grows, confirm Shift+Enter adds a
  line and bare Enter submits.
