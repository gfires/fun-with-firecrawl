# Spec — The Question Board

A self-contained design + implementation spec for the orchestrated-research UI. Replaces the
node-centric `ResearchProgress` dashboard with a **question-centric board**: each research question
is a horizontal swimlane whose cells trace its lifecycle, live as the agent decides and replayable
after. This document is the contract; it names every file, event, and reducer field the build
touches, and phases the work behind `tsc` + `vitest` + commit gates.

## 0. Why

The product's value is the **agent's judgment**, not its output. For four questions the system makes
four different calls: skip a settled one, debate a contested one, go get evidence for a thin one,
report a fault line for an interpretive one. The current dashboard is organized by *pipeline stage*
(all questions' evidence, then all questions' debate, then all gate decisions), which scatters each
question's story across five sections and buries the decisions. The board flips the axis: **the
question is the unit, its lifecycle is the spine.** A viewer scans four lanes and sees four reasoned
decisions. That is the whole pitch.

Confirmed scope (from design review):
1. **Replace** `ResearchProgress` — recompose the existing nine components into the board, don't run both.
2. **Live-first, replay-capable** — the hero is watching decisions stream in; replay is near-free because every event is already persisted to the trace, so build for both with live as primary.
3. **Swimlanes** — one row per question, time flowing left→right through lifecycle stages.

## 1. The layout

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  Deep Research: "freight brokerage"          $0.72 · 1m14s · loop 1/3   [▮▮▮░ live]│
│  ─────────────────────────────────────────────────────────────────────────────── │
│  PipelineMinimap:  decompose ─▶ retrieve ─▶ debate ─▶ gate ─↻                       │  ← was PipelineGraph, shrunk
├──────────────────────────────────────────────────────────────────────────────────┤
│                RECON     OPENINGS      DELIBERATION      GATE          LOOP         │  ← stage columns (time →)
│  ┌────────┐  ┌───────┐ ┌──────────┐ ┌────────────┐ ┌───────────┐ ┌──────────┐      │
│ Q1 │ TAM     │  │ 4 src │ │ ⬤⬤⬤⬤ →  │ │ 🗣 debated  │ │ ✔ supports │ │          │      │
│  │ "how big"│  │       │ │ split    │ │ 3 rounds   │ │ settled   │ │          │      │
│  └────────┘  └───────┘ └──────────┘ └────────────┘ └───────────┘ └──────────┘      │
│  ┌────────┐  ┌───────┐ ┌──────────┐ ┌────────────┐ ┌───────────┐ ┌──────────┐      │
│ Q2 │ willing │  │ 3 src │ │ ⬤⬤⬤⬤ →  │ │ ⚡ skipped  │ │ ∅ insuff. │ │ ↻ retrieve│      │
│  │ to pay   │  │       │ │ all abst │ │ no disagree│ │ +gap      │ │ loop 1   │      │
│  └────────┘  └───────┘ └──────────┘ └────────────┘ └───────────┘ └──────────┘      │
│                                                    … Q3, Q4 …                        │
├──────────────────────────────────────────────────────────────────────────────────┤
│  ▸ Activity (raw trace, collapsible)                                                │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **Rows** = questions (3–4, so cells can be information-rich).
- **Columns** = lifecycle stages, fixed order, time flowing right. A cell is empty until its stage
  reaches that question; the active stage-cell pulses.
- **Click any cell → drill-down** opens below the board (an inspector panel), scoped to that
  question+stage. Only one open at a time; the board stays the persistent spine.
- **Run end** collapses the board to a compact summary and reveals the report + the **run-mechanics
  receipt** (debated/skipped/productive, effort split, cost) as the closing artifact.

### Lifecycle stages (the columns)

| Stage | Cell shows | Drill-down |
|-------|-----------|------------|
| **Recon** | source count gathered on loop 0 | evidence list for this question |
| **Openings** | four role dots colored by round-0 **stance** (green supports / red opposes / grey insufficient); the "→" resolves to `agree` or `split` | the blind opening claims fanned out: role, conclusion, confidence bar, stance chip |
| **Deliberation** | `⚡ skipped` (+reason) or `🗣 debated N rounds` (+ productive?) | the debate: openings → conversational rounds → final, with concede/rebut arrows (DebateArena/Swimlane) |
| **Gate** | committee stance chip + route verdict (`settled` / `resolve fault line` / `retrieve +gap`) | the gate reason + GateScore (VOI, gap count) |
| **Loop** | `↻ retrieve loop K` with a **window-shopping mini-viz**, or `—` if settled | the researcher trace: mission → search (hits, capped?) → read (stored/ceiling) |

