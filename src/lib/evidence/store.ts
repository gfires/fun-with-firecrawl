import { createHash } from "crypto";

export interface Evidence {
  id: string;
  url: string;
  domain: string;
  title: string;
  snippet: string;
  content: string;
  contentHash: string;
  sourceQuery: string;
  loopIteration: number;
}

const store = new Map<string, Evidence>();

export function addEvidence(items: Evidence[]): void {
  for (const item of items) {
    if (!store.has(item.contentHash)) {
      store.set(item.contentHash, item);
    }
  }
}

export function getEvidence(ids: string[]): Evidence[] {
  return ids.flatMap((id) => {
    const item = store.get(id);
    return item ? [item] : [];
  });
}

export function searchEvidence(query: string, k: number): Evidence[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [...store.values()].map((ev) => {
    const haystack = `${ev.title} ${ev.content}`.toLowerCase();
    const score = words.reduce((n, w) => n + (haystack.includes(w) ? 1 : 0), 0);
    return { ev, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => s.ev);
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
