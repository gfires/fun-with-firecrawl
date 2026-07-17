"use client";

const NODES = [
  { id: "decompose", x: 70, y: 44, label: "Decompose" },
  { id: "retrieve", x: 220, y: 44, label: "Retrieve" },
  { id: "debate", x: 370, y: 44, label: "Debate" },
  { id: "gate", x: 520, y: 44, label: "Gate" },
  { id: "recommend", x: 670, y: 44, label: "Recommend" },
];

const NODE_W = 116;
const NODE_H = 34;

interface Props {
  activeNode: string | null;
  completedNodes: string[];
  loopIteration: number;
  continueLoop: boolean;
}

type EdgeState = "idle" | "traversed" | "active";

function edgeState(toId: string, active: string | null, completed: string[]): EdgeState {
  if (toId === active) return "active";
  if (completed.includes(toId)) return "traversed";
  return "idle";
}

function nodeState(id: string, active: string | null, completed: string[]): EdgeState {
  if (id === active) return "active";
  if (completed.includes(id)) return "traversed";
  return "idle";
}

const STROKE: Record<EdgeState, string> = { idle: "#1c2634", traversed: "#2dd4bf", active: "#2dd4bf" };

/** Straight edge between two nodes, with a marching-ants flow animation while active and a
 *  traveling particle riding the same path — the literal "data is moving through here" cue. */
function Edge({ x1, y1, x2, y2, state }: { x1: number; y1: number; x2: number; y2: number; state: EdgeState }) {
  const d = `M ${x1},${y1} L ${x2},${y2}`;
  return (
    <g>
      <path
        d={d}
        fill="none"
        stroke={STROKE[state]}
        strokeWidth={state === "active" ? 2.5 : 1.5}
        strokeDasharray={state === "active" ? "6 4" : undefined}
        strokeOpacity={state === "idle" ? 1 : state === "traversed" ? 0.55 : 1}
        className={state === "active" ? "animate-dash-flow" : ""}
        markerEnd={state !== "idle" ? "url(#arrow-accent)" : "url(#arrow)"}
      />
      {state === "active" && (
        <circle r="3.5" fill="#2dd4bf" filter="url(#glow)">
          <animateMotion dur="1s" repeatCount="indefinite" path={d} />
        </circle>
      )}
    </g>
  );
}

/** The pipeline as an animated state machine — decompose→retrieve→debate→gate→recommend, with the
 *  gate→retrieve loop-back arc — instead of a static diagram: the active edge visibly flows and a
 *  particle rides it, and completed edges stay lit (a trail), so the whole run reads as motion. */
export function PipelineGraph({ activeNode, completedNodes, loopIteration, continueLoop }: Props) {
  const loopActive = continueLoop && loopIteration > 0;
  const loopState: EdgeState = loopActive ? "active" : loopIteration > 0 ? "traversed" : "idle";
  const loopPath = "M 520,26 C 520,-18 220,-18 220,26";

  return (
    <div className="panel h-full overflow-hidden p-3">
      <svg viewBox="-10 -38 760 124" className="h-full w-full" preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6" fill="#1c2634" />
          </marker>
          <marker id="arrow-accent" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6" fill="#2dd4bf" />
          </marker>
          <filter id="glow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {NODES.slice(0, -1).map((node, i) => {
          const next = NODES[i + 1];
          return (
            <Edge
              key={`edge-${i}`}
              x1={node.x + NODE_W / 2}
              y1={node.y + NODE_H / 2}
              x2={next.x - NODE_W / 2}
              y2={next.y + NODE_H / 2}
              state={edgeState(next.id, activeNode, completedNodes)}
            />
          );
        })}

        {/* Loop arc: gate → retrieve, arcing above the row */}
        <path
          d={loopPath}
          fill="none"
          stroke={STROKE[loopState]}
          strokeWidth={loopState === "active" ? 2.5 : 1.5}
          strokeDasharray={loopState === "active" ? "6 4" : loopState === "idle" ? "5 4" : undefined}
          strokeOpacity={loopState === "traversed" ? 0.55 : 1}
          className={loopState === "active" ? "animate-dash-flow" : ""}
          markerEnd={loopState !== "idle" ? "url(#arrow-accent)" : "url(#arrow)"}
        />
        {loopState === "active" && (
          <circle r="3.5" fill="#2dd4bf" filter="url(#glow)">
            <animateMotion dur="1.4s" repeatCount="indefinite" path={loopPath} />
          </circle>
        )}
        {loopIteration > 0 && (
          <g>
            <rect x="355" y="-32" width="30" height="17" rx="4" fill="#0b0f16" stroke="#1c2634" />
            <text x="370" y="-19.5" textAnchor="middle" fill="#2dd4bf" fontSize="10.5" fontFamily="var(--font-mono)">
              L{loopIteration}
            </text>
          </g>
        )}

        {NODES.map((node) => {
          const status = nodeState(node.id, activeNode, completedNodes);
          const cx = node.x;
          const cy = node.y + NODE_H / 2;

          return (
            <g key={node.id}>
              <rect
                x={cx - NODE_W / 2}
                y={cy - NODE_H / 2}
                width={NODE_W}
                height={NODE_H}
                rx="7"
                fill={status === "active" ? "rgba(45,212,191,0.12)" : "#0b0f16"}
                stroke={status === "idle" ? "#1c2634" : "#2dd4bf"}
                strokeWidth={status === "active" ? 2 : 1}
                filter={status === "active" ? "url(#glow)" : undefined}
                className={status === "active" ? "animate-pulse" : ""}
              />
              {status === "traversed" && (
                <text x={cx - NODE_W / 2 + 10} y={cy + 4} fill="#2dd4bf" fontSize="12">
                  ✓
                </text>
              )}
              <text
                x={cx}
                y={cy + 4}
                textAnchor="middle"
                fill={status === "active" ? "#2dd4bf" : status === "traversed" ? "#c7d2e0" : "#5b6b80"}
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
