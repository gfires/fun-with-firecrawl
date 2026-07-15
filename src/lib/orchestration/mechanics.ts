/**
 * mechanics.ts — a pure, LLM-free run-mechanics report.
 *
 * Every orchestrated/agentic run leaves a trace (llm/firecrawl/researcher/debate/gate entries)
 * and a final state (evidence, claims, transcripts). This module reads BOTH and computes the
 * MECHANICS of the run — how much was retrieved, how productively the committee deliberated, how
 * the spend split between "search" (retrieval) and "analyze" (deliberation), and how it converged.
 *
 * Everything here is a real mechanical COUNT or a $ figure derived from actual usage. Per the
 * project's "no vibe floats" rule there are NO invented 0–1 quality scores; the only judgments are
 * threshold-based FLAGS in the formatted report (a starved question, a reading-starved ratio, a
 * degraded run), and those are computed from real counts. Defensive throughout: missing/empty
 * inputs yield zeros, never a throw.
 */
import type { TraceEntry } from "./trace";
import type { ArmTokens } from "./eval";
import { toAnnotatedUsage, estimateCostUsd } from "./eval";
import type { ResearchStateT } from "../schemas/state";
import type { ResponseStanceT } from "../schemas/claim";
import { extractContentions, committeeStance, type CommitteeStance } from "./debate";
import { scopeEvidenceToQuestions } from "./graph";
import { MAX_RUN_COST_USD } from "../params";

/** The five buckets the LLM spend is grouped into for the search-vs-analyze headline. */
export type EffortGroup =
  | "retrieval"
  | "deliberation"
  | "digest"
  | "synthesis"
  | "manager";

const EFFORT_GROUPS: EffortGroup[] = [
  "retrieval",
  "deliberation",
  "digest",
  "synthesis",
  "manager",
];

export interface RunMechanics {
  retrieval: {
    evidenceTotal: number;
    evidencePerQuestion: Record<string, number>;
    starvedQuestions: string[];
    evidenceByLoop: Record<string, number>;
    firecrawlCalls: number;
    firecrawlCredits: number;
    cacheHits: number;
    searchOps: number;
    scrapeOps: number;
    /** Agentic-only: `researcher:webSearch` count (undefined on the coded arm). */
    agentSearches?: number;
    /** Agentic-only: `researcher:readSource` count (undefined on the coded arm). */
    agentReads?: number;
    /** agentSearches / max(1, agentReads); undefined when agentic signals are absent. */
    searchToReadRatio?: number;
    evidencePerCredit: number;
  };
  deliberation: {
    /** Questions whose conversational rounds RAN (round ≥1 present) — a genuine debate. */
    questionsDebated: number;
    /** Questions SKIPPED after the blind opening because the roles showed no genuine disagreement. */
    questionsSkipped: number;
    /** committeeStance breakdown of the skipped questions (how many insufficient vs agreed-answer). */
    skippedByStance: Partial<Record<CommitteeStance, number>>;
    /**
     * Debated questions that actually moved something: a role's stance changed between its round-0
     * and final claim, OR a contention was resolved (a peer conceded). Purely mechanical — the
     * counterpart of a "debated but unanimous" waste flag; no invented quality score.
     */
    productiveQuestions: number;
    conversationalRounds: number;
    avgRoundsPerQuestion: number;
    moved: number;
    newRebuttals: number;
    concessions: number;
    contentions: { evidential: number; interpretive: number };
    confidence: { mean: number; perQuestionSpread: Record<string, number> };
    stanceMix: { rebut: number; concede: number; extend: number };
  };
  effortSplit: {
    costByGroup: Record<EffortGroup, number>;
    pctByGroup: Record<EffortGroup, number>;
    tokensByGroup: Record<EffortGroup, { in: number; out: number }>;
    usdPerCredit: number;
    costByLoop: Record<string, number>;
  };
  convergence: {
    loopIterations: number;
    reason: string;
    degraded: boolean;
    totalCostUsd: number;
    capUsd: number;
    overCap: boolean;
  };
}

// --- trace entry views ------------------------------------------------------
// The trace stores `data: unknown`; these read the fields we log without trusting shape.

