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
import type { ScanEvent, ScanPhase, TokenUsage } from "./events";
import { phaseFor } from "./events";
import type { ScanReport } from "./schema";
import { fmtMs } from "./format";

/** Live status of a single search intent, including the exact query sent to Firecrawl. */
export interface IntentStatus {
  label: string;
  query: string;
  status: "pending" | "searching" | "done";
  count: number;
  ms: number; // search latency for this intent (0 until done)
}

/** The exact prompt sent to the model, surfaced for full transparency. */
export interface PromptTrace {
  model: string;
  systemPrompt: string;
  userPrompt: string;
}

/**
 * Live status of a single source as it moves through scraping. `scrape` states:
 *   queued   — selected, not yet reached
 *   scraping — request in flight
 *   ok       — content retrieved
 *   blocked  — hard anti-scraping block (403/etc.); domain just added to the blocklist
 *   skipped  — not attempted; domain was already a known blocker
 *   empty    — transient failure (timeout/404/5xx); no content, not blocklisted
 * `ms` is that page's scrape latency (0 for skipped).
 */
export interface SourceStatus {
  id: number;
  url: string;
  domain: string;
  title: string;
  intent: string;
  blocked: boolean; // was on the blocklist at rank time
  scrape: "queued" | "scraping" | "ok" | "blocked" | "skipped" | "empty";
  chars: number;
  ms: number;
  /** Pre-scrape triage score (0–10) and rationale, if triage ran. */
  relevanceScore?: number;
  reason?: string;
}

/** Per-phase and end-to-end latencies (ms), filled in as the scan progresses. */
export interface Timing {
  adaptMs: number | null;
  searchMs: number | null;
  triageMs: number | null;
  scrapeMs: number | null;
  analyzeMs: number | null;
  totalMs: number | null;
}

/** Accumulated API usage across the scan — tokens by model + Firecrawl call count. */
export interface UsageSummary {
  /** Token counts grouped by model (e.g. { "gpt-4o-mini": { prompt: 1200, completion: 400 }, ... }). */
  tokensByModel: Record<string, { prompt: number; completion: number }>;
  /** Total Firecrawl API calls (searches + scrapes). */
  firecrawlCalls: number;
}

/** The full reduced state the UI renders from. */
export interface ScanState {
  phase: ScanPhase | "idle";
  industry: string;
  intents: IntentStatus[];
  /** Whether the intents were LLM-adapted to the industry (vs. static fallback). */
  intentsAdapted: boolean;
  sources: SourceStatus[];
  /** Count of deduped candidates triage scored (0 until triage runs). */
  candidateCount: number;
  /** Human-readable log lines, newest last — feeds the terminal-style activity feed. */
  trace: string[];
  /** The exact prompt sent to the model, once analysis begins. */
  prompt: PromptTrace | null;
  /** Phase + total latencies, for the "path taken" transparency. */
  timing: Timing;
  /** Accumulated API usage (tokens + Firecrawl calls). */
  usage: UsageSummary;
  report: ScanReport | null;
  error: string | null;
  running: boolean;
}

const initialState: ScanState = {
  phase: "idle",
  industry: "",
  intents: [],
  intentsAdapted: false,
  sources: [],
  candidateCount: 0,
  trace: [],
  prompt: null,
  timing: { adaptMs: null, searchMs: null, triageMs: null, scrapeMs: null, analyzeMs: null, totalMs: null },
  usage: { tokensByModel: {}, firecrawlCalls: 0 },
  report: null,
  error: null,
  running: false,
};

function addUsage(prev: UsageSummary, u?: TokenUsage): UsageSummary {
  if (!u) return prev;
  const byModel = { ...prev.tokensByModel };
  const existing = byModel[u.model] ?? { prompt: 0, completion: 0 };
  byModel[u.model] = { prompt: existing.prompt + u.promptTokens, completion: existing.completion + u.completionTokens };
  return { ...prev, tokensByModel: byModel, firecrawlCalls: prev.firecrawlCalls };
}

