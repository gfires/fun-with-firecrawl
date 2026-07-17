/**
 * runs.test.ts — locks in the `blindspot.research_runs` persistence contract (src/lib/runs.ts).
 *
 * Correctness requirement called out repeatedly in the spec: a Supabase outage must NEVER fail or
 * block an actual research run. saveRun() must swallow every error and resolve `null`, never throw
 * or reject. Mirrors the in-memory Supabase mock pattern from test/scrape-cache.test.ts, adapted to
 * an insert/select-with-order/eq-maybeSingle builder shape for a single `research_runs` table.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ResearchEvent } from "@/lib/research-events";
import type { Evidence } from "@/lib/schemas/evidence";
import type { RunMechanics } from "@/lib/orchestration/mechanics";

interface Row {
  id: string;
  topic: string;
  status: string;
  started_at: string;
  finished_at?: string;
  budget: number | null;
  usd_budget: number | null;
  total_cost_usd: number | null;
  firecrawl_credits: number | null;
  events: unknown;
  mechanics: unknown;
}

let store: Row[] = [];
let nextId = 1;
let forceInsertError = false;
let forceSelectError = false;

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from(table: string) {
      if (table !== "research_runs") throw new Error(`unexpected table ${table}`);
      return {
        insert(row: Partial<Row>) {
          return {
            select() {
              return {
                single() {
                  if (forceInsertError) {
                    return Promise.resolve({ data: null, error: { message: "insert failed" } });
                  }
                  const id = String(nextId++);
                  const fullRow: Row = {
                    id,
                    topic: row.topic ?? "",
                    status: row.status ?? "completed",
                    started_at: row.started_at ?? "",
                    finished_at: row.finished_at,
                    budget: row.budget ?? null,
                    usd_budget: row.usd_budget ?? null,
                    total_cost_usd: row.total_cost_usd ?? null,
                    firecrawl_credits: row.firecrawl_credits ?? null,
                    events: row.events ?? [],
                    mechanics: row.mechanics ?? null,
                  };
                  store.push(fullRow);
                  return Promise.resolve({ data: { id }, error: null });
                },
              };
            },
          };
        },
        select() {
          const builder = {
            order() {
              return builder;
            },
            limit(n: number) {
              if (forceSelectError) return Promise.resolve({ data: null, error: { message: "select failed" } });
              const sorted = [...store].sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
              return Promise.resolve({ data: sorted.slice(0, n), error: null });
            },
            eq(_col: string, val: string) {
              return {
                maybeSingle() {
                  if (forceSelectError) return Promise.resolve({ data: null, error: { message: "select failed" } });
                  const found = store.find((r) => r.id === val);
                  return Promise.resolve({ data: found ?? null, error: null });
                },
              };
            },
          };
          return builder;
        },
      };
    },
  },
}));

import { saveRun, listRuns, getRun } from "@/lib/runs";

beforeEach(() => {
  store = [];
  nextId = 1;
  forceInsertError = false;
  forceSelectError = false;
});

const longEvidence: Evidence = {
  url: "https://a.com",
  title: "t",
  snippet: "s",
  content: "x".repeat(2000),
  contentHash: "h1",
  sourceQuery: "q",
  questionId: "q1",
} as Evidence;

const sampleEvents: ResearchEvent[] = [
  { type: "research:start", topic: "freight brokerage" },
  { type: "retrieve:evidence", questionId: "q1", evidence: longEvidence },
];

describe("saveRun", () => {
  it("degrades silently (resolves null, never throws) when Supabase errors", async () => {
    forceInsertError = true;
    await expect(
      saveRun({
        topic: "freight brokerage",
        status: "completed",
        startedAt: new Date().toISOString(),
        events: sampleEvents,
      }),
    ).resolves.toBeNull();
  });

  it("maps fields correctly into the inserted row, slimming events", async () => {
    const startedAt = new Date("2026-01-01T00:00:00Z").toISOString();
    const id = await saveRun({
      topic: "freight brokerage",
      status: "completed",
      startedAt,
      budget: 80,
      usdBudget: 0.75,
      totalCostUsd: 0.42,
      firecrawlCredits: 12,
      events: sampleEvents,
      mechanics: { fake: true } as unknown as RunMechanics,
    });

    expect(id).toBe("1");
    expect(store).toHaveLength(1);
    const row = store[0];
    expect(row.topic).toBe("freight brokerage");
    expect(row.status).toBe("completed");
    expect(row.started_at).toBe(startedAt);
    expect(row.budget).toBe(80);
    expect(row.usd_budget).toBe(0.75);
    expect(row.total_cost_usd).toBe(0.42);
    expect(row.firecrawl_credits).toBe(12);
    expect(row.mechanics).toEqual({ fake: true });

    const events = row.events as ResearchEvent[];
    const evidenceEvent = events.find((e) => e.type === "retrieve:evidence") as Extract<
      ResearchEvent,
      { type: "retrieve:evidence" }
    >;
    expect(evidenceEvent.evidence.content.length).toBeLessThanOrEqual(800);
  });

  it("defaults optional numeric fields to null when omitted", async () => {
    await saveRun({
      topic: "t",
      status: "errored",
      startedAt: new Date().toISOString(),
      events: [],
    });
    const row = store[0];
    expect(row.budget).toBeNull();
    expect(row.usd_budget).toBeNull();
    expect(row.total_cost_usd).toBeNull();
    expect(row.firecrawl_credits).toBeNull();
    expect(row.mechanics).toBeNull();
  });
});

describe("listRuns", () => {
  it("returns [] on error", async () => {
    forceSelectError = true;
    expect(await listRuns()).toEqual([]);
  });

  it("returns rows mapped into RunSummary, newest-first", async () => {
    await saveRun({ topic: "older", status: "completed", startedAt: new Date("2026-01-01T00:00:00Z").toISOString(), events: [] });
    await saveRun({ topic: "newer", status: "errored", startedAt: new Date("2026-01-02T00:00:00Z").toISOString(), events: [] });

    const runs = await listRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0].topic).toBe("newer");
    expect(runs[0].status).toBe("errored");
    expect(runs[1].topic).toBe("older");
    expect(runs[0]).toHaveProperty("id");
    expect(runs[0]).toHaveProperty("startedAt");
    expect(runs[0]).toHaveProperty("totalCostUsd");
    expect(runs[0]).toHaveProperty("firecrawlCredits");
  });
});

describe("getRun", () => {
  it("returns null on missing row", async () => {
    expect(await getRun("nonexistent")).toBeNull();
  });

  it("returns null on select error", async () => {
    forceSelectError = true;
    expect(await getRun("1")).toBeNull();
  });

  it("returns events on hit", async () => {
    const id = await saveRun({
      topic: "freight brokerage",
      status: "completed",
      startedAt: new Date().toISOString(),
      events: sampleEvents,
    });
    expect(id).not.toBeNull();

    const result = await getRun(id as string);
    expect(result).not.toBeNull();
    expect(result?.events.length).toBe(sampleEvents.length);
    expect(result?.events[0].type).toBe("research:start");
  });
});
