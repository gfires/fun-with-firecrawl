/**
 * Gauge — a 0–10 diagnostic sub-score rendered as a labeled bar with its evidence beneath.
 * Color ramps from teal (low) → amber → danger (high) so "heat" reads at a glance.
 *
 * The evidence list under each gauge is where per-score citations live, satisfying the
 * "display evidence for every score" requirement.
 */
import type { Score, Source } from "@/lib/schema";
import { Citations } from "./SourceChip";

/** Pick a heat color for a 0–10 value. */
function heatClass(v: number): string {
  if (v >= 7.5) return "bg-danger";
  if (v >= 5) return "bg-amber";
  return "bg-accent";
}

export function Gauge({ name, score, sources }: { name: string; score: Score; sources: Source[] }) {
  const pct = Math.round((score.value / 10) * 100);
  return (
    <div className="panel p-4">
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">{name}</span>
        <span className="nums text-lg text-fg">
          {score.value.toFixed(1)}
          <span className="text-mute text-xs">/10</span>
        </span>
      </div>

      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-panel2">
        <div className={`h-full rounded-full ${heatClass(score.value)}`} style={{ width: `${pct}%` }} />
      </div>

      <div className="mt-1 text-xs text-mute">{score.label}</div>

      {score.evidence.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-line pt-3">
          {score.evidence.map((e, i) => (
            <li key={i} className="text-[13px] leading-snug text-fg/90">
              {e.text}
              <Citations ids={e.sourceIds} sources={sources} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
