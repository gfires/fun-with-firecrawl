"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ResearchEvent } from "./research-events";
import { reduce, initialResearchState, type ResearchUIState } from "./useResearchStream";

// Events carry no timestamps (the live wire protocol has none — see extract-replay-fixture.ts), so
// replay steps at a fixed, readable pace rather than reproducing real recorded timing. `speed` scales it.
const REPLAY_BASE_INTERVAL_MS = 150;

export interface ResearchReplay {
  state: ResearchUIState;
  index: number;
  total: number;
  playing: boolean;
  speed: number;
  play: () => void;
  pause: () => void;
  scrub: (index: number) => void;
  setSpeed: (speed: number) => void;
}

/**
 * Drives the SAME `reduce` the live stream uses over a pre-recorded event array, behind a
 * play/pause/scrub/speed controller (question-board-spec.md §5). The board needs zero changes —
 * it's a pure function of reduced state; this just substitutes a timed event iterator for the
 * live EventSource. Non-goal for v1: editing/branching a replay, only scrub + play/pause.
 */
export function useResearchReplay(events: ResearchEvent[]): ResearchReplay {
  const [index, setIndex] = useState(-1); // -1 = nothing applied yet
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  // A caller switching to a different recorded run passes a new `events` array (reference
  // identity, e.g. /replay's run picker) — reset playback rather than resuming mid-stream or
  // showing the new run as already finished. Callers passing a stable reference across renders
  // (unchanged run) are unaffected.
  useEffect(() => {
    setIndex(-1);
    setPlaying(false);
  }, [events]);

  const state = useMemo(
    () => events.slice(0, index + 1).reduce(reduce, initialResearchState),
    [events, index],
  );

  useEffect(() => {
    if (!playing || events.length === 0 || index >= events.length - 1) {
      if (playing && index >= events.length - 1) setPlaying(false);
      return;
    }
    const id = setInterval(() => {
      setIndex((i) => (i >= events.length - 1 ? i : i + 1));
    }, REPLAY_BASE_INTERVAL_MS / speed);
    return () => clearInterval(id);
  }, [playing, speed, events.length, index]);

  const play = useCallback(() => {
    if (events.length === 0) return;
    setPlaying(true);
  }, [events.length]);
  const pause = useCallback(() => setPlaying(false), []);
  const scrub = useCallback(
    (i: number) => setIndex(Math.max(-1, Math.min(events.length - 1, i))),
    [events.length],
  );

  return { state, index, total: events.length, playing, speed, play, pause, scrub, setSpeed };
}
