/**
 * digest.ts — the per-question evidence digest (L2).
 *
 * Before the committee fans out, a single cheap Haiku pass compresses each retrieved
 * source into ONE short item keyed by that source's exact evidence id. The committee
 * then reasons over the compact digest instead of the full page content, which both
 * cuts committee input tokens dramatically AND structurally avoids the gpt-4o TPM crash:
 * the skeptic (OpenAI) no longer receives tens of thousands of characters of raw content.
 *
 * A digest failure must NEVER kill a run — `digestEvidence` swallows generation errors
 * and returns an empty digest, and the committee falls back to raw evidence downstream.
 */
import { generateText, Output } from "ai";
import { z } from "zod";
import { digestModel } from "../models/provider";
import type { Evidence } from "../schemas/evidence";
import type { Question } from "../schemas/state";
import { toAnnotatedUsage, type AnnotatedUsage } from "./eval";
import { getActiveTrace } from "./trace";
import { getActiveCostTracker } from "./cost-tracker";
import { MAX_DIGEST_SUMMARY_CHARS, LLM_MAX_RETRIES } from "../params";
// Prompt wording lives in src/lib/prompts.ts; this file keeps the source assembly + clamping logic.
import { NO_EVIDENCE_NOTICE, digestPrompt } from "../prompts";

/** One compressed source: the evidence id it summarizes and the summary text. */
export interface DigestItem {
  evidenceId: string;
  summary: string;
}

/** A question's digest — its items plus the digest call's usage (absent on failure). */
export interface QuestionDigest {
  questionId: string;
  items: DigestItem[];
  usage?: AnnotatedUsage;
}

// No .min()/.max() — providers strip them and they only cause client-side validation
// failures. Steer length with .describe(); truncate in code (clampDigest).
export const DigestOutputSchema = z.object({
  items: z.array(
    z.object({
      evidenceId: z.string().describe("the EXACT bracketed id of the source being summarized"),
      summary: z
        .string()
        .describe("<=400 chars: concrete facts, numbers, named entities, dates from this source"),
    }),
  ),
});

/**
 * Build the digest prompt: one item per source, keyed by its exact bracketed id, with
 * numbers/names/quotes preserved and off-topic sources flagged rather than padded.
 */
export function buildDigestPrompt(question: Question, evidence: Evidence[]): string {
  const sourcesBlock = evidence
    .map((e) => `[${e.id}] ${e.title} — ${e.url}\n${e.content}`)
    .join("\n\n---\n\n");
  return digestPrompt({ question, sourcesBlock });
}

/**
 * Sanitize a raw model digest against the real evidence ids: drop invented ids, dedupe
 * repeated ids (keep first), and truncate each summary to MAX_DIGEST_SUMMARY_CHARS.
 */
export function clampDigest(raw: DigestItem[], validIds: Set<string>): DigestItem[] {
  const seen = new Set<string>();
  const out: DigestItem[] = [];
  for (const item of raw) {
    // The model was shown ids as "[<id>]" and often echoes them WITH the brackets. Strip a
    // matched surrounding pair before matching, and emit the BARE id so downstream lookups
    // (formatDigestForCommittee, by e.id) hit. Real ids are hex hashes — never bracketed.
    const id = item.evidenceId.replace(/^\[(.*)\]$/, "$1");
    if (!validIds.has(id)) continue; // invented id — drop
    if (seen.has(id)) continue; // duplicate id — keep first only
    seen.add(id);
    out.push({ evidenceId: id, summary: item.summary.slice(0, MAX_DIGEST_SUMMARY_CHARS) });
  }
  return out;
}

/**
 * Render the committee's evidence block from a digest: a `[id] title (domain)` header per
 * source followed by its digest summary, falling back to the raw snippet for any source id
 * the digest didn't cover. Ids stay citable exactly as the committee expects.
 */
export function formatDigestForCommittee(evidence: Evidence[], items: DigestItem[]): string {
  if (evidence.length === 0) {
    return NO_EVIDENCE_NOTICE;
  }
  const summaryById = new Map(items.map((it) => [it.evidenceId, it.summary]));
  return evidence
    .map((e) => `[${e.id}] ${e.title} (${e.domain})\n  ${summaryById.get(e.id) ?? e.snippet}`)
    .join("\n\n");
}

/**
 * Digest one question's fresh evidence with a single Haiku call. Budget-gated via the
 * active cost tracker (a hit budget cap propagates — it must halt the run), traced, and
 * clamped against the real ids. ANY generation error is swallowed and an empty digest is
 * returned so the caller falls back to raw evidence — a digest failure never kills a run.
 */
export async function digestEvidence(
  question: Question,
  freshEvidence: Evidence[],
): Promise<QuestionDigest> {
  if (freshEvidence.length === 0) return { questionId: question.id, items: [] };

  // Budget gate OUTSIDE the try: a BudgetExceededError must propagate to halt the run,
  // not be swallowed into an empty-digest fallback.
  const costTracker = getActiveCostTracker();
  costTracker?.check();

  const prompt = buildDigestPrompt(question, freshEvidence);
  try {
    const { output: object, usage } = await generateText({
      model: digestModel,
      output: Output.object({ schema: DigestOutputSchema }),
      prompt,
      maxRetries: LLM_MAX_RETRIES,
    });

    const annotated = toAnnotatedUsage(usage, digestModel.modelId, `digest:${question.id}`);
    costTracker?.record(annotated);

    const trace = getActiveTrace();
    if (trace) {
      const loopIteration = freshEvidence.reduce((m, e) => Math.max(m, e.loopIteration), 0);
      trace.logLlmCall(`digest:${question.id}`, { model: digestModel.modelId, loopIteration, prompt }, object, usage);
    }

    const validIds = new Set(freshEvidence.map((e) => e.id));
    return { questionId: question.id, items: clampDigest(object.items, validIds), usage: annotated };
  } catch (err) {
    const trace = getActiveTrace();
    if (trace) {
      trace.log("digest_failed", {
        questionId: question.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return { questionId: question.id, items: [] };
  }
}
