/**
 * ReportView — renders a completed ScanReport: hero, gauges, the eight sections (in the
 * spec's order), playful stats, and a full source appendix. Every claim carries citations.
 */
import type { ScanReport } from "@/lib/schema";
import type { PromptTrace } from "@/lib/useScanStream";
import { SCORE_DEFINITIONS } from "@/lib/analyze";
import { OpportunityMeter } from "./OpportunityMeter";
import { Gauge } from "./Gauge";
import { ReportSection, EvidenceList } from "./ReportSection";
import { PlayfulStats } from "./PlayfulStats";
import { Citations } from "./SourceChip";

export function ReportView({
  report,
  prompt,
  onReset,
}: {
  report: ScanReport;
  prompt: PromptTrace | null;
  onReset: () => void;
}) {
  const { sources } = report;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      {/* Hero */}
      <div className="panel flex flex-col items-center gap-6 p-6 sm:flex-row sm:items-center animate-rise">
        <OpportunityMeter score={report.opportunityScore} />
        <div className="flex-1 text-center sm:text-left">
          <div className="eyebrow">Opportunity MRI · complete</div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{report.industry}</h1>
          <p className="mt-2 text-sm text-fg/85">{report.snapshot}</p>
        </div>
      </div>

      {/* Playful diagnostic readout */}
      <PlayfulStats stats={report.playfulStats} />

      {/* Five sub-score gauges */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SCORE_DEFINITIONS.map((d) => (
          <Gauge
            key={d.key}
            name={d.name}
            score={report.scores[d.key as keyof ScanReport["scores"]]}
            sources={sources}
          />
        ))}
      </div>

      {/* Sections in the spec's order */}
      <ReportSection index="01" title="Industry Snapshot">
        <p className="text-sm leading-relaxed text-fg/90">{report.snapshot}</p>
      </ReportSection>

      <ReportSection index="02" title="Detected Bottlenecks">
        <EvidenceList items={report.bottlenecks} sources={sources} />
      </ReportSection>

      <ReportSection index="03" title="Current Software Ecosystem" subtitle={report.softwareEcosystem.summary}>
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

      <ReportSection index="04" title="Signals of Friction">
        <EvidenceList items={report.frictionSignals} sources={sources} />
      </ReportSection>

      <ReportSection index="05" title="Potential AI Opportunities">
        <div className="grid gap-3 sm:grid-cols-2">
          {report.aiOpportunities.map((o, i) => (
            <div key={i} className="rounded border border-line bg-panel2 p-3">
              <div className="font-mono text-sm text-accent">{o.title}</div>
              <p className="mt-1 text-[13px] leading-snug text-fg/85">{o.why}</p>
              <div className="mt-1.5">
                <Citations ids={o.sourceIds} sources={sources} />
              </div>
            </div>
          ))}
        </div>
      </ReportSection>

      <ReportSection index="06" title="Underserved Niches">
        <EvidenceList items={report.underservedNiches} sources={sources} />
      </ReportSection>

      <ReportSection index="07" title="Adjacent Markets">
        <EvidenceList items={report.adjacentMarkets} sources={sources} />
      </ReportSection>

      <ReportSection index="08" title="Example Startup Concepts">
        <div className="grid gap-3 sm:grid-cols-2">
          {report.startupConcepts.map((c, i) => (
            <div key={i} className="rounded border border-line bg-panel2 p-3">
              <div className="font-mono text-sm text-amber">{c.name}</div>
              <p className="mt-1 text-[13px] leading-snug text-fg/85">{c.pitch}</p>
              <div className="mt-1.5">
                <Citations ids={c.sourceIds} sources={sources} />
              </div>
            </div>
          ))}
        </div>
      </ReportSection>

      {/* Source appendix — the full [N] list */}
      <ReportSection index="—" title="Sources" subtitle="Every score and claim above cites these by number.">
        <ol className="space-y-1">
          {sources.map((s) => (
            <li key={s.id} className="flex gap-2 font-mono text-[12px]">
              <span className="nums w-7 shrink-0 text-accent">[{s.id}]</span>
              <a href={s.url} target="_blank" rel="noreferrer" className="truncate text-mute hover:text-accent" title={s.url}>
                {s.title} · {s.domain}
              </a>
            </li>
          ))}
        </ol>
      </ReportSection>

      {/* Method / assumptions disclosure — transparency requirement. */}
      <details className="panel p-4 text-sm text-mute">
        <summary className="cursor-pointer font-mono text-xs uppercase tracking-widest text-fg/70">
          Method &amp; assumptions
        </summary>
        <p className="mt-3 leading-relaxed">
          Opportunity MRI generated {report.sources.length ? "a set of" : "no"} search intents,
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
      </details>

      {/* The exact prompt that produced this report — collapsed, for full transparency. */}
      {prompt && (
        <details className="panel p-4">
          <summary className="cursor-pointer font-mono text-xs uppercase tracking-widest text-fg/70">
            Prompt sent to {prompt.model} <span className="normal-case tracking-normal text-mute">(exact)</span>
          </summary>
          <div className="mt-3 space-y-3">
            <div>
              <div className="eyebrow mb-1">System</div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-line bg-ink p-2 font-mono text-[11px] leading-relaxed text-fg/80">
                {prompt.systemPrompt}
              </pre>
            </div>
            <div>
              <div className="eyebrow mb-1">User</div>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-line bg-ink p-2 font-mono text-[11px] leading-relaxed text-fg/80">
                {prompt.userPrompt}
              </pre>
            </div>
          </div>
        </details>
      )}

      <div className="flex justify-center pb-8 pt-2">
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
