# Workspace brief — The Question Board

You're implementing **`docs/question-board-spec.md`**: replacing the node-centric research dashboard
with a question-centric swimlane board, live + replayable. Read the spec first; it's the contract and
names every file, event, and reducer field. This brief covers only what a fresh workspace needs to
get moving: the base branch, secrets, and the trace/fixture the replay work depends on.

## Base branch

Base this workspace off **`implement-debate-disagreement-spec`** (must be pushed first — a Conductor
workspace is cut from `origin/<base>`, so unpushed commits won't be present). All the SSE plumbing the
board consumes already landed on that branch:
- `researcher:begin|search|read|done` events (per-question window-shopping progress).
- `runGraphStreaming` now defaults to the **agentic** arm and threads `retrievalMode`, so those
  researcher events actually fire live (before this, the web/streaming path was hardwired to coded and
  the events were unreachable). The `/api/research/orchestrated` route accepts an optional `mode`.

## Secrets: `.env.local`

`.env.local` is gitignored, so it does NOT travel to a fresh workspace. `.env.local.example` (tracked)
lists the keys. Two ways to get real values:

```bash
# Copy from the primary workspace (same machine):
cp /Users/gpfirestone/conductor/workspaces/blindspot/sucre/.env.local .env.local
```

**You do NOT need secrets for Phases 1–3.** Those are pure reducer + component work; `vitest` mocks the
network and `tsc`/`vitest` are the only gates. Secrets are needed only to (a) generate a fresh trace
for replay, or (b) run the app in the browser against a live search. If you build against the committed
replay fixture (below), you can develop and visually verify the whole board with **zero secrets** — the
fixture drives the same reducer the live stream does.

## The trace + the replay fixture

Replay (spec §5, Phase 4) feeds the reducer a saved `ResearchEvent[]`. Only the **streaming** path logs
those (as `sse:*` trace entries); the batch `run-arm` (plain `runGraph`) does not. Tooling is committed:

```bash
# 1. Generate a streaming, agentic, sse-bearing trace (needs .env.local; ~$0.70/run):
npx tsx scripts/run-arm.ts agentic "freight brokerage" --stream
#    → writes trace-output/<slug>-<ts>.trace.json  (contains sse:* + researcher:* events)

# 2. Extract the slim, validated fixture (no secrets; round-trips through the real reducer):
npx tsx scripts/extract-replay-fixture.ts
#    → writes test/fixtures/replay-events.json  (commit this)
```

`extract-replay-fixture.ts` refuses to write a stream that doesn't reduce to a finished run, trims
evidence content to keep the file small, and warns if the trace lacks `researcher:*` events (i.e. came
from the coded arm — regenerate with `agentic`). Commit `test/fixtures/replay-events.json` so the fixture
travels via git and Phases 1–4 need no live run.

> The existing `trace-output/*.trace.json` in the primary workspace is from a NON-streaming run — it has
> no `sse:*` events and can't be replayed directly. Generate a fresh one with `--stream`.

## Per-phase needs

| Phase | Needs secrets? | Needs a trace/fixture? |
|-------|:--:|:--:|
| 1 — board shell + derived data (no new events) | no | no |
| 2 — `debate:opening` / `debate:round` events | no (vitest) | no |
| 3 — window-shop mini-viz | no (vitest) | no |
| 4 — replay | no, if the fixture is committed | **yes** — `test/fixtures/replay-events.json` |
| 5 — mechanics receipt | no | no |

Only Phase 4 hard-depends on the fixture, and only fixture *generation* (once) needs secrets. Bake the
fixture up front (steps above) and the rest is hermetic.

## Working agreement

- **Tests-first**, matching the debate-disagreement spec. Reducer logic is pure — that's where coverage
  goes (event → state assertions); components get light smoke tests.
- **Gate every phase**: `npx tsc --noEmit` clean + `npx vitest run` green + one commit per phase.
- Don't touch orchestration/debate/gate/retrieval logic. The board is a **view**; Phase 2's new events
  emit state that already exists (walk `debateTranscripts`), they don't compute anything new.
- Design principles still bind: enforce in code not prompts, no `.min()/.max()` on LLM schemas, all
  prompt wording in `src/lib/prompts.ts`. The board adds none of these surfaces, but the repo rules hold.

## Fast facts the spec relies on

- `committeeStance` / `hasGenuineDisagreement` / `decisiveStances` in `src/lib/orchestration/debate.ts`
  import only from `schemas/claim` → **client-safe**; reuse directly for stance dots (spec §3a).
- Skip-vs-debate is derivable: `debate:begin.questionIds` IS `questionsNeedingDebate`; an unresolved
  question absent from it was skipped on agreement (spec §3b).
- Every streamed `Claim` already carries `stance` and `debateRound`; only FINAL claims stream today —
  blind openings + intermediate rounds are the one genuine data gap, closed in Phase 2 (spec §3c).
