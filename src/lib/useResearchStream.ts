"use client";

import { useState, useCallback, useRef } from "react";
import type { ResearchEvent, ResearchPhase, GateScore } from "./research-events";
import { researchPhaseFor } from "./research-events";
import type { Question } from "./schemas/state";
import type { Evidence } from "./schemas/evidence";
import type { Claim } from "./schemas/claim";
import type { AnnotatedUsage } from "./orchestration/eval";
import type { ResearchReport } from "./orchestration/graph";
import type { RunMechanics } from "./orchestration/mechanics";

export interface QuestionStatus {
  question: Question;
  status: "pending" | "retrieving" | "debating" | "resolved" | "looping";
  evidenceCount: number;
  claimCount: number;
  aggregateConfidence: number;
  currentLoop: number;
  /**
   * Whether this loop's debate node actually re-ran the committee for this question
   * ("debated") or reused its prior claim because it wasn't in `debate:begin.questionIds`
   * ("skipped") — set at `debate:begin` (board spec §3b). "pending" until the first
   * `debate:begin` this question participates in.
   */
  debateOutcome: "pending" | "skipped" | "debated";
  /** Max `debateRound` seen across this question's streamed claims (0 = opening only). */
  debateRounds: number;
}

/** One researcher-agent pass over a question (agentic arm only) — the window-shopping story. */
export interface ResearcherPass {
  loop: number;
  mission: string;
  searches: { query: string; hits: number; capped: boolean }[];
  reads: { stored: number; requested: number; hitCeiling: boolean }[];
  done?: { evidenceCount: number; searchCalls: number };
}

export interface GateDecision {
  loopIteration: number;
  gateScores: GateScore[];
  resolvedIds: string[];
  unresolvedIds: string[];
  continueLoop: boolean;
}

export interface LoopSnapshot {
  iteration: number;
  evidenceCount: number;
  claimCount: number;
  questionConfidences: Record<string, number>;
}

export interface ResearchUsage {
  calls: AnnotatedUsage[];
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostUsd: number;
  firecrawlCalls: number;
  firecrawlCredits: number;
}

export interface ResearchUIState {
  phase: ResearchPhase | "idle";
  topic: string;
  activeNode: string | null;
  completedNodes: string[];
  loopIteration: number;
  loopHistory: LoopSnapshot[];
  questions: QuestionStatus[];
  evidence: Evidence[];
  evidenceByQuestion: Record<string, Evidence[]>;
  claims: Claim[];
  claimsByQuestion: Record<string, Claim[]>;
  /** Round-0 blind-opening claims per question (§3c) — replaced (not appended) when a question's
   *  committee re-runs on a later loop, detected via the claim's `loopIteration`. */
  openingsByQuestion: Record<string, Claim[]>;
  /** Conversational rounds (round >= 1) per question, for the deliberation drill-down timeline. */
  roundsByQuestion: Record<string, { round: number; claims: Claim[] }[]>;
  /** Per-question researcher-agent passes (agentic arm), one entry per begin, closed by done. */
  researcherByQuestion: Record<string, ResearcherPass[]>;
  gateDecisions: GateDecision[];
  usage: ResearchUsage;
  trace: string[];
  report: ResearchReport | null;
  /** The run-mechanics receipt (§6 Phase 5) — set from the terminal research:mechanics event. */
  mechanics: RunMechanics | null;
  error: string | null;
  running: boolean;
}

export const initialResearchState: ResearchUIState = {
  phase: "idle",
  topic: "",
  activeNode: null,
  completedNodes: [],
  loopIteration: 0,
  loopHistory: [],
  questions: [],
  evidence: [],
  evidenceByQuestion: {},
  claims: [],
  claimsByQuestion: {},
  openingsByQuestion: {},
  roundsByQuestion: {},
  researcherByQuestion: {},
  gateDecisions: [],
  usage: {
    calls: [],
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCostUsd: 0,
    firecrawlCalls: 0,
    firecrawlCredits: 0,
  },
  trace: [],
  report: null,
  mechanics: null,
  error: null,
  running: false,
};

function addUsage(prev: ResearchUsage, u: AnnotatedUsage): ResearchUsage {
  return {
    calls: [...prev.calls, u],
    totalPromptTokens: prev.totalPromptTokens + u.promptTokens,
    totalCompletionTokens: prev.totalCompletionTokens + u.completionTokens,
    totalCostUsd: prev.totalCostUsd + u.costUsd,
    firecrawlCalls: prev.firecrawlCalls,
    firecrawlCredits: prev.firecrawlCredits,
  };
}

function meanConfidence(claims: Claim[]): number {
  if (claims.length === 0) return 0;
  return claims.reduce((s, c) => s + c.confidence, 0) / claims.length;
}

