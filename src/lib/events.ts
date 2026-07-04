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

/** Coarse pipeline stages, used to drive the progress header. */
export type ScanPhase = "intents" | "search" | "scrape" | "analyze" | "done";

export type ScanEvent =
  /** Emitted once at the very start with the parsed industry. */
  | { type: "start"; industry: string }
  /**
   * The generated search intents, emitted before any network calls. Each carries both the
   * human label and the FULL search query string that will be sent to Firecrawl, so the UI
   * can show exactly what's being searched — not just the category.
   */
  | { type: "intents"; intents: { label: string; query: string }[] }
  /** A single intent's search has begun. */
  | { type: "search:begin"; intent: string }
  /** A single intent's search returned N results. */
  | { type: "search:done"; intent: string; count: number }
  /**
   * The deduped, ranked set of sources chosen for scraping. Sent after all searches
   * finish so the UI can render the full source list before scraping ticks through it.
   */
  | { type: "sources"; sources: { id: number; url: string; domain: string; title: string; intent: string }[] }
  /** A page scrape has started (id maps to the `sources` list above). */
  | { type: "scrape:begin"; id: number; domain: string }
  /** A page scrape finished. `ok` false means it timed out / errored (soft failure). */
  | { type: "scrape:done"; id: number; domain: string; ok: boolean; chars: number }
  /**
   * The LLM inference step has begun. Carries the EXACT prompt being sent (system + user)
   * and the model name, so the UI can show the full prompt — nothing hidden.
   */
  | { type: "analyze:begin"; model: string; systemPrompt: string; userPrompt: string }
  /** Terminal success: the complete report. */
  | { type: "report"; report: ScanReport }
  /** Terminal failure with a human-readable message. */
  | { type: "error"; message: string };

/** Narrow helper so `phaseFor(event)` stays exhaustive as events are added. */
export function phaseFor(type: ScanEvent["type"]): ScanPhase {
  switch (type) {
    case "start":
    case "intents":
      return "intents";
    case "search:begin":
    case "search:done":
    case "sources":
      return "search";
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
