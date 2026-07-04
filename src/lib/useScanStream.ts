/**
 * useScanStream.ts — client hook that runs a scan and reduces the SSE stream into UI state.
 *
 * FOR FUTURE AGENTS: This is the client counterpart to app/api/scan/route.ts. It POSTs the
 * industry, reads the `data: {json}` SSE frames off the response body, and folds each ScanEvent
 * into a `ScanState`. The live exploration UI (ScanProgress) renders straight off this state:
 * intents, per-intent search status, the streaming source list, and per-source scrape status.
 *
 * Everything the "watch it explore" experience needs is in `state.trace`.
 */
"use client";

import { useCallback, useRef, useState } from "react";
import type { ScanEvent, ScanPhase } from "./events";
import { phaseFor } from "./events";
import type { ScanReport } from "./schema";

/** Live status of a single search intent, including the exact query sent to Firecrawl. */
export interface IntentStatus {
  label: string;
  query: string;
  status: "pending" | "searching" | "done";
  count: number;
}

/** The exact prompt sent to the model, surfaced for full transparency. */
export interface PromptTrace {
  model: string;
  systemPrompt: string;
  userPrompt: string;
}

/** Live status of a single source as it moves through scraping. */
export interface SourceStatus {
  id: number;
  url: string;
  domain: string;
  title: string;
  intent: string;
  scrape: "queued" | "scraping" | "ok" | "failed";
  chars: number;
}

/** The full reduced state the UI renders from. */
export interface ScanState {
  phase: ScanPhase | "idle";
  industry: string;
  intents: IntentStatus[];
  sources: SourceStatus[];
  /** Human-readable log lines, newest last — feeds the terminal-style activity feed. */
  trace: string[];
  /** The exact prompt sent to the model, once analysis begins. */
  prompt: PromptTrace | null;
  report: ScanReport | null;
  error: string | null;
  running: boolean;
}

const initialState: ScanState = {
  phase: "idle",
  industry: "",
  intents: [],
  sources: [],
  trace: [],
  prompt: null,
  report: null,
  error: null,
  running: false,
};

/** Pure reducer: fold one ScanEvent into the state. Exported for testing. */
export function reduce(state: ScanState, ev: ScanEvent): ScanState {
  const phase = phaseFor(ev.type);
  switch (ev.type) {
    case "start":
      return { ...state, phase, industry: ev.industry, trace: [`Initializing MRI scan for “${ev.industry}”…`] };

    case "intents":
      return {
        ...state,
        phase,
        intents: ev.intents.map((i) => ({ label: i.label, query: i.query, status: "pending", count: 0 })),
        trace: [...state.trace, `Generated ${ev.intents.length} search intents.`],
      };

    case "search:begin":
      return {
        ...state,
        phase,
        intents: state.intents.map((i) => (i.label === ev.intent ? { ...i, status: "searching" } : i)),
      };

    case "search:done":
      return {
        ...state,
        phase,
        intents: state.intents.map((i) =>
          i.label === ev.intent ? { ...i, status: "done", count: ev.count } : i,
        ),
        trace: [...state.trace, `↳ “${ev.intent}” → ${ev.count} result${ev.count === 1 ? "" : "s"}`],
      };

    case "sources":
      return {
        ...state,
        phase,
        sources: ev.sources.map((s) => ({ ...s, scrape: "queued", chars: 0 })),
        trace: [...state.trace, `Selected ${ev.sources.length} sources to scan.`],
      };

    case "scrape:begin":
      return {
        ...state,
        phase,
        sources: state.sources.map((s) => (s.id === ev.id ? { ...s, scrape: "scraping" } : s)),
      };

    case "scrape:done":
      return {
        ...state,
        phase,
        sources: state.sources.map((s) =>
          s.id === ev.id ? { ...s, scrape: ev.ok ? "ok" : "failed", chars: ev.chars } : s,
        ),
      };

    case "analyze:begin":
      return {
        ...state,
        phase,
        prompt: { model: ev.model, systemPrompt: ev.systemPrompt, userPrompt: ev.userPrompt },
        trace: [...state.trace, `Corpus assembled. Running inference on ${ev.model}…`],
      };

    case "report":
      return { ...state, phase: "done", running: false, report: ev.report, trace: [...state.trace, "Scan complete."] };

    case "error":
      return { ...state, phase: "done", running: false, error: ev.message };
  }
}

/**
 * Hook API: `{ state, start, reset }`. `start(industry)` kicks off the scan and streams updates.
 */
export function useScanStream() {
  const [state, setState] = useState<ScanState>(initialState);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async (industry: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ ...initialState, running: true, phase: "intents", industry });

    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ industry }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Scan request failed (${res.status}).`);

      // Parse the SSE stream frame by frame. Frames are separated by a blank line.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const json = line.slice(5).trim();
          if (!json) continue;
          const ev = JSON.parse(json) as ScanEvent;
          setState((prev) => reduce(prev, ev));
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) return; // user reset — ignore
      const message = err instanceof Error ? err.message : "Scan failed.";
      setState((prev) => ({ ...prev, running: false, phase: "done", error: message }));
    }
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState(initialState);
  }, []);

  return { state, start, reset };
}
