"use client";

import { useEffect, useRef, useState } from "react";
import type { ResearchUIState, QuestionStatus } from "@/lib/useResearchStream";
import type { AgentRoleT, Claim } from "@/lib/schemas/claim";
import { committeeStance } from "@/lib/orchestration/debate";
import { confidenceColor as barColor } from "@/lib/research/arena";
import {
  reconCount,
  claimsByRole as indexClaimsByRole,
  currentCommitteeClaims,
  latestGateScoreFor,
  gateVerdict,
  scopeGateDecisionsToQuestion,
  deliberationLabel,
  type GateVerdict,
} from "@/lib/research/board";
import { PipelineGraph } from "./PipelineGraph";
import { ActivityTicker } from "./ActivityTicker";
import { StanceDots } from "./StanceDots";
import { CostCounter } from "./CostCounter";
import { DebateArena } from "./DebateArena";
import { AgentSwimlane } from "./AgentSwimlane";
import { EvidenceFeed } from "./EvidenceFeed";
import { GateDecisionPanel } from "./GateDecisionPanel";
import { WindowShopStrip } from "./WindowShopStrip";

const ROLE_LABELS: Record<AgentRoleT, string> = {
  historian: "Historian",
  operator: "Operator",
  investor: "Investor",
  skeptic: "Skeptic",
};

const STATUS_STYLE: Record<QuestionStatus["status"], { label: string; cls: string }> = {
  pending: { label: "pending", cls: "text-mute border-line" },
  retrieving: { label: "retrieving", cls: "text-amber border-amber animate-blink" },
  debating: { label: "debating", cls: "text-accent border-accent animate-blink" },
  resolved: { label: "resolved", cls: "text-accent border-accent" },
  looping: { label: "looping", cls: "text-amber border-amber" },
};

const GATE_VERDICT_STYLE: Record<GateVerdict, { label: string; cls: string }> = {
  pending: { label: "—", cls: "text-mute" },
  settled: { label: "✔ settled", cls: "text-accent" },
  "fault-line": { label: "⚡ fault line", cls: "text-amber" },
  limitation: { label: "⚠ limitation", cls: "text-mute" },
  retrieve: { label: "↻ retrieve +gap", cls: "text-amber" },
  // Answered — but the run converged before chasing a gap this question had flagged. It WAS resolved
  // (committee stance + report entry), just on the evidence in hand; the gap is noted, not fatal. So
  // "answered · gap unchased", amber (a caveat), NOT danger (which read as a failed/cut-off question).
  truncated: { label: "⌛ answered · gap unchased", cls: "text-amber" },
};

// Human phrasing for the gate's convergence reason (why the whole loop stopped) — shown once,
// above the board, so a run that halted on budget/loops doesn't read as if every question settled.
const CONVERGED_REASON_LABEL: Record<string, string> = {
  "cost-headroom": "LLM cost cap — stopped before a loop it couldn't afford to finish",
  budget: "retrieval budget exhausted",
  "max-loops": "hit the max retrieval-loop limit",
  "no-progress": "a retrieval loop added no new evidence",
  "gate-decided-no-retrieve": "the gate judged more retrieval wouldn't help",
  "zero-cost-resolved": "every question resolved without needing another loop",
};

const COLUMNS = "minmax(180px,1fr) repeat(5, minmax(120px,1fr))";

type Stage = "question" | "recon" | "openings" | "deliberation" | "gate" | "loop";
interface DrillDown {
  questionId: string;
  stage: Stage;
}

