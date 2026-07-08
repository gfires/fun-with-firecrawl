import { z } from "zod";

export const EvidenceSchema = z.object({
  id: z.string(),                    // stable hash of URL+content
  url: z.string().url(),
  title: z.string(),
  snippet: z.string(),
  sourceQuery: z.string(),           // which search query surfaced this
  loopIteration: z.number().int(),  // 0 = initial retrieval, 1+ = targeted
  retrievedAt: z.string().datetime(),
  contentHash: z.string(),          // for dedup
});
export type Evidence = z.infer<typeof EvidenceSchema>;