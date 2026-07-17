import { runGraphStreaming } from "@/lib/orchestration/graph-stream";
import type { ResearchEvent } from "@/lib/research-events";
import type { RetrievalMode } from "@/lib/schemas/state";
import { MAX_RUN_COST_USD, TOTAL_RETRIEVAL_BUDGET } from "@/lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Blast-radius guards: a client-supplied budget/usdBudget is honored up to this multiple of the
// server default, then silently clamped down rather than rejected — the request is still valid,
// it's just asking for more spend than we're willing to allow unattended.
const MAX_USD_BUDGET = 10 * MAX_RUN_COST_USD;
const MAX_RETRIEVAL_BUDGET = 10 * TOTAL_RETRIEVAL_BUDGET;

function isPositiveFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

export async function POST(req: Request) {
  const { topic, budget, usdBudget, mode } = (await req.json()) as {
    topic: string;
    budget?: number;
    usdBudget?: number;
    mode?: RetrievalMode;
  };

  if (!topic || typeof topic !== "string") {
    return new Response(JSON.stringify({ error: "topic is required" }), { status: 400 });
  }
  if (budget !== undefined && !isPositiveFiniteNumber(budget)) {
    return new Response(JSON.stringify({ error: "budget must be a positive number" }), { status: 400 });
  }
  if (usdBudget !== undefined && !isPositiveFiniteNumber(usdBudget)) {
    return new Response(JSON.stringify({ error: "usdBudget must be a positive number" }), { status: 400 });
  }
  // Rounded to an integer: budget is a retrieval CREDIT count, and research_runs.budget is an
  // `integer` column — a fractional value here would fail the saveRun insert and silently drop
  // an otherwise-successful run from history.
  const clampedBudget = budget !== undefined ? Math.min(Math.round(budget), MAX_RETRIEVAL_BUDGET) : undefined;
  const clampedUsdBudget = usdBudget !== undefined ? Math.min(usdBudget, MAX_USD_BUDGET) : undefined;
  // Default (undefined mode) → agentic, chosen by runGraphStreaming. "coded" is available for an
  // explicit A/B against the eval control arm.
  const retrievalMode: RetrievalMode | undefined = mode === "coded" || mode === "agentic" ? mode : undefined;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ResearchEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        await runGraphStreaming(topic.trim(), send, clampedBudget, retrievalMode, clampedUsdBudget);
      } catch (err) {
        console.error("[research] orchestrated run failed:", err);
        send({ type: "research:error", message: err instanceof Error ? err.message : String(err) });
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
