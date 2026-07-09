"use client";

import type { ResearchUIState } from "@/lib/useResearchStream";
import type { ResearchReport } from "@/lib/orchestration/graph";
import type { AgentRoleT } from "@/lib/schemas/claim";
import { ResearchProgress } from "./ResearchProgress";

const ROLE_LABELS: Record<AgentRoleT, string> = {
  historian: "Historian",
  operator: "Operator",
  investor: "Investor",
  skeptic: "Skeptic",
};

function confidenceColor(c: number): string {
  if (c >= 0.6) return "text-accent";
  if (c >= 0.3) return "text-amber";
  return "text-danger";
}

function barColor(c: number): string {
  if (c >= 0.6) return "bg-accent";
  if (c >= 0.3) return "bg-amber";
  return "bg-danger";
}

interface Props {
  report: ResearchReport;
  scan: ResearchUIState;
  onReset: () => void;
}

export function ResearchReportView({ report, scan, onReset }: Props) {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 pb-20">
      {/* Hero */}
      <div className="panel p-6 text-center">
        <div className="eyebrow mb-2">Research Complete</div>
        <h1 className="text-2xl font-semibold text-fg">{report.topic}</h1>
        <div className="mt-3 flex justify-center gap-4 font-mono text-xs text-mute">
          <span>{report.loopIterations} loop{report.loopIterations !== 1 ? "s" : ""}</span>
          <span className="text-line">·</span>
          <span>{report.evidence.length} sources</span>
          <span className="text-line">·</span>
          <span>{report.claims.length} claims</span>
          <span className="text-line">·</span>
          <span>{report.questions.length} questions</span>
        </div>
      </div>

      {/* Per-question results */}
      {report.questions.map(qr => (
        <div key={qr.question.id} className="panel p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <span className="font-mono text-xs text-mute">{qr.question.id}</span>
              <span className="mx-1.5 text-line">·</span>
              <span className="text-xs text-fg/70">{qr.question.category}</span>
              <p className="mt-0.5 text-sm font-medium text-fg">{qr.question.text}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className="h-2 w-16 rounded-full bg-panel2 overflow-hidden">
                <div
                  className={`h-full rounded-full ${barColor(qr.confidence)}`}
                  style={{ width: `${Math.round(qr.confidence * 100)}%` }}
                />
              </div>
              <span className={`nums text-sm font-semibold ${confidenceColor(qr.confidence)}`}>
                {qr.confidence.toFixed(2)}
              </span>
              {qr.resolved && <span className="text-accent text-xs">✓</span>}
            </div>
          </div>

          {/* Agent claims */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {qr.claims.map(claim => (
              <div key={claim.id} className="rounded border border-line bg-panel2 p-2.5 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="eyebrow text-[10px]">{ROLE_LABELS[claim.agentRole]}</span>
                  <span className={`nums text-[11px] ${confidenceColor(claim.confidence)}`}>
                    {claim.confidence.toFixed(2)}
                  </span>
                </div>
                <p className="text-[11px] text-fg leading-snug">{claim.conclusion}</p>
                <div className="flex gap-2 text-[9px] font-mono text-mute">
                  <span>{claim.supportingEvidenceIds.length} sup</span>
                  <span>{claim.contradictingEvidenceIds.length} con</span>
                  <span>{claim.missingEvidence.length} gaps</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Unresolved questions */}
      {report.unresolvedQuestions.length > 0 && (
        <div className="panel p-4">
          <div className="eyebrow text-amber mb-2">Unresolved Questions</div>
          <ul className="space-y-1 text-sm text-fg/70">
            {report.unresolvedQuestions.map(q => (
              <li key={q.id} className="flex gap-2">
                <span className="font-mono text-xs text-mute">{q.id}</span>
                <span>{q.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Cost summary */}
      <div className="panel p-4">
        <div className="eyebrow mb-2">Cost Summary</div>
        <div className="flex flex-wrap gap-4 font-mono text-xs text-mute">
          <span>tokens: <span className="nums text-fg">{(scan.usage.totalPromptTokens + scan.usage.totalCompletionTokens).toLocaleString()}</span></span>
          <span>cost: <span className="nums text-fg">${scan.usage.totalCostUsd.toFixed(4)}</span></span>
          <span>firecrawl: <span className="nums text-fg">{scan.usage.firecrawlCredits} credits</span></span>
          <span>llm calls: <span className="nums text-fg">{scan.usage.calls.length}</span></span>
        </div>
        {scan.usage.calls.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-[10px] font-mono text-mute hover:text-fg transition">
              per-call breakdown
            </summary>
            <div className="mt-1 max-h-40 overflow-y-auto">
              <table className="w-full text-[10px] font-mono">
                <thead>
                  <tr className="text-mute text-left">
                    <th className="py-0.5 pr-2">Label</th>
                    <th className="py-0.5 pr-2">Model</th>
                    <th className="py-0.5 pr-2">In</th>
                    <th className="py-0.5 pr-2">Out</th>
                    <th className="py-0.5">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {scan.usage.calls.map((call, i) => (
                    <tr key={i} className="text-fg/70">
                      <td className="py-0.5 pr-2">{call.label}</td>
                      <td className="py-0.5 pr-2 text-mute">{call.model}</td>
                      <td className="py-0.5 pr-2 nums">{call.promptTokens.toLocaleString()}</td>
                      <td className="py-0.5 pr-2 nums">{call.completionTokens.toLocaleString()}</td>
                      <td className="py-0.5 nums">${call.costUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>

      {/* Exploration trace */}
      <details className="panel">
        <summary className="cursor-pointer px-4 py-3 text-xs font-mono text-mute hover:text-fg transition">
          Exploration trace
        </summary>
        <div className="px-4 pb-4">
          <ResearchProgress state={scan} done />
        </div>
      </details>

      {/* Actions */}
      <div className="flex justify-center">
        <button
          onClick={onReset}
          className="rounded-lg border border-line bg-panel px-5 py-2 font-mono text-sm text-mute
                     transition hover:border-accent hover:text-accent"
        >
          Research another topic
        </button>
      </div>
    </div>
  );
}
