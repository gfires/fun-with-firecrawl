/**
 * analyze.ts — the inference layer: turn the scraped corpus into a scored, cited ScanReport.
 *
 * FOR FUTURE AGENTS: The prompt lives here IN FULL and readable (transparency is a product
 * requirement — see README "Prompt transparency"). `buildPrompt()` is pure and unit-testable;
 * `callLLM()` is the thin network wrapper. The model returns JSON validated against
 * LlmReportSchema; on validation failure we do ONE repair retry, then a graceful fallback.
 *
 * The five diagnostic dimensions and their definitions are defined once (SCORE_DEFINITIONS)
 * and shown to BOTH the model and (optionally) the user, so scoring is never a black box.
 */
import OpenAI from "openai";
import { LlmReportSchema, type LlmReport, type ScanReport, type Source } from "./schema";
import type { ScrapedSource } from "./firecrawl";
import type { TokenUsage } from "./events";
import { opportunityScore, derivePlayfulStats } from "./scoring";
import { titleCase } from "./format";

/** Human + model-facing definitions of each 0–10 dimension. Keep in sync with schema.Scores. */
export const SCORE_DEFINITIONS: { key: string; name: string; definition: string }[] = [
  { key: "pain", name: "Pain Score", definition: "How much frustration, friction, and unmet need shows up (complaints, manual work, workarounds). 10 = severe, chronic pain." },
  { key: "softwareMaturity", name: "Software Maturity", definition: "How modern/complete the existing software ecosystem is. 10 = mature SaaS everywhere; 0 = spreadsheets, paper, legacy tools." },
  { key: "laborScarcity", name: "Labor Scarcity", definition: "How hard it is to staff the work (open roles, shortages, turnover). 10 = acute shortage." },
  { key: "aiSuitability", name: "AI Suitability", definition: "How well current manual work maps to what AI can automate today. 10 = highly automatable." },
  { key: "budgetSignal", name: "Budget Signal", definition: "Evidence that buyers have money and will pay for software (deal sizes, funded vendors, conferences, associations). 10 = strong budgets." },
];

function config() {
  return { model: process.env.OPENAI_MODEL ?? "gpt-4o" };
}

/** The model name in use — exported so the route can surface it to the UI. */
export function currentModel(): string {
  return config().model;
}

/** Construct the OpenAI client. Throws a clear error if the key is missing. */
export function makeOpenAI(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set. Copy .env.local.example to .env.local.");
  return new OpenAI({ apiKey });
}

/** Render the numbered source corpus that the model cites by [id]. Pure. */
export function renderCorpus(sources: ScrapedSource[]): string {
  return sources
    .map((s) => {
      const body = s.content?.trim() ? s.content.trim() : "(no page content — cite from title/domain only)";
      return `[${s.id}] ${s.title} — ${s.domain} (found via "${s.intent}")\n${body}`;
    })
    .join("\n\n---\n\n");
}

/**
 * The 8 report sections, in order — the scan's final "destination". Shared so the adaptive-intents
 * step (triage.ts) can tell the LLM what evidence the report ultimately needs, keeping the search
 * intents aligned with what we render. Keep in sync with the section order in ReportView.
 */
export const REPORT_SECTIONS: string[] = [
  "Industry Snapshot",
  "Detected Bottlenecks",
  "Current Software Ecosystem",
  "Signals of Friction",
  "Potential AI Opportunities",
  "Underserved Niches",
  "Adjacent Markets",
  "Example Startup Concepts",
];

/** The system prompt: role + hard rules. Kept transparent and short. */
export const SYSTEM_PROMPT = `You are Opportunity MRI, a playful but sharp industry-diagnostics engine. \
You read raw web sources about an industry and infer where the structural inefficiencies, labor \
shortages, software gaps, and AI-native business opportunities are.

Hard rules:
- Ground EVERY score and EVERY claim in the provided sources. Cite them by their [id] number via \
the sourceIds arrays. Do not invent facts that no source supports.
- USE DIRECT QUOTES. Pull exact phrases, sentences, or fragments from the source text and embed \
them in your claims using quotation marks. Example: Multiple coordinators describe the process as \
"manual and unbelievably tedious" [3] while vendors admit "we still fax 40% of orders" [7]. The \
reader should feel like they're hearing real voices, not reading a summary.
- Every evidence item should be a SPECIFIC THESIS backed by concrete details — names, numbers, \
quotes, patterns — not a generic observation. BAD: "Many companies use outdated software." \
GOOD: "Three of the top five vendors (Procore, Viewpoint, Sage 300) were founded pre-2005 and \
users on Reddit call them 'the necessary evil' [4] — 'if it crashes one more time I'm going back \
to spreadsheets' [9]."
- Scores are heuristic and 0–10 (except opportunityScore which you do NOT output — the app computes it).
- Keep the tone confident and a little fun, like a Bloomberg terminal with a sense of humor.
- Return ONLY valid JSON matching the requested schema. No prose outside the JSON.`;

