/**
 * PlayfulStats — the tongue-in-cheek "diagnostic readout" grid ("AI Invasion Risk: 89%",
 * "Software Maturity: 2008"). This is the shareable, personality-giving part of the report.
 */
import type { ScanReport } from "@/lib/schema";

export function PlayfulStats({ stats }: { stats: ScanReport["playfulStats"] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {stats.map((s, i) => (
        <div key={i} className="panel px-3 py-2.5">
          <div className="eyebrow truncate" title={s.label}>
            {s.label}
          </div>
          <div className="nums mt-1 text-lg text-accent">{s.value}</div>
        </div>
      ))}
    </div>
  );
}
