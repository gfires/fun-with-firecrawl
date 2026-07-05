/**
 * events.ts — the wire protocol for the live exploration stream.
 *
 * FOR FUTURE AGENTS: The scan route (app/api/scan/route.ts) emits a sequence of these
 * events as Server-Sent Events; the client (useScanStream) reduces them into UI state.
 * This is the ONE contract that couples server pipeline ↔ live visualization, so keep
 * the producer and the consumer in sync when editing it.
 *
 * Every event has a `type` discriminator. The client switches on it. The final
 * `report` event carries the fully-assembled ScanReport; `error` ends the stream sadly.
 */
import type { ScanReport } from "./schema";

/** Token usage from a single OpenAI call. */
export interface TokenUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/** Coarse pipeline stages, used to drive the progress header. */
export type ScanPhase = "adapt" | "intents" | "search" | "triage" | "scrape" | "analyze" | "done";

export type ScanEvent =
  /** Emitted once at the very start with the parsed industry. */
  | { type: "start"; industry: string }
  /** The adaptive-intents (a) LLM step has begun (before intents are known). */
  | { type: "adapt:begin"; model: string }
  /**
   * The search intents to run. `adapted` = true when an LLM tailored them to the industry, false
   * when we fell back to the static templates. Each carries the human label and the FULL query
   * string, so the UI shows exactly what's being searched. `ms` is the adapt-step latency.
   */
  | { type: "intents"; intents: { label: string; query: string }[]; adapted: boolean; ms: number; usage?: TokenUsage }
  /** A single intent's search has begun. */
  | { type: "search:begin"; intent: string }
  /** A single intent's search returned N results. `ms` is the search latency for that intent. */
  | { type: "search:done"; intent: string; count: number; ms: number }
  /** The pre-scrape triage (c) LLM step has begun, scoring `candidates` deduped hits. `blocked` = pre-filtered known blockers. */
  | { type: "triage:begin"; model: string; candidates: number; blocked: number }
  /** Triage finished: scored `candidates` hits, selected `selected` to scrape. `blocked` = pre-filtered. `ms` = latency. */
  | { type: "triage:done"; candidates: number; selected: number; blocked: number; adapted: boolean; ms: number; usage?: TokenUsage }
  /**
   * The triaged, selected set of sources chosen for scraping. Sent after triage so the UI can
   * render the source list (with relevance scores) before scraping ticks through it. Each source
   * carries `blocked` (true = known-blocker, will be SKIPPED) and its triage `relevanceScore` +
   * `reason` (absent if triage was unavailable). `searchMs` is the search-phase wall-clock.
   */
  | {
      type: "sources";
      searchMs: number;
      sources: {
        id: number;
        url: string;
        domain: string;
        title: string;
        intent: string;
        blocked: boolean;
        relevanceScore?: number;
        reason?: string;
      }[];
    }
  /** A page scrape has started (id maps to the `sources` list above). */
  | { type: "scrape:begin"; id: number; domain: string }
  /**
   * A page scrape resolved. `ms` is that page's scrape latency.
   *   status "ok"      — content retrieved.
   *   status "blocked" — hard-block (401/403/429/451); the domain was just added to the
   *                      running blocklist so future scans skip it proactively.
   *   status "skipped" — we did NOT attempt it because the domain was already blocklisted.
   *   status "empty"   — transient failure (timeout/404/5xx/network); not blocklisted.
   */
  | {
      type: "scrape:done";
      id: number;
      domain: string;
      status: "ok" | "blocked" | "skipped" | "empty";
      chars: number;
      ms: number;
    }
  /**
   * The LLM inference step has begun. Carries the EXACT prompt being sent (system + user)
   * and the model name, so the UI can show the full prompt — nothing hidden. `scrapeMs` is the
   * total wall-clock of the scrape phase.
   */
  | { type: "analyze:begin"; model: string; systemPrompt: string; userPrompt: string; scrapeMs: number }
  /** Terminal success: the complete report. `totalMs`/`analyzeMs` document end-to-end timing. */
  | { type: "report"; report: ScanReport; analyzeMs: number; totalMs: number; usage?: TokenUsage; firecrawlCalls: number }
  /** Terminal failure with a human-readable message. */
  | { type: "error"; message: string };

/** Narrow helper so `phaseFor(event)` stays exhaustive as events are added. */
export function phaseFor(type: ScanEvent["type"]): ScanPhase {
  switch (type) {
    case "start":
    case "adapt:begin":
      return "adapt";
    case "intents":
      return "intents";
    case "search:begin":
    case "search:done":
      return "search";
    case "triage:begin":
    case "triage:done":
    case "sources":
      return "triage";
    case "scrape:begin":
    case "scrape:done":
      return "scrape";
    case "analyze:begin":
      return "analyze";
    case "report":
    case "error":
      return "done";
  }
}
