"use client";

import type { Claim, AgentRoleT } from "@/lib/schemas/claim";
import { swimlaneCells, confidenceColor, confidenceTextColor } from "@/lib/research/arena";

const ROLE_META: Record<AgentRoleT, { glyph: string; label: string }> = {
  historian: { glyph: "H", label: "Historian" },
  operator: { glyph: "O", label: "Operator" },
  investor: { glyph: "$", label: "Investor" },
  skeptic: { glyph: "?", label: "Skeptic" },
};

const ROLES: AgentRoleT[] = ["historian", "operator", "investor", "skeptic"];

interface Props {
  claimsByQuestion: Record<string, Claim[]>;
  activeQuestionId: string | null;
  activeNode: string | null;
}

export function AgentSwimlane({ claimsByQuestion, activeQuestionId, activeNode }: Props) {
  const qid = activeQuestionId;
  if (!qid) return null;

  const claims = claimsByQuestion[qid] ?? [];
  const { maxLoop, rows } = swimlaneCells(claims, qid);
  const isDebating = activeNode === "debate";

  const hasAnyCells = ROLES.some(r => rows[r].some(c => c.confidence !== null));
  if (!hasAnyCells && !isDebating) return null;

  const loops = Array.from({ length: maxLoop + 1 }, (_, i) => i);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="eyebrow">Confidence Over Loops</div>
        {isDebating && (
          <span className="font-mono text-[10px] text-accent animate-blink">LIVE</span>
        )}
      </div>

      <div className="panel overflow-x-auto p-3">
        {loops.length === 0 ? (
          <p className={`text-xs text-mute ${isDebating ? "animate-blink" : ""}`}>
            {isDebating ? "deliberating..." : "no loop data"}
          </p>
        ) : (
          <div
            className="grid gap-px text-[10px]"
            style={{
              gridTemplateColumns: `80px repeat(${loops.length}, minmax(60px, 1fr))`,
            }}
          >
            {/* Header row */}
            <div />
            {loops.map(l => (
              <div key={l} className="eyebrow text-center py-1">L{l}</div>
            ))}

            {/* Role rows */}
            {ROLES.map(role => {
              const meta = ROLE_META[role];
              const cells = rows[role];
              return [
                <div key={`${role}-label`} className="flex items-center gap-1.5 py-1">
                  <span className="flex h-5 w-5 items-center justify-center rounded border border-line font-mono text-[10px] text-accent">
                    {meta.glyph}
                  </span>
                  <span className="text-mute font-mono">{meta.label}</span>
                </div>,
                ...loops.map(l => {
                  const cell = cells[l];
                  if (!cell || cell.confidence === null) {
                    return (
                      <div key={`${role}-${l}`} className="flex items-center justify-center py-1">
                        <span className="h-1.5 w-full rounded-full border border-dashed border-line/40" />
                      </div>
                    );
                  }
                  return (
                    <div key={`${role}-${l}`} className="flex items-center gap-1 py-1">
                      <div className="h-1.5 flex-1 rounded-full bg-panel2 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${confidenceColor(cell.confidence)}`}
                          style={{ width: `${Math.round(cell.confidence * 100)}%` }}
                        />
                      </div>
                      <span className="w-4 text-center font-mono">
                        {cell.delta === "up" && <span className="text-accent">▲</span>}
                        {cell.delta === "down" && <span className="text-danger">▼</span>}
                        {cell.delta === "flat" && <span className="text-mute">–</span>}
                        {cell.delta === null && <span className="text-transparent">·</span>}
                      </span>
                    </div>
                  );
                }),
              ];
            })}
          </div>
        )}
      </div>
    </div>
  );
}
