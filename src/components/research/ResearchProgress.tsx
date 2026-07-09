"use client";

import { useState, useEffect, useRef } from "react";
import type { ResearchUIState } from "@/lib/useResearchStream";
import { PipelineGraph } from "./PipelineGraph";
import { QuestionTracker } from "./QuestionTracker";
import { AgentPanel } from "./AgentPanel";
import { EvidenceFeed } from "./EvidenceFeed";
import { GateDecisionPanel } from "./GateDecisionPanel";
import { CostCounter } from "./CostCounter";

function useElapsed(running: boolean, resetKey: string): number {
  const [elapsed, setElapsed] = useState(0);
  const t0 = useRef(Date.now());

  useEffect(() => {
    t0.current = Date.now();
    setElapsed(0);
  }, [resetKey]);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setElapsed(Date.now() - t0.current), 100);
    return () => clearInterval(id);
  }, [running]);

  return elapsed;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

interface Props {
  state: ResearchUIState;
  done?: boolean;
}

export function ResearchProgress({ state, done = false }: Props) {
  const elapsed = useElapsed(state.running, state.topic);
  const traceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (traceRef.current) {
      traceRef.current.scrollTop = traceRef.current.scrollHeight;
    }
  }, [state.trace.length]);

  const lastGate = state.gateDecisions[state.gateDecisions.length - 1];
  const continueLoop = lastGate?.continueLoop ?? false;

  return (
    <div className="relative mx-auto w-full max-w-5xl space-y-4">
      {/* Sweep animation */}
      {!done && state.running && (
        <div className="pointer-events-none absolute inset-0 z-10 animate-sweep bg-gradient-to-b from-accent/5 via-accent/10 to-transparent" />
      )}

      {/* Header */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="eyebrow">Deep Research</div>
          <h2 className="text-lg font-semibold text-fg">
            {state.topic}
          </h2>
        </div>
        <div className="flex items-center gap-3">
          <CostCounter usage={state.usage} />
          <span className="nums text-sm text-mute">
            {fmtMs(elapsed)}
            {state.running && <span className="animate-blink">█</span>}
          </span>
        </div>
      </div>

      {/* Pipeline graph */}
      <PipelineGraph
        activeNode={state.activeNode}
        completedNodes={state.completedNodes}
        loopIteration={state.loopIteration}
        continueLoop={continueLoop}
      />

      {/* Two-column: questions + evidence */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <QuestionTracker questions={state.questions} />
        <EvidenceFeed evidence={state.evidence} loopIteration={state.loopIteration} />
      </div>

      {/* Agent panel */}
      <AgentPanel
        claims={state.claims}
        claimsByQuestion={state.claimsByQuestion}
        questions={state.questions}
        activeNode={state.activeNode}
      />

      {/* Gate decisions */}
      <GateDecisionPanel decisions={state.gateDecisions} />

      {/* Activity feed */}
      <div className="space-y-1">
        <div className="eyebrow">Activity</div>
        <div
          ref={traceRef}
          className="panel max-h-48 overflow-y-auto p-3 font-mono text-xs leading-relaxed"
        >
          {state.trace.map((line, i) => (
            <div key={i} className="text-mute">
              <span className="text-accent">$</span> {line.replace(/^\$ /, "")}
            </div>
          ))}
          {state.running && state.activeNode && (
            <div className="text-mute animate-blink">
              <span className="text-accent">$</span> {state.activeNode}...
            </div>
          )}
        </div>
      </div>

      {/* Error */}
      {state.error && (
        <div className="panel border-danger bg-danger/10 p-4">
          <div className="eyebrow text-danger">Error</div>
          <p className="mt-1 text-sm text-fg">{state.error}</p>
        </div>
      )}
    </div>
  );
}
