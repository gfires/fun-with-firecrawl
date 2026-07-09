"use client";

import type { GateDecision } from "@/lib/useResearchStream";
import { VOI_THRESHOLD } from "@/lib/params";

interface Props {
  decisions: GateDecision[];
}

export function GateDecisionPanel({ decisions }: Props) {
  if (decisions.length === 0) return null;

  const latest = decisions[decisions.length - 1];

  return (
    <details className="panel" open={decisions.length === 1}>
      <summary className="cursor-pointer px-3 py-2 text-xs font-mono text-mute hover:text-fg transition">
        Gate Decision — Loop {latest.loopIteration}
        {latest.continueLoop ? (
          <span className="ml-2 text-amber">→ looping</span>
        ) : (
          <span className="ml-2 text-accent">→ converged</span>
        )}
      </summary>
      <div className="px-3 pb-3 space-y-2">
        {latest.voiScores.length > 0 ? (
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-mute text-left">
                <th className="py-1 pr-2">Question</th>
                <th className="py-1 pr-2">VOI</th>
                <th className="py-1 pr-2">Disagree</th>
                <th className="py-1 pr-2">Sensitivity</th>
                <th className="py-1 pr-2">Tractability</th>
                <th className="py-1">Decision</th>
              </tr>
            </thead>
            <tbody>
              {latest.voiScores.map(s => {
                const passes = s.voi > VOI_THRESHOLD;
                return (
                  <tr key={s.questionId} className={passes ? "text-fg" : "text-mute"}>
                    <td className="py-1 pr-2">{s.questionId}</td>
                    <td className="py-1 pr-2">
                      <div className="flex items-center gap-1">
                        <div className="h-1 w-12 rounded-full bg-panel2 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${passes ? "bg-accent" : "bg-mute"}`}
                            style={{ width: `${Math.min(100, s.voi * 100 / 0.5)}%` }}
                          />
                        </div>
                        <span className="nums">{s.voi.toFixed(3)}</span>
                      </div>
                    </td>
                    <td className="py-1 pr-2 nums">{s.disagreement.toFixed(2)}</td>
                    <td className="py-1 pr-2 nums">{s.sensitivity.toFixed(2)}</td>
                    <td className="py-1 pr-2 nums">{s.tractability.toFixed(2)}</td>
                    <td className="py-1">
                      {latest.resolvedIds.includes(s.questionId) ? (
                        <span className="text-mute">resolved</span>
                      ) : (
                        <span className="text-accent">continue</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="text-xs text-mute">
            {latest.resolvedIds.length} resolved, {latest.unresolvedIds.length} unresolved
            {latest.continueLoop && " — looping for more evidence"}
          </div>
        )}
        <div className="text-[10px] text-mute font-mono">
          threshold: {VOI_THRESHOLD}
        </div>
      </div>
    </details>
  );
}