The **window-shopping mini-viz** is the payoff of the SSE work already landed. Per retrieval pass,
render a tiny strip: `🔍 "query" (10 hits) → 🚫 capped → 📄 read 3/5 ⛔ceiling`. The `capped` and
`hitCeiling` flags are the story — the agent told to stop shopping and commit to reading.

## 2. The hero moment

Round-0 openings are the emotional core: four agents answer **blind**, independently, then their dots
snap to stance colors. Four green dots with no debate is *real signal* — the board says **`⚡ skipped —
unanimous, no genuine disagreement`** and the viewer understands agreement is a trigger to act, not a
dead end. A split (2+ distinct decisive stances or an evidence id-clash) flips the cell to **`🗣
debated`** and the deliberation drill-down animates the rounds. This single row-transition — blind
openings → skip-or-debate → gate verdict — is what we optimize the animation for.

## 3. Data plumbing

The board needs three things the current stream doesn't fully carry. Two are derivable client-side;
one needs new events. **Enforce in code, not vibes** — derive from real fields, never guess.

### 3a. Committee stance per question — DERIVE (no new event)

`committeeStance(claims)`, `hasGenuineDisagreement(claims)`, `decisiveStances(claims)` in
`debate.ts` import only from `schemas/claim` (pure, no server deps) → import them directly in the
board. Per-question stance = `committeeStance(state.claimsByQuestion[qid])`. Stance chips and the
openings `agree|split` resolution come free from the `stance` field already on every streamed Claim.

Lift these three functions into a shared pure module if the linter objects to a client file importing
from `orchestration/` — proposed `src/lib/debate-stance.ts` re-exporting them, imported by both
`debate.ts` and the board. No logic change; a move.

### 3b. Skip-vs-debate per question — DERIVE (reducer addition)

`debate:begin.questionIds` is exactly `questionsNeedingDebate` — the questions that WILL debate.
An unresolved question absent from that set was **skipped on agreement**. The reducer currently
drops this. Add to `QuestionStatus`:

```ts
debateOutcome: "pending" | "skipped" | "debated";   // set at debate:begin (skipped = unresolved ∧ ∉ questionIds)
debateRounds: number;                                // final debateRound seen for this question
```

`debated`+`debateRounds` come from the max `debateRound` across the question's streamed claims once
`debate:claim` events land. `skipped` is set at `debate:begin` for unresolved questions not in
`questionIds`. Productive-vs-wasted (did a debated question actually move?) is a run-end concern —
read it from the mechanics receipt, don't recompute in the reducer.

### 3c. Blind openings + debate rounds — NEW EVENTS (the one real gap)

Only *final* claims stream today (`debate:claim` fires on `output.claims`). The board's openings
column and deliberation drill-down need the **round-0 opening claims** and ideally the intermediate
rounds. The transcript already exists in state (`debateTranscripts` channel); it just isn't emitted.
Add two events, mirroring the existing `debate:claim` shape:

```ts
| { type: "debate:opening"; claim: Claim }   // round-0 blind opening, one per role per question
| { type: "debate:round"; questionId: string; round: number; claims: Claim[] }  // a conversational round's revised claims
```

Emit from the debate node in `graph-stream.ts`'s `case "debate"` by walking
`output.debateTranscripts[qid]` (round 0 → `debate:opening`, rounds ≥1 → `debate:round`) before the
existing final-claim loop. Reducer accumulates into:

```ts
openingsByQuestion: Record<string, Claim[]>;              // round-0, for the stance dots
roundsByQuestion: Record<string, { round: number; claims: Claim[] }[]>;  // for the deliberation timeline
```

This is the only change touching the orchestration/event layer; scope it to Phase 2 and keep it
behind the same "researcher stays unaware of the wire protocol" layering — the node walks state,
graph-stream owns the events.

### 3d. Researcher progress — ALREADY DONE

`researcher:begin|search|read|done` (commit `0d389bd`) already land tagged by `questionId`. The
board demuxes them into per-question window-shopping strips. Add reducer state:

```ts
researcherByQuestion: Record<string, ResearcherPass[]>;   // one entry per begin, closed by done
// ResearcherPass = { loop, mission, searches: {query,hits,capped}[], reads: {stored,requested,hitCeiling}[], done?: {evidenceCount,searchCalls} }
```

## 4. Component disposition

Nothing is thrown away; the nine components are recomposed, most as drill-downs.

