/**
 * intents.ts — turns a raw industry string into the search intents that drive exploration.
 *
 * FOR FUTURE AGENTS: This is pure and deterministic (unit-tested in test/intents.test.ts).
 * Each intent both (a) becomes a Firecrawl search query and (b) is stored as a tag on every
 * resulting source, so the "why did we find this" trail is preserved end-to-end.
 *
 * To change WHAT the scanner looks for, edit INTENT_TEMPLATES — that's the whole knob.
 */

/**
 * The ten angles we probe every industry from. Each entry has:
 *   - `label`: the short human-readable intent shown in the UI and stored on sources.
 *   - `query`: how it's phrased to the search engine ({industry} is interpolated).
 * Labels and queries are separate so the UI can read cleanly ("labor shortage") while
 * the query can be more search-optimized ("{industry} labor shortage staffing").
 */
export const INTENT_TEMPLATES: { label: string; query: string }[] = [
  { label: "software", query: "{industry} software platform tools" },
  { label: "jobs", query: "{industry} jobs hiring open positions" },
  { label: "labor shortage", query: "{industry} labor shortage staffing crisis" },
  { label: "complaints", query: "{industry} complaints problems frustrations" },
  { label: "forum", query: "{industry} forum reddit discussion community" },
  { label: "association", query: "{industry} association professional organization" },
  { label: "conference", query: "{industry} conference expo trade show 2025" },
  { label: "trends", query: "{industry} trends market report growth" },
  { label: "regulation", query: "{industry} regulation compliance requirements" },
  { label: "workflow", query: "{industry} workflow process manual steps" },
];

/** Normalize user input: trim, collapse whitespace. Empty-safe. */
export function normalizeIndustry(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** A concrete search intent: the label to display and the query to run. */
export interface Intent {
  label: string;
  query: string;
}

/**
 * Build the list of search intents for an industry.
 * @example buildIntents("insurance claims")[0]
 *   // => { label: "software", query: "insurance claims software platform tools" }
 */
export function buildIntents(rawIndustry: string): Intent[] {
  const industry = normalizeIndustry(rawIndustry);
  return INTENT_TEMPLATES.map((t) => ({
    label: t.label,
    query: t.query.replaceAll("{industry}", industry),
  }));
}