/** Apply `updater` to the LATEST pass in the list (the one `begin` most recently opened). */
function updateLatestPass(
  passes: ResearcherPass[],
  updater: (p: ResearcherPass) => ResearcherPass,
): ResearcherPass[] {
  if (passes.length === 0) return passes;
  return [...passes.slice(0, -1), updater(passes[passes.length - 1])];
}

export function reduce(state: ResearchUIState, ev: ResearchEvent): ResearchUIState {
  const phase = researchPhaseFor(ev.type);

  switch (ev.type) {
    case "research:start":
      return {
        ...initialResearchState,
        phase: "decompose",
        topic: ev.topic,
        running: true,
        trace: [`$ research started: "${ev.topic}"`],
      };

    case "decompose:begin":
      return {
        ...state,
        phase,
        activeNode: "decompose",
        trace: [...state.trace, "$ decomposing topic into research questions..."],
      };

    case "decompose:done": {
      const questions: QuestionStatus[] = ev.questions.map(q => ({
        question: q,
        status: "pending",
        evidenceCount: 0,
        claimCount: 0,
        aggregateConfidence: 0,
        currentLoop: 0,
        debateOutcome: "pending",
        debateRounds: 0,
      }));
      return {
        ...state,
        phase,
        activeNode: null,
        completedNodes: [...state.completedNodes, "decompose"],
        questions,
        trace: [...state.trace, `$ decomposed into ${ev.questions.length} questions`],
      };
    }

    case "retrieve:begin":
      return {
        ...state,
        phase,
        activeNode: "retrieve",
        loopIteration: ev.loopIteration,
        questions: state.questions.map(q =>
          ev.questionIds.includes(q.question.id) || !q.question.resolved
            ? { ...q, status: "retrieving" as const }
            : q,
        ),
        trace: [
          ...state.trace,
          `$ retrieving evidence (loop ${ev.loopIteration}, ${ev.questionIds.length} questions)...`,
        ],
      };

    case "retrieve:progress": {
      const line = `$ ${ev.message}`;
      // Scrape progress is a counter ("scraping pages… 12/28") — overwrite the
      // previous counter line instead of appending 28 near-identical lines.
      const last = state.trace[state.trace.length - 1];
      const trace =
        ev.kind === "scrape" && last?.startsWith("$ scraping pages…")
          ? [...state.trace.slice(0, -1), line]
          : [...state.trace, line];
      return { ...state, phase, trace };
    }

    case "retrieve:evidence": {
      const newEvByQ = { ...state.evidenceByQuestion };
      const qKey = ev.questionId;
      newEvByQ[qKey] = [...(newEvByQ[qKey] ?? []), ev.evidence];
      return {
        ...state,
        evidence: [...state.evidence, ev.evidence],
        evidenceByQuestion: newEvByQ,
        questions: state.questions.map(q =>
          q.question.text === ev.questionId || q.question.id === ev.questionId
            ? { ...q, evidenceCount: q.evidenceCount + 1 }
            : q,
        ),
      };
    }

    case "retrieve:done":
      return {
        ...state,
        activeNode: null,
        completedNodes: state.completedNodes.includes("retrieve")
          ? state.completedNodes
          : [...state.completedNodes, "retrieve"],
        usage: {
          ...state.usage,
          firecrawlCalls: state.usage.firecrawlCalls + ev.firecrawlCalls,
          firecrawlCredits: state.usage.firecrawlCredits + ev.evidenceCount,
        },
        trace: [
          ...state.trace,
          `$ retrieved ${ev.evidenceCount} sources (${ev.firecrawlCalls} firecrawl calls)`,
        ],
      };

    // Agentic researcher lifecycle — drives both the raw trace feed and the board's per-question
    // Loop-cell window-shopping strip (researcherByQuestion, question-board-spec.md §3d).
    case "researcher:begin": {
      const pass: ResearcherPass = { loop: ev.loopIteration, mission: ev.mission, searches: [], reads: [] };
      return {
        ...state,
        phase,
        activeNode: "retrieve",
        researcherByQuestion: {
          ...state.researcherByQuestion,
          [ev.questionId]: [...(state.researcherByQuestion[ev.questionId] ?? []), pass],
        },
        trace: [...state.trace, `$ researcher on ${ev.questionId} (loop ${ev.loopIteration}): ${ev.mission.slice(0, 80)}`],
      };
    }

    case "researcher:search":
      return {
        ...state,
        phase,
        researcherByQuestion: {
          ...state.researcherByQuestion,
          [ev.questionId]: updateLatestPass(state.researcherByQuestion[ev.questionId] ?? [], p => ({
            ...p,
            searches: [...p.searches, { query: ev.query, hits: ev.hits, capped: ev.capped }],
          })),
        },
        trace: [
          ...state.trace,
          ev.capped
            ? `$   search capped — committing to read (wanted "${ev.query.slice(0, 60)}")`
            : `$   searched "${ev.query.slice(0, 60)}" — ${ev.hits} hits`,
        ],
      };

    case "researcher:read":
      return {
        ...state,
        phase,
        researcherByQuestion: {
          ...state.researcherByQuestion,
          [ev.questionId]: updateLatestPass(state.researcherByQuestion[ev.questionId] ?? [], p => ({
            ...p,
            reads: [...p.reads, { stored: ev.stored, requested: ev.requested, hitCeiling: ev.hitCeiling }],
          })),
        },
        trace: [
          ...state.trace,
          `$   read ${ev.stored}/${ev.requested} sources${ev.hitCeiling ? " (ceiling — enough this pass)" : ""}`,
        ],
      };

    case "researcher:done":
      return {
        ...state,
        phase,
        researcherByQuestion: {
          ...state.researcherByQuestion,
          [ev.questionId]: updateLatestPass(state.researcherByQuestion[ev.questionId] ?? [], p => ({
            ...p,
            done: { evidenceCount: ev.evidenceCount, searchCalls: ev.searchCalls },
          })),
        },
        trace: [...state.trace, `$ researcher ${ev.questionId} done: ${ev.evidenceCount} sources, ${ev.searchCalls} search(es)`],
      };

    case "debate:begin":
      return {
        ...state,
        phase,
        activeNode: "debate",
        // questionIds is exactly questionsNeedingDebate — the questions whose committee WILL
        // re-run this loop. An unresolved question absent from it wasn't selected (see board
        // spec §3b); a resolved question is left untouched (it's done, win or lose).
        questions: state.questions.map(q => {
          if (q.question.resolved) return q;
          const debating = ev.questionIds.includes(q.question.id);
          return {
            ...q,
            status: debating ? ("debating" as const) : q.status,
            debateOutcome: debating ? ("debated" as const) : ("skipped" as const),
          };
        }),
        trace: [
          ...state.trace,
          `$ committee deliberating on ${ev.questionIds.length} questions (loop ${ev.loopIteration})...`,
        ],
      };

    case "debate:digest":
      return {
        ...state,
        phase,
        trace: [
          ...state.trace,
          `$ digested ${ev.evidenceCount} sources for ${ev.questionId} (loop ${ev.loopIteration})`,
        ],
      };

    case "debate:opening": {
      // Replace (not append) once a NEW loop's openings start arriving for this question — a
      // transcript is ephemeral to one evidence snapshot (mirrors the graph's mergeTranscripts),
      // detected mechanically off the claim's `loopIteration`, never guessed.
      const qid = ev.claim.questionId;
      const existing = state.openingsByQuestion[qid] ?? [];
      const sameLoop = existing.length > 0 && existing[0].loopIteration === ev.claim.loopIteration;
      return {
        ...state,
        phase,
        openingsByQuestion: {
          ...state.openingsByQuestion,
          [qid]: sameLoop ? [...existing, ev.claim] : [ev.claim],
        },
      };
    }

    case "debate:round": {
      const existing = state.roundsByQuestion[ev.questionId] ?? [];
      const sameLoop = existing.length > 0 && existing[0].claims[0]?.loopIteration === ev.claims[0]?.loopIteration;
      return {
        ...state,
        phase,
        roundsByQuestion: {
          ...state.roundsByQuestion,
          [ev.questionId]: sameLoop
            ? [...existing, { round: ev.round, claims: ev.claims }]
            : [{ round: ev.round, claims: ev.claims }],
        },
      };
    }

    case "debate:claim": {
      const newClaims = [...state.claims, ev.claim];
      const newClaimsByQ = { ...state.claimsByQuestion };
      const cqKey = ev.claim.questionId;
      newClaimsByQ[cqKey] = [...(newClaimsByQ[cqKey] ?? []), ev.claim];

      return {
        ...state,
        claims: newClaims,
        claimsByQuestion: newClaimsByQ,
        questions: state.questions.map(q => {
          if (q.question.id !== ev.claim.questionId) return q;
          const qClaims = newClaimsByQ[cqKey] ?? [];
          return {
            ...q,
            claimCount: qClaims.length,
            aggregateConfidence: meanConfidence(qClaims),
            debateRounds: Math.max(q.debateRounds, ev.claim.debateRound),
          };
        }),
        trace: [
          ...state.trace,
          `$ ${ev.claim.agentRole}: confidence ${ev.claim.confidence.toFixed(2)} on ${ev.claim.questionId}`,
        ],
      };
    }

    case "debate:done":
      return {
        ...state,
        activeNode: null,
        completedNodes: state.completedNodes.includes("debate")
          ? state.completedNodes
          : [...state.completedNodes, "debate"],
        trace: [...state.trace, `$ debate complete: ${ev.claimCount} claims from ${ev.claimCount / 4} questions`],
      };

    case "gate:begin":
      return {
        ...state,
        phase,
        activeNode: "gate",
        trace: [...state.trace, `$ gate scoring value of further retrieval (loop ${ev.loopIteration})...`],
      };

    case "gate:done": {
      const decision: GateDecision = {
        loopIteration: ev.loopIteration,
        gateScores: ev.gateScores,
        resolvedIds: ev.resolvedQuestionIds,
        unresolvedIds: ev.unresolvedQuestionIds,
        continueLoop: ev.continueLoop,
      };
      const snapshot: LoopSnapshot = {
        iteration: ev.loopIteration,
        evidenceCount: state.evidence.length,
        claimCount: state.claims.length,
        questionConfidences: Object.fromEntries(
          state.questions.map(q => [q.question.id, q.aggregateConfidence]),
        ),
      };
      return {
        ...state,
        activeNode: null,
        completedNodes: state.completedNodes.includes("gate")
          ? state.completedNodes
          : [...state.completedNodes, "gate"],
        gateDecisions: [...state.gateDecisions, decision],
        loopHistory: [...state.loopHistory, snapshot],
        questions: state.questions.map(q => {
          if (ev.resolvedQuestionIds.includes(q.question.id)) {
            return { ...q, status: "resolved" as const, question: { ...q.question, resolved: true } };
          }
          if (ev.unresolvedQuestionIds.includes(q.question.id) && ev.continueLoop) {
            return { ...q, status: "looping" as const, currentLoop: ev.loopIteration + 1 };
          }
          return q;
        }),
        trace: [
          ...state.trace,
          ev.continueLoop
            ? `$ gate: ${ev.unresolvedQuestionIds.length} questions need more evidence — looping`
            : `$ gate: all questions resolved or budget exhausted — proceeding to synthesis`,
        ],
      };
    }

    case "recommend:begin":
      return {
        ...state,
        phase,
        activeNode: "recommend",
        trace: [...state.trace, "$ synthesizing final report..."],
      };

    case "recommend:done":
      return {
        ...state,
        phase: "done",
        activeNode: null,
        completedNodes: [...state.completedNodes, "recommend"],
        report: ev.report,
        running: false,
        // The run is over — nothing is still "debating"/"retrieving"/"looping" regardless of
        // which loop a question's committee was mid-flight in when the run stopped (e.g. a cost
        // cap ending the loop early). Otherwise that question's badge blinks "debating" forever.
        questions: state.questions.map((q) => (q.status === "resolved" ? q : { ...q, status: "resolved" as const })),
        trace: [...state.trace, "$ research complete"],
      };

    case "research:usage":
      return { ...state, usage: addUsage(state.usage, ev.usage) };

    case "research:mechanics":
      return { ...state, mechanics: ev.mechanics };

    case "research:error":
      return {
        ...state,
        phase: "done",
        activeNode: null,
        running: false,
        error: ev.message,
        trace: [...state.trace, `$ error: ${ev.message}`],
      };
  }
}

