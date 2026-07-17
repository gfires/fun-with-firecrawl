import { supabase } from "./supabase";
import { warnOnce } from "./warn-once";
import { slimReplayEvent } from "./orchestration/replay-slim";
import type { ResearchEvent } from "./research-events";
import type { RunMechanics } from "./orchestration/mechanics";

const RUNS_DOWN = "[runs] supabase unreachable — run not persisted";

export interface RunSummary {
  id: string;
  topic: string;
  status: "completed" | "errored";
  startedAt: string;
  finishedAt: string;
  totalCostUsd: number | null;
  firecrawlCredits: number | null;
}

export async function saveRun(run: {
  topic: string;
  status: "completed" | "errored";
  startedAt: string;
  budget?: number;
  usdBudget?: number;
  totalCostUsd?: number;
  firecrawlCredits?: number;
  events: ResearchEvent[];
  mechanics?: RunMechanics;
}): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("research_runs")
      .insert({
        topic: run.topic,
        status: run.status,
        started_at: run.startedAt,
        budget: run.budget ?? null,
        usd_budget: run.usdBudget ?? null,
        total_cost_usd: run.totalCostUsd ?? null,
        firecrawl_credits: run.firecrawlCredits ?? null,
        events: run.events.map(slimReplayEvent),
        mechanics: run.mechanics ?? null,
      })
      .select("id")
      .single();

    if (error) {
      warnOnce("runs", RUNS_DOWN);
      return null;
    }
    return (data as { id: string }).id;
  } catch {
    warnOnce("runs", RUNS_DOWN);
    return null;
  }
}

export async function listRuns(limit = 20): Promise<RunSummary[]> {
  try {
    const { data, error } = await supabase
      .from("research_runs")
      .select("id, topic, status, started_at, finished_at, total_cost_usd, firecrawl_credits")
      .order("started_at", { ascending: false })
      .limit(limit);

    if (error) {
      warnOnce("runs", RUNS_DOWN);
      return [];
    }

    return (data as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      topic: row.topic as string,
      status: row.status as "completed" | "errored",
      startedAt: row.started_at as string,
      finishedAt: row.finished_at as string,
      totalCostUsd: (row.total_cost_usd as number | null) ?? null,
      firecrawlCredits: (row.firecrawl_credits as number | null) ?? null,
    }));
  } catch {
    warnOnce("runs", RUNS_DOWN);
    return [];
  }
}

export async function getRun(id: string): Promise<{ events: ResearchEvent[] } | null> {
  try {
    const { data, error } = await supabase.from("research_runs").select("events").eq("id", id).maybeSingle();

    if (error || !data) return null;
    return { events: (data as { events: ResearchEvent[] }).events };
  } catch {
    warnOnce("runs", RUNS_DOWN);
    return null;
  }
}
