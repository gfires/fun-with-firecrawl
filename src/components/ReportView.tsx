/**
 * ReportView — renders a completed ScanReport: hero, gauges, the eight sections (in the
 * spec's order), playful stats, and a full source appendix. Every claim carries citations.
 */
import type { ScanReport } from "@/lib/schema";
import type { ScanState, UsageSummary } from "@/lib/useScanStream";
import { SCORE_DEFINITIONS } from "@/lib/analyze";
import { MODEL_CATALOG } from "@/lib/models/pricing";
import { OpportunityMeter } from "./OpportunityMeter";
import { Gauge } from "./Gauge";
import { ReportSection, EvidenceList } from "./ReportSection";
import { Citations } from "./SourceChip";
import { ScanProgress } from "./ScanProgress";
import { exportReportPdf } from "@/lib/exportPdf";

export function ReportView({
  report,
  scan,
  onReset,
}: {
  report: ScanReport;
  /** The full finished scan state — carries the exploration trace (search path, scrape, timing). */
  scan: ScanState;
  onReset: () => void;
}) {
  const { sources } = report;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      {/* Hero */}
      <div className="panel flex flex-col items-center gap-6 p-6 sm:flex-row sm:items-center animate-rise">
        <OpportunityMeter score={report.opportunityScore} />
        <div className="flex-1 text-center sm:text-left">
          <div className="eyebrow">Blindspot · complete</div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{report.industry}</h1>
          <p className="mt-2 text-sm text-fg/85">{report.snapshot}</p>
        </div>
      </div>

      {/* Five sub-score gauges */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SCORE_DEFINITIONS.map((d) => (
          <Gauge
            key={d.key}
            name={d.name}
            score={report.scores[d.key as keyof ScanReport["scores"]]}
            scoreKey={d.key}
          />
        ))}
      </div>

      {/* Sections in order: snapshot, ecosystem, bottlenecks, niches, thesis, adjacent, next steps */}
      <ReportSection index="01" title="Industry Snapshot">
        <p className="text-sm leading-relaxed text-fg/90">{report.snapshot}</p>
      </ReportSection>

      <ReportSection index="02" title="Current Software Ecosystem" subtitle={report.softwareEcosystem.summary}>
        {report.softwareEcosystem.vendors.length === 0 ? (
          <p className="text-sm text-mute">No distinct vendors surfaced.</p>
        ) : (
          <ul className="space-y-2.5">
            {report.softwareEcosystem.vendors.map((v, i) => (
              <li key={i} className="text-sm leading-snug">
                <span className="font-mono text-fg">{v.name}</span>
                <span className="text-fg/80"> — {v.note}</span>
                <Citations ids={v.sourceIds} sources={sources} />
              </li>
            ))}
          </ul>
        )}
      </ReportSection>

      <ReportSection index="03" title="Bottlenecks">
        <EvidenceList items={report.bottlenecks} sources={sources} />
      </ReportSection>

      <ReportSection index="04" title="Underserved Niches">
        <EvidenceList items={report.underservedNiches} sources={sources} />
      </ReportSection>

      <ReportSection index="05" title="Opportunity Thesis">
        <div className="space-y-3">
          {report.opportunityThesis.split("\n\n").map((p, i) => (
            <p key={i} className="text-sm leading-relaxed text-fg/90">{p}</p>
          ))}
        </div>
      </ReportSection>

      <ReportSection index="06" title="Adjacent Markets">
        <EvidenceList items={report.adjacentMarkets} sources={sources} />
      </ReportSection>

      <ReportSection index="07" title="Next Steps">
        <EvidenceList items={report.nextSteps} sources={sources} />
      </ReportSection>

      {/* Source appendix — the full [N] list with triage scores */}
      <ReportSection index="—" title="Sources" subtitle="Every score and claim above cites these by number. Relevance scores (0–10) show how useful each source was judged before scraping.">
        <ol className="space-y-1.5">
          {sources.map((s) => (
            <li key={s.id} className="font-mono text-[12px]">
              <div className="flex items-center gap-2">
                <span className="nums w-7 shrink-0 text-accent">[{s.id}]</span>
                {s.relevanceScore != null && (
                  <span
                    className={`nums w-5 shrink-0 text-center text-[10px] font-semibold ${
                      s.relevanceScore >= 7 ? "text-accent" : s.relevanceScore >= 4 ? "text-fg/60" : "text-danger/70"
                    }`}
                  >
                    {s.relevanceScore}
                  </span>
                )}
                <a href={s.url} target="_blank" rel="noreferrer" className="flex-1 truncate text-fg/80 hover:text-accent" title={s.url}>
                  {s.title}
                </a>
                <span className="shrink-0 text-[10px] text-mute">{s.domain}</span>
              </div>
              {s.reason && (
                <div className="ml-12 mt-0.5 text-[10px] text-mute/70">{s.reason}</div>
              )}
            </li>
          ))}
        </ol>
      </ReportSection>

      {/* Method / assumptions disclosure — transparency requirement. */}
      <details className="panel p-4 text-sm text-mute">
        <summary className="cursor-pointer font-mono text-xs uppercase tracking-widest text-fg/70">
          Method &amp; assumptions
          <UsagePill usage={scan.usage} />
        </summary>
        <p className="mt-3 leading-relaxed">
          Blindspot generated {report.sources.length ? "a set of" : "no"} search intents,
          searched the public web via Firecrawl, scraped the most relevant pages, and asked an LLM
          to infer the five diagnostic scores below — each grounded in the cited sources. The
          headline Opportunity Score (0–100) is computed deterministically from the sub-scores
          (pain, software gap, labor scarcity, AI suitability, budget signal). <strong>All scores
          are heuristic and playful</strong> — treat them as a provocation to explore, not a
          verdict.
        </p>
        <ul className="mt-2 list-inside list-disc space-y-0.5">
          {SCORE_DEFINITIONS.map((d) => (
            <li key={d.key}>
              <span className="text-fg/80">{d.name}:</span> {d.definition}
            </li>
          ))}
        </ul>
        <UsageBreakdown usage={scan.usage} />
      </details>

      {/* The exact prompt that produced this report — collapsed, for full transparency. */}
      {/*
        Exploration trace — the full search/scrape path preserved after analysis. Collapsible so
        the report stays clean, but the user can reopen exactly what was searched, which sources
        were read/skipped/blocked, the per-step latencies, and the exact prompt. `done` renders it
        statically (no sweep animation; clock frozen).
      */}
      <details className="panel p-4">
        <summary className="cursor-pointer font-mono text-xs uppercase tracking-widest text-fg/70">
          Exploration trace
          <span className="ml-2 normal-case tracking-normal text-mute">
            {scan.candidateCount > 0 && `${scan.candidateCount} candidates → `}{scan.sources.length} scraped · {scan.timing.totalMs != null ? `${(scan.timing.totalMs / 1000).toFixed(1)}s` : ""} · {scan.intentsAdapted ? "adapted intents" : "static intents"}
          </span>
        </summary>
        <div className="mt-4">
          <ScanProgress state={scan} done />
        </div>
      </details>

      <div className="flex justify-center gap-3 pb-8 pt-2">
        <button
          onClick={() => exportReportPdf(report)}
          className="rounded-lg border border-accent px-6 py-2.5 font-mono text-sm font-semibold text-accent transition hover:bg-accent hover:text-ink"
        >
          Export PDF
        </button>
        <button
          onClick={onReset}
          className="rounded-lg bg-accent px-6 py-2.5 font-mono text-sm font-semibold text-ink transition hover:brightness-110"
        >
          Scan another industry →
        </button>
      </div>
    </div>
  );
}