/** Pure POST-body builder for start() — factored out so it's unit-testable without a DOM/fetch harness. */
export function buildResearchRequestBody(topic: string, budget?: number, usdBudget?: number) {
  return { topic, budget, usdBudget };
}

export function useResearchStream() {
  const [state, setState] = useState<ResearchUIState>(initialResearchState);
  const controllerRef = useRef<AbortController | null>(null);

  const start = useCallback((topic: string, budget?: number, usdBudget?: number) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setState({
      ...initialResearchState,
      running: true,
      phase: "decompose",
      topic,
    });

    (async () => {
      try {
        const res = await fetch("/api/research/orchestrated", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildResearchRequestBody(topic, budget, usdBudget)),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          setState(s => ({ ...s, running: false, phase: "done", error: `HTTP ${res.status}` }));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6)) as ResearchEvent;
              setState(prev => reduce(prev, event));
            } catch {
              // skip malformed frames
            }
          }
        }

        // The stream ended (reader.read() returned done) without ever delivering a terminal
        // event (recommend:done / research:error) — e.g. the connection dropped mid-run. Without
        // this, `running` stays true forever: the UI just sits on whatever phase it last saw
        // (e.g. "synthesizing final report...") with no way out but a manual reset.
        setState(s =>
          s.running
            ? { ...s, running: false, phase: "done", error: "connection closed before the run finished" }
            : s,
        );
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState(s => ({
          ...s,
          running: false,
          phase: "done",
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    })();
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState(initialResearchState);
  }, []);

  return { state, start, reset };
}