| Component | Becomes |
|-----------|---------|
| `ResearchProgress` | **Rewritten** as `QuestionBoard` — the swimlane grid + drill-down router. Top-level view. |
| `PipelineGraph` | **Shrunk** to a one-line `PipelineMinimap` in the header (keeps "you are here"). |
| `QuestionTracker` | **Absorbed** — its status/confidence logic becomes the row header cell. |
| `DebateArena` | **Deliberation drill-down** (unchanged props; opened from the debate cell). |
| `AgentSwimlane` | **Deliberation drill-down** companion (round-by-round, now fed by `roundsByQuestion`). |
| `EvidenceFeed` | **Recon/Loop drill-down**, scoped to one question (`evidenceByQuestion[qid]`). |
| `GateDecisionPanel` | **Gate drill-down**, scoped to one question's GateScore + reason. |
| `CostCounter` | **Header**, unchanged. |
| `ResearchReportView` | **Run-end view**, unchanged, plus a new mechanics-receipt block. |
| *(new)* `WindowShopStrip` | The Loop-cell mini-viz + researcher drill-down. |
| *(new)* `StanceDots` | The Openings-cell four-dot indicator. |
| *(new)* `RunMechanicsReceipt` | Run-end card from `computeRunMechanics` output (debated/skipped/productive, effort split). Needs mechanics on the wire — see §6 open item. |

## 5. Live vs replay

One data source, two clocks.

- **Live**: `useResearchStream` reduces SSE events as they arrive; the board renders current state.
  Active stage-cells pulse; the newest event drives a subtle highlight. This already works for
  everything except §3c's new events.
- **Replay**: the trace persisted by `TraceLogger` already contains every event
  (`trace.logEvent`). Add a **replay source** that reads a saved trace's event array and feeds the
  *same* `reduce` function through a play/pause/scrub controller at adjustable speed. Because the
  board is a pure function of reduced state, replay needs **zero board changes** — only a driver that
  substitutes a timed event iterator for the live `EventSource`. Build it as
  `useResearchReplay(events)` alongside `useResearchStream`, sharing `reduce`.

Non-goal for v1: editing/branching a replay. Scrub + play/pause only.

## 6. Phasing (each phase: `tsc` clean + `vitest` green + commit)

Tests-first, matching the debate-disagreement spec's discipline. Reducer logic is pure and
unit-testable without a browser — that's where the coverage goes; components get light smoke tests.

- **Phase 1 — Board shell + derived data (no new events).** Add §3a stance derivation + §3b
  reducer fields (`debateOutcome`, `debateRounds`) with reducer tests. Build `QuestionBoard`,
  `StanceDots`, row/cell scaffold, drill-down router reusing DebateArena/EvidenceFeed/GateDecisionPanel
  as-is. Ship the board reading only data that already streams (final claims → stance, skip/debate,
  gate, researcher strips). This alone replaces the dashboard and shows the four-decisions story.
- **Phase 2 — Openings + rounds events (§3c).** Add `debate:opening` / `debate:round`, emit from
  the debate node, reduce into `openingsByQuestion` / `roundsByQuestion`. Wire the Openings column to
  real blind openings and the deliberation drill-down to the round timeline. Reducer + emit tests.
- **Phase 3 — Window-shop mini-viz.** `WindowShopStrip` from `researcherByQuestion`; the loop-cell
  strip + researcher drill-down. Reducer test for pass accumulation (begin→search×n→read×n→done).
- **Phase 4 — Replay.** `useResearchReplay` + scrub controller over saved traces. Requires a trace
  retrieval path to the client (endpoint or bundled fixture) — decide source in the phase.
- **Phase 5 — Run-mechanics receipt.** `RunMechanicsReceipt` at run end. `computeRunMechanics`
  runs server-side after the stream; surface it via a terminal `research:mechanics` event (or fold
  into `recommend:done`). Small; do last.

## 7. Open items to resolve during build (not blockers)

- **Mechanics on the wire** — `computeRunMechanics` currently returns in `ArmResult`, not over SSE.
  Phase 5 adds a terminal event; confirm shape then.
- **Stance-fn location** — move to `src/lib/debate-stance.ts` only if a client-imports-orchestration
  lint rule fires; otherwise import in place. Trivial either way.
- **Replay trace source** — endpoint vs bundled fixture; Phase 4 decides.
- **Density at 4 questions × 5 stages** on narrow viewports — cells collapse to glyph-only under a
  breakpoint; drill-down carries the detail. A styling call, not structural.

## 8. Non-goals

- No change to orchestration logic, the debate, the gate, or retrieval — this is a **view** over the
  existing event stream (Phase 2's opening/round events are additive emissions of state that already
  exists, not new computation).
- No new LLM calls, no cost. Everything the board shows is already produced by a run.
- No replay editing/branching in v1.
