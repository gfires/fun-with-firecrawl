"use client";

import { useRef, useState } from "react";
import { TOTAL_RETRIEVAL_BUDGET, MAX_RUN_COST_USD } from "@/lib/params";
import { shouldSubmitOnKeyDown, parseBudgetInput } from "@/lib/scan-input-utils";

export type RunMode = "scan" | "research";

const EXAMPLES = ["college athletics", "construction permitting", "insurance claims", "industrial ergonomics"];

// Blast-radius guards on client-side budget overrides — no server-side ceiling exists yet.
const MAX_RETRIEVAL_BUDGET = 500;
const MAX_USD_BUDGET = 10 * MAX_RUN_COST_USD;

interface Props {
  onRun: (industry: string, budget?: number, usdBudget?: number) => void;
  disabled?: boolean;
  mode: RunMode;
  onModeChange: (mode: RunMode) => void;
}

export function ScanInput({ onRun, disabled, mode, onModeChange }: Props) {
  const [value, setValue] = useState("");
  const [budgetRaw, setBudgetRaw] = useState("");
  const [usdBudgetRaw, setUsdBudgetRaw] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const run = () => {
    const v = value.trim();
    if (!v) return;
    onRun(
      v,
      parseBudgetInput(budgetRaw, { max: MAX_RETRIEVAL_BUDGET }),
      parseBudgetInput(usdBudgetRaw, { max: MAX_USD_BUDGET }),
    );
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  return (
    <div className="mx-auto w-full max-w-2xl text-center">
      <div className="eyebrow mb-4">Industry diagnostics · scores are heuristic</div>
      <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
        Blind<span className="text-accent">spot</span>
      </h1>
      <p className="mx-auto mt-3 max-w-md text-balance text-sm text-mute">
        Scan any industry for structural bottlenecks, software gaps, and founder-ready
        opportunities. See what the market isn't seeing.
      </p>

      {/* Mode toggle */}
      <div className="mt-6 flex justify-center gap-1">
        <button
          onClick={() => onModeChange("scan")}
          className={`rounded-l-lg border px-4 py-1.5 font-mono text-xs transition
            ${mode === "scan"
              ? "border-accent bg-accent/10 text-accent"
              : "border-line text-mute hover:text-fg"}`}
        >
          Industry Scan
        </button>
        <button
          onClick={() => onModeChange("research")}
          className={`rounded-r-lg border px-4 py-1.5 font-mono text-xs transition
            ${mode === "research"
              ? "border-accent bg-accent/10 text-accent"
              : "border-line text-mute hover:text-fg"}`}
        >
          Deep Research
        </button>
      </div>

      <div className="mt-4 flex items-stretch gap-2">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-3 top-3 font-mono text-accent">
            &gt;
          </span>
          <textarea
            ref={textareaRef}
            autoFocus
            rows={1}
            value={value}
            disabled={disabled}
            onChange={(e) => {
              setValue(e.target.value);
              autoGrow(e.target);
            }}
            onKeyDown={(e) => {
              if (shouldSubmitOnKeyDown(e.key, e.shiftKey)) {
                e.preventDefault();
                run();
              }
            }}
            placeholder={mode === "research" ? "enter a topic…" : "enter an industry…"}
            className="max-h-40 w-full resize-none overflow-y-auto rounded-lg border border-line bg-panel
                       py-3 pl-9 pr-3 font-mono text-fg placeholder:text-mute focus:border-accent
                       focus:outline-none disabled:opacity-50"
          />
        </div>
        <button
          onClick={run}
          disabled={disabled || !value.trim()}
          className="rounded-lg bg-accent px-5 font-mono text-sm font-semibold text-ink
                     transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {mode === "research" ? "Run Research" : "Run Scan"}
        </button>
      </div>

      {mode === "research" && (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-4 font-mono text-xs text-mute">
          <label className="flex items-center gap-2">
            <span>Retrieval budget (credits)</span>
            <input
              type="number"
              min={1}
              disabled={disabled}
              value={budgetRaw}
              onChange={(e) => setBudgetRaw(e.target.value)}
              placeholder={String(TOTAL_RETRIEVAL_BUDGET)}
              className="w-20 rounded border border-line bg-panel px-2 py-1 font-mono text-xs text-fg
                         placeholder:text-mute focus:border-accent focus:outline-none disabled:opacity-50"
            />
          </label>
          <label className="flex items-center gap-2">
            <span>LLM budget ($)</span>
            <input
              type="number"
              min={0}
              step="0.01"
              disabled={disabled}
              value={usdBudgetRaw}
              onChange={(e) => setUsdBudgetRaw(e.target.value)}
              placeholder={String(MAX_RUN_COST_USD)}
              className="w-20 rounded border border-line bg-panel px-2 py-1 font-mono text-xs text-fg
                         placeholder:text-mute focus:border-accent focus:outline-none disabled:opacity-50"
            />
          </label>
        </div>
      )}

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
