"use client";

import type { GateDecision } from "@/lib/useResearchStream";

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
        {latest.gateScores.length > 0 ? (
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-mute text-left">
                <th className="py-1 pr-2">Question</th>
                <th className="py-1 pr-2">Decision</th>
                <th className="py-1 pr-2">Gaps</th>
                <th className="py-1 pr-2">Spread</th>
                <th className="py-1">Reason</th>
              </tr>
            </thead>
            <tbody>
              {latest.gateScores.map(s => (
                <tr key={s.questionId} className={s.retrieve ? "text-fg" : "text-mute"}>
                  <td className="py-1 pr-2">{s.questionId}</td>
                  <td className="py-1 pr-2">
                    {/* A truncated question was still RESOLVED (committee stance + report entry) — it
                        just had a flagged gap the run stopped before chasing. Show it as a distinct
                        answered-with-caveat state (amber), not the plain grey RESOLVED and not a red
                        failure, so this drill-down matches the board's "answered · gap unchased". */}
                    {s.retrieve ? (
                      <span className="text-accent">RETRIEVE</span>
                    ) : s.truncated ? (
                      <span className="text-amber">RESOLVED*</span>
                    ) : (
                      <span className="text-mute">RESOLVED</span>
                    )}
                  </td>
                  <td className="py-1 pr-2 nums">{s.gapCount}</td>
                  <td className="py-1 pr-2 nums">{s.confidenceSpread.toFixed(2)}</td>
                  <td className="py-1 text-mute">{s.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-xs text-mute">
            {latest.resolvedIds.length} resolved, {latest.unresolvedIds.length} unresolved
            {latest.continueLoop && " — looping for more evidence"}
          </div>
        )}
      </div>
    </details>
  );
}
