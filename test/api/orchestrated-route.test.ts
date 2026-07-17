import { describe, it, expect, vi, beforeEach } from "vitest";
import { MAX_RUN_COST_USD, TOTAL_RETRIEVAL_BUDGET } from "@/lib/params";

const runGraphStreaming = vi.fn((..._args: unknown[]) => {
  const send = _args[1] as (e: unknown) => void;
  send({ type: "research:usage" });
  return Promise.resolve({} as unknown);
});

vi.mock("@/lib/orchestration/graph-stream", () => ({
  runGraphStreaming,
}));

async function post(body: unknown): Promise<Response> {
  const { POST } = await import("@/app/api/research/orchestrated/route");
  return POST(
    new Request("http://localhost/api/research/orchestrated", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/research/orchestrated", () => {
  beforeEach(() => {
    runGraphStreaming.mockClear();
  });

  it("400s when topic is missing", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("400s when usdBudget is provided but not a positive finite number", async () => {
    const res = await post({ topic: "x", usdBudget: -1 });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
    expect(runGraphStreaming).not.toHaveBeenCalled();
  });

  it("400s when usdBudget is NaN/Infinity", async () => {
    const res = await post({ topic: "x", usdBudget: Infinity });
    expect(res.status).toBe(400);
  });

  it("400s when budget is provided but not a positive finite number", async () => {
    const res = await post({ topic: "x", budget: 0 });
    expect(res.status).toBe(400);
    expect(runGraphStreaming).not.toHaveBeenCalled();
  });

  it("passes budget, mode, and usdBudget through to runGraphStreaming", async () => {
    const res = await post({ topic: "  freight brokerage  ", budget: 40, mode: "coded", usdBudget: 0.5 });
    expect(res.status).toBe(200);
    // Drain the stream so the async start() callback (and thus runGraphStreaming) actually runs.
    await res.body?.getReader().read();
    expect(runGraphStreaming).toHaveBeenCalledTimes(1);
    const args = runGraphStreaming.mock.calls[0];
    expect(args[0]).toBe("freight brokerage");
    expect(args[2]).toBe(40);
    expect(args[3]).toBe("coded");
    expect(args[4]).toBe(0.5);
  });

  it("omits budget/usdBudget (passes undefined) when not provided", async () => {
    const res = await post({ topic: "topic only" });
    await res.body?.getReader().read();
    const args = runGraphStreaming.mock.calls[0];
    expect(args[2]).toBeUndefined();
    expect(args[4]).toBeUndefined();
  });

  it("clamps usdBudget down to 10x MAX_RUN_COST_USD as a blast-radius guard", async () => {
    const res = await post({ topic: "x", usdBudget: 999 });
    await res.body?.getReader().read();
    const args = runGraphStreaming.mock.calls[0];
    expect(args[4]).toBe(10 * MAX_RUN_COST_USD);
  });

  it("clamps budget down to 10x TOTAL_RETRIEVAL_BUDGET as a blast-radius guard", async () => {
    const res = await post({ topic: "x", budget: 99999 });
    await res.body?.getReader().read();
    const args = runGraphStreaming.mock.calls[0];
    expect(args[2]).toBe(10 * TOTAL_RETRIEVAL_BUDGET);
  });

  it("does not clamp values within the allowed range", async () => {
    const res = await post({ topic: "x", budget: 10 * TOTAL_RETRIEVAL_BUDGET, usdBudget: 10 * MAX_RUN_COST_USD });
    await res.body?.getReader().read();
    const args = runGraphStreaming.mock.calls[0];
    expect(args[2]).toBe(10 * TOTAL_RETRIEVAL_BUDGET);
    expect(args[4]).toBe(10 * MAX_RUN_COST_USD);
  });
});