/** Pure reducer: fold one ScanEvent into the state. Exported for testing. */
export function reduce(state: ScanState, ev: ScanEvent): ScanState {
  const phase = phaseFor(ev.type);
  switch (ev.type) {
    case "start":
      return { ...state, phase, industry: ev.industry, trace: [`Initializing MRI scan for “${ev.industry}”…`] };

    case "adapt:begin":
      return { ...state, phase, trace: [...state.trace, `Designing search intents for this industry (${ev.model})…`] };

    case "intents":
      return {
        ...state,
        phase,
        intents: ev.intents.map((i) => ({ label: i.label, query: i.query, status: "pending", count: 0, ms: 0 })),
        intentsAdapted: ev.adapted,
        timing: { ...state.timing, adaptMs: ev.ms },
        usage: addUsage(state.usage, ev.usage),
        trace: [
          ...state.trace,
          ev.adapted
            ? `Designed ${ev.intents.length} industry-specific intents (${fmtMs(ev.ms)}).`
            : `Using ${ev.intents.length} standard intents (adaptation unavailable).`,
        ],
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
          i.label === ev.intent ? { ...i, status: "done", count: ev.count, ms: ev.ms } : i,
        ),
        trace: [...state.trace, `↳ “${ev.intent}” → ${ev.count} result${ev.count === 1 ? "" : "s"} (${fmtMs(ev.ms)})`],
      };

    case "triage:begin":
      return {
        ...state,
        phase,
        candidateCount: ev.candidates,
        trace: [
          ...state.trace,
          `Scoring ${ev.candidates} candidate sources for relevance (${ev.model})…`
            + (ev.blocked > 0 ? ` (${ev.blocked} known blocker${ev.blocked === 1 ? "" : "s"} pre-filtered)` : ""),
        ],
      };

    case "triage:done":
      return {
        ...state,
        phase,
        timing: { ...state.timing, triageMs: ev.ms },
        usage: addUsage(state.usage, ev.usage),
        trace: [
          ...state.trace,
          `Triaged ${ev.candidates} candidates → selected ${ev.selected} to scrape (${fmtMs(ev.ms)})`
            + (ev.blocked > 0 ? `, ${ev.blocked} blocked domain${ev.blocked === 1 ? "" : "s"} excluded.` : "."),
        ],
      };

    case "sources": {
      const blocked = ev.sources.filter((s) => s.blocked).length;
      return {
        ...state,
        phase,
        sources: ev.sources.map((s) => ({
          ...s,
          scrape: s.blocked ? "skipped" : "queued",
          chars: 0,
          ms: 0,
        })),
        timing: { ...state.timing, searchMs: ev.searchMs },
        trace: [
          ...state.trace,
          `Search phase ${fmtMs(ev.searchMs)}` +
            (blocked > 0 ? ` — skipping ${blocked} known blocker${blocked === 1 ? "" : "s"} up front.` : "."),
        ],
      };
    }

    case "scrape:begin":
      return {
        ...state,
        phase,
        sources: state.sources.map((s) => (s.id === ev.id ? { ...s, scrape: "scraping" } : s)),
      };

    case "scrape:done": {
      // Surface newly-discovered blockers in the activity feed — the "learn from failures" moment.
      const extraTrace =
        ev.status === "blocked"
          ? [...state.trace, `⛔ ${ev.domain} blocked scraping — added to blocklist for next time.`]
          : state.trace;
      return {
        ...state,
        phase,
        sources: state.sources.map((s) =>
          s.id === ev.id ? { ...s, scrape: ev.status, chars: ev.chars, ms: ev.ms } : s,
        ),
        trace: extraTrace,
      };
    }

    case "analyze:begin":
      return {
        ...state,
        phase,
        prompt: { model: ev.model, systemPrompt: ev.systemPrompt, userPrompt: ev.userPrompt },
        timing: { ...state.timing, scrapeMs: ev.scrapeMs },
        trace: [...state.trace, `Scraped corpus in ${fmtMs(ev.scrapeMs)}. Running inference on ${ev.model}…`],
      };

    case "report": {
      const updated = addUsage(state.usage, ev.usage);
      return {
        ...state,
        phase: "done",
        running: false,
        report: ev.report,
        timing: { ...state.timing, analyzeMs: ev.analyzeMs, totalMs: ev.totalMs },
        usage: { ...updated, firecrawlCalls: ev.firecrawlCalls },
        trace: [...state.trace, `Inference done in ${fmtMs(ev.analyzeMs)}. Scan complete in ${fmtMs(ev.totalMs)}.`],
      };
    }

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
