/**
 * limiter.ts — a dependency-free FIFO concurrency limiter (promise semaphore).
 *
 * Some providers have low token-per-minute ceilings (gpt-4o), and the committee fans out
 * many calls at once. `limiterForModel(id)` returns a shared limiter that caps the number
 * of concurrent calls to that model across the whole run, so a burst can't trip a 429.
 * Models without a configured cap run unlimited (passthrough).
 */
import { MODEL_CONCURRENCY } from "../params";

/** Runs `task` when a slot is free; resolves/rejects with the task's result. */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Build a limiter allowing at most `maxConcurrent` tasks in flight. Queued tasks start in
 * strict FIFO order as slots free up; a task that rejects releases its slot just like one
 * that resolves.
 */
export function createLimiter(maxConcurrent: number): Limiter {
  let active = 0;
  const queue: Array<() => void> = [];

  const pump = () => {
    while (active < maxConcurrent && queue.length > 0) {
      const start = queue.shift()!;
      start();
    }
  };

  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            pump();
          });
      };
      queue.push(start);
      pump();
    });
}

// One limiter per capped model, seeded from params. Shared across the run so the cap is
// global, not per-call-site.
const limiters = new Map<string, Limiter>(
  Object.entries(MODEL_CONCURRENCY).map(([id, cap]) => [id, createLimiter(cap)]),
);

/** Passthrough for models without a configured cap — no queueing, unlimited concurrency. */
const passthrough: Limiter = (task) => task();

/** The shared limiter for a model id, or an unlimited passthrough if it has no cap. */
export function limiterForModel(modelId: string): Limiter {
  return limiters.get(modelId) ?? passthrough;
}
