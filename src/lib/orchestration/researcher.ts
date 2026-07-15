/**
 * researcher.ts — the agentic-retrieval researcher (P3).
 *
 * ONE researcher agent works ONE unresolved question. It's a bounded AI-SDK tool-loop on Haiku:
 * it alternates `webSearch` (plan a keyword query, judge the snippets) and `readSource` (read the
 * most promising hits), and stops when it has enough — or when a bound trips. The bounds are the
 * whole point: agency where the task is a search problem, determinism where the guarantees live.
 *
 * Four independent bounds cap the swarm (spec §4/§11):
 *   1. MAX_AGENT_STEPS   — per-agent model-step cap (this module drives ONE step per generateText).
 *   2. the shared PassPool — a FCFS Firecrawl-credit pool shared across all of a pass's agents.
 *   3. getActiveCostTracker().check() — the interior $-cap, run before EVERY step (landmine 4).
 *   4. RECON_FLOOR       — a loop-0 MINIMUM (not a cap): the agent may not stop below it, but the
 *      floor never deadlocks (steps/pool/no-progress still terminate — §11).
 *
 * Every readSource ALWAYS stores the full page as Evidence tagged `questionId: question.id` — the
 * P1 identity tag is what lets an agent's self-invented queries reach the committee (scoping by
 * identity, not by a registered `sourceQuery`; landmine 1). The node (P4) reconciles credits and
 * dedupes across agents; this module dedupes within its own agent and rolls ALL steps' usage into
 * ONE AnnotatedUsage (invariant 7).
 *
 * Model + Firecrawl client are injectable (mirrors the injected clock in firecrawl.ts) so tests
 * drive the agent with a scripted mock model and mocked Firecrawl primitives.
 */
import { generateText, tool, stepCountIs, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";
import type FirecrawlApp from "@mendable/firecrawl-js";
import { webSearchRaw, scrapeOneCached, makeFirecrawl } from "../evidence/firecrawl";
import { type Evidence, contentHash } from "../evidence/store";
import type { Question } from "../schemas/state";
import { researcherModel } from "../models/provider";
import { getActiveCostTracker } from "./cost-tracker";
import { getActiveTrace } from "./trace";
import { limiterForModel } from "./limiter";
import { toAnnotatedUsage, estimateCostUsd, type AnnotatedUsage } from "./eval";
import {
  researcherSystemPrompt,
  researcherReconNudge,
  WEBSEARCH_TOOL_DESCRIPTION,
  READSOURCE_TOOL_DESCRIPTION,
} from "../prompts";
import { MAX_AGENT_STEPS, MAX_SEARCHES_PER_PASS, RECON_FLOOR, READSOURCE_HEAD_CHARS, LLM_MAX_RETRIES, resultsPerQuestionForLoop } from "../params";

/**
 * A FCFS Firecrawl-credit pool shared across all of a pass's concurrent researcher agents.
 * Agents charge REAL post-cache credits (a cache hit is 0 → always free); once the pool is
 * exhausted, tools gate FUTURE calls (webSearch returns a plain message, readSource breaks).
 *
 * Bounded overshoot is accepted by design — the same philosophy the cost-tracker documents: we
 * gate on `exhausted` BEFORE a call and book the real credits AFTER, so a single in-flight call
 * can drive `remaining` ≤ 0 by at most that one call. We never reserve against a guessed cost.
 *
 * P4 seeds it `new PassPool(Math.min(budgetRemaining, Math.ceil(initialBudget × MAX_LOOP_SPEND_FRACTION)))`
 * — the `Math.min` clamp is load-bearing on later loops (mirror graph.ts:319). P3 tests construct
 * pools directly.
 */
export class PassPool {
  private remaining: number;
  private spentCredits = 0;
  private billableCalls = 0;
  constructor(seed: number) {
    this.remaining = seed;
  }
  get exhausted(): boolean {
    return this.remaining <= 0;
  }
  /** Book real post-cache credits (cache hit = 0 → free). May drive remaining ≤ 0; bounded overshoot accepted. */
  charge(realCredits: number): void {
    this.remaining -= realCredits;
    this.spentCredits += realCredits;
    // A cache hit charges 0 → no billable Firecrawl call; a live search/scrape charges >0 → exactly
    // one call. Counting here keeps the agentic arm's firecrawlCalls report honest and parallel to
    // the coded arm's `queries.length`.
    if (realCredits > 0) this.billableCalls += 1;
  }
  get spent(): number {
    return this.spentCredits;
  }
  /** Number of billable (non-cache-hit) Firecrawl calls charged against this pool. */
  get calls(): number {
    return this.billableCalls;
  }
}

/** Metadata carried from a search hit onto the Evidence it becomes when read. */
interface HitMeta {
  title: string;
  snippet: string;
  sourceQuery: string;
}

/** A working-memo entry the agent sees per read source (title + head only; full page is stored). */
interface SourceMemo {
  title: string;
  url: string;
  head: string;
}

/** Dedupe Evidence by contentHash, keeping first occurrence. */
function dedupeByContentHash(items: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const e of items) {
    if (seen.has(e.contentHash)) continue;
    seen.add(e.contentHash);
    out.push(e);
  }
  return out;
}

