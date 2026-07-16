/**
 * scripts/compare-arms.ts — run both research arms on a topic; write side-by-side cost + output.
 *
 * Usage:
 *   npm run compare -- "veterinary telemedicine"
 *   npx tsx scripts/compare-arms.ts "veterinary telemedicine"
 *   npx tsx scripts/compare-arms.ts "veterinary telemedicine" --budget=50 --usd-budget=0.5
 *
 * Requires OPENAI_API_KEY and FIRECRAWL_API_KEY (loaded from .env.local automatically).
 * Output: compare-output/<topic-slug>-<timestamp>.json
 *
 * The JSON has an arms[] array — baseline, orchestrated (coded retrieval), and agentic
 * (agentic retrieval) — each with the full report and a tokens block (per-call usage +
 * total cost). Diff them by eye or in a JSON viewer. When graph.ts isn't available, the
 * graph arms are skipped with a logged note.
 *
 * `--budget=N` caps search/scrape CREDITS (TOTAL_RETRIEVAL_BUDGET, params.ts); `--usd-budget=N`
 * caps LLM $ SPEND (MAX_RUN_COST_USD) — independent pools, applied to both graph arms (the
 * baseline arm has no cost tracker, so neither applies to it).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

// Load .env.local (Next.js env file) for standalone script use.
const envPath = join(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

import { runBaseline } from "../src/lib/orchestration/eval";
import type { ArmResult, ComparisonResult } from "../src/lib/orchestration/eval";
import { formatMechanicsReport } from "../src/lib/orchestration/mechanics";

const cliArgs = process.argv.slice(2);
const budgetFlag = cliArgs.find((a) => a.startsWith("--budget="));
const usdBudgetFlag = cliArgs.find((a) => a.startsWith("--usd-budget="));
const positional = cliArgs.filter((a) => !a.startsWith("--budget=") && !a.startsWith("--usd-budget="));

const topic = positional[0]?.trim();
if (!topic) {
  console.error("Usage: tsx scripts/compare-arms.ts <topic> [--budget=N] [--usd-budget=N]");
  console.error('Example: tsx scripts/compare-arms.ts "commercial real estate" --budget=50');
  process.exit(1);
}

function parsePositiveFlag(flag: string, prefix: string): number | undefined {
  const value = Number(flag.slice(prefix.length));
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`Invalid ${prefix.replace(/=$/, "")} value: ${flag}`);
    process.exit(1);
  }
  return value;
}

const budgetOverride: number | undefined = budgetFlag ? parsePositiveFlag(budgetFlag, "--budget=") : undefined;
const usdBudgetOverride: number | undefined = usdBudgetFlag
  ? parsePositiveFlag(usdBudgetFlag, "--usd-budget=")
  : undefined;

type RunGraph = (t: string, budget?: number, mode?: "coded" | "agentic", usdBudget?: number) => Promise<ArmResult>;

/**
 * Run one graph arm (coded → "orchestrated", agentic → "agentic"). Returns null and logs a
 * note if graph.ts / runGraph isn't available or the run fails, so a missing arm degrades
 * gracefully instead of aborting the whole comparison.
 */
async function runGraphArm(
  t: string,
  mode: "coded" | "agentic",
  label: string,
): Promise<ArmResult | null> {
  try {
    // Dynamic import so a missing graph.ts is a runtime skip, not a compile error.
    const mod = await import("../src/lib/orchestration/graph");
    const fn = (mod as { runGraph?: RunGraph }).runGraph;
    if (typeof fn !== "function") throw new Error("runGraph not exported");
    return await fn(t, budgetOverride, mode, usdBudgetOverride);
  } catch (err) {
    console.log(
      `      SKIPPED (${label}) — ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function logArmDone(arm: ArmResult, ms: number): void {
  console.log(
    `      done in ${fmtMs(ms)} — ` +
      `$${arm.tokens.totalCostUsd.toFixed(4)} — ` +
      `${arm.tokens.totalPromptTokens.toLocaleString()} in / ` +
      `${arm.tokens.totalCompletionTokens.toLocaleString()} out tokens`,
  );
  // Graph arms carry a mechanics report; the baseline arm does not.
  if (arm.mechanics) console.log("\n" + formatMechanicsReport(arm.mechanics) + "\n");
}

async function main() {
  console.log(`\n=== compare-arms: "${topic}" ===\n`);

  const arms: ArmResult[] = [];

  // --- Baseline arm ---
  console.log("[1/3] Running baseline (single-prompt) arm…");
  const baseline = await runBaseline(topic);
  logArmDone(baseline, baseline.durationMs);
  arms.push(baseline);

  // --- Orchestrated arm (coded retrieval) ---
  console.log("[2/3] Running orchestrated (coded graph) arm…");
  const orchStart = Date.now();
  const orchestrated = await runGraphArm(topic, "coded", "orchestrated");
  if (orchestrated) {
    logArmDone(orchestrated, Date.now() - orchStart);
    arms.push(orchestrated);
  }

  // --- Agentic arm (agentic retrieval) ---
  console.log("[3/3] Running agentic (graph) arm…");
  const agenticStart = Date.now();
  const agentic = await runGraphArm(topic, "agentic", "agentic");
  if (agentic) {
    logArmDone(agentic, Date.now() - agenticStart);
    arms.push(agentic);
  }

  // --- Write output ---
  const result: ComparisonResult = {
    topic,
    runAt: new Date().toISOString(),
    arms,
  };

  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(process.cwd(), "compare-output");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${slug}-${timestamp}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");

  console.log(`\nOutput written to: ${outPath}`);

  // --- Cost summary ---
  console.log("\n--- Cost summary ---");
  for (const arm of arms) {
    console.log(
      `${arm.arm.padEnd(13)} $${arm.tokens.totalCostUsd.toFixed(4)}` +
        `  (${arm.tokens.calls.map((c) => `${c.label}: $${c.costUsd.toFixed(4)}`).join(", ")})`,
    );
  }
  console.log("");
}

main().catch((err) => {
  console.error("compare-arms failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
