/**
 * app/api/scan/route.ts — the streaming orchestrator.
 *
 * FOR FUTURE AGENTS: This is the ONE server entry point. It runs the whole pipeline
 * (intents → search → scrape → analyze) and streams every step to the client as
 * Server-Sent Events (SSE), so the browser can render the live exploration visualization.
 *
 * Why a route handler and not a server action: server actions return once, at the end.
 * We need to push incremental progress, which requires a streaming Response.
 *
 * SSE format: each event is written as `data: <json>\n\n`. The client parses these in
 * useScanStream. The ScanEvent union (lib/events.ts) is the shared contract.
 *
 * Runtime: `nodejs` (the Firecrawl + OpenAI SDKs need Node APIs) and no timeout cap so
 * the ~30–60s scan can complete.
 */
import { normalizeIndustry } from "@/lib/intents";
import { explore } from "@/lib/evidence/firecrawl";
import { callLLM, assembleReport, buildPrompt, SYSTEM_PROMPT, currentModel } from "@/lib/analyze";
import { recordScan } from "@/lib/leaderboard";
import type { ScanEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120; // seconds — headroom over the 30–60s target

export async function POST(req: Request) {
  const { industry: rawIndustry } = (await req.json().catch(() => ({}))) as { industry?: string };
  const industry = normalizeIndustry(rawIndustry ?? "");

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      /** Serialize + push one SSE event to the client. */
      const send = (event: ScanEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        if (!industry) {
          send({ type: "error", message: "Please enter an industry to scan." });
          return;
        }

        // Total-scan stopwatch — reported at the end so the UI can show end-to-end latency.
        const scanStart = Date.now();
        send({ type: "start", industry });

        // Exploration: adapt intents → search → dedupe → triage → select → scrape. `explore`
        // owns intent generation now and emits adapt/intents/search/triage/sources/scrape events
        // (with timing), returning the phase durations for the summary.
        const { sources, scraped, scrapeMs, firecrawlCalls, firecrawlCredits } = await explore(industry, send);

        // 4) Analyze. Build the prompt here so we can surface the EXACT prompt to the UI before
        //    the call. generatedAt is stamped here (server time) — one-shot, nothing persisted.
        send({
          type: "analyze:begin",
          model: currentModel(),
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: buildPrompt(industry, scraped),
          scrapeMs,
        });
        const analyzeStart = Date.now();
        const { report: llm, usage: analyzeUsage } = await callLLM(industry, scraped);
        const report = assembleReport(industry, llm, sources, new Date().toISOString());
        const analyzeMs = Date.now() - analyzeStart;

        void recordScan(report.industry, report.opportunityScore, report.scores);

        send({ type: "report", report, analyzeMs, totalMs: Date.now() - scanStart, usage: analyzeUsage, firecrawlCalls, firecrawlCredits });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unexpected error during scan.";
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
