/**
 * ReportSection — a titled report block with an eyebrow label and optional index number,
 * used for the eight report sections (Snapshot, Bottlenecks, Software Ecosystem, etc.).
 */
export function ReportSection({
  index,
  title,
  subtitle,
  children,
}: {
  index?: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel p-5 animate-rise">
      <div className="mb-3 flex items-baseline gap-2">
        {index && <span className="nums text-xs text-accent">{index}</span>}
        <h2 className="font-mono text-sm uppercase tracking-[0.14em] text-fg">{title}</h2>
      </div>
      {subtitle && <p className="mb-3 text-xs text-mute">{subtitle}</p>}
      {children}
    </section>
  );
}

/**
 * EvidenceList — renders an array of cited Evidence as bullets with inline citations.
 * The workhorse for Bottlenecks / Friction / Niches / Adjacent Markets sections.
 */
import type { Evidence, Source } from "@/lib/schema";
import { Citations } from "./SourceChip";

export function EvidenceList({ items, sources }: { items: Evidence[]; sources: Source[] }) {
  if (items.length === 0) return <p className="text-sm text-mute">No clear signals detected.</p>;
  return (
    <ul className="space-y-2.5">
      {items.map((e, i) => (
        <li key={i} className="flex gap-2 text-sm leading-snug text-fg/90">
          <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-accent" />
          <span>
            {e.text}
            <Citations ids={e.sourceIds} sources={sources} />
          </span>
        </li>
      ))}
    </ul>
  );
}
