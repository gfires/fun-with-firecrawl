"use client";

import type { QuestionStatus } from "@/lib/useResearchStream";

const STATUS_STYLE: Record<QuestionStatus["status"], { label: string; cls: string }> = {
  pending: { label: "pending", cls: "text-mute border-line" },
  retrieving: { label: "retrieving", cls: "text-amber border-amber animate-blink" },
  debating: { label: "debating", cls: "text-accent border-accent animate-blink" },
  resolved: { label: "resolved", cls: "text-accent border-accent" },
  looping: { label: "looping", cls: "text-amber border-amber" },
};

function confidenceColor(c: number): string {
  if (c >= 0.6) return "bg-accent";
  if (c >= 0.3) return "bg-amber";
  return "bg-danger";
}

interface Props {
  questions: QuestionStatus[];
}

export function QuestionTracker({ questions }: Props) {
  if (questions.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="eyebrow">Research Questions</div>
      {questions.map(q => {
        const s = STATUS_STYLE[q.status];
        return (
          <div key={q.question.id} className="panel p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <span className="font-mono text-xs text-mute">{q.question.id}</span>
                <span className="mx-1.5 text-line">·</span>
                <span className="text-xs text-fg/70">{q.question.category}</span>
                <p className="mt-0.5 text-sm text-fg leading-snug">{q.question.text}</p>
              </div>
              <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase ${s.cls}`}>
                {s.label}
              </span>
            </div>

            {/* Confidence bar */}
            <div className="flex items-center gap-2">
              <div className="h-1.5 flex-1 rounded-full bg-panel2 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${confidenceColor(q.aggregateConfidence)}`}
                  style={{ width: `${Math.round(q.aggregateConfidence * 100)}%` }}
                />
              </div>
              <span className="nums text-[11px] text-mute w-8 text-right">
                {q.aggregateConfidence > 0 ? q.aggregateConfidence.toFixed(2) : "—"}
              </span>
            </div>

            {/* Counts */}
            <div className="flex gap-3 text-[11px] text-mute font-mono">
              <span>{q.evidenceCount} sources</span>
              <span>{q.claimCount} claims</span>
              {q.currentLoop > 0 && <span className="text-amber">L{q.currentLoop}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
