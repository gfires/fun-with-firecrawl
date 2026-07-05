/**
 * triage.ts — the intelligence layer between search and scrape.
 *
 * FOR FUTURE AGENTS: Today's pipeline searches the web and scrapes pages chosen by blind
 * round-robin rank. This module inserts LLM judgment so we (a) tailor the search intents to the
 * industry and (c) spend our scarce scrape budget on the genuinely useful hits. It owns three
 * pieces, with a clean labor split — **the LLM judges quality; the code owns coverage and the cut**:
 *
 *   makeIntents(industry)      — (a) LLM designs 10 industry-specific search intents, told the
 *                                 report's final sections. Fallback: the static templates.
 *   scoreCandidates(ind, cands)— (c) LLM scores each deduped search hit 0–10 (+ reason), shown the
 *                                 intents that surfaced it so it can reward centrality.
 *   selectSources(...)         — PURE, deterministic. Picks the final scrape set: a per-intent
 *                                 quota floor (each intent's top-N) then merit fill. Unit-tested.
 *
 * Both LLM steps NEVER throw — they fall back to today's behavior so reliability never regresses.
 * Uses gpt-4o-mini (cheap/fast); analysis stays on the main model.
 */
import { z } from "zod";
import { makeOpenAI, REPORT_SECTIONS } from "./analyze";
import { buildIntents, normalizeIndustry, type Intent } from "./intents";
import { clamp, domainOf } from "./format";
import type { Source } from "./schema";
import type { TokenUsage } from "./events";

/** The triage/adaptation model — cheap and fast. Overridable for testing the fallback path. */
export function triageModel(): string {
  return process.env.SCAN_TRIAGE_MODEL ?? "gpt-4o-mini";
}

/** A deduped search hit awaiting triage. `intents` = every intent whose search surfaced this URL. */
export interface Candidate {
  url: string;
  title: string;
  snippet: string;
  intents: string[];
}

/** A triage verdict for one candidate. */
export interface TriageScore {
  score: number; // 0–10
  reason: string;
}

// ---------------------------------------------------------------------------
// (a) Adaptive intents
// ---------------------------------------------------------------------------

const IntentsSchema = z.object({
  intents: z
    .array(z.object({ label: z.string().min(1), query: z.string().min(1) }))
    .min(1),
});

/**
 * Design ~10 industry-specific search intents. The LLM is told the report's final sections so the
 * intents aim at evidence the report actually needs. Always resolves to exactly `count` intents;
 * on ANY failure returns the static templates (buildIntents) so search never stalls.
 */
export async function makeIntents(
  rawIndustry: string,
  count = Number(process.env.SCAN_INTENTS ?? 10),
): Promise<{ intents: Intent[]; adapted: boolean; usage?: TokenUsage }> {
  const industry = normalizeIndustry(rawIndustry);
  const fallback = { intents: buildIntents(industry).slice(0, count), adapted: false };

  try {
    const client = makeOpenAI();
    const model = triageModel();
    const prompt = `You design web-search queries for an industry-diagnostics report on "${industry}".

The report will contain these sections:
${REPORT_SECTIONS.map((s) => `- ${s}`).join("\n")}

Design EXACTLY ${count} search intents that will surface the most useful public web evidence for
those sections — the pain, the software landscape, labor/staffing, complaints, community, budgets,
and where AI could help. Tailor them to what actually matters in THIS industry (use its real
jargon, named systems, regulations, roles). Each intent has:
  - "label": 1-3 word category shown in the UI (e.g. "labor shortage", "NIL rules")
  - "query": the literal search string to run

Return ONLY JSON: { "intents": [ { "label": "...", "query": "..." }, ... ] }`;

    const res = await client.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      temperature: 0.5,
      messages: [{ role: "user", content: prompt }],
    });

    const usage: TokenUsage | undefined = res.usage
      ? { model, promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens }
      : undefined;

    const parsed = IntentsSchema.safeParse(JSON.parse(res.choices[0]?.message?.content ?? "{}"));
    if (!parsed.success || parsed.data.intents.length === 0) return { ...fallback, usage };

    // Normalize to exactly `count`: truncate if over, pad from static templates if under.
    const llm = parsed.data.intents;
    const intents = llm.slice(0, count);
    if (intents.length < count) {
      for (const s of fallback.intents) {
        if (intents.length >= count) break;
        if (!intents.some((i) => i.label.toLowerCase() === s.label.toLowerCase())) intents.push(s);
      }
    }
    return { intents, adapted: true, usage };
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// (c) Pre-scrape triage scoring
// ---------------------------------------------------------------------------

const ScoresSchema = z.object({
  scores: z.array(z.object({ id: z.number().int(), score: z.number(), reason: z.string() })),
});

/** The score assigned when triage is unavailable — neutral, so selection degrades to coverage-only. */
export const UNSCORED: TriageScore = { score: 5, reason: "unscored (triage unavailable)" };

/**
 * Score each candidate 0–10 for how useful it will be as report evidence. ONE LLM call over all
 * candidates (so the model has context), but each is judged on its OWN merit. The candidate's
 * intent tags are shown so the model can reward pages that multiple angles surfaced (centrality).
 *
 * Returns a Map keyed by URL. NEVER throws: on any failure every candidate maps to UNSCORED, which
 * makes selectSources fall back to pure coverage (today's effective behavior).
 */
