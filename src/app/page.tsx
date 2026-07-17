"use client";

import { useState } from "react";
import Link from "next/link";
import { useScanStream } from "@/lib/useScanStream";
import { useResearchStream } from "@/lib/useResearchStream";
import { ScanInput, type RunMode } from "@/components/ScanInput";
import { ScanProgress } from "@/components/ScanProgress";
import { ReportView } from "@/components/ReportView";
import { QuestionBoard } from "@/components/research/QuestionBoard";
import { ResearchReportView } from "@/components/research/ResearchReportView";
import { Leaderboard } from "@/components/Leaderboard";
import type { ResearchReport } from "@/lib/orchestration/graph";

export default function Home() {
  const [mode, setMode] = useState<RunMode>("scan");
  const scan = useScanStream();
  const research = useResearchStream();

  const isIdle = scan.state.phase === "idle" && research.state.phase === "idle";

  const handleRun = (topic: string, budget?: number, usdBudget?: number) => {
    if (mode === "research") {
      scan.reset();
      research.start(topic, budget, usdBudget);
    } else {
      research.reset();
      scan.start(topic);
    }
  };

  const handleReset = () => {
    scan.reset();
    research.reset();
  };

  // Scan state derivation
  const scanShowReport = scan.state.report && !scan.state.running;
  const scanShowError = scan.state.error && !scan.state.running;
  const scanShowProgress = scan.state.running || (!scan.state.report && !scan.state.error && scan.state.phase !== "idle");

  // Research state derivation
  const researchReport = research.state.report;
  const researchShowReport = researchReport && !research.state.running;
  const researchShowError = research.state.error && !research.state.running;
  const researchShowProgress = research.state.running || (!researchReport && !research.state.error && research.state.phase !== "idle");

  return (
    <main className="min-h-screen px-4 py-10 sm:py-16">
      {/* Idle / landing */}
      {isIdle && (
        <div className="flex min-h-[70vh] flex-col items-center justify-center">
          <ScanInput onRun={handleRun} disabled={scan.state.running || research.state.running} mode={mode} onModeChange={setMode} />
          <Leaderboard />
          <Link
            href="/replay"
            className="mt-4 font-mono text-xs text-mute transition hover:text-accent"
          >
            past runs →
          </Link>
        </div>
      )}

      {/* Scan: live exploration */}
      {scanShowProgress && (
        <div className="pt-4">
          <ScanProgress state={scan.state} />
        </div>
      )}

      {/* Scan: report */}
      {scanShowReport && <ReportView report={scan.state.report!} scan={scan.state} onReset={handleReset} />}

      {/* Research: live progress */}
      {researchShowProgress && (
        <div className="pt-4">
          <QuestionBoard state={research.state} />
        </div>
      )}

      {/* Research: report */}
      {researchShowReport && (
        <ResearchReportView report={researchReport as ResearchReport} scan={research.state} onReset={handleReset} />
      )}

      {/* Scan error */}
      {scanShowError && (
        <div className="mx-auto mt-10 max-w-md panel p-6 text-center">
          <div className="eyebrow mb-2 text-danger">Scan failed</div>
          <p className="text-sm text-fg/85">{scan.state.error}</p>
          <button
            onClick={handleReset}
            className="mt-4 rounded-lg border border-line px-5 py-2 font-mono text-sm text-fg transition hover:border-accent hover:text-accent"
          >
            Try again
          </button>
        </div>
      )}

      {/* Research error */}
      {researchShowError && (
        <div className="mx-auto mt-10 max-w-md panel p-6 text-center">
          <div className="eyebrow mb-2 text-danger">Research failed</div>
          <p className="text-sm text-fg/85">{research.state.error}</p>
          <button
            onClick={handleReset}
            className="mt-4 rounded-lg border border-line px-5 py-2 font-mono text-sm text-fg transition hover:border-accent hover:text-accent"
          >
            Try again
          </button>
        </div>
      )}
    </main>
  );
}
