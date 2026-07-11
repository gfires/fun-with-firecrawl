"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import type { Claim, AgentRoleT } from "@/lib/schemas/claim";
import type { Evidence } from "@/lib/schemas/evidence";
import type { QuestionStatus } from "@/lib/useResearchStream";
import { buildArenaGraph, confidenceColor, confidenceTextColor } from "@/lib/research/arena";
import type { ArenaGraph, AgentNode, EvidenceNode } from "@/lib/research/arena";

const ROLE_META: Record<AgentRoleT, { glyph: string; label: string }> = {
  historian: { glyph: "H", label: "Historian" },
  operator: { glyph: "O", label: "Operator" },
  investor: { glyph: "$", label: "Investor" },
  skeptic: { glyph: "?", label: "Skeptic" },
};

const AGENT_ANCHORS: Record<AgentRoleT, { x: number; y: number }> = {
  historian: { x: 200, y: 40 },
  operator: { x: 360, y: 200 },
  investor: { x: 200, y: 360 },
  skeptic: { x: 40, y: 200 },
};

const VIEW_W = 400;
const VIEW_H = 400;
const AGENT_R = 24;
const EV_R = 8;
const SETTLE_EPSILON = 0.5;
const DAMPING = 0.85;
const REPULSION = 800;

interface NodePos { x: number; y: number; vx: number; vy: number; settled: boolean }

function agentFill(confidence: number): string {
  if (confidence >= 0.6) return "#2dd4bf";
  if (confidence >= 0.3) return "#f5a623";
  return "#ff5c73";
}

function edgeColor(kind: "support" | "contradict"): string {
  return kind === "support" ? "#2dd4bf" : "#ff5c73";
}

interface Props {
  claimsByQuestion: Record<string, Claim[]>;
  evidenceByQuestion: Record<string, Evidence[]>;
  questions: QuestionStatus[];
  activeNode: string | null;
  activeQuestionId: string | null;
  onSelectQuestion: (id: string) => void;
}

