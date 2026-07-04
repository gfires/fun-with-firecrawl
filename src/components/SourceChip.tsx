/**
 * SourceChip — a clickable [N] citation. Given a sourceId and the report's source list,
 * renders `[N] domain` linking to the page. Used everywhere a claim cites evidence.
 *
 * FOR FUTURE AGENTS: This is the visual embodiment of the "cite every score" promise.
 * `Citations` renders a row of chips for an array of ids; unknown ids are skipped safely.
 */
import type { Source } from "@/lib/schema";

export function SourceChip({ source }: { source: Source }) {
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer"
      className="source-chip"
      title={source.title}
    >
      <span className="text-accent">[{source.id}]</span>
      <span className="max-w-[140px] truncate">{source.domain}</span>
    </a>
  );
}

export function Citations({ ids, sources }: { ids: number[]; sources: Source[] }) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const resolved = ids.map((id) => byId.get(id)).filter((s): s is Source => Boolean(s));
  if (resolved.length === 0) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {resolved.map((s) => (
        <SourceChip key={s.id} source={s} />
      ))}
    </span>
  );
}
