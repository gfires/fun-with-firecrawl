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
import type { ScrapedSource } from "./evidence/provider";
import type { TokenUsage } from "./events";
import { opportunityScore } from "./scoring";
import { titleCase } from "./format";
import { ANALYSIS_MODEL } from "./params";

/** Human + model-facing definitions of each 0–10 dimension. Keep in sync with schema.Scores. */
export const SCORE_DEFINITIONS: { key: string; name: string; definition: string }[] = [
  { key: "pain", name: "Pain Score", definition: "Frustration/unmet need a new entrant could address. CALIBRATE: 7+ requires evidence of BEHAVIORAL change (building workarounds, hiring extra staff, switching vendors) — not just complaints. 1-2=cope fine. 3-4=friction but accepted. 5-6=active pain, seeking alternatives. 7-8=quantified losses, people changing behavior. 9-10=crisis/lawsuits/exodus." },
  { key: "softwareMaturity", name: "Existing Solution Maturity", definition: "How modern/complete existing solutions are. CALIBRATE: actually COUNT vendors and assess adoption — '4-5 = some tools but fragmented' is lazy. 1-2=paper/spreadsheets, no purpose-built tool. 3-4=1-2 niche tools, poorly funded. 5-6=several tools, actively maintained, significant gaps. 7-8=3+ funded vendors, most practitioners use them. 9-10=dominant players (Salesforce/Epic-level)." },
  { key: "founderAccessibility", name: "Founder Accessibility", definition: "Can an outsider founder break in? Consider regulation, sales cycles, trust, data access, integration complexity. Ask: 'Could a 2-person team get 10 paying customers in 6 months?' 1-2=licenses, multi-year procurement. 3-4=deep domain expertise, 6+ month sales cycles. 5-6=learnable domain, moderate sales cycles. 7-8=open market, self-serve possible. 9-10=consumer-style, viral distribution." },
  { key: "aiSuitability", name: "AI Suitability", definition: "How well the SPECIFIC BOTTLENECKS above map to what AI can automate TODAY. Score the identified pain points, not the industry generally. 1-2=physical/relationship work, no data trail. 3-4=hard part is non-digital. 5-6=data workflows but need domain fine-tuning. 7-8=clear NLP/vision/classification tasks with training data. 9-10=rote data entry, AI already outperforms humans." },
  { key: "budgetSignal", name: "Budget Signal", definition: "Evidence buyers will pay for NEW solutions (legacy spend doesn't count). Look for: recent startup funding, new RFPs, expanding budgets. 1-2=price-sensitive individuals, no budget. 3-4=small biz, <$1K/yr spend. 5-6=mid-market, $5-50K contracts. 7-8=enterprise, $50K+ deals, funded competitors. 9-10=six-figure deals, dedicated procurement." },
];

function config() {
  return { model: ANALYSIS_MODEL };
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
  "Current Software Ecosystem",
  "Bottlenecks",
  "Underserved Niches",
  "Opportunity Thesis",
  "Adjacent Markets",
  "Next Steps",
];

