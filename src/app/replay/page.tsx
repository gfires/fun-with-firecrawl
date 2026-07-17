"use client";

import { useEffect, useState, useCallback } from "react";
import type { ResearchEvent } from "@/lib/research-events";
import type { RunSummary } from "@/lib/runs";
import { useResearchReplay } from "@/lib/useResearchReplay";
import { QuestionBoard } from "@/components/research/QuestionBoard";

const SPEEDS = [0.5, 1, 2, 4, 8];
const DEMO_RUN_ID = "fixture";
// Stable reference for the "no run loaded yet" case — `events ?? []` would allocate a fresh
// array every render and defeat useResearchReplay's events-identity-based playback reset.
const EMPTY_EVENTS: ResearchEvent[] = [];

function relativeTime(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatCost(cost: number | null): string {
  return cost === null ? "—" : `$${cost.toFixed(3)}`;
}

export default function ReplayPage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>(DEMO_RUN_ID);
  const [events, setEvents] = useState<ResearchEvent[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/research/runs")
      .then((res) => res.json())
      .then((data: { runs: RunSummary[] }) => setRuns(data.runs ?? []))
      .catch(() => setRuns([]));
  }, []);

  const loadRun = useCallback((id: string) => {
    setEvents(null);
    setLoadError(null);
    const qs = id === DEMO_RUN_ID ? "" : `?id=${encodeURIComponent(id)}`;
    fetch(`/api/research/replay${qs}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "failed to load run" }));
          throw new Error(body.error ?? "failed to load run");
        }
        return res.json();
      })
      .then(setEvents)
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : String(err));
        setEvents([]);
      });
  }, []);

  useEffect(() => {
    loadRun(selectedId);
  }, [selectedId, loadRun]);

  const replay = useResearchReplay(events ?? EMPTY_EVENTS);

  // A single fixed-height row regardless of how many runs exist — horizontally scrollable, never
  // wrapping to more lines. Without this, a long saved-run list ate the vertical space the board's
  // swimlane region needs to actually scroll (topBar grows -> swimlane's flex-1 remainder shrinks).
  const picker = (
    <div className="flex shrink-0 items-center gap-2 font-mono text-xs">
      <span className="eyebrow shrink-0">past runs</span>
      <div className="flex flex-1 gap-2 overflow-x-auto pb-1">
        <button
          onClick={() => setSelectedId(DEMO_RUN_ID)}
          className={`shrink-0 rounded border px-3 py-1 transition ${
            selectedId === DEMO_RUN_ID
              ? "border-accent text-accent"
              : "border-line text-fg hover:border-accent hover:text-accent"
          }`}
        >
          Demo run
        </button>
        {runs.map((run) => (
          <button
            key={run.id}
            onClick={() => setSelectedId(run.id)}
            className={`flex shrink-0 items-center gap-2 rounded border px-3 py-1 transition ${
              selectedId === run.id
                ? "border-accent text-accent"
                : "border-line text-fg hover:border-accent hover:text-accent"
            }`}
            title={run.topic}
          >
            <span className="max-w-[16ch] truncate">{run.topic}</span>
            <span className="text-mute">{relativeTime(run.startedAt)}</span>
            <span className="text-mute">{formatCost(run.totalCostUsd)}</span>
            {run.status === "errored" && <span className="rounded bg-danger/20 px-1 text-danger">errored</span>}
          </button>
        ))}
      </div>
    </div>
  );

  const playbackControls = (
    <div className="flex items-center gap-2 font-mono text-xs text-mute">
      <button
        onClick={replay.playing ? replay.pause : replay.play}
        className="rounded border border-line px-3 py-1 text-fg transition hover:border-accent hover:text-accent"
      >
        {replay.playing ? "pause" : "play"}
      </button>
      <input
        type="range"
        min={-1}
        max={Math.max(0, replay.total - 1)}
        value={replay.index}
        onChange={(e) => replay.scrub(Number(e.target.value))}
        className="w-32"
      />
      <span className="nums">
        {replay.index + 1}/{replay.total}
      </span>
      <select
        value={replay.speed}
        onChange={(e) => replay.setSpeed(Number(e.target.value))}
        className="rounded border border-line bg-panel px-2 py-1"
      >
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}x
          </option>
        ))}
      </select>
    </div>
  );

  if (!events) {
    return (
      <main className="flex min-h-screen flex-col gap-6 px-4 py-10 text-center sm:py-16">
        {picker}
        <p className="text-mute">loading replay…</p>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="flex min-h-screen flex-col gap-6 px-4 py-10 sm:py-16">
        {picker}
        <p className="text-center text-sm text-danger">{loadError}</p>
      </main>
    );
  }

  return (
    <QuestionBoard
      state={replay.state}
      done={!replay.state.running}
      topBar={picker}
      headerExtra={playbackControls}
      live={false}
    />
  );
}
