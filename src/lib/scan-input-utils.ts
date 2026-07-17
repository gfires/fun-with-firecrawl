/**
 * Pure, JSX-free helpers for `ScanInput` — kept in their own module so they're importable from
 * node-environment vitest tests (component files are `"use client"` React/JSX and can't be
 * exercised by this repo's DOM-less test setup; see `vitest.config.ts`).
 */

/** True only for a bare Enter (no Shift) — the submit gesture. Shift+Enter inserts a newline instead. */
export function shouldSubmitOnKeyDown(key: string, shiftKey: boolean): boolean {
  return key === "Enter" && !shiftKey;
}

/**
 * Parse an optional numeric budget-override input.
 * - Empty/whitespace-only → `undefined` (use server default).
 * - Non-numeric or `<= 0` → `undefined` (invalid input is ignored, not sent as garbage).
 * - Valid positive number → clamped to `opts.max` (blast-radius guard against a fat-fingered value).
 */
export function parseBudgetInput(raw: string, opts: { max: number }): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, opts.max);
}
