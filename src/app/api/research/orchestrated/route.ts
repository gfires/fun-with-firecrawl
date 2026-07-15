import { runGraphStreaming } from "@/lib/orchestration/graph-stream";
import type { ResearchEvent } from "@/lib/research-events";
import type { RetrievalMode } from "@/lib/schemas/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const { topic, budget, mode } = (await req.json()) as { topic: string; budget?: number; mode?: RetrievalMode };

  if (!topic || typeof topic !== "string") {
    return new Response(JSON.stringify({ error: "topic is required" }), { status: 400 });
  }
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
        await runGraphStreaming(topic.trim(), send, budget, retrievalMode);
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
