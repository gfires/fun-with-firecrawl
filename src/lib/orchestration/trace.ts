import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { ResearchEvent } from "../research-events";
import type { ResearchStateT } from "../schemas/state";

export interface TraceEntry {
  timestamp: string;
  elapsed_ms: number;
  type: string;
  data: unknown;
}

export class TraceLogger {
  private entries: TraceEntry[] = [];
  private t0: number;

  constructor() {
    this.t0 = Date.now();
  }

  log(type: string, data: unknown): void {
    this.entries.push({
      timestamp: new Date().toISOString(),
      elapsed_ms: Date.now() - this.t0,
      type,
      data,
    });
  }

  logEvent(event: ResearchEvent): void {
    this.log(`sse:${event.type}`, event);
  }

  logLlmCall(label: string, request: { model: string; prompt: unknown; system?: string; schema?: unknown; loopIteration?: number; debateRound?: number }, response: unknown, usage: unknown): void {
    this.log("llm:call", { label, request, response, usage });
  }

  logFirecrawlCall(operation: string, params: unknown, resultCount: number): void {
    this.log("firecrawl:call", { operation, params, resultCount });
  }

  logStateSnapshot(node: string, state: Partial<ResearchStateT>): void {
    this.log("state:snapshot", {
      node,
      questionsCount: (state.questions ?? []).length,
      evidenceCount: (state.evidence ?? []).length,
      claimsCount: (state.claims ?? []).length,
      loopIteration: state.loopIteration,
      budgetRemaining: state.budgetRemaining,
      budgetSpent: state.budgetSpent,
      converged: state.converged,
    });
  }

  getEntries(): TraceEntry[] {
    return this.entries;
  }

  async writeToDisk(topic: string): Promise<string> {
    const dir = join(process.cwd(), "trace-output");
    await mkdir(dir, { recursive: true });
    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${slug}-${ts}.trace.json`;
    const filepath = join(dir, filename);
    await writeFile(filepath, JSON.stringify(this.entries, null, 2));
    return filepath;
  }
}

let activeTrace: TraceLogger | null = null;

export function startTrace(): TraceLogger {
  activeTrace = new TraceLogger();
  return activeTrace;
}

export function getActiveTrace(): TraceLogger | null {
  return activeTrace;
}
