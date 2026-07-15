/**
 * eval.ts — shared types and run harness for A/B arm evaluation.
 *
 * FOR FUTURE AGENTS: This module owns the ArmResult type and the runBaseline() function,
 * which is the same pipeline as scan/route.ts but without SSE streaming — it returns a
 * plain object so scripts and tests can call it directly and compare arms side-by-side.
 *
 * The orchestrated and agentic arms are produced by runGraph() in graph.ts; the compare
 * script collects every arm into ComparisonResult.arms[] so a human can open one JSON file
 * and read output + cost side-by-side.
 */
import { explore } from "../evidence/firecrawl";
import { callLLM, assembleReport } from "../analyze";
import { normalizeIndustry } from "../intents";
import type { ScanReport } from "../schema";
import type { ResearchReport } from "./graph";
import type { ScanEvent, TokenUsage } from "../events";

/**
 * Cost per million tokens by model (USD). Update when model pricing changes.
 * `cacheReadMult`/`cacheWriteMult` are per-model overrides for the prompt-cache
 * pricing multipliers (fraction of the base input rate). They default to
 * DEFAULT_CACHE_READ_MULT / DEFAULT_CACHE_WRITE_MULT when absent.
 */
const MODEL_COST: Record<
  string,
  { input: number; output: number; cacheReadMult?: number; cacheWriteMult?: number }
> = {
  "gpt-4o":                       { input: 2.50, output: 10.00 },
  "gpt-4o-mini":                  { input: 0.15, output:  0.60 },
  "claude-sonnet-5":              { input: 2.00, output: 10.00 },
  "claude-haiku-4-5-20251001":    { input: 1.00, output:  5.00 },
};

/** Cached (read) prompt tokens bill at this fraction of the base input rate. */
const DEFAULT_CACHE_READ_MULT = 0.1;
/** Cache-creation (write) prompt tokens bill at this fraction of the base input rate. */
const DEFAULT_CACHE_WRITE_MULT = 1.25;

/** Unknown model ids we've already warned about, so each warns exactly once. */
const warnedUnknownModels = new Set<string>();

/** Usage with optional prompt-cache breakdowns folded into the base TokenUsage. */
export type CacheAwareUsage = TokenUsage & {
  /** Prompt tokens served from the provider's cache (billed at the read multiplier). */
  cachedPromptTokens?: number;
  /** Prompt tokens written to the provider's cache (billed at the write multiplier). */
  cacheCreationTokens?: number;
};

export function estimateCostUsd(usage: CacheAwareUsage): number {
  const pricing = MODEL_COST[usage.model];
  if (!pricing) {
    if (!warnedUnknownModels.has(usage.model)) {
      warnedUnknownModels.add(usage.model);
      console.warn(
        `[eval] Unknown model "${usage.model}" — cost estimated as $0. Add it to MODEL_COST.`,
      );
    }
    return 0;
  }

  const cached = usage.cachedPromptTokens ?? 0;
  const creation = usage.cacheCreationTokens ?? 0;
  const readMult = pricing.cacheReadMult ?? DEFAULT_CACHE_READ_MULT;
  const writeMult = pricing.cacheWriteMult ?? DEFAULT_CACHE_WRITE_MULT;

  // Cached and cache-creation tokens are subsets of promptTokens billed at reduced
  // rates; the remainder bills at the full input rate. Clamp the remainder ≥ 0 so a
  // provider that double-counts can never yield a negative cost.
  const uncached = Math.max(0, usage.promptTokens - cached - creation);
  const inputCost =
    ((uncached / 1_000_000) * pricing.input) +
    ((cached / 1_000_000) * readMult * pricing.input) +
    ((creation / 1_000_000) * writeMult * pricing.input);

  return inputCost + (usage.completionTokens / 1_000_000) * pricing.output;
}

/** One LLM call's usage annotated with its estimated USD cost. */
export type AnnotatedUsage = CacheAwareUsage & { label: string; costUsd: number };

/**
 * Build an AnnotatedUsage from a Vercel AI SDK `generateText` result's `usage` field.
 * Reads `inputTokens`/`outputTokens` (both possibly undefined for providers that omit
 * them) and, when the provider reports it, `cachedInputTokens`. Pass the call's
 * `providerMetadata` to also capture Anthropic's `cacheCreationInputTokens` (most call
 * sites won't — the arg is optional and absence is guarded). Every graph/committee/gate
 * call site should route its usage through this so cost estimation stays in one place.
 */
export function toAnnotatedUsage(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
        /** AI SDK v7 cache breakdown — the shape providers actually report. */
        inputTokenDetails?: {
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
          noCacheTokens?: number;
        };
      }
    | undefined,
  model: string,
  label: string,
  providerMetadata?: Record<string, unknown>,
): AnnotatedUsage {
  const details = usage?.inputTokenDetails;
  const anthropic = providerMetadata?.anthropic as
    | { cacheCreationInputTokens?: number }
    | undefined;

  // Prefer AI SDK v7's inputTokenDetails.{cacheReadTokens,cacheWriteTokens}; fall back to
  // the legacy top-level cachedInputTokens / providerMetadata fields for older shapes.
  const cachedRead =
    details?.cacheReadTokens ?? usage?.cachedInputTokens ?? 0;
  const cacheCreation =
    typeof details?.cacheWriteTokens === "number"
      ? details.cacheWriteTokens
      : typeof anthropic?.cacheCreationInputTokens === "number"
        ? anthropic.cacheCreationInputTokens
        : undefined;

  const tokenUsage: CacheAwareUsage = {
    model,
    promptTokens: usage?.inputTokens ?? 0,
    completionTokens: usage?.outputTokens ?? 0,
    cachedPromptTokens: cachedRead,
    ...(cacheCreation !== undefined ? { cacheCreationTokens: cacheCreation } : {}),
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
  arms: ArmResult[];
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