const BUDGET_EXHAUSTED_MESSAGE =
  "The retrieval budget for this pass is exhausted — stop searching and finish.";
const SEARCH_CAP_MESSAGE =
  "You have used your one web search for this pass. Do NOT search again — read the most relevant of " +
  "the hits you already have (readSource), then finish. If the evidence is still thin, that is fine: " +
  "the research loop will run another, sharper search on the next pass.";
const READ_CEILING_MESSAGE =
  "You have read enough sources for this pass — stop reading and finish. Any further sources this pass " +
  "are dropped; the research loop will read more on the next pass if a gap remains.";

/**
 * Run ONE researcher agent for `question` on this pass. `mission` (the user message) says what to
 * look for: loop-0 reconnaissance, or the question's contested evidential gaps on later loops.
 *
 * @param loopIteration  tags `Evidence.loopIteration` AND selects the recon floor (RECON_FLOOR on
 *                       loop 0, else 0). REQUIRED — a superset of the spec's signature.
 * @param seenUrls       urls already gathered (this loop or by prior loops) — seeds the per-agent
 *                       read-set so the agent never re-scrapes what the run already holds.
 * @param passPool       the shared FCFS credit pool for this pass.
 * @param opts.maxReads  per-pass evidence CEILING — the max sources this agent may STORE. Defaults to
 *                       `resultsPerQuestionForLoop(loopIteration)` (3 on recon, 6 on gap passes), the
 *                       coded arm's exact per-pass depth, so the committee sees the SAME evidence
 *                       VOLUME as the coded arm (eval parity — the arms differ in source QUALITY, not
 *                       count). A hard stop: once stored count hits it, readSource stores nothing more.
 */