// `live` gates the ticking interval — replay's `state.running` mirrors whatever the replayed
// reducer computed (true until recommend:done/research:error is reached), which has nothing to do
// with wall-clock time. Without this guard, scrubbing/playing a replay ran a REAL setInterval
// counting up in actual elapsed seconds since the component mounted — meaningless during replay,
// and disconnected from playback position or the original run's real duration (events carry no
// timestamps to reconstruct that from). Replay's own scrub bar already shows position.
function useElapsed(running: boolean, resetKey: string, live: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  const t0 = useRef(Date.now());

  useEffect(() => {
    t0.current = Date.now();
    setElapsed(0);
  }, [resetKey]);

  useEffect(() => {
    if (!running || !live) return;
    const id = setInterval(() => setElapsed(Date.now() - t0.current), 100);
    return () => clearInterval(id);
  }, [running, live]);

  return elapsed;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The Openings cell's claims: the real round-0 blind opening once §3c events have arrived, else
 * (Phase 1 fallback) the latest claim per role from whatever's streamed so far.
 */
function openingClaimsFor(state: ResearchUIState, qid: string): Claim[] {
  const openings = state.openingsByQuestion[qid];
  if (openings && openings.length > 0) return openings;
  return currentCommitteeClaims(state.claimsByQuestion[qid] ?? [], qid);
}

interface CellProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function Cell({ active, onClick, children }: CellProps) {
  return (
    <button
      onClick={onClick}
      className={`min-h-[52px] rounded border p-2 text-left text-[11px] transition
        ${active ? "border-accent bg-accent/10" : "border-line hover:border-accent/50 hover:bg-panel2"}`}
    >
      {children}
    </button>
  );
}

interface RowProps {
  q: QuestionStatus;
  state: ResearchUIState;
  drill: DrillDown | null;
  onToggle: (questionId: string, stage: Stage) => void;
}

function QuestionRow({ q, state, drill, onToggle }: RowProps) {
  const qid = q.question.id;
  const s = STATUS_STYLE[q.status];
  const evidence = state.evidenceByQuestion[qid] ?? [];
  const claims = state.claimsByQuestion[qid] ?? [];
  const openingClaimsByRole = indexClaimsByRole(openingClaimsFor(state, qid));
  // The committee's CURRENT position, not every loop's accumulated claims — else a question
  // contested early but converged to a unanimous lean by its latest loop still reads "contested".
  const stance = committeeStance(currentCommitteeClaims(claims, qid));
  const gateScore = latestGateScoreFor(state.gateDecisions, qid);
  const verdict = gateVerdict(gateScore, stance);
  const verdictStyle = GATE_VERDICT_STYLE[verdict];

  const isDrilled = (stage: Stage) => drill?.questionId === qid && drill.stage === stage;

  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: COLUMNS }}>
      {/* Row header — absorbed QuestionTracker */}
      <div className="panel space-y-1.5 p-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <span className="font-mono text-[10px] text-mute">{qid}</span>
            <span className="mx-1 text-line">·</span>
            <span className="text-[10px] text-fg/70">{q.question.category}</span>
            <button
              onClick={() => onToggle(qid, "question")}
              className="mt-0.5 line-clamp-2 text-left text-xs leading-snug text-fg transition hover:text-accent"
              title="click for full question"
            >
              {q.question.text}
            </button>
          </div>
          <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase ${s.cls}`}>
            {s.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-panel2">
            <div
              className={`h-full rounded-full ${barColor(q.aggregateConfidence)}`}
              style={{ width: `${Math.round(q.aggregateConfidence * 100)}%` }}
            />
          </div>
          <span className="nums w-8 text-right text-[10px] text-mute">
            {q.aggregateConfidence > 0 ? q.aggregateConfidence.toFixed(2) : "—"}
          </span>
        </div>
      </div>

      {/* Recon — "recon" is loop-0's initial reconnaissance pass specifically (reconCount filters
          evidence.loopIteration === 0); "total" is everything gathered since, including later
          targeted retrieval loops. Labeled explicitly (not "src"/"total") because once a second
          loop adds evidence the two numbers diverge, and an unexplained pair reads as two
          inconsistent measures of the same thing rather than two different things. */}
      <Cell active={isDrilled("recon")} onClick={() => onToggle(qid, "recon")}>
        <div className="nums text-fg">{reconCount(evidence)} recon</div>
        <div className="text-mute">{evidence.length} total</div>
      </Cell>

      {/* Openings */}
      <Cell active={isDrilled("openings")} onClick={() => onToggle(qid, "openings")}>
        <StanceDots claimsByRole={openingClaimsByRole} />
      </Cell>

      {/* Deliberation */}
      <Cell active={isDrilled("deliberation")} onClick={() => onToggle(qid, "deliberation")}>
        <span className={q.debateOutcome === "debated" ? "text-accent" : "text-mute"}>
          {deliberationLabel(q, stance)}
        </span>
      </Cell>

      {/* Gate */}
      <Cell active={isDrilled("gate")} onClick={() => onToggle(qid, "gate")}>
        <div className="font-mono text-[10px] uppercase text-mute">{stance}</div>
        <div className={verdictStyle.cls}>{verdictStyle.label}</div>
      </Cell>

      {/* Loop */}
      <Cell active={isDrilled("loop")} onClick={() => onToggle(qid, "loop")}>
        {q.status === "looping" ? (
          // Actively mid-loop right now — present tense, amber (matches the row's own
          // "looping"/"retrieving" status styling).
          <>
            <span className="text-amber">↻ retrieve loop {q.currentLoop}</span>
            <WindowShopStrip passes={state.researcherByQuestion[qid] ?? []} variant="cell" />
          </>
        ) : q.currentLoop > 0 ? (
          // The run has since ended (status normalizes to "resolved" on recommend:done) but this
          // question DID go through extra retrieval — currentLoop never resets, so say so in the
          // past tense instead of reusing the active "retrieve loop N" wording, which reads as
          // still-in-progress and contradicts a "converged"/finished run.
          <>
            <span className="text-mute">loop {q.currentLoop} · done</span>
            <WindowShopStrip passes={state.researcherByQuestion[qid] ?? []} variant="cell" />
          </>
        ) : (
          <span className="text-mute">—</span>
        )}
      </Cell>
    </div>
  );
}

interface DrillDownPanelProps {
  drill: DrillDown;
  state: ResearchUIState;
  onClose: () => void;
  onSelectQuestion: (questionId: string) => void;
}

function DrillDownPanel({ drill, state, onClose, onSelectQuestion }: DrillDownPanelProps) {
  const { questionId, stage } = drill;
  const openingClaimsByRole = indexClaimsByRole(openingClaimsFor(state, questionId));
  const question = state.questions.find((q) => q.question.id === questionId)?.question;

  return (
    <div
      className="fixed inset-0 z-30 flex items-end justify-center bg-ink/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[70vh] w-full max-w-6xl animate-rise overflow-y-auto rounded-t-xl border border-line
                   border-b-0 bg-panel p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="eyebrow">
            {questionId} · {stage}
          </div>
          <button onClick={onClose} className="text-xs text-mute hover:text-fg">
            close ✕
          </button>
        </div>

        {stage === "question" ? (
          <div className="space-y-2">
            {question && (
              <div className="text-[10px] text-fg/70">{question.category}</div>
            )}
            <p className="text-base leading-relaxed text-fg">{question?.text}</p>
          </div>
        ) : stage === "recon" ? (
          <EvidenceFeed evidence={state.evidenceByQuestion[questionId] ?? []} loopIteration={state.loopIteration} />
        ) : stage === "loop" ? (
          <div className="space-y-3">
            <WindowShopStrip passes={state.researcherByQuestion[questionId] ?? []} />
            <EvidenceFeed evidence={state.evidenceByQuestion[questionId] ?? []} loopIteration={state.loopIteration} />
          </div>
        ) : stage === "openings" ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {(Object.keys(openingClaimsByRole) as AgentRoleT[]).map((role) => {
              const claim = openingClaimsByRole[role];
              if (!claim) return null;
              return (
                <div key={role} className="rounded border border-line bg-panel2 p-2.5 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="eyebrow text-[10px]">{ROLE_LABELS[role]}</span>
                    <span className="nums text-[11px] text-fg/70">{claim.confidence.toFixed(2)}</span>
                  </div>
                  <p className="text-[11px] leading-snug text-fg">{claim.conclusion}</p>
                  <span className="font-mono text-[9px] uppercase text-mute">{claim.stance}</span>
                </div>
              );
            })}
            {Object.keys(openingClaimsByRole).length === 0 && (
              <p className="text-xs text-mute">awaiting openings...</p>
            )}
          </div>
        ) : stage === "deliberation" ? (
          <div className="space-y-3">
            <DebateArena
              claimsByQuestion={state.claimsByQuestion}
              evidenceByQuestion={state.evidenceByQuestion}
              questions={state.questions}
              activeNode={state.activeNode}
              activeQuestionId={questionId}
              onSelectQuestion={onSelectQuestion}
            />
            <AgentSwimlane
              openings={state.openingsByQuestion[questionId] ?? []}
              rounds={state.roundsByQuestion[questionId] ?? []}
              questionId={questionId}
              activeNode={state.activeNode}
            />
          </div>
        ) : (
          <GateDecisionPanel decisions={scopeGateDecisionsToQuestion(state.gateDecisions, questionId)} />
        )}
      </div>
    </div>
  );
}

interface Props {
  state: ResearchUIState;
  done?: boolean;
  /** Extra content rendered in the header row, alongside cost/elapsed — e.g. replay's play/scrub bar. */
  headerExtra?: React.ReactNode;
  /** Content rendered above the header — e.g. replay's past-runs picker. */
  topBar?: React.ReactNode;
  /**
   * Fullscreen "mission control" takeover (fixed inset-0) vs. a normal-flow embedded block.
   * Default true — the live run (page.tsx) and /replay want the viewport-pinned dashboard. Set
   * false when embedding the board inside other page content (e.g. ResearchReportView's
   * "Exploration trace" recap) — fixed positioning there would cover the report it's nested in.
   */
  fullscreen?: boolean;
  /**
   * Whether this is a real-time run (drives the wall-clock elapsed timer) vs. a replay (position
   * is whatever the scrub bar says, not real elapsed seconds). Default true; /replay passes false.
   */
  live?: boolean;
}

/**
 * The question-centric swimlane board (question-board-spec.md) — a fullscreen "mission control"
 * takeover while a run is live or being replayed: the pipeline state machine and the live activity
 * ticker anchor a fixed top band, the swimlane rows scroll in a bounded middle region, and a
 * question's drill-down slides up as an overlay sheet instead of pushing page height — the whole
 * picture always fits the viewport, no matter how many questions or how deep a drill-down gets.
 */
export function QuestionBoard({ state, done = false, headerExtra, topBar, fullscreen = true, live = true }: Props) {
  const elapsed = useElapsed(state.running, state.topic, live);
  const [drill, setDrill] = useState<DrillDown | null>(null);
  const [topicExpanded, setTopicExpanded] = useState(false);

  const lastGate = state.gateDecisions[state.gateDecisions.length - 1];
  const continueLoop = lastGate?.continueLoop ?? false;
  // Why the run stopped — shown once the loop has converged (not while still looping). Falls back to
  // the raw reason code if it's one we haven't given friendly wording. Any question flagged
  // `truncated` means the stop cut an investigation short (budget/loops), which we call out.
  const stopReason = !continueLoop && lastGate?.convergedReason ? lastGate.convergedReason : null;
  // Scan EVERY loop's scores, not just the last gate's: a question truncated in an earlier loop is
  // resolved out of later gates, so `lastGate` alone would miss it and the banner would read "clean
  // convergence" while that question's own cell (which scans all decisions) shows "truncated · gap".
  const anyTruncated = state.gateDecisions.some((d) => d.gateScores.some((s) => s.truncated));

  const toggle = (questionId: string, stage: Stage) => {
    setDrill((prev) => (prev && prev.questionId === questionId && prev.stage === stage ? null : { questionId, stage }));
  };

  const rootClass = fullscreen
    ? "fixed inset-0 z-20 flex flex-col gap-3 overflow-hidden bg-ink p-3 sm:p-4"
    : "relative flex h-[70vh] flex-col gap-3 overflow-hidden rounded-lg border border-line bg-ink p-3";

  return (
    <div className={rootClass}>
      {!done && state.running && (
        <div className="pointer-events-none absolute inset-0 z-10 animate-sweep bg-gradient-to-b from-accent/5 via-accent/10 to-transparent" />
      )}

      {topBar}

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 shrink">
          <div className="eyebrow">Deep Research</div>
          <button
            onClick={() => setTopicExpanded(true)}
            className="line-clamp-2 text-left text-sm font-semibold leading-snug text-fg transition hover:text-accent"
            title="click for full topic"
          >
            {state.topic}
          </button>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          {headerExtra}
          <CostCounter usage={state.usage} />
          {live && (
            <span className="nums text-sm text-mute">
              {fmtMs(elapsed)}
              {state.running && <span className="animate-blink">█</span>}
            </span>
          )}
        </div>
      </div>

      {/* Why the run stopped — one line, so a budget/loop truncation never masquerades as
          "every question settled". Amber caveat when a question's gap went unchased, mute otherwise. */}
      {stopReason && (
        <div
          className={`shrink-0 rounded border px-2.5 py-1.5 text-[11px] ${
            anyTruncated ? "border-amber/40 bg-amber/5 text-amber" : "border-line bg-panel2 text-mute"
          }`}
        >
          <span className="font-mono uppercase tracking-wide">
            {anyTruncated ? "⌛ answered · gap unchased" : "✔ run converged"}
          </span>
          <span className="mx-1.5 text-line">·</span>
          {CONVERGED_REASON_LABEL[stopReason] ?? stopReason}
          {anyTruncated && (
            <span className="text-mute">
              {" "}— every question was still answered from the evidence gathered; some had a flagged
              gap the run stopped before chasing
            </span>
          )}
        </div>
      )}

      {/* Pipeline state machine + live ticker — the "what's happening" band */}
      <div className="grid h-24 shrink-0 grid-cols-1 gap-3 sm:h-28 lg:grid-cols-[2fr_1fr]">
        <PipelineGraph
          activeNode={state.activeNode}
          completedNodes={state.completedNodes}
          loopIteration={state.loopIteration}
          continueLoop={continueLoop}
        />
        <ActivityTicker trace={state.trace} running={state.running} />
      </div>

      {/* Swimlanes — the only region that scrolls; everything else stays pinned in view */}
      {state.questions.length > 0 && (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div
            className="grid shrink-0 gap-2 font-mono text-[10px] uppercase text-mute"
            style={{ gridTemplateColumns: COLUMNS }}
          >
            <div />
            <div>Recon</div>
            <div>Openings</div>
            <div>Deliberation</div>
            <div>Gate</div>
            <div>Loop</div>
          </div>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {state.questions.map((q) => (
              <QuestionRow key={q.question.id} q={q} state={state} drill={drill} onToggle={toggle} />
            ))}

            {state.error && (
              <div className="panel border-danger bg-danger/10 p-4">
                <div className="eyebrow text-danger">Error</div>
                <p className="mt-1 text-sm text-fg">{state.error}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {drill && (
        <DrillDownPanel
          drill={drill}
          state={state}
          onClose={() => setDrill(null)}
          onSelectQuestion={(qid) => setDrill({ questionId: qid, stage: "deliberation" })}
        />
      )}

      {topicExpanded && (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center bg-ink/70 backdrop-blur-sm"
          onClick={() => setTopicExpanded(false)}
        >
          <div
            className="max-h-[70vh] w-full max-w-6xl animate-rise overflow-y-auto rounded-t-xl border border-line
                       border-b-0 bg-panel p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="eyebrow">topic</div>
              <button onClick={() => setTopicExpanded(false)} className="text-xs text-mute hover:text-fg">
                close ✕
              </button>
            </div>
            <p className="text-base leading-relaxed text-fg">{state.topic}</p>
          </div>
        </div>
      )}
    </div>
  );
}