/** The system prompt: role + hard rules. Kept transparent and short. */
export const SYSTEM_PROMPT = `You are Blindspot, a sharp industry-diagnostics engine. \
You read raw web sources about an industry and infer where the structural inefficiencies, labor \
shortages, solution gaps, and business opportunities are — whether the right play is software, \
hardware, services, or a combination.

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

PERSPECTIVE: The user wants to BUILD in this space — they are a founder or investor scanning for \
opportunities, gaps, and unmet needs. Diagnose where the opportunities are to create something \
new, not how the industry works for an end consumer or operator.

SCORE DEFINITIONS (each 0–10, with a one-sentence reason — keep it brief, the report body carries the detail):
${defs}

Produce a JSON object with EXACTLY these fields:
{
  "industry": string,
  "scores": {
    "pain": { "value": 0-10, "label": short word, "reason": one sentence },
    "softwareMaturity": {...}, "founderAccessibility": {...}, "aiSuitability": {...}, "budgetSignal": {...}
  },
  "snapshot": string,                 // SEE SPECIAL INSTRUCTIONS BELOW
  "softwareEcosystem": {
    "summary": string,                // SEE SPECIAL INSTRUCTIONS BELOW
    "vendors": [{ "name", "note", "sourceIds" }]
  },
  "bottlenecks": [{ "text", "sourceIds" }],          // SEE SPECIAL INSTRUCTIONS BELOW
  "underservedNiches": [{ "text", "sourceIds" }],    // Segments or workflows nobody is solving well
  "opportunityThesis": string,        // SEE SPECIAL INSTRUCTIONS BELOW
  "adjacentMarkets": [{ "text", "sourceIds" }],
  "nextSteps": [{ "text", "sourceIds" }]              // SEE SPECIAL INSTRUCTIONS BELOW
}

SCORING CALIBRATION:
The goal is DIFFERENTIATION — a restaurant scan should score very differently from a biotech scan. \
Before finalizing, ask: "Would these same scores fit a different industry?" If yes, you're lazy. \
TRAPS: Pain 7 (complaints ≠ behavioral change — people building workarounds/switching = 7+, \
"wish it was better" = 4-5). Software Maturity 5 ("some tools with gaps" = every market — COUNT \
vendors, check funding). AI Suitability 7 (score the SPECIFIC bottlenecks, not the industry). \
Budget 7 (legacy spend ≠ new-tool budget — look for ACTIVE buying signals). \
Reference specific sources in each score's "reason" field.

SECTION INSTRUCTIONS:

- "snapshot": 4-6 sentences. (1) Size the industry with a number from sources, (2) describe what \
practitioners actually DO day-to-day, (3) name 1-2 macro forces reshaping the space now, \
(4) state the core tension that creates opportunity. Cite sources with [id]s.

- "softwareEcosystem": \
  "summary": 2-3 sentences. State maturity bluntly (greenfield / fragmented / mature). Name the \
  specific GAP across existing tools. \
  "vendors": 4-6 vendors. Each "note" must cover strengths AND weaknesses in 2-3 sentences — \
  what it does well, where it falls short, what users say, pricing if available.

- "bottlenecks": Structural ROOT CAUSES, not surface friction. 4-6 items, each 3-4 sentences: \
(1) the specific workflow/process that breaks, naming documents, systems, job titles, \
(2) quantified impact — time/money/error from sources, (3) why existing tools don't solve it.

- "underservedNiches": 3-5 items. Each must name a SPECIFIC population or workflow gap and explain \
WHY it's underserved — population size, what they need, what exists today, what's missing.

- "opportunityThesis": TWO LONG, DENSE PARAGRAPHS (separated by \\n\\n, not a list). Each 6-8 \
sentences. Thread specific data points, quotes, numbers, product names from the sources into \
every sentence. Vague generalities are a failure mode. \
PARAGRAPH 1 — THE PRODUCT: tie bottlenecks to a specific product (features, data flows, \
integrations), name the wedge workflow, the user persona, the current workaround, the technical \
approach, and where incumbents fall short. 4+ citations. \
PARAGRAPH 2 — THE TIMING AND MOAT: why NOW (specific dates/events from sources), compounding \
advantage (data flywheel, network effect), wedge market size with numbers, expansion path. 4+ \
citations. Someone should read these two paragraphs and start building a PRD.

- "adjacentMarkets": 3-5 items. Each must explain the SPECIFIC MECHANISM of crossover — shared \
data formats, vendor ecosystems, regulatory overlaps, or customer segments.

- "nextSteps": 4-6 items. Extremely specific actions executable THIS WEEK — name communities, \
tools, conferences, datasets, or organizations from the sources.

CROSS-CUTTING RULES:
- Every "text", "note", and "opportunityThesis" MUST include direct quotes from sources with [id].
- SPECIFICITY TEST: "Could someone who did zero research write this?" If yes, REWRITE with \
specific names, numbers, processes, and quotes from the sources.
- Minimize redundancy: bottlenecks=problems, niches=who's underserved, thesis=what to build, \
next steps=how to start.

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
      temperature: 0.2,
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
 * The server (not the model) owns `sources`, `generatedAt`, and the computed `opportunityScore`.
 */
export function assembleReport(
  industry: string,
  llm: LlmReport,
  sources: Source[],
  generatedAt: string,
): ScanReport {
  const opportunity = opportunityScore(llm.scores);

  return {
    ...llm,
    industry: titleCase(industry),
    generatedAt,
    opportunityScore: opportunity,
    sources,
  };
}
