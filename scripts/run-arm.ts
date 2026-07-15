/**
 * scripts/run-arm.ts — run a single research arm in isolation.
 *
 * Usage:
 *   npx tsx scripts/run-arm.ts orchestrated "freight brokerage"
 *   npx tsx scripts/run-arm.ts agentic "freight brokerage"
 *   npx tsx scripts/run-arm.ts baseline "freight brokerage"
 *   npx tsx scripts/run-arm.ts orchestrated "freight brokerage" --budget=50
 *
 * Requires OPENAI_API_KEY and FIRECRAWL_API_KEY (loaded from .env.local automatically).
 * Output: compare-output/<arm>-<topic-slug>-<timestamp>.json — a single ArmResult.
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

const cliArgs = process.argv.slice(2);
const budgetFlag = cliArgs.find((a) => a.startsWith("--budget="));
const positional = cliArgs.filter((a) => !a.startsWith("--budget="));

const arm = positional[0]?.trim();
const topic = positional[1]?.trim();

if (arm !== "orchestrated" && arm !== "baseline" && arm !== "agentic") {
  console.error("Usage: tsx scripts/run-arm.ts <orchestrated|agentic|baseline> <topic> [--budget=N]");
  console.error('Example: tsx scripts/run-arm.ts agentic "freight brokerage"');
  process.exit(1);
}
if (!topic) {
  console.error("Usage: tsx scripts/run-arm.ts <orchestrated|agentic|baseline> <topic> [--budget=N]");
  process.exit(1);
}

let budgetOverride: number | undefined;
if (budgetFlag) {
  budgetOverride = Number(budgetFlag.slice("--budget=".length));
  if (!Number.isFinite(budgetOverride) || budgetOverride <= 0) {
    console.error(`Invalid --budget value: ${budgetFlag}`);
    process.exit(1);
  }
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function runGraphArm(
  t: string,
  mode: "coded" | "agentic",
  budget?: number,
): Promise<ArmResult> {
  const mod = await import("../src/lib/orchestration/graph");
  const fn = (
    mod as { runGraph?: (t: string, budget?: number, mode?: "coded" | "agentic") => Promise<ArmResult> }
  ).runGraph;
  if (typeof fn !== "function") throw new Error("runGraph not exported from graph.ts");
  return await fn(t, budget, mode);
}

async function main() {
  console.log(`\n=== run-arm: ${arm} — "${topic}" ===\n`);

  const result: ArmResult =
    arm === "baseline"
      ? await runBaseline(topic)
      : await runGraphArm(topic, arm === "agentic" ? "agentic" : "coded", budgetOverride);

  console.log(
    `done in ${fmtMs(result.durationMs)} — ` +
      `$${result.tokens.totalCostUsd.toFixed(4)} — ` +
      `${result.tokens.totalPromptTokens.toLocaleString()} in / ` +
      `${result.tokens.totalCompletionTokens.toLocaleString()} out tokens — ` +
      `${result.firecrawlCalls} firecrawl calls / ${result.firecrawlCredits} credits`,
  );

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
