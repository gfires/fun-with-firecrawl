/**
 * page.tsx — the single page. Three states, driven by useScanStream:
 *   idle     → ScanInput (landing)
 *   running  → ScanProgress (live exploration visualization)
 *   done+ok  → ReportView (the diagnostic report)
 *   done+err → error card with retry
 *
 * No routing, no persistence — one-shot, exactly as specced.
 */
"use client";

import { useScanStream } from "@/lib/useScanStream";
import { ScanInput } from "@/components/ScanInput";
import { ScanProgress } from "@/components/ScanProgress";
import { ReportView } from "@/components/ReportView";

export default function Home() {
  const { state, start, reset } = useScanStream();

  const showReport = state.report && !state.running;
  const showError = state.error && !state.running;
  const showProgress = state.running || (!state.report && !state.error && state.phase !== "idle");

  return (
    <main className="min-h-screen px-4 py-10 sm:py-16">
      {/* Idle / landing */}
      {state.phase === "idle" && (
        <div className="flex min-h-[70vh] items-center justify-center">
          <ScanInput onRun={start} disabled={state.running} />
        </div>
      )}

      {/* Live exploration */}
      {showProgress && (
        <div className="pt-4">
          <ScanProgress state={state} />
        </div>
      )}

      {/* Report */}
      {showReport && <ReportView report={state.report!} prompt={state.prompt} onReset={reset} />}

      {/* Error */}
      {showError && (
        <div className="mx-auto mt-10 max-w-md panel p-6 text-center">
          <div className="eyebrow mb-2 text-danger">Scan failed</div>
          <p className="text-sm text-fg/85">{state.error}</p>
          <button
            onClick={reset}
            className="mt-4 rounded-lg border border-line px-5 py-2 font-mono text-sm text-fg transition hover:border-accent hover:text-accent"
          >
            Try again
          </button>
        </div>
      )}
    </main>
  );
}
