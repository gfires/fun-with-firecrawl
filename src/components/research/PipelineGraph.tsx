"use client";

const NODES = [
  { id: "decompose", x: 80, y: 90, label: "Decompose" },
  { id: "retrieve", x: 220, y: 90, label: "Retrieve" },
  { id: "debate", x: 360, y: 90, label: "Debate" },
  { id: "gate", x: 500, y: 90, label: "Gate" },
  { id: "refine", x: 640, y: 90, label: "Refine" },
  { id: "recommend", x: 780, y: 90, label: "Recommend" },
];

const NODE_W = 110;
const NODE_H = 36;

interface Props {
  activeNode: string | null;
  completedNodes: string[];
  loopIteration: number;
  continueLoop: boolean;
}

function nodeClass(id: string, active: string | null, completed: string[]): string {
  if (id === active) return "active";
  if (completed.includes(id)) return "completed";
  return "idle";
}

export function PipelineGraph({ activeNode, completedNodes, loopIteration, continueLoop }: Props) {
  return (
    <div className="panel overflow-x-auto p-4">
      <svg viewBox="0 0 860 140" className="mx-auto w-full max-w-4xl" preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6" fill="currentColor" className="text-line" />
          </marker>
          <marker id="arrow-accent" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6" fill="#2dd4bf" />
          </marker>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Edges between nodes (skip refine→recommend — refine loops back to retrieve) */}
        {NODES.slice(0, -1).map((node, i) => {
          const next = NODES[i + 1];
          if (node.id === "refine") return null;
          const isActive = activeNode === next.id;
          return (
            <line
              key={`edge-${i}`}
              x1={node.x + NODE_W / 2 + NODE_W / 2}
              y1={node.y + NODE_H / 2}
              x2={next.x - NODE_W / 2}
              y2={next.y + NODE_H / 2}
              stroke={isActive ? "#2dd4bf" : "#1c2634"}
              strokeWidth={isActive ? 2 : 1.5}
              markerEnd={isActive ? "url(#arrow-accent)" : "url(#arrow)"}
            />
          );
        })}

        {/* Loop arc: refine → retrieve */}
        <path
          d="M 640,72 C 640,20 220,20 220,72"
          fill="none"
          stroke={continueLoop && loopIteration > 0 ? "#2dd4bf" : "#1c2634"}
          strokeWidth={continueLoop && loopIteration > 0 ? 2 : 1.5}
          strokeDasharray={continueLoop && loopIteration > 0 ? "none" : "6 4"}
          markerEnd={continueLoop && loopIteration > 0 ? "url(#arrow-accent)" : "url(#arrow)"}
          className="transition-all duration-500"
        />

        {/* Loop iteration badge */}
        {loopIteration > 0 && (
          <g>
            <rect x="415" y="8" width="30" height="18" rx="4" fill="#0b0f16" stroke="#1c2634" />
            <text x="430" y="21" textAnchor="middle" fill="#2dd4bf" fontSize="11" fontFamily="var(--font-mono)">
              L{loopIteration}
            </text>
          </g>
        )}

        {/* Nodes */}
        {NODES.map(node => {
          const status = nodeClass(node.id, activeNode, completedNodes);
          const cx = node.x;
          const cy = node.y;

          return (
            <g key={node.id}>
              <rect
                x={cx - NODE_W / 2}
                y={cy - NODE_H / 2 + NODE_H / 2}
                width={NODE_W}
                height={NODE_H}
                rx="6"
                fill={status === "active" ? "rgba(45,212,191,0.1)" : "#0b0f16"}
                stroke={status === "active" ? "#2dd4bf" : status === "completed" ? "#2dd4bf" : "#1c2634"}
                strokeWidth={status === "active" ? 2 : 1}
                filter={status === "active" ? "url(#glow)" : undefined}
                className={status === "active" ? "animate-pulse" : ""}
              />
              {status === "completed" && (
                <text
                  x={cx - NODE_W / 2 + 10}
                  y={cy + NODE_H / 2 + 4}
                  fill="#2dd4bf"
                  fontSize="12"
                >
                  ✓
                </text>
              )}
              <text
                x={cx}
                y={cy + NODE_H / 2 + 4}
                textAnchor="middle"
                fill={status === "active" ? "#2dd4bf" : status === "completed" ? "#c7d2e0" : "#5b6b80"}
                fontSize="12"
                fontFamily="var(--font-mono)"
              >
                {node.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
