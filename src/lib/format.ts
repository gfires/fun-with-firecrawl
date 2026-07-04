/**
 * format.ts — small pure string/number helpers shared across server and client.
 * Kept dependency-free so it can be imported anywhere (unit-tested behavior lives
 * in scoring.test.ts alongside the logic that uses it).
 */

/** Extract a bare hostname from a URL, stripping "www.". Returns "" on garbage input. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Clamp a number into [min, max]. */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Truncate text to `max` chars on a word boundary, adding an ellipsis. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd() + "…";
}

/** Title-case a string for display, e.g. "college athletics" -> "College Athletics". */
export function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