/**
 * Build the full user prompt. Pure and deterministic given (industry, sources) — this is the
 * function unit tests and future agents should read to understand exactly what the model sees.
 */
export function buildPrompt(industry: string, sources: ScrapedSource[]): string {
  const defs = SCORE_DEFINITIONS.map((d) => `- ${d.key} (${d.name}): ${d.definition}`).join("\n");

  return `INDUSTRY: ${industry}

SCORE DEFINITIONS (each 0–10, with evidence citing [id]s):
${defs}

Produce a JSON object with EXACTLY these fields:
{
  "industry": string,
  "scores": {
    "pain": { "value": 0-10, "label": short word, "evidence": [{ "text": string, "sourceIds": [int] }] },
    "softwareMaturity": {...}, "laborScarcity": {...}, "aiSuitability": {...}, "budgetSignal": {...}
  },
  "snapshot": string,                 // 2-3 sentence "Industry Snapshot"
  "bottlenecks": [{ "text", "sourceIds" }],        // Detected Bottlenecks
  "softwareEcosystem": { "summary": string, "vendors": [{ "name", "note", "sourceIds" }] },
  "frictionSignals": [{ "text", "sourceIds" }],    // Signals of Friction (Excel, manual review, etc.)
  "aiOpportunities": [{ "title", "why", "sourceIds" }],
  "underservedNiches": [{ "text", "sourceIds" }],
  "adjacentMarkets": [{ "text", "sourceIds" }],
  "startupConcepts": [{ "name", "pitch", "sourceIds" }],   // 3-5 playful, concrete AI-native startup ideas
  "playfulStats": [{ "label", "value" }]           // e.g. { "label": "Excel Dependency", "value": "Severe" }
}

CRITICAL — every "text", "why", "note", and "evidence" string MUST include direct quotes pulled \
verbatim from the sources in quotation marks, with the source [id] immediately after. Build each \
item as a specific thesis supported by concrete details (names, numbers, exact phrases from real \
people/companies), NOT a generic summary. The reader should encounter real voices and hard data, \
not paraphrased abstractions.

Aim for 3-6 items in each list. Every item's sourceIds MUST reference the sources below.

SOURCES:
${renderCorpus(sources)}`;
}

/** Attempt to parse a model text response into validated LlmReport. Returns null on failure. */
function tryParse(raw: string): LlmReport | null {
  try {
    // Models occasionally wrap JSON in prose or fences despite instructions — extract the object.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    const json = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
    const parsed = LlmReportSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Call the LLM and return a validated LlmReport. One repair retry on invalid output; throws
 * only if both attempts fail (the route catches and turns this into an `error` event).
 */
export async function callLLM(industry: string, sources: ScrapedSource[]): Promise<{ report: LlmReport; usage?: TokenUsage }> {
  const client = makeOpenAI();
  const { model } = config();
  const prompt = buildPrompt(industry, sources);

  let promptTokens = 0;
  let completionTokens = 0;

  const complete = (extra?: string) =>
    client.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      temperature: 0.6,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: extra ? `${prompt}\n\n${extra}` : prompt },
      ],
    });

  const first = await complete();
  if (first.usage) {
    promptTokens += first.usage.prompt_tokens;
    completionTokens += first.usage.completion_tokens;
  }
  const firstReport = tryParse(first.choices[0]?.message?.content ?? "");
  if (firstReport) return { report: firstReport, usage: { model, promptTokens, completionTokens } };

  // Repair pass: same corpus, explicit nudge to fix the JSON shape.
  const retry = await complete(
    "Your previous response was not valid JSON matching the schema. Return ONLY the JSON object, all fields present, scores within 0-10.",
  );
  if (retry.usage) {
    promptTokens += retry.usage.prompt_tokens;
    completionTokens += retry.usage.completion_tokens;
  }
  const retryReport = tryParse(retry.choices[0]?.message?.content ?? "");
  if (retryReport) return { report: retryReport, usage: { model, promptTokens, completionTokens } };

  throw new Error("The analysis model did not return a valid report. Try running the scan again.");
}

/**
 * Assemble the final ScanReport the UI renders: LLM output + server-owned fields.
 * The server (not the model) owns `sources`, `generatedAt`, the computed `opportunityScore`,
 * and guarantees baseline `playfulStats` so that section is never empty.
 */
export function assembleReport(
  industry: string,
  llm: LlmReport,
  sources: Source[],
  generatedAt: string,
): ScanReport {
  const opportunity = opportunityScore(llm.scores);
  const baselineStats = derivePlayfulStats(llm.scores, opportunity);

  // Merge model stats first (they're bespoke), then any baseline labels not already present.
  const seenLabels = new Set(llm.playfulStats.map((s) => s.label.toLowerCase()));
  const mergedStats = [
    ...llm.playfulStats,
    ...baselineStats.filter((s) => !seenLabels.has(s.label.toLowerCase())),
  ];

  return {
    ...llm,
    industry: titleCase(industry),
    generatedAt,
    opportunityScore: opportunity,
    playfulStats: mergedStats,
    sources,
  };
}
