"use client";

// Type-only import — `mechanics` arrives as a plain JSON value over the wire (research:mechanics).
// Importing any VALUE from orchestration/mechanics.ts here would drag its server-only dependency
// chain (graph.ts -> trace.ts's fs/promises, cost-tracker.ts's async_hooks) into the client bundle.
import type { RunMechanics, EffortGroup } from "@/lib/orchestration/mechanics";

interface Props {
  mechanics: RunMechanics;
}

const EFFORT_GROUPS: EffortGroup[] = ["retrieval", "deliberation", "digest", "synthesis", "manager"];

/** The run-end closing artifact (question-board-spec.md §1/§6 Phase 5) — debated/skipped/productive,
 *  effort split, convergence. Renders the RunMechanics fields directly (no orchestration import). */
export function RunMechanicsReceipt({ mechanics }: Props) {
  const { retrieval: r, deliberation: d, effortSplit: e, convergence: c } = mechanics;

  return (
    <div className="panel space-y-3 p-4">
      <div className="eyebrow">Run Mechanics</div>

      <div className="flex flex-wrap gap-4 font-mono text-xs text-mute">
        <span>
          debated <span className="nums text-fg">{d.questionsDebated}</span> · skipped{" "}
          <span className="nums text-fg">{d.questionsSkipped}</span> · productive{" "}
          <span className="nums text-fg">
            {d.productiveQuestions}/{d.questionsDebated}
          </span>
        </span>
        <span className="text-line">·</span>
        <span>
          evidence <span className="nums text-fg">{r.evidenceTotal}</span> (
          <span className="nums text-fg">{r.evidencePerCredit.toFixed(2)}</span>/credit) —{" "}
          <span className="nums text-fg">{r.searchOps}</span> search /{" "}
          <span className="nums text-fg">{r.scrapeOps}</span> scrape /{" "}
          <span className="nums text-fg">{r.cacheHits}</span> cache-hit
        </span>
        <span className="text-line">·</span>
        <span>
          cost <span className="nums text-fg">${c.totalCostUsd.toFixed(4)}</span> / $
          <span className="nums text-fg">{c.capUsd.toFixed(2)}</span> cap
          {c.overCap && <span className="text-danger"> ⚠ over</span>}
        </span>
        <span className="text-line">·</span>
        <span>
          converged: <span className="text-fg">{c.reason}</span>
          {c.degraded && <span className="text-amber"> ⚠ degraded</span>}
        </span>
      </div>

      <div className="space-y-1">
        <div className="eyebrow text-[10px]">Effort split (search vs analyze)</div>
        {EFFORT_GROUPS.filter((g) => e.costByGroup[g] > 0).map((g) => (
          <div key={g} className="flex items-center gap-2 font-mono text-[11px]">
            <span className="w-24 text-mute">{g}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel2">
              <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(e.pctByGroup[g])}%` }} />
            </div>
            <span className="nums w-16 text-right text-fg/70">${e.costByGroup[g].toFixed(4)}</span>
            <span className="nums w-10 text-right text-mute">{Math.round(e.pctByGroup[g])}%</span>
          </div>
        ))}
      </div>

      {r.starvedQuestions.length > 0 && (
        <div className="text-[11px] text-amber">
          ⚠ {r.starvedQuestions.length} starved question{r.starvedQuestions.length === 1 ? "" : "s"}: {r.starvedQuestions.join(", ")}
        </div>
      )}
    </div>
  );
}
