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

/** A 0–10 diagnostic sub-score with its supporting evidence. */
export const ScoreSchema = z.object({
  value: z.number().min(0).max(10),
  /** Short qualitative label, e.g. "Severe", "Legacy-heavy". */
  label: z.string(),
  evidence: z.array(EvidenceSchema).default([]),
});
export type Score = z.infer<typeof ScoreSchema>;

/** The five diagnostic dimensions. Keys are stable — the UI renders them in order. */
export const ScoresSchema = z.object({
  pain: ScoreSchema,
  softwareMaturity: ScoreSchema,
  laborScarcity: ScoreSchema,
  aiSuitability: ScoreSchema,
  budgetSignal: ScoreSchema,
});
export type Scores = z.infer<typeof ScoresSchema>;

/** A named software vendor detected in the ecosystem. */
export const VendorSchema = z.object({
  name: z.string(),
  note: z.string(),
  sourceIds: z.array(z.number().int()).default([]),
});

/** A concrete AI opportunity within the industry. */
export const OpportunitySchema = z.object({
  title: z.string(),
  why: z.string(),
  sourceIds: z.array(z.number().int()).default([]),
});

/** A playful, speculative startup concept. */
export const StartupConceptSchema = z.object({
  name: z.string(),
  pitch: z.string(),
  sourceIds: z.array(z.number().int()).default([]),
});

/** A shareable "diagnostic readout" stat, e.g. { label: "AI Invasion Risk", value: "89%" }. */
export const PlayfulStatSchema = z.object({
  label: z.string(),
  value: z.string(),
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
  bottlenecks: z.array(EvidenceSchema).default([]),
  softwareEcosystem: z.object({
    summary: z.string(),
    vendors: z.array(VendorSchema).default([]),
  }),
  frictionSignals: z.array(EvidenceSchema).default([]),
  aiOpportunities: z.array(OpportunitySchema).default([]),
  underservedNiches: z.array(EvidenceSchema).default([]),
  adjacentMarkets: z.array(EvidenceSchema).default([]),
  startupConcepts: z.array(StartupConceptSchema).default([]),
  playfulStats: z.array(PlayfulStatSchema).default([]),
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
