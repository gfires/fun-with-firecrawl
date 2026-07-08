/**
 * gate.ts — budget allocation & loop control for the research graph.
 *
 * OWNERSHIP: This file is a STUB. It is owned by another agent. `graph.ts` only
 * depends on the SIGNATURE below — do not fill in the body here.
 *
 * `allocateBudget` inspects the current research state (evidence gathered, claims
 * debated, confidence per question, budget remaining) and decides:
 *   - how to spend the remaining budget on the next retrieval loop, and
 *   - whether the loop should continue at all (`continueLoop`).
 *
 * It returns the (possibly mutated) state — e.g. decremented `budgetRemaining`,
 * incremented `loopIteration`, questions marked `resolved` once confident — plus a
 * `continueLoop` flag the graph's conditional edge uses to route back to `retrieve`
 * or forward to `recommend`.
 */
import type { ResearchStateT } from "../schemas/state";

export class NotImplementedError extends Error {
  constructor(message = "allocateBudget is not implemented yet") {
    super(message);
    this.name = "NotImplementedError";
  }
}

/**
 * @returns `state` — the next research state after budget allocation.
 * @returns `continueLoop` — true to run another retrieve→debate→gate loop.
 */
export function allocateBudget(
  _state: ResearchStateT,
): { state: ResearchStateT; continueLoop: boolean } {
  throw new NotImplementedError();
}
