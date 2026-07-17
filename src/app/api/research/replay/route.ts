import { readFileSync } from "fs";
import { join } from "path";
import type { ResearchEvent } from "@/lib/research-events";
import { getRun } from "@/lib/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves a replay event stream. `?id=<uuid>` fetches a real persisted run from Supabase
 * (src/lib/runs.ts). No `id` (or `id=fixture`) falls back to the committed replay fixture
 * (test/fixtures/replay-events.json) — a real agentic streaming run's ResearchEvent[], extracted
 * by scripts/extract-replay-fixture.ts. The board's replay path (question-board-spec.md §5) drives
 * the SAME `reduce` the live stream uses over this array; the bundled fixture keeps replay working
 * with no live run, no keys, no cost, no Supabase runs saved yet.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (id && id !== "fixture") {
    const result = await getRun(id);
    if (!result) {
      return new Response(JSON.stringify({ error: "run not found" }), { status: 404 });
    }
    return Response.json(result.events);
  }

  const path = join(process.cwd(), "test", "fixtures", "replay-events.json");
  const events = JSON.parse(readFileSync(path, "utf8")) as ResearchEvent[];
  return Response.json(events);
}
