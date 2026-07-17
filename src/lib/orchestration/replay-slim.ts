/**
 * replay-slim.ts — shared evidence-trimming helper for persisted/replayed ResearchEvent streams.
 *
 * Both `scripts/extract-replay-fixture.ts` (committed test fixture) and the live run-persistence
 * write path (`src/lib/runs.ts` via `graph-stream.ts`) need the same trim: scraped page `content`
 * bloats a stored event stream without adding replay signal (the board renders snippet/title, not
 * the full scrape), so `retrieve:evidence` events get their evidence content capped. Every other
 * event type passes through unchanged.
 */
import type { ResearchEvent } from "../research-events";

export const EVIDENCE_CONTENT_CAP = 800; // chars kept per source (snippet/title stay whole)

export function slimReplayEvent(event: ResearchEvent): ResearchEvent {
  if (event.type === "retrieve:evidence") {
    return { ...event, evidence: { ...event.evidence, content: event.evidence.content.slice(0, EVIDENCE_CONTENT_CAP) } };
  }
  return event;
}
