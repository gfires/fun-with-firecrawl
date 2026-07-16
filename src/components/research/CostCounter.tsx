"use client";

import type { ResearchUsage } from "@/lib/useResearchStream";

interface Props {
  usage: ResearchUsage;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function CostCounter({ usage }: Props) {
  const totalTokens = usage.totalPromptTokens + usage.totalCompletionTokens;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-mute">
      <span>
        tokens: <span className="nums text-fg/70">{fmtTokens(totalTokens)}</span>
      </span>
      <span className="text-line">|</span>
      <span>
        cost: <span className="nums text-fg/70">~${usage.totalCostUsd.toFixed(4)}</span>
      </span>
      <span className="text-line">|</span>
      <span>
        retrieval: <span className="nums text-fg/70">{usage.firecrawlCredits}</span> credits
      </span>
    </div>
  );
}
