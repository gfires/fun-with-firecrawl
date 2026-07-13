"use client";

import { useState, useCallback, useRef } from "react";
import type { ResearchEvent, ResearchPhase, GateScore } from "./research-events";
import { researchPhaseFor } from "./research-events";
import type { Question } from "./schemas/state";
import type { Evidence } from "./schemas/evidence";
import type { Claim } from "./schemas/claim";
import type { AnnotatedUsage } from "./orchestration/eval";
import type { ResearchReport } from "./orchestration/graph";

export interface QuestionStatus {
  question: Question;
  status: "pending" | "retrieving" | "debating" | "resolved" | "looping";
  evidenceCount: number;
  claimCount: number;
  aggregateConfidence: number;
  currentLoop: number;
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
  gateDecisions: GateDecision[];
  usage: ResearchUsage;
  trace: string[];
  report: ResearchReport | null;
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

    case "debate:begin":
      return {
        ...state,
        phase,
        activeNode: "debate",
        questions: state.questions.map(q =>
          ev.questionIds.includes(q.question.id)
            ? { ...q, status: "debating" as const }
            : q,
        ),
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

    case "refine:begin":
      return {
        ...state,
        phase,
        activeNode: "refine",
        trace: [
          ...state.trace,
          `$ refining search queries from evidence gaps (loop ${ev.loopIteration}, ${ev.questionIds.length} questions)...`,
        ],
      };

    case "refine:done":
      return {
        ...state,
        activeNode: null,
        completedNodes: state.completedNodes.includes("refine")
          ? state.completedNodes
          : [...state.completedNodes, "refine"],
        trace: [
          ...state.trace,
          `$ refined queries for ${ev.refinedQueries.length} questions`,
        ],
      };

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
        trace: [...state.trace, "$ research complete"],
      };

    case "research:usage":
      return { ...state, usage: addUsage(state.usage, ev.usage) };

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

export function useResearchStream() {
  const [state, setState] = useState<ResearchUIState>(initialResearchState);
  const controllerRef = useRef<AbortController | null>(null);

  const start = useCallback((topic: string, budget?: number) => {
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
          body: JSON.stringify({ topic, budget }),
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
