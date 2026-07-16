/**
 * scripts/run-arm.ts — run a single research arm in isolation.
 *
 * Usage:
 *   npx tsx scripts/run-arm.ts orchestrated "freight brokerage"
 *   npx tsx scripts/run-arm.ts agentic "freight brokerage"
 *   npx tsx scripts/run-arm.ts baseline "freight brokerage"
 *   npx tsx scripts/run-arm.ts orchestrated "freight brokerage" --budget=50
 *   npx tsx scripts/run-arm.ts agentic "freight brokerage" --usd-budget=0.25
 *   npx tsx scripts/run-arm.ts agentic "freight brokerage" --stream   # emits the SSE event stream
 *
 * Requires OPENAI_API_KEY and FIRECRAWL_API_KEY (loaded from .env.local automatically).
 * Output: compare-output/<arm>-<topic-slug>-<timestamp>.json — a single ArmResult.
 *
 * `--stream` runs the STREAMING graph (graph-stream.ts) instead of the batch `runGraph`, so the run
 * emits the live `ResearchEvent` SSE stream and persists an `sse:*`-bearing trace to trace-output/.
 * That trace is what `scripts/extract-replay-fixture.ts` turns into the board's replay fixture — the
 * headless way to produce one without the browser. `baseline` has no graph, so `--stream` is ignored.
 *
 * `--budget=N` caps search/scrape CREDITS (TOTAL_RETRIEVAL_BUDGET, params.ts); `--usd-budget=N` caps
 * LLM $ SPEND (MAX_RUN_COST_USD) — the two are independent pools (retrieval vs deliberation), and
 * either can run out first. Neither applies to `baseline` (no graph, no cost tracker).
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
import type { ArmResult } from "../src/lib/orchestration/eval";
import { formatMechanicsReport } from "../src/lib/orchestration/mechanics";

const cliArgs = process.argv.slice(2);
const budgetFlag = cliArgs.find((a) => a.startsWith("--budget="));
const usdBudgetFlag = cliArgs.find((a) => a.startsWith("--usd-budget="));
const streamFlag = cliArgs.includes("--stream");
const positional = cliArgs.filter((a) => !a.startsWith("--") );

const arm = positional[0]?.trim();
const topic = positional[1]?.trim();

if (arm !== "orchestrated" && arm !== "baseline" && arm !== "agentic") {
  console.error("Usage: tsx scripts/run-arm.ts <orchestrated|agentic|baseline> <topic> [--budget=N] [--usd-budget=N]");
  console.error('Example: tsx scripts/run-arm.ts agentic "freight brokerage"');
  process.exit(1);
}
if (!topic) {
  console.error("Usage: tsx scripts/run-arm.ts <orchestrated|agentic|baseline> <topic> [--budget=N] [--usd-budget=N]");
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

if (usdBudgetOverride !== undefined && arm === "baseline") {
  console.error("--usd-budget has no effect on the baseline arm (no cost tracker) — dropping it.");
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function runGraphArm(
  t: string,
  mode: "coded" | "agentic",
  budget?: number,
  usdBudget?: number,
): Promise<ArmResult> {
  const mod = await import("../src/lib/orchestration/graph");
  const fn = (
    mod as {
      runGraph?: (t: string, budget?: number, mode?: "coded" | "agentic", usdBudget?: number) => Promise<ArmResult>;
    }
  ).runGraph;
  if (typeof fn !== "function") throw new Error("runGraph not exported from graph.ts");
  return await fn(t, budget, mode, usdBudget);
}

// Streaming arm: drive the SSE graph runner. graph-stream persists an sse:*-bearing trace to
// trace-output/ on its own; here we just print a terse live event log so a headless run is legible.
async function runStreamArm(
  t: string,
  mode: "coded" | "agentic",
  budget?: number,
  usdBudget?: number,
): Promise<ArmResult> {
  const { runGraphStreaming } = await import("../src/lib/orchestration/graph-stream");
  let n = 0;
  return await runGraphStreaming(
    t,
    (event) => {
      n++;
      // One line per event; researcher:* and gate/debate milestones are the interesting ones.
      process.stdout.write(`  [${String(n).padStart(3, "0")}] ${event.type}\n`);
    },
    budget,
    mode,
    usdBudget,
  );
}

async function main() {
  console.log(`\n=== run-arm: ${arm}${streamFlag ? " (stream)" : ""} — "${topic}" ===\n`);

  const mode = arm === "agentic" ? "agentic" : "coded";
  const result: ArmResult =
    arm === "baseline"
      ? await runBaseline(topic)
      : streamFlag
        ? await runStreamArm(topic, mode, budgetOverride, usdBudgetOverride)
        : await runGraphArm(topic, mode, budgetOverride, usdBudgetOverride);

  console.log(
    `done in ${fmtMs(result.durationMs)} — ` +
      `$${result.tokens.totalCostUsd.toFixed(4)} — ` +
      `${result.tokens.totalPromptTokens.toLocaleString()} in / ` +
      `${result.tokens.totalCompletionTokens.toLocaleString()} out tokens — ` +
      `${result.firecrawlCalls} firecrawl calls / ${result.firecrawlCredits} credits`,
  );

  if (result.mechanics) console.log("\n" + formatMechanicsReport(result.mechanics));

  // Cap the slug so a long free-form topic (an intake thesis can be a full paragraph) can't
  // blow past the filesystem's per-name limit (ENAMETOOLONG). The timestamp keeps it unique.
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
    .replace(/-$/, "");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(process.cwd(), "compare-output");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${arm}-${slug}-${timestamp}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");

  console.log(`\nOutput written to: ${outPath}`);
}

main().catch((err) => {
  console.error("run-arm failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
