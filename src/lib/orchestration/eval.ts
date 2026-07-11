/**
 * eval.ts — shared types and run harness for A/B arm evaluation.
 *
 * FOR FUTURE AGENTS: This module owns the ArmResult type and the runBaseline() function,
 * which is the same pipeline as scan/route.ts but without SSE streaming — it returns a
 * plain object so scripts and tests can call it directly and compare arms side-by-side.
 *
 * The orchestrated arm (runOrchestrated) lives here too once graph.ts + gate.ts exist;
 * for now the compare script stubs it. Both arms write into ComparisonResult so a human
 * can open one JSON file and read output + cost side-by-side.
 */
import { explore } from "../evidence/firecrawl";
import { callLLM, assembleReport } from "../analyze";
import { normalizeIndustry } from "../intents";
import type { ScanReport } from "../schema";
import type { ResearchReport } from "./graph";
import type { ScanEvent, TokenUsage } from "../events";

/** Cost per million tokens by model (USD). Update when model pricing changes. */
const MODEL_COST: Record<string, { input: number; output: number }> = {
  "gpt-4o":                       { input: 2.50, output: 10.00 },
  "gpt-4o-mini":                  { input: 0.15, output:  0.60 },
  "claude-sonnet-5":              { input: 2.00, output: 10.00 },
  "claude-haiku-4-5-20251001":    { input: 1.00, output:  5.00 },
};

export function estimateCostUsd(usage: TokenUsage): number {
  const pricing = MODEL_COST[usage.model] ?? { input: 0, output: 0 };
  return (
    (usage.promptTokens / 1_000_000) * pricing.input +
    (usage.completionTokens / 1_000_000) * pricing.output
  );
}

/** One LLM call's usage annotated with its estimated USD cost. */
export type AnnotatedUsage = TokenUsage & { label: string; costUsd: number };

/**
 * Build an AnnotatedUsage from a Vercel AI SDK `generateText` result's `usage` field
 * (`inputTokens`/`outputTokens`, both possibly undefined for providers that omit them).
 * Every graph/committee/gate call site should route its usage through this so cost
 * estimation stays in one place.
 */
export function toAnnotatedUsage(
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
  model: string,
  label: string,
): AnnotatedUsage {
  const tokenUsage: TokenUsage = {
    model,
    promptTokens: usage?.inputTokens ?? 0,
    completionTokens: usage?.outputTokens ?? 0,
  };
  return { ...tokenUsage, label, costUsd: estimateCostUsd(tokenUsage) };
}

/** Roll up a flat list of per-call usages into the aggregated ArmTokens shape. */
export function rollupTokens(calls: AnnotatedUsage[]): ArmTokens {
  return {
    calls,
    totalPromptTokens:     calls.reduce((s, u) => s + u.promptTokens,     0),
    totalCompletionTokens: calls.reduce((s, u) => s + u.completionTokens, 0),
    totalCostUsd:          calls.reduce((s, u) => s + u.costUsd,          0),
  };
}

/** Aggregated token/cost summary for one arm run. */
export interface ArmTokens {
  calls: AnnotatedUsage[];
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostUsd: number;
}

/** The complete result of running one research arm. */
export interface ArmResult {
  arm: string;
  topic: string;
  report: ScanReport | ResearchReport;
  tokens: ArmTokens;
  firecrawlCalls: number;
  firecrawlCredits: number;
  durationMs: number;
}

/** Side-by-side comparison written to the output JSON file. */
export interface ComparisonResult {
  topic: string;
  runAt: string;
  baseline: ArmResult;
  orchestrated: ArmResult | { arm: "orchestrated"; stub: true; note: string };
}

function collectingEventHandler(calls: AnnotatedUsage[]) {
  return (event: ScanEvent): void => {
    if (event.type === "intents" && event.usage) {
      calls.push({ ...event.usage, label: "adapt-intents", costUsd: estimateCostUsd(event.usage) });
    }
    if (event.type === "triage:done" && event.usage) {
      calls.push({ ...event.usage, label: "triage", costUsd: estimateCostUsd(event.usage) });
    }
  };
}

/**
 * Run the baseline (single-prompt) arm and return a plain ArmResult.
 * Logic is identical to scan/route.ts — explore → callLLM → assembleReport —
 * but without SSE so it can be called from scripts and tests.
 */
export async function runBaseline(rawTopic: string): Promise<ArmResult> {
  const topic = normalizeIndustry(rawTopic);
  const t0 = Date.now();
  const calls: AnnotatedUsage[] = [];

  const onEvent = collectingEventHandler(calls);
  const { sources, scraped, firecrawlCalls, firecrawlCredits } = await explore(topic, onEvent);

  const { report: llm, usage: analyzeUsage } = await callLLM(topic, scraped);
  if (analyzeUsage) {
    calls.push({ ...analyzeUsage, label: "analyze", costUsd: estimateCostUsd(analyzeUsage) });
  }

  const report = assembleReport(topic, llm, sources, new Date().toISOString());

  const tokens: ArmTokens = {
    calls,
    totalPromptTokens:     calls.reduce((s, u) => s + u.promptTokens,     0),
    totalCompletionTokens: calls.reduce((s, u) => s + u.completionTokens, 0),
    totalCostUsd:          calls.reduce((s, u) => s + u.costUsd,          0),
  };

  return {
    arm: "baseline",
    topic,
    report,
    tokens,
    firecrawlCalls,
    firecrawlCredits,
    durationMs: Date.now() - t0,
  };
}
