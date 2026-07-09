"use client";

import { useState } from "react";
import type { Claim, AgentRoleT } from "@/lib/schemas/claim";
import type { QuestionStatus } from "@/lib/useResearchStream";

const ROLE_META: Record<AgentRoleT, { glyph: string; label: string }> = {
  historian: { glyph: "H", label: "Historian" },
  operator: { glyph: "O", label: "Operator" },
  investor: { glyph: "$", label: "Investor" },
  skeptic: { glyph: "?", label: "Skeptic" },
};

const ROLES: AgentRoleT[] = ["historian", "operator", "investor", "skeptic"];

function confidenceColor(c: number): string {
  if (c >= 0.6) return "bg-accent";
  if (c >= 0.3) return "bg-amber";
  return "bg-danger";
}

function confidenceTextColor(c: number): string {
  if (c >= 0.6) return "text-accent";
  if (c >= 0.3) return "text-amber";
  return "text-danger";
}

interface Props {
  claims: Claim[];
  claimsByQuestion: Record<string, Claim[]>;
  questions: QuestionStatus[];
  activeNode: string | null;
}

export function AgentPanel({ claims, claimsByQuestion, questions, activeNode }: Props) {
  const debatedQuestionIds = [...new Set(claims.map(c => c.questionId))];
  const [selectedQ, setSelectedQ] = useState<string | null>(null);
  const activeQ = selectedQ ?? debatedQuestionIds[debatedQuestionIds.length - 1] ?? null;

  if (debatedQuestionIds.length === 0 && activeNode !== "debate") return null;

  const activeClaims = activeQ ? (claimsByQuestion[activeQ] ?? []) : [];
  const isDebating = activeNode === "debate";

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="eyebrow">Committee Deliberation</div>
        {isDebating && (
          <span className="font-mono text-[10px] text-accent animate-blink">LIVE</span>
        )}
      </div>

      {/* Question tabs */}
      {debatedQuestionIds.length > 1 && (
        <div className="flex gap-1 overflow-x-auto">
          {debatedQuestionIds.map(qid => (
            <button
              key={qid}
              onClick={() => setSelectedQ(qid)}
              className={`shrink-0 rounded border px-2 py-0.5 font-mono text-[10px] transition
                ${activeQ === qid ? "border-accent text-accent bg-accent/10" : "border-line text-mute hover:text-fg"}`}
            >
              {qid}
            </button>
          ))}
        </div>
      )}

      {/* Agent cards */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {ROLES.map(role => {
          const meta = ROLE_META[role];
          const claim = activeClaims.find(c => c.agentRole === role);

          return (
            <div key={role} className="panel p-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded border border-line font-mono text-xs text-accent">
                  {meta.glyph}
                </span>
                <span className="eyebrow">{meta.label}</span>
              </div>

              {claim ? (
                <>
                  <p className="text-xs text-fg leading-snug line-clamp-3">{claim.conclusion}</p>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 rounded-full bg-panel2 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${confidenceColor(claim.confidence)}`}
                        style={{ width: `${Math.round(claim.confidence * 100)}%` }}
                      />
                    </div>
                    <span className={`nums text-[11px] ${confidenceTextColor(claim.confidence)}`}>
                      {claim.confidence.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex gap-2 text-[10px] font-mono">
                    <span className="text-accent">{claim.supportingEvidenceIds.length} supporting</span>
                    <span className="text-danger">{claim.contradictingEvidenceIds.length} contra</span>
                    <span className="text-amber">{claim.missingEvidence.length} gaps</span>
                  </div>
                </>
              ) : (
                <p className={`text-xs text-mute ${isDebating ? "animate-blink" : ""}`}>
                  {isDebating ? "deliberating..." : "awaiting debate"}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
