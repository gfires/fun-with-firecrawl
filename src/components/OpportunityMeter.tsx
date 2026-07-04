/**
 * OpportunityMeter — the hero 0–100 score, rendered as a radial gauge. This is the
 * headline number computed deterministically in scoring.ts (not from the LLM).
 */
export function OpportunityMeter({ score }: { score: number }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const dash = (score / 100) * circumference;
  const color = score >= 70 ? "#2dd4bf" : score >= 45 ? "#f5a623" : "#5b6b80";

  return (
    <div className="relative flex h-[136px] w-[136px] items-center justify-center">
      <svg className="h-full w-full -rotate-90" viewBox="0 0 128 128">
        <circle cx="64" cy="64" r={radius} fill="none" stroke="#1c2634" strokeWidth="8" />
        <circle
          cx="64"
          cy="64"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          style={{ transition: "stroke-dasharray 900ms cubic-bezier(0.16,1,0.3,1)" }}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="nums text-4xl font-semibold" style={{ color }}>
          {score}
        </span>
        <span className="eyebrow mt-0.5">Opportunity</span>
      </div>
    </div>
  );
}