export async function runResearcher(
  question: Question,
  mission: string,
  loopIteration: number,
  seenUrls: Set<string>,
  passPool: PassPool,
  opts?: { model?: LanguageModel; firecrawl?: FirecrawlApp; maxReads?: number },
): Promise<{ evidence: Evidence[]; usage: AnnotatedUsage }> {
  const model = opts?.model ?? researcherModel;
  const modelId = typeof model === "string" ? model : model.modelId;
  const firecrawl = opts?.firecrawl ?? makeFirecrawl();
  // Per-pass evidence ceiling — default to the coded arm's per-pass depth so standalone/test callers
  // get eval-parity volume automatically; the node passes it explicitly (belt-and-suspenders).
  const maxReads = opts?.maxReads ?? resultsPerQuestionForLoop(loopIteration);

  // Per-agent closures the two tools mutate.
  const collected: Evidence[] = [];
  const searchHits = new Map<string, HitMeta>();
  const readUrls = new Set<string>(seenUrls); // seed from prior loops — never re-scrape
  let firstQuery: string | undefined; // sourceQuery fallback for a read that wasn't in searchHits
  let searchCount = 0; // web searches issued this pass — capped at MAX_SEARCHES_PER_PASS

  const webSearch = tool({
    description: WEBSEARCH_TOOL_DESCRIPTION,
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) => {
      getActiveCostTracker()?.check(); // interior $-cap on every tool call
      // Search cap (the coded arm's fixed 1-query-per-question discipline): once used, refuse further
      // searches so the agent commits to READING its hits instead of running a query-refinement
      // treadmill. Enforced in code — the prompt is only a hint. Charges nothing, hits no network.
      if (searchCount >= MAX_SEARCHES_PER_PASS) return SEARCH_CAP_MESSAGE;
      if (passPool.exhausted) return BUDGET_EXHAUSTED_MESSAGE; // graceful, NOT a throw
      searchCount += 1;
      if (firstQuery === undefined) firstQuery = query;
      const { hits, credits } = await webSearchRaw(query, firecrawl);
      passPool.charge(credits);
      for (const h of hits) {
        // first-wins: the query that FIRST surfaced a url owns its sourceQuery tag.
        if (!searchHits.has(h.url)) {
          searchHits.set(h.url, { title: h.title, snippet: h.snippet, sourceQuery: query });
        }
      }
      getActiveTrace()?.log("researcher:webSearch", {
        questionId: question.id,
        query,
        hits: hits.length,
        credits,
        loopIteration,
      });
      return hits.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet }));
    },
  });

  const readSource = tool({
    description: READSOURCE_TOOL_DESCRIPTION,
    inputSchema: z.object({ urls: z.array(z.string()) }),
    execute: async ({ urls }) => {
      getActiveCostTracker()?.check(); // interior $-cap on every tool call
      const memos: (SourceMemo | { url?: string; note: string })[] = [];
      let hitCeiling = false;
      for (const url of urls) {
        // Per-pass evidence ceiling (eval parity): stop STORING once this pass's stored count reaches
        // maxReads — same graceful partial-read break as pool exhaustion. The committee then sees the
        // coded arm's per-pass VOLUME, so deliberation cost matches by construction. Hard stop in code.
        if (collected.length >= maxReads) {
          hitCeiling = true;
          break;
        }
        if (readUrls.has(url)) {
          memos.push({ url, note: "already gathered" });
          continue;
        }
        if (passPool.exhausted) break; // partial multi-URL read until the cap — then stop
        const { content, domain, credits } = await scrapeOneCached(url, firecrawl);
        passPool.charge(credits);
        readUrls.add(url);
        // ALWAYS store full Evidence — even empty content (a PDF / failed scrape) is still citable
        // from its snippet. questionId is the P1 identity tag: the whole point.
        const hash = contentHash(content || url);
        const meta =
          searchHits.get(url) ?? { title: domain, snippet: "", sourceQuery: firstQuery ?? mission };
        collected.push({
          id: hash,
          url,
          domain,
          title: meta.title,
          snippet: meta.snippet,
          content,
          contentHash: hash,
          sourceQuery: meta.sourceQuery,
          loopIteration,
          questionId: question.id,
        });
        memos.push({ title: meta.title, url, head: content.slice(0, READSOURCE_HEAD_CHARS) });
      }
      // At the ceiling: tell the model it has read enough this pass so it finishes instead of retrying.
      if (hitCeiling) memos.push({ note: READ_CEILING_MESSAGE });
      getActiveTrace()?.log("researcher:readSource", {
        questionId: question.id,
        requested: urls.length,
        stored: memos.filter((m) => "head" in m).length,
        loopIteration,
      });
      return memos;
    },
  });

  // Recon floor: loop 0 is reconnaissance (a MINIMUM before the agent may finish); later loops
  // target a named gap, so no floor. Enforced by re-driving the loop, never a deadlock. Clamped to
  // the ceiling so the floor can never exceed maxReads — on loop 0, RECON_FLOOR (3) == maxReads (3),
  // so the agent reads EXACTLY 3 (floor == ceiling), matching the coded grounding depth.
  const reconFloor = loopIteration === 0 ? Math.min(RECON_FLOOR, maxReads) : 0;

  const messages: ModelMessage[] = [{ role: "user", content: mission }];
  const acc = { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 };
  let steps = 0;
  // True after we nudged an under-floor agent that tried to stop — if the NEXT step still makes no
  // tool call, the nudge failed and more can't help, so we stop (no deadlock; §11).
  let nudgePending = false;

  while (steps < MAX_AGENT_STEPS && !passPool.exhausted) {
    getActiveCostTracker()?.check(); // interior $-cap BEFORE every step — plain throw → propagates

    const res = await limiterForModel(modelId)(() =>
      generateText({
        model,
        system: researcherSystemPrompt(question),
        messages,
        tools: { webSearch, readSource },
        stopWhen: [stepCountIs(1)], // one model step per generateText → check() gates every step
        maxRetries: LLM_MAX_RETRIES,
      }),
    );
    steps += 1;

    const annotated = toAnnotatedUsage(res.totalUsage, modelId, `researcher:${question.id}`);
    getActiveCostTracker()?.record(annotated);
    acc.promptTokens += annotated.promptTokens;
    acc.completionTokens += annotated.completionTokens;
    acc.cachedPromptTokens += annotated.cachedPromptTokens ?? 0;
    getActiveTrace()?.logLlmCall(
      `researcher:${question.id}`,
      { model: modelId, prompt: messages, loopIteration },
      res.text,
      res.totalUsage,
    );

    messages.push(...res.response.messages); // continuation context (assistant + tool results)

    const madeToolCall = res.steps.some((s) => s.toolCalls.length > 0);
    if (madeToolCall) {
      // Actively gathering — let it keep going (bounded by MAX_AGENT_STEPS / the pool). The recon
      // floor is a minimum, never a cap: we do NOT stop just because it's been met.
      nudgePending = false;
      continue;
    }

    // The model made no tool call → it wants to stop.
    if (collected.length >= reconFloor) break; // floor met (or reconFloor 0) → honor the stop
    if (nudgePending) break; // already nudged and it STILL gathered nothing → stop, no deadlock
    messages.push({ role: "user", content: researcherReconNudge(collected.length, reconFloor) });
    nudgePending = true;
  }

  // Invariant 7: totalUsage across ALL steps, rolled into ONE AnnotatedUsage for this agent.
  const usage: AnnotatedUsage = {
    model: modelId,
    promptTokens: acc.promptTokens,
    completionTokens: acc.completionTokens,
    cachedPromptTokens: acc.cachedPromptTokens,
    label: `researcher:${question.id}`,
    costUsd: estimateCostUsd({
      model: modelId,
      promptTokens: acc.promptTokens,
      completionTokens: acc.completionTokens,
      cachedPromptTokens: acc.cachedPromptTokens,
    }),
  };

  return { evidence: dedupeByContentHash(collected), usage };
}