function entriesOfType(entries: TraceEntry[], type: string): Record<string, unknown>[] {
  return entries
    .filter((e) => e.type === type && e.data != null && typeof e.data === "object")
    .map((e) => e.data as Record<string, unknown>);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Map an `llm:call` label to its effort group. Prefix-matched so per-role / per-question
 * suffixes (`committee:historian`, `researcher:q1`, `digest:q2`) collapse into one bucket.
 * Returns null for an unrecognised label (it's then omitted from the split rather than guessed).
 */
export function effortGroupForLabel(label: string): EffortGroup | null {
  if (label.startsWith("researcher:") || label === "triage") return "retrieval";
  if (label.startsWith("committee:") || label.startsWith("debate:")) return "deliberation";
  if (label.startsWith("digest:")) return "digest";
  if (label.startsWith("synthesis:")) return "synthesis";
  if (label === "intake" || label === "decompose" || label === "gate" || label === "refine")
    return "manager";
  return null;
}

function zeroByGroup(): Record<EffortGroup, number> {
  return { retrieval: 0, deliberation: 0, digest: 0, synthesis: 0, manager: 0 };
}

// --- main -------------------------------------------------------------------

export function computeRunMechanics(
  entries: TraceEntry[],
  state: ResearchStateT,
  tokens: ArmTokens,
): RunMechanics {
  const safeEntries = Array.isArray(entries) ? entries : [];
  const questions = state.questions ?? [];
  const evidence = state.evidence ?? [];
  const transcripts = state.debateTranscripts ?? {};

  // -- retrieval --
  const scoped = scopeEvidenceToQuestions(questions, evidence);
  const evidencePerQuestion: Record<string, number> = {};
  const starvedQuestions: string[] = [];
  for (const qq of questions) {
    const n = (scoped.get(qq.id) ?? []).length;
    evidencePerQuestion[qq.id] = n;
    if (n === 0) starvedQuestions.push(qq.id);
  }
  const evidenceByLoop: Record<string, number> = {};
  for (const e of evidence) {
    const key = String(e.loopIteration ?? 0);
    evidenceByLoop[key] = (evidenceByLoop[key] ?? 0) + 1;
  }

  const firecrawlEntries = entriesOfType(safeEntries, "firecrawl:call");
  const opCount = (op: string) =>
    firecrawlEntries.filter((d) => str(d.operation) === op).length;
  const cacheHits = firecrawlEntries.filter((d) =>
    str(d.operation).endsWith("-cache-hit"),
  ).length;

  const webSearchEntries = entriesOfType(safeEntries, "researcher:webSearch");
  const readSourceEntries = entriesOfType(safeEntries, "researcher:readSource");
  const hasAgentic = webSearchEntries.length > 0 || readSourceEntries.length > 0;
  const agentSearches = hasAgentic ? webSearchEntries.length : undefined;
  const agentReads = hasAgentic ? readSourceEntries.length : undefined;
  const searchToReadRatio =
    agentSearches === undefined || agentReads === undefined
      ? undefined
      : agentSearches / Math.max(1, agentReads);

  const evidenceTotal = evidence.length;
  const firecrawlCredits = num(state.firecrawlCredits);

  // -- deliberation --
  const debateRoundEntries = entriesOfType(safeEntries, "debate:round");
  const moved = debateRoundEntries.reduce((s, d) => s + num(d.moved), 0);
  const newRebuttals = debateRoundEntries.reduce((s, d) => s + num(d.newRebuttals), 0);

  let questionsDebated = 0;
  let questionsSkipped = 0;
  let productiveQuestions = 0;
  const skippedByStance: Partial<Record<CommitteeStance, number>> = {};
  let conversationalRounds = 0;
  let evidential = 0;
  let interpretive = 0;
  const stanceMix = { rebut: 0, concede: 0, extend: 0 };
  const perQuestionSpread: Record<string, number> = {};
  const finalConfidences: number[] = [];

  for (const [qid, rounds] of Object.entries(transcripts)) {
    if (!Array.isArray(rounds) || rounds.length === 0) continue;
    // Rounds RAN (≥1 conversational round) → a real debate; only the blind opening → skipped on
    // agreement. Skipped questions are bucketed by the committee's position over the opening claims.
    const ran = rounds.length > 1;
    if (ran) {
      questionsDebated += 1;
      conversationalRounds += rounds.length - 1; // round 0 is the opening, not debate
    } else {
      questionsSkipped += 1;
      const stance = committeeStance(rounds[0]?.claims ?? []);
      skippedByStance[stance] = (skippedByStance[stance] ?? 0) + 1;
    }

    const finalRound = rounds[rounds.length - 1];
    const claims = finalRound?.claims ?? [];
    if (claims.length === 0) continue;

    // Productive = debated AND something moved: a role's stance shifted round-0 → final, or a peer
    // conceded in a conversational round (a contention resolved). Both are read straight off the
    // transcript — no invented score.
    if (ran) {
      const opening = rounds[0]?.claims ?? [];
      const openStance = new Map(opening.map((c) => [c.agentRole, c.stance]));
      const stanceMoved = claims.some(
        (c) => openStance.has(c.agentRole) && openStance.get(c.agentRole) !== c.stance,
      );
      const contentionResolved = rounds
        .slice(1)
        .some((r) => (r.claims ?? []).some((c) => (c.responses ?? []).some((resp) => resp.stance === "concede")));
      if (stanceMoved || contentionResolved) productiveQuestions += 1;
    }

    for (const c of extractContentions(qid, claims)) {
      if (c.type === "evidential") evidential += 1;
      else interpretive += 1;
    }
    const confs = claims.map((c) => c.confidence);
    perQuestionSpread[qid] = Math.max(...confs) - Math.min(...confs);
    finalConfidences.push(...confs);
    for (const c of claims) {
      for (const r of c.responses ?? []) {
        const stance = r.stance as ResponseStanceT;
        if (stance in stanceMix) stanceMix[stance] += 1;
      }
    }
  }
  const concessions = stanceMix.concede;
  const confidenceMean =
    finalConfidences.length > 0
      ? finalConfidences.reduce((a, b) => a + b, 0) / finalConfidences.length
      : 0;
  const avgRoundsPerQuestion =
    questionsDebated > 0 ? conversationalRounds / questionsDebated : 0;

  // -- effortSplit --
  const costByGroup = zeroByGroup();
  const tokensByGroup: Record<EffortGroup, { in: number; out: number }> = {
    retrieval: { in: 0, out: 0 },
    deliberation: { in: 0, out: 0 },
    digest: { in: 0, out: 0 },
    synthesis: { in: 0, out: 0 },
    manager: { in: 0, out: 0 },
  };
  const costByLoop: Record<string, number> = {};

  for (const d of entriesOfType(safeEntries, "llm:call")) {
    const label = str(d.label);
    const request = (d.request ?? {}) as Record<string, unknown>;
    const model = str(request.model);
    const usage = (d.usage ?? {}) as Record<string, unknown>;
    // Forward the AI SDK v7 cache breakdown (inputTokenDetails.{cacheReadTokens,cacheWriteTokens})
    // so the split bills cache-reads at the read rate — matching the live cost tracker. Without this
    // the report double-counts cached re-reads at full price and over-states deliberation cost.
    const rawDetails = usage.inputTokenDetails;
    const inputTokenDetails =
      rawDetails && typeof rawDetails === "object"
        ? {
            cacheReadTokens: num((rawDetails as Record<string, unknown>).cacheReadTokens),
            cacheWriteTokens: num((rawDetails as Record<string, unknown>).cacheWriteTokens),
            noCacheTokens: num((rawDetails as Record<string, unknown>).noCacheTokens),
          }
        : undefined;
    const annotated = toAnnotatedUsage(
      {
        inputTokens: num(usage.inputTokens),
        outputTokens: num(usage.outputTokens),
        cachedInputTokens:
          typeof usage.cachedInputTokens === "number" ? usage.cachedInputTokens : undefined,
        ...(inputTokenDetails ? { inputTokenDetails } : {}),
      },
      model,
      label,
    );
    const cost = estimateCostUsd(annotated);

    const group = effortGroupForLabel(label);
    if (group) {
      costByGroup[group] += cost;
      tokensByGroup[group].in += annotated.promptTokens;
      tokensByGroup[group].out += annotated.completionTokens;
    }

    const loopKey =
      typeof request.loopIteration === "number" ? String(request.loopIteration) : "-";
    costByLoop[loopKey] = (costByLoop[loopKey] ?? 0) + cost;
  }

  const groupTotal = EFFORT_GROUPS.reduce((s, g) => s + costByGroup[g], 0);
  const pctByGroup = zeroByGroup();
  for (const g of EFFORT_GROUPS) {
    pctByGroup[g] = groupTotal > 0 ? (costByGroup[g] / groupTotal) * 100 : 0;
  }

  const totalCostUsd = num(tokens?.totalCostUsd);
  const usdPerCredit = totalCostUsd / Math.max(1, firecrawlCredits);

  // -- convergence --
  const gateReasons = entriesOfType(safeEntries, "gate:converged");
  const lastGateReason = gateReasons.length ? str(gateReasons[gateReasons.length - 1].reason) : "";
  const finalStateReason = (() => {
    const fs = entriesOfType(safeEntries, "final_state");
    if (!fs.length) return "";
    const last = fs[fs.length - 1];
    return last.converged === true ? "converged" : "";
  })();
  const reason = lastGateReason || finalStateReason || (state.converged ? "converged" : "incomplete");
  const degraded =
    entriesOfType(safeEntries, "budget_exceeded").length > 0 ||
    entriesOfType(safeEntries, "recursion_limit").length > 0;

  return {
    retrieval: {
      evidenceTotal,
      evidencePerQuestion,
      starvedQuestions,
      evidenceByLoop,
      firecrawlCalls: num(state.firecrawlCalls),
      firecrawlCredits,
      cacheHits,
      searchOps: opCount("search"),
      scrapeOps: opCount("scrape"),
      agentSearches,
      agentReads,
      searchToReadRatio,
      evidencePerCredit: evidenceTotal / Math.max(1, firecrawlCredits),
    },
    deliberation: {
      questionsDebated,
      questionsSkipped,
      skippedByStance,
      productiveQuestions,
      conversationalRounds,
      avgRoundsPerQuestion,
      moved,
      newRebuttals,
      concessions,
      contentions: { evidential, interpretive },
      confidence: { mean: confidenceMean, perQuestionSpread },
      stanceMix,
    },
    effortSplit: {
      costByGroup,
      pctByGroup,
      tokensByGroup,
      usdPerCredit,
      costByLoop,
    },
    convergence: {
      loopIterations: num(state.loopIteration),
      reason,
      degraded,
      totalCostUsd,
      capUsd: MAX_RUN_COST_USD,
      overCap: totalCostUsd > MAX_RUN_COST_USD,
    },
  };
}

// --- formatting -------------------------------------------------------------

const usd = (n: number) => `$${n.toFixed(4)}`;
const pct = (n: number) => `${n.toFixed(0)}%`;

/** Compact, sectioned, human-readable render of a RunMechanics. Never throws. */
export function formatMechanicsReport(m: RunMechanics): string {
  const r = m.retrieval;
  const d = m.deliberation;
  const e = m.effortSplit;
  const c = m.convergence;
  const L: string[] = [];

  L.push("═══ RUN MECHANICS ═══");

  // RETRIEVAL
  const starvedFlag =
    r.starvedQuestions.length > 0
      ? `   ⚠ ${r.starvedQuestions.length} starved question${r.starvedQuestions.length > 1 ? "s" : ""} [${r.starvedQuestions.join(", ")}]`
      : "";
  L.push("RETRIEVAL");
  L.push(
    `  evidence ${r.evidenceTotal} (${r.evidencePerCredit.toFixed(2)}/credit) · ` +
      `firecrawl ${r.firecrawlCalls} calls / ${r.firecrawlCredits} credits · ` +
      `${r.searchOps} search / ${r.scrapeOps} scrape / ${r.cacheHits} cache-hit${starvedFlag}`,
  );
  if (r.agentSearches !== undefined) {
    const ratio = r.searchToReadRatio ?? 0;
    const ratioFlag = ratio > 1 ? `  ⚠ search:read ${ratio.toFixed(1)} (reading-starved)` : "";
    L.push(`  agent: ${r.agentSearches} searches / ${r.agentReads} reads${ratioFlag}`);
  }

  // DELIBERATION
  const insufficientSkipped = d.skippedByStance.insufficient ?? 0;
  const agreedSkipped = (d.skippedByStance.supports ?? 0) + (d.skippedByStance.opposes ?? 0);
  const unproductiveDebated = d.questionsDebated - d.productiveQuestions;
  const wasteFlag =
    unproductiveDebated > 0 ? `  ⚠ ${unproductiveDebated} debated but unanimous` : "";
  L.push("DELIBERATION");
  L.push(
    `  debated ${d.questionsDebated} · skipped ${d.questionsSkipped} ` +
      `(${insufficientSkipped} insufficient→retrieve, ${agreedSkipped} agreed) · ` +
      `productive ${d.productiveQuestions}/${d.questionsDebated}${wasteFlag}`,
  );
  L.push(
    `  ${d.conversationalRounds} conversational rounds ` +
      `(${d.avgRoundsPerQuestion.toFixed(1)}/q) · ${d.moved} moves / ${d.newRebuttals} new rebuttals`,
  );
  L.push(
    `  contentions ${d.contentions.evidential} evidential / ${d.contentions.interpretive} interpretive · ` +
      `stances ${d.stanceMix.rebut} rebut / ${d.stanceMix.concede} concede / ${d.stanceMix.extend} extend · ` +
      `mean conf ${d.confidence.mean.toFixed(2)}`,
  );

  // EFFORT SPLIT
  L.push("EFFORT SPLIT (search vs analyze)");
  for (const g of EFFORT_GROUPS) {
    if (e.costByGroup[g] <= 0 && e.pctByGroup[g] <= 0) continue;
    const t = e.tokensByGroup[g];
    L.push(
      `  ${g.padEnd(12)} ${usd(e.costByGroup[g]).padStart(9)}  ${pct(e.pctByGroup[g]).padStart(4)}  ` +
        `(${t.in.toLocaleString()} in / ${t.out.toLocaleString()} out)`,
    );
  }
  L.push(`  ${usd(e.usdPerCredit)}/credit`);

  // CONVERGENCE
  const degradedFlag = c.degraded ? "  ⚠ degraded" : "";
  const capFlag = c.overCap ? `  ⚠ over cap` : "";
  L.push("CONVERGENCE");
  L.push(
    `  ${c.loopIterations} loops · reason "${c.reason}" · ` +
      `${usd(c.totalCostUsd)} / ${usd(c.capUsd)} cap${capFlag}${degradedFlag}`,
  );

  return L.join("\n");
}
