"use client";

interface Props {
  trace: string[];
  running: boolean;
}

/** The prominent "what's happening right now" readout — the trace feed already carries a
 *  human-readable line per event; this surfaces the latest one big and animates each new line in,
 *  instead of leaving it buried in the small scrollback log. */
export function ActivityTicker({ trace, running }: Props) {
  const clean = (s: string | undefined) => s?.replace(/^\$ /, "") ?? "";
  const last = clean(trace[trace.length - 1]);
  const prev = clean(trace[trace.length - 2]);

  return (
    <div className="panel flex h-full flex-col justify-center gap-1 overflow-hidden px-4 py-2">
      <div className="eyebrow">Live</div>
      {prev && <p className="truncate font-mono text-[11px] text-mute/50">{prev}</p>}
      <p key={trace.length} className="animate-rise truncate font-mono text-sm text-fg">
        <span className={running ? "text-accent animate-blink" : "text-accent"}>▸</span>{" "}
        {last || "waiting to start…"}
      </p>
    </div>
  );
}