/**
 * Pulls straight from MODEL_CATALOG (lib/models/pricing.ts) — the same table the backend cost
 * tracker uses — so this display can never drift from what a run actually billed. An id absent
 * from the catalog contributes $0 rather than guessing another model's rate (was: silently
 * mispricing every unrecognized model at gpt-4o's rate).
 */
function estimateCost(usage: UsageSummary): number {
  let cents = 0;
  for (const [model, tokens] of Object.entries(usage.tokensByModel)) {
    const rates = MODEL_CATALOG[model];
    if (!rates) continue;
    cents += (tokens.prompt / 1_000_000) * rates.input * 100;
    cents += (tokens.completion / 1_000_000) * rates.output * 100;
  }
  return cents;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function UsagePill({ usage }: { usage: UsageSummary }) {
  const total = Object.values(usage.tokensByModel).reduce((s, t) => s + t.prompt + t.completion, 0);
  if (total === 0) return null;
  const cents = estimateCost(usage);
  return (
    <span className="ml-2 inline-flex items-center gap-1.5 normal-case tracking-normal text-mute/70">
      {fmtTokens(total)} tokens · ~${cents < 1 ? cents.toFixed(2) : cents.toFixed(1)}¢
      {usage.firecrawlCredits > 0 && <> · {usage.firecrawlCredits} Firecrawl credits</>}
    </span>
  );
}

function UsageBreakdown({ usage }: { usage: UsageSummary }) {
  const models = Object.entries(usage.tokensByModel);
  if (models.length === 0) return null;
  return (
    <div className="mt-3 rounded border border-line bg-ink p-3">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-mute/70">API usage</div>
      <div className="space-y-1 font-mono text-[12px]">
        {models.map(([model, tokens]) => (
          <div key={model} className="flex items-center justify-between gap-4">
            <span className="text-fg/70">{model}</span>
            <span className="nums text-mute">
              {fmtTokens(tokens.prompt)} in · {fmtTokens(tokens.completion)} out
            </span>
          </div>
        ))}
        {usage.firecrawlCredits > 0 && (
          <div className="flex items-center justify-between gap-4">
            <span className="text-fg/70">Firecrawl</span>
            <span className="nums text-mute">{usage.firecrawlCredits} credits ({usage.firecrawlCalls} API calls)</span>
          </div>
        )}
        <div className="mt-1 border-t border-line pt-1 flex items-center justify-between gap-4">
          <span className="text-fg/70">Estimated cost</span>
          <span className="nums text-mute">~${estimateCost(usage) < 1 ? estimateCost(usage).toFixed(2) : estimateCost(usage).toFixed(1)}¢</span>
        </div>
      </div>
    </div>
  );
}
