import { describe, it, expect } from "vitest";
import { createLimiter } from "@/lib/orchestration/limiter";
import { modelForRole } from "@/lib/models/provider";

/** A promise you resolve/reject by hand — lets a test hold tasks "in flight". */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush the microtask/macrotask queue so limiter .finally() chains settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createLimiter", () => {
  it("never runs more than maxConcurrent tasks at once", async () => {
    const limit = createLimiter(2);
    let inFlight = 0;
    let maxInFlight = 0;
    const defs = Array.from({ length: 6 }, () => deferred());

    const tasks = defs.map((d) =>
      limit(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await d.promise;
        inFlight--;
      }),
    );

    await tick();
    expect(inFlight).toBe(2); // only 2 admitted immediately

    // Drain one at a time; the cap must hold as queued tasks are promoted.
    for (const d of defs) {
      d.resolve();
      await tick();
    }
    await Promise.all(tasks);
    expect(maxInFlight).toBe(2);
  });

  it("admits queued tasks in strict FIFO order", async () => {
    const limit = createLimiter(1);
    const order: number[] = [];
    const defs = [deferred(), deferred(), deferred()];

    const tasks = defs.map((d, i) =>
      limit(async () => {
        order.push(i);
        await d.promise;
      }),
    );

    await tick();
    expect(order).toEqual([0]); // only the first runs under a cap of 1
    defs[0].resolve();
    await tick();
    expect(order).toEqual([0, 1]);
    defs[1].resolve();
    await tick();
    expect(order).toEqual([0, 1, 2]);
    defs[2].resolve();
    await Promise.all(tasks);
  });

  it("releases a slot when a task rejects", async () => {
    const limit = createLimiter(1);
    const d0 = deferred();
    const d1 = deferred();
    let secondStarted = false;

    const t0 = limit(() => d0.promise).catch(() => "handled");
    const t1 = limit(async () => {
      secondStarted = true;
      await d1.promise;
    });

    await tick();
    expect(secondStarted).toBe(false); // blocked behind the first task

    d0.reject(new Error("boom"));
    await tick();
    expect(secondStarted).toBe(true); // rejection freed the slot

    d1.resolve();
    await Promise.all([t0, t1]);
  });
});

describe("modelForRole", () => {
  it("uses Sonnet for the 3 analytical roles on loop 0, Haiku on a re-debate", () => {
    for (const role of ["historian", "operator", "investor"] as const) {
      expect(modelForRole(role, 0).modelId).toBe("claude-sonnet-5");
      expect(modelForRole(role, 1).modelId).toBe("claude-haiku-4-5-20251001");
    }
  });

  it("keeps the skeptic on gpt-4o across every loop", () => {
    expect(modelForRole("skeptic", 0).modelId).toBe("gpt-4o");
    expect(modelForRole("skeptic", 1).modelId).toBe("gpt-4o");
    expect(modelForRole("skeptic", 3).modelId).toBe("gpt-4o");
  });

  it("defaults to the loop-0 mix when no loop iteration is given", () => {
    expect(modelForRole("historian").modelId).toBe("claude-sonnet-5");
  });
});