export async function scoreCandidates(
  rawIndustry: string,
  candidates: Candidate[],
): Promise<{ scores: Map<string, TriageScore>; usage?: TokenUsage }> {
  const industry = normalizeIndustry(rawIndustry);
  const out = new Map<string, TriageScore>();
  if (candidates.length === 0) return { scores: out };

  try {
    const client = makeOpenAI();
    const model = triageModel();
    const list = candidates
      .map((c, i) => {
        const tags = c.intents.length > 1 ? `intents: ${c.intents.join(", ")} (${c.intents.length}×)` : `intent: ${c.intents[0] ?? "?"}`;
        return `[${i}] ${c.title} — ${domainOf(c.url)} | ${tags}\n    ${c.snippet.slice(0, 240)}`;
      })
      .join("\n");

    const prompt = `You are triaging web search results before an expensive scrape, for an
industry-diagnostics report on "${industry}".

Score EACH result 0–10 for how useful its page will be as evidence:
- HIGH: primary sources, real forums/discussions, vendor & industry-association pages, job boards,
  market reports, government/regulatory pages, substantive articles.
- LOW: SEO spam, thin listicles ("top 10 best…"), generic definitions, unrelated topics, pure ads.
- A page surfaced by MULTIPLE intents (shown as "N×") is often more central — weigh that up.

Give a terse one-line reason for each. Return ONLY JSON:
{ "scores": [ { "id": <number>, "score": <0-10>, "reason": "..." }, ... ] } — one per result.

RESULTS:
${list}`;

    const res = await client.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    });

    const usage: TokenUsage | undefined = res.usage
      ? { model, promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens }
      : undefined;

    const parsed = ScoresSchema.safeParse(JSON.parse(res.choices[0]?.message?.content ?? "{}"));
    if (!parsed.success) return { scores: fillUnscored(candidates, out), usage };

    for (const s of parsed.data.scores) {
      const cand = candidates[s.id];
      if (cand) out.set(cand.url, { score: clamp(s.score, 0, 10), reason: s.reason || "" });
    }
    for (const c of candidates) if (!out.has(c.url)) out.set(c.url, UNSCORED);
    return { scores: out, usage };
  } catch {
    return { scores: fillUnscored(candidates, out) };
  }
}

function fillUnscored(candidates: Candidate[], out: Map<string, TriageScore>): Map<string, TriageScore> {
  for (const c of candidates) out.set(c.url, UNSCORED);
  return out;
}

// ---------------------------------------------------------------------------
// Selection — PURE, deterministic, the testable heart
// ---------------------------------------------------------------------------

/**
 * Choose the final scrape set from scored candidates. Deterministic and I/O-free.
 *
 * Algorithm (equal intents, equal floor):
 *   1. QUOTA FLOOR — for each intent, take its top-`quotaFloor` candidates by score (a candidate
 *      counts under every intent that surfaced it, but is selected at most once). This guarantees
 *      coverage: no single dominant intent can starve the others.
 *   2. MERIT FILL — fill the remaining slots (up to `maxScrape`) with the highest-scored
 *      candidates not already chosen, globally.
 *
 * Ties break by higher intent-count (centrality) then original order (stable). Returns Sources with
 * 1-based [N] ids, `relevanceScore`, `reason`, and a primary `intent` (its first tag).
 */
export function selectSources(
  candidates: Candidate[],
  scores: Map<string, TriageScore>,
  maxScrape: number,
  quotaFloor: number,
): Source[] {
  const scoreOf = (c: Candidate) => scores.get(c.url)?.score ?? UNSCORED.score;

  // Stable, merit-first ordering used both for the per-intent floor and the global fill.
  const ranked = (list: Candidate[]) =>
    [...list].sort((a, b) => {
      const ds = scoreOf(b) - scoreOf(a);
      if (ds !== 0) return ds;
      return b.intents.length - a.intents.length; // centrality tiebreak
    });

  const chosen: Candidate[] = [];
  const chosenUrls = new Set<string>();
  const take = (c: Candidate) => {
    if (chosenUrls.has(c.url) || chosen.length >= maxScrape) return;
    chosenUrls.add(c.url);
    chosen.push(c);
  };

  // 1) Quota floor — each intent's top-`quotaFloor`.
  const byIntent = new Map<string, Candidate[]>();
  for (const c of candidates) {
    for (const it of c.intents) {
      if (!byIntent.has(it)) byIntent.set(it, []);
      byIntent.get(it)!.push(c);
    }
  }
  for (const list of byIntent.values()) {
    for (const c of ranked(list).slice(0, quotaFloor)) take(c);
  }

  // 2) Merit fill — highest-scored remaining, globally.
  for (const c of ranked(candidates)) take(c);

  return chosen.map((c, idx) => {
    const verdict = scores.get(c.url);
    return {
      id: idx + 1,
      url: c.url,
      domain: domainOf(c.url),
      title: c.title,
      intent: c.intents[0] ?? "",
      relevanceScore: verdict?.score,
      reason: verdict?.reason,
    };
  });
}
