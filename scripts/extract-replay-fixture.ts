/**
 * scripts/extract-replay-fixture.ts — turn a real run trace into the board's replay fixture.
 *
 * The streaming graph runner (graph-stream.ts) logs every emitted `ResearchEvent` to the trace as an
 * `sse:<type>` entry whose `.data` IS the event. This script lifts those out, in order, into a slim
 * `ResearchEvent[]` the UI reducer can replay deterministically with no network, no keys, no cost.
 *
 * Usage:
 *   npx tsx scripts/extract-replay-fixture.ts                       # newest trace in trace-output/
 *   npx tsx scripts/extract-replay-fixture.ts <trace.json> [<out>]  # explicit input / output
 *
 * IMPORTANT: only traces from the STREAMING path carry `sse:*` entries. Generate one with
 *   npx tsx scripts/run-arm.ts agentic "<topic>" --stream
 * A `run-arm` run WITHOUT --stream (the batch runGraph) logs llm/firecrawl entries but no events, so
 * this script will find nothing to extract and tell you so.
 *
 * The fixture is validated before it's written: it's fed through the REAL `reduce` (the same reducer
 * the live UI uses), and we refuse to write a stream that doesn't reduce to a finished run (a report
 * plus at least one question). Evidence `content` is trimmed to keep the committed file small — the
 * board renders it, but a fixture doesn't need whole scraped pages.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { ResearchEvent } from "../src/lib/research-events";
import { reduce, initialResearchState } from "../src/lib/useResearchStream";
import { slimReplayEvent } from "../src/lib/orchestration/replay-slim";

function newestTrace(dir: string): string {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".trace.json"))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) throw new Error(`no *.trace.json in ${dir} — run with --stream first`);
  return join(dir, files[0].f);
}

function main() {
  const [inArg, outArg] = process.argv.slice(2);
  const tracePath = inArg ?? newestTrace(join(process.cwd(), "trace-output"));
  const outPath = outArg ?? join(process.cwd(), "test", "fixtures", "replay-events.json");

  const entries = JSON.parse(readFileSync(tracePath, "utf8")) as { type: string; data: unknown }[];
  const events = entries
    .filter((e) => typeof e.type === "string" && e.type.startsWith("sse:"))
    .map((e) => slimReplayEvent(e.data as ResearchEvent));

  if (events.length === 0) {
    console.error(
      `No sse:* events in ${tracePath}.\n` +
        `This trace came from the batch runner (no event stream). Generate a streaming trace:\n` +
        `  npx tsx scripts/run-arm.ts agentic "<topic>" --stream`,
    );
    process.exit(1);
  }

  // Validate: replay through the REAL reducer and insist on a finished run.
  let s = initialResearchState;
  for (const e of events) s = reduce(s, e);
  if (!s.report || s.questions.length === 0) {
    console.error(
      `Extracted ${events.length} events but they don't reduce to a finished run ` +
        `(report=${s.report ? "yes" : "no"}, questions=${s.questions.length}). Refusing to write a broken fixture.`,
    );
    process.exit(1);
  }

  const researcherEvents = events.filter((e) => e.type.startsWith("researcher:")).length;
  mkdirSync(join(process.cwd(), "test", "fixtures"), { recursive: true });
  writeFileSync(outPath, JSON.stringify(events, null, 2), "utf8");

  console.log(
    `Wrote ${events.length} events → ${outPath}\n` +
      `  questions ${s.questions.length} · claims ${s.claims.length} · evidence ${s.evidence.length} · ` +
      `gate decisions ${s.gateDecisions.length} · researcher events ${researcherEvents} · $${s.usage.totalCostUsd.toFixed(4)}`,
  );
  if (researcherEvents === 0) {
    console.warn(
      `  ⚠ no researcher:* events — this trace is from the CODED arm. For the window-shopping viz, ` +
        `regenerate with the AGENTIC arm: run-arm.ts agentic "<topic>" --stream`,
    );
  }
}

main();
