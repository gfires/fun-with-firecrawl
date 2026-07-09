Refactor src/lib/firecrawl.ts into src/lib/evidence/firecrawl.ts and add
src/lib/evidence/store.ts. Keep all existing dedup/blocklist/PDF-filter/cache
logic intact — this is a move + reshape, not a rewrite.

store.ts must expose:
  addEvidence(items: Evidence[]): void
  getEvidence(ids: string[]): Evidence[]
  searchEvidence(query: string, k: number): Evidence[]   // simple relevance for now, can be naive
Dedup on Evidence.contentHash. Tag every stored item with sourceQuery and
loopIteration (passed in by the caller, don't invent it).
Export a search(queries: string[], k: number, loopIteration: number): Promise<Evidence[]>
function that wraps your existing Firecrawl search+scrape and returns typed Evidence[].