export function DebateArena({
  claimsByQuestion,
  evidenceByQuestion,
  questions,
  activeNode,
  activeQuestionId,
  onSelectQuestion,
}: Props) {
  const debatedQuestionIds = [...new Set(
    Object.keys(claimsByQuestion).filter(k => claimsByQuestion[k]?.length > 0),
  )];

  const activeQ = activeQuestionId ?? debatedQuestionIds[debatedQuestionIds.length - 1] ?? null;
  const isDebating = activeNode === "debate";

  const claims = activeQ ? (claimsByQuestion[activeQ] ?? []) : [];
  const evidence = activeQ ? (evidenceByQuestion[activeQ] ?? []) : [];
  const graph = buildArenaGraph(claims, evidence, activeQ ?? "");

  const posRef = useRef<Map<string, NodePos>>(new Map());
  const rafRef = useRef<number>(0);
  const [positions, setPositions] = useState<Map<string, NodePos>>(new Map());
  const [hoveredEv, setHoveredEv] = useState<string | null>(null);

  const initPositions = useCallback((g: ArenaGraph) => {
    const m = new Map<string, NodePos>();
    for (const ev of g.evidence) {
      const existing = posRef.current.get(ev.id);
      if (existing) {
        m.set(ev.id, existing);
        continue;
      }
      const connectedAgents = g.edges
        .filter(e => e.evidenceId === ev.id)
        .map(e => AGENT_ANCHORS[e.role]);
      const cx = connectedAgents.length
        ? connectedAgents.reduce((s, a) => s + a.x, 0) / connectedAgents.length
        : VIEW_W / 2;
      const cy = connectedAgents.length
        ? connectedAgents.reduce((s, a) => s + a.y, 0) / connectedAgents.length
        : VIEW_H / 2;
      m.set(ev.id, { x: cx + (Math.random() - 0.5) * 20, y: cy + (Math.random() - 0.5) * 20, vx: 0, vy: 0, settled: false });
    }
    posRef.current = m;
    return m;
  }, []);

  useEffect(() => {
    if (graph.evidence.length === 0) {
      cancelAnimationFrame(rafRef.current);
      posRef.current = new Map();
      setPositions(new Map());
      return;
    }

    const pos = initPositions(graph);

    function step() {
      let anyUnsettled = false;
      const keys = [...pos.keys()];

      for (const id of keys) {
        const p = pos.get(id)!;
        if (p.settled) continue;

        let fx = 0, fy = 0;

        const connectedAgents = graph.edges
          .filter(e => e.evidenceId === id)
          .map(e => AGENT_ANCHORS[e.role]);
        if (connectedAgents.length) {
          const tx = connectedAgents.reduce((s, a) => s + a.x, 0) / connectedAgents.length;
          const ty = connectedAgents.reduce((s, a) => s + a.y, 0) / connectedAgents.length;
          fx += (tx - p.x) * 0.05;
          fy += (ty - p.y) * 0.05;
        }

        for (const otherId of keys) {
          if (otherId === id) continue;
          const o = pos.get(otherId)!;
          const dx = p.x - o.x;
          const dy = p.y - o.y;
          const dist2 = dx * dx + dy * dy;
          if (dist2 < 1) continue;
          const f = REPULSION / dist2;
          fx += dx * f;
          fy += dy * f;
        }

        p.vx = (p.vx + fx) * DAMPING;
        p.vy = (p.vy + fy) * DAMPING;
        p.x += p.vx;
        p.y += p.vy;

        p.x = Math.max(EV_R + 4, Math.min(VIEW_W - EV_R - 4, p.x));
        p.y = Math.max(EV_R + 4, Math.min(VIEW_H - EV_R - 4, p.y));

        if (Math.abs(p.vx) < SETTLE_EPSILON && Math.abs(p.vy) < SETTLE_EPSILON) {
          p.settled = true;
        } else {
          anyUnsettled = true;
        }
      }

      setPositions(new Map(pos));
      if (anyUnsettled) {
        rafRef.current = requestAnimationFrame(step);
      }
    }

    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [activeQ, claims.length, evidence.length]);

  if (debatedQuestionIds.length === 0 && !isDebating) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="eyebrow">Debate Arena</div>
        {isDebating && (
          <span className="font-mono text-[10px] text-accent animate-blink">LIVE</span>
        )}
      </div>

      {debatedQuestionIds.length > 1 && (
        <div className="flex gap-1 overflow-x-auto">
          {debatedQuestionIds.map(qid => (
            <button
              key={qid}
              onClick={() => onSelectQuestion(qid)}
              className={`shrink-0 rounded border px-2 py-0.5 font-mono text-[10px] transition
                ${activeQ === qid ? "border-accent text-accent bg-accent/10" : "border-line text-mute hover:text-fg"}`}
            >
              {qid}
            </button>
          ))}
        </div>
      )}

      <div className="panel p-3">
        {graph.agents.length === 0 ? (
          <p className={`text-xs text-mute ${isDebating ? "animate-blink" : ""}`}>
            {isDebating ? "deliberating..." : "awaiting debate"}
          </p>
        ) : (
          <>
            <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="w-full max-h-[400px]">
              {/* Edges */}
              {graph.edges.map((edge, i) => {
                const agentPos = AGENT_ANCHORS[edge.role];
                const evPos = positions.get(edge.evidenceId);
                if (!evPos) return null;
                return (
                  <line
                    key={`edge-${i}`}
                    x1={agentPos.x}
                    y1={agentPos.y}
                    x2={evPos.x}
                    y2={evPos.y}
                    stroke={edgeColor(edge.kind)}
                    strokeWidth={1.5}
                    strokeOpacity={0.6}
                  />
                );
              })}

              {/* Evidence nodes */}
              {graph.evidence.map(ev => {
                const p = positions.get(ev.id);
                if (!p) return null;
                return (
                  <g
                    key={ev.id}
                    onMouseEnter={() => setHoveredEv(ev.id)}
                    onMouseLeave={() => setHoveredEv(null)}
                    className="cursor-pointer"
                  >
                    {ev.contested && (
                      <circle cx={p.x} cy={p.y} r={EV_R + 4} fill="none" stroke="#f5a623" strokeWidth={2} />
                    )}
                    <circle cx={p.x} cy={p.y} r={EV_R} fill="#1c2634" stroke="#5b6b80" strokeWidth={1} />
                    {hoveredEv === ev.id && (
                      <foreignObject x={p.x + EV_R + 4} y={p.y - 14} width={160} height={40}>
                        <div className="rounded bg-panel2 border border-line px-1.5 py-0.5 text-[9px] text-fg leading-tight">
                          <div className="truncate font-medium">{ev.label}</div>
                          {ev.domain && <div className="text-mute truncate">{ev.domain}</div>}
                        </div>
                      </foreignObject>
                    )}
                  </g>
                );
              })}

              {/* Agent nodes */}
              {graph.agents.map(agent => {
                const pos = AGENT_ANCHORS[agent.role];
                const meta = ROLE_META[agent.role];
                const r = AGENT_R * (0.7 + agent.confidence * 0.6);
                return (
                  <g key={agent.role}>
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={r}
                      fill={agentFill(agent.confidence)}
                      fillOpacity={0.15}
                      stroke={agentFill(agent.confidence)}
                      strokeWidth={2}
                    />
                    <text
                      x={pos.x}
                      y={pos.y + 1}
                      textAnchor="middle"
                      dominantBaseline="central"
                      className="font-mono text-xs"
                      fill={agentFill(agent.confidence)}
                    >
                      {meta.glyph}
                    </text>
                    <text
                      x={pos.x}
                      y={pos.y + r + 14}
                      textAnchor="middle"
                      className="text-[9px]"
                      fill="#5b6b80"
                    >
                      {meta.label}
                    </text>
                    <text
                      x={pos.x}
                      y={pos.y + r + 24}
                      textAnchor="middle"
                      className="font-mono text-[9px]"
                      fill={agentFill(agent.confidence)}
                    >
                      {agent.confidence.toFixed(2)}
                    </text>
                  </g>
                );
              })}
            </svg>

            {/* Legend */}
            <div className="mt-2 flex gap-3 text-[9px] font-mono text-mute">
              <span className="flex items-center gap-1">
                <span className="inline-block h-0.5 w-3 bg-accent" /> supports
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-0.5 w-3 bg-danger" /> contradicts
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full border-2 border-amber" /> contested
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
