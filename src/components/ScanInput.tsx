/**
 * ScanInput — the landing state: title, industry field, example chips, and the Run button.
 * Purely presentational; the parent page owns the scan lifecycle.
 */
"use client";

import { useState } from "react";

/** Curated examples that show the tool's range and invite a click. */
const EXAMPLES = ["college athletics", "construction permitting", "insurance claims", "industrial ergonomics"];

export function ScanInput({ onRun, disabled }: { onRun: (industry: string) => void; disabled?: boolean }) {
  const [value, setValue] = useState("");

  const run = () => {
    const v = value.trim();
    if (v) onRun(v);
  };

  return (
    <div className="mx-auto w-full max-w-2xl text-center">
      <div className="eyebrow mb-4">Industry diagnostics · scores are heuristic</div>
      <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
        Opportunity <span className="text-accent">MRI</span>
      </h1>
      <p className="mx-auto mt-3 max-w-md text-balance text-sm text-mute">
        Scan any industry for structural inefficiencies, labor shortages, software gaps, and
        AI-native business openings. See the hidden shape of a market.
      </p>

      <div className="mt-8 flex items-stretch gap-2">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-accent">
            &gt;
          </span>
          <input
            autoFocus
            value={value}
            disabled={disabled}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
            placeholder="enter an industry…"
            className="w-full rounded-lg border border-line bg-panel py-3 pl-9 pr-3 font-mono text-fg
                       placeholder:text-mute focus:border-accent focus:outline-none disabled:opacity-50"
          />
        </div>
        <button
          onClick={run}
          disabled={disabled || !value.trim()}
          className="rounded-lg bg-accent px-5 font-mono text-sm font-semibold text-ink
                     transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Run Scan
        </button>
      </div>

      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            disabled={disabled}
            onClick={() => {
              setValue(ex);
              onRun(ex);
            }}
            className="rounded-full border border-line bg-panel px-3 py-1 font-mono text-xs text-mute
                       transition hover:border-accent hover:text-accent disabled:opacity-40"
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}
