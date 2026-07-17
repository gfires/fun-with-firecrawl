/**
 * schema.ts — the single source of truth for the shape of a scan.
 *
 * FOR FUTURE AGENTS: Everything downstream (the LLM's JSON output, the API stream,
 * and the React UI) is typed off the zod schemas defined here. If you need to add a
 * field to the report, add it here first — the type flows everywhere automatically.
 *
 * Two design rules encoded in these schemas:
 *   1. EVERY claim and score carries `sourceIds` — citations are structurally required,
 *      not optional, because "cite your sources" is a core product promise.
 *   2. Scores are constrained to their documented ranges (0–10 sub-scores, 0–100 overall)
 *      so a hallucinated out-of-range value is rejected at parse time.
 */
import { z } from "zod";

/** A web source discovered during exploration. `id` is the [N] citation number. */
export const SourceSchema = z.object({
  id: z.number().int().nonnegative(),
  url: z.string(),
  domain: z.string(),
  title: z.string(),
  /** Which search intent surfaced this source (e.g. "labor shortage"). */
  intent: z.string(),
  /**
   * Pre-scrape triage score (0–10) — how useful the LLM judged this hit before we spent a scrape.
   * Optional: absent when triage is unavailable, and the analysis LLM echoing sources back need
   * not supply it. See triage.ts.
   */
  relevanceScore: z.number().min(0).max(10).optional(),
  /** One-line triage rationale for why this source was (or wasn't) worth scraping. */
  reason: z.string().optional(),
});
export type Source = z.infer<typeof SourceSchema>;

/**
 * A single cited claim. `text` is the human-readable finding; `sourceIds` are the
 * [N] citation numbers backing it. We allow an empty array but the prompt strongly
 * pushes the model to always cite — see analyze.ts.
 */
export const EvidenceSchema = z.object({
  text: z.string(),
  sourceIds: z.array(z.number().int()).default([]),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** A 0–10 diagnostic sub-score with a brief rationale. */
export const ScoreSchema = z.object({
  value: z.number().min(0).max(10),
  /** Short qualitative label, e.g. "Severe", "Legacy-heavy". */
  label: z.string(),
  /** One-sentence explanation — the detailed evidence lives in the report body. */
  reason: z.string().default(""),
});
export type Score = z.infer<typeof ScoreSchema>;

/** The five diagnostic dimensions. Keys are stable — the UI renders them in order. */
export const ScoresSchema = z.object({
  pain: ScoreSchema,
  softwareMaturity: ScoreSchema,
  founderAccessibility: ScoreSchema,
  aiSuitability: ScoreSchema,
  budgetSignal: ScoreSchema,
});
export type Scores = z.infer<typeof ScoresSchema>;

/** A named software vendor detected in the ecosystem — strengths, weaknesses, and pricing. */
export const VendorSchema = z.object({
  name: z.string(),
  note: z.string(),
  sourceIds: z.array(z.number().int()).default([]),
});

/**
 * The complete scan report. This is what the LLM must return (minus `sources` and
 * `generatedAt`, which the server owns) and what the UI renders.
 */
export const ScanReportSchema = z.object({
  industry: z.string(),
  generatedAt: z.string(),
  scores: ScoresSchema,
  /** Composite 0–100. Recomputed server-side from sub-scores for explainability. */
  opportunityScore: z.number().min(0).max(100),
  snapshot: z.string(),
  softwareEcosystem: z.object({
    summary: z.string(),
    vendors: z.array(VendorSchema).default([]),
  }),
  bottlenecks: z.array(EvidenceSchema).default([]),
  underservedNiches: z.array(EvidenceSchema).default([]),
  /** Two dense, evidence-packed paragraphs (product + timing/moat) laying out the actionable opportunity thesis. */
  opportunityThesis: z.string(),
  adjacentMarkets: z.array(EvidenceSchema).default([]),
  /** Clear, unambiguous next steps a founder should take. */
  nextSteps: z.array(EvidenceSchema).default([]),
  sources: z.array(SourceSchema).default([]),
});
export type ScanReport = z.infer<typeof ScanReportSchema>;

/**
 * The subset of the report the LLM is responsible for producing. The server fills in
 * `sources`, `generatedAt`, and re-derives `opportunityScore`. Keeping this separate
 * keeps the model's job (and its JSON) as small as possible.
 */
export const LlmReportSchema = ScanReportSchema.omit({
  sources: true,
  generatedAt: true,
  opportunityScore: true,
});
export type LlmReport = z.infer<typeof LlmReportSchema>;
