/**
 * scripts/compare-arms.ts — run both research arms on a topic; write side-by-side cost + output.
 *
 * Usage:
 *   npm run compare -- "veterinary telemedicine"
 *   npx tsx scripts/compare-arms.ts "veterinary telemedicine"
 *
 * Requires OPENAI_API_KEY and FIRECRAWL_API_KEY (loaded from .env.local automatically).
 * Output: compare-output/<topic-slug>-<timestamp>.json
 *
 * The JSON has two keys — baseline and orchestrated — each with the full ScanReport and
 * a tokens block (per-call usage + total cost). Diff them by eye or in a JSON viewer.
 * When graph.ts / gate.ts don't exist yet, orchestrated is a stub object with { stub: true }.
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

const cliArgs = process.argv.slice(2);
const budgetFlag = cliArgs.find((a) => a.startsWith("--budget="));
const positional = cliArgs.filter((a) => !a.startsWith("--budget="));

const topic = positional[0]?.trim();
if (!topic) {
  console.error("Usage: tsx scripts/compare-arms.ts <topic> [--budget=N]");
  console.error('Example: tsx scripts/compare-arms.ts "commercial real estate" --budget=50');
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

async function runOrchestrated(
  t: string,
): Promise<ArmResult | { arm: "orchestrated"; stub: true; note: string }> {
  try {
    // Dynamic import so missing graph.ts is a runtime stub, not a compile error.
    const mod = await import("../src/lib/orchestration/graph");
    const fn = (mod as { runGraph?: (t: string, budget?: number) => Promise<ArmResult> }).runGraph;
    if (typeof fn !== "function") throw new Error("runGraph not exported");
    return await fn(t, budgetOverride);
  } catch {
    return {
      arm: "orchestrated" as const,
      stub: true,
      note: "graph.ts / gate.ts not yet implemented — export runGraph(topic) from src/lib/orchestration/graph.ts to fill this arm",
    };
  }
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function main() {
  console.log(`\n=== compare-arms: "${topic}" ===\n`);

  // --- Baseline arm ---
  console.log("[1/2] Running baseline (single-prompt) arm…");
  const baseline = await runBaseline(topic);
  console.log(
    `      done in ${fmtMs(baseline.durationMs)} — ` +
      `$${baseline.tokens.totalCostUsd.toFixed(4)} — ` +
      `${baseline.tokens.totalPromptTokens.toLocaleString()} in / ` +
      `${baseline.tokens.totalCompletionTokens.toLocaleString()} out tokens`,
  );

  // --- Orchestrated arm ---
  console.log("[2/2] Running orchestrated (graph) arm…");
  const orchStart = Date.now();
  const orchestrated = await runOrchestrated(topic);
  const orchMs = Date.now() - orchStart;

  if ("stub" in orchestrated && orchestrated.stub) {
    console.log(`      STUB — graph.ts not yet implemented`);
  } else {
    const o = orchestrated as ArmResult;
    console.log(
      `      done in ${fmtMs(orchMs)} — ` +
        `$${o.tokens.totalCostUsd.toFixed(4)} — ` +
        `${o.tokens.totalPromptTokens.toLocaleString()} in / ` +
        `${o.tokens.totalCompletionTokens.toLocaleString()} out tokens`,
    );
  }

  // --- Write output ---
  const result: ComparisonResult = {
    topic,
    runAt: new Date().toISOString(),
    baseline,
    orchestrated,
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
  console.log(
    `Baseline:     $${baseline.tokens.totalCostUsd.toFixed(4)}` +
      `  (${baseline.tokens.calls.map((c) => `${c.label}: $${c.costUsd.toFixed(4)}`).join(", ")})`,
  );
  if (!("stub" in orchestrated)) {
    const o = orchestrated as ArmResult;
    console.log(
      `Orchestrated: $${o.tokens.totalCostUsd.toFixed(4)}` +
        `  (${o.tokens.calls.map((c) => `${c.label}: $${c.costUsd.toFixed(4)}`).join(", ")})`,
    );
  } else {
    console.log("Orchestrated: [stub — no data yet]");
  }
  console.log("");
}

main().catch((err) => {
  console.error("compare-arms failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
