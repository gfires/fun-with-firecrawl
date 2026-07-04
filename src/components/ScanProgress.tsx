/**
 * ScanProgress — the live exploration visualization. THIS is the "watch it explore" experience
 * the product is built around. It renders straight off the reduced ScanState:
 *
 *   ┌ phase rail ──────────────────────────────────────────────┐
 *   │ INTENTS → SEARCH → SCRAPE → ANALYZE   (active one glows)   │
 *   ├─ intents grid ─────────────┬─ source scanner ─────────────┤
 *   │ each intent: status + count│ each source: [N] domain +     │
 *   │                            │ scrape status, ticking to ok  │
 *   ├─ activity feed (terminal) ─────────────────────────────────┤
 *   │ > running log of everything happening, newest last         │
 *   └────────────────────────────────────────────────────────────┘
 *
 * A sweeping scan-line overlays the whole thing to sell the "MRI" motif.
 */
"use client";

import { useEffect, useRef } from "react";
import type { ScanState } from "@/lib/useScanStream";

const PHASES: { key: string; label: string }[] = [
  { key: "intents", label: "Intents" },
  { key: "search", label: "Search" },
  { key: "scrape", label: "Scrape" },
  { key: "analyze", label: "Analyze" },
];

/** Order phases so "past" ones read as complete in the rail. */
const PHASE_ORDER = ["idle", "intents", "search", "scrape", "analyze", "done"];

function scrapeGlyph(scrape: string): { char: string; cls: string } {
  switch (scrape) {
    case "scraping":
      return { char: "◐", cls: "text-amber animate-blink" };
    case "ok":
      return { char: "●", cls: "text-accent" };
    case "failed":
      return { char: "○", cls: "text-mute" };
    default:
      return { char: "·", cls: "text-mute" }; // queued
  }
}

export function ScanProgress({ state }: { state: ScanState }) {
  const feedRef = useRef<HTMLDivElement>(null);
  const currentIdx = PHASE_ORDER.indexOf(state.phase);

  // Keep the activity feed pinned to the newest line.
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [state.trace.length]);

  const scrapedOk = state.sources.filter((s) => s.scrape === "ok").length;
  const scrapedDone = state.sources.filter((s) => s.scrape === "ok" || s.scrape === "failed").length;

  return (
    <div className="relative mx-auto w-full max-w-4xl overflow-hidden">
      {/* Sweeping MRI scan line across the whole panel. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-full">
        <div className="h-16 w-full animate-sweep bg-gradient-to-b from-transparent via-accent/10 to-transparent" />
      </div>

      {/* Phase rail */}
      <div className="mb-5 flex items-center gap-2">
        {PHASES.map((p, i) => {
          const pIdx = PHASE_ORDER.indexOf(p.key);
          const done = currentIdx > pIdx && state.phase !== "done" ? true : currentIdx > pIdx;
          const active = state.phase === p.key;
          return (
            <div key={p.key} className="flex flex-1 items-center gap-2">
              <div
                className={`flex-1 rounded border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors
                  ${active ? "border-accent bg-accent/10 text-accent" : done ? "border-line text-fg/70" : "border-line text-mute"}`}
              >
                {active && <span className="mr-1 animate-blink">▸</span>}
                {p.label}
              </div>
              {i < PHASES.length - 1 && <span className="text-mute">·</span>}
            </div>
          );
        })}
      </div>

      <div className="mb-2 flex items-baseline justify-between">
        <div className="font-mono text-sm text-fg">
          Scanning <span className="text-accent">{state.industry}</span>
        </div>
        <div className="nums text-xs text-mute">
          {scrapedDone > 0 && `${scrapedOk}/${state.sources.length} sources read`}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {/* Intents grid */}
        <div className="panel p-4">
          <div className="eyebrow mb-3">Search Intents</div>
          <ul className="space-y-1.5">
            {state.intents.map((intent) => (
              <li key={intent.label} className="font-mono text-[13px]">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <span
                      className={
                        intent.status === "searching"
                          ? "text-amber animate-blink"
                          : intent.status === "done"
                            ? "text-accent"
                            : "text-mute"
                      }
                    >
                      {intent.status === "done" ? "✓" : intent.status === "searching" ? "◐" : "·"}
                    </span>
                    <span className={intent.status === "pending" ? "text-mute" : "text-fg/90"}>
                      {intent.label}
                    </span>
                  </span>
                  {intent.status === "done" && <span className="nums text-xs text-mute">{intent.count}</span>}
                </div>
                {/* The EXACT query string sent to Firecrawl — full transparency. */}
                <div className="ml-6 truncate text-[11px] text-mute/70" title={intent.query}>
                  {intent.query}
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Source scanner */}
        <div className="panel flex flex-col p-4">
          <div className="eyebrow mb-3">Sources</div>
          {state.sources.length === 0 ? (
            <div className="flex flex-1 items-center justify-center py-6 font-mono text-xs text-mute">
              awaiting search results…
            </div>
          ) : (
            <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
              {state.sources.map((s) => {
                const g = scrapeGlyph(s.scrape);
                return (
                  <li key={s.id} className="flex items-center gap-2 font-mono text-[12px]">
                    <span className={g.cls}>{g.char}</span>
                    <span className="nums w-6 shrink-0 text-mute">[{s.id}]</span>
                    <span className="flex-1 truncate text-fg/80" title={s.title}>
                      {s.domain}
                    </span>
                    <span className="shrink-0 text-[10px] text-mute">{s.intent}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Activity feed — the terminal log */}
      <div ref={feedRef} className="panel mt-3 max-h-32 overflow-y-auto p-3 font-mono text-[12px] leading-relaxed">
        {state.trace.map((line, i) => (
          <div key={i} className="text-mute">
            <span className="text-accent/60">$</span> {line}
          </div>
        ))}
        {state.phase === "analyze" && (
          <div className="text-amber">
            <span className="animate-blink">▸</span> inferring scores &amp; opportunities…
          </div>
        )}
      </div>

      {/* The EXACT prompt sent to the model — surfaced live once inference begins. */}
      {state.prompt && <PromptPanel prompt={state.prompt} />}
    </div>
  );
}

/**
 * PromptPanel — shows the full, unedited prompt (system + user) sent to the LLM, plus the
 * model name. Collapsible; expanded by default while analyzing so nothing feels hidden.
 */
function PromptPanel({ prompt }: { prompt: NonNullable<ScanState["prompt"]> }) {
  return (
    <details open className="panel mt-3 p-3">
      <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-widest text-mute">
        Prompt sent to <span className="text-accent">{prompt.model}</span>
        <span className="ml-2 normal-case tracking-normal text-mute/60">(exact, unedited)</span>
      </summary>
      <div className="mt-3 space-y-3">
        <div>
          <div className="eyebrow mb-1">System</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-line bg-ink p-2 font-mono text-[11px] leading-relaxed text-fg/80">
            {prompt.systemPrompt}
          </pre>
        </div>
        <div>
          <div className="eyebrow mb-1">User (industry + score definitions + cited corpus)</div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-line bg-ink p-2 font-mono text-[11px] leading-relaxed text-fg/80">
            {prompt.userPrompt}
          </pre>
        </div>
      </div>
    </details>
  );
}
