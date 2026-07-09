"use client";

import { useEffect, useRef } from "react";
import type { Evidence } from "@/lib/schemas/evidence";

interface Props {
  evidence: Evidence[];
  loopIteration: number;
}

export function EvidenceFeed({ evidence, loopIteration }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [evidence.length]);

  if (evidence.length === 0) {
    return (
      <div className="space-y-2">
        <div className="eyebrow">Evidence</div>
        <div className="panel p-3 text-xs text-mute">No evidence retrieved yet</div>
      </div>
    );
  }

  const byLoop = new Map<number, Evidence[]>();
  for (const ev of evidence) {
    const arr = byLoop.get(ev.loopIteration) ?? [];
    arr.push(ev);
    byLoop.set(ev.loopIteration, arr);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="eyebrow">Evidence</div>
        <span className="nums text-[11px] text-mute">{evidence.length} sources</span>
      </div>
      <div className="panel max-h-[400px] overflow-y-auto space-y-1 p-2">
        {[...byLoop.entries()].map(([loop, items]) => (
          <div key={loop}>
            {loopIteration > 0 && (
              <div className="eyebrow py-1 text-[10px] text-mute border-b border-line mb-1">
                Loop {loop}
              </div>
            )}
            {items.map(ev => (
              <div key={ev.id} className="animate-rise rounded px-2 py-1.5 hover:bg-panel2 transition">
                <div className="flex items-center gap-1.5">
                  <span className="source-chip text-[10px]">{ev.domain}</span>
                  <span className="flex-1 truncate text-xs text-fg">{ev.title}</span>
                </div>
                <p className="mt-0.5 text-[11px] text-mute leading-snug line-clamp-2">
                  {ev.snippet}
                </p>
              </div>
            ))}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
