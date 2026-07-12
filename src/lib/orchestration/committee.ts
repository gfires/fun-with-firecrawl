/**
 * committee.ts — the four-role deliberation layer.
 *
 * Given one Question and the evidence relevant to it, four role-agents each render an
 * INDEPENDENT Claim. The roles are chosen so their incentives pull in different directions —
 * a historian who wants precedent, an operator who wants friction, an investor who wants
 * returns, and a skeptic whose only job is to find the failure. Because they disagree by
 * construction, the manager can treat convergence across roles as real signal and divergence
 * as an open question worth more retrieval.
 *
 * FOR FUTURE AGENTS: The system prompts live here IN FULL and readable (prompt transparency is
 * a product requirement). Confidence is the load-bearing output — every prompt is explicit that
 * confidence must be *earned* by evidence, not asserted. See CONFIDENCE_CALIBRATION below; it is
 * shared verbatim across all four roles so the calibration bar is identical regardless of model.
 *
 * The skeptic deliberately runs on a different model family (see models/provider.ts) so the
 * adversarial check is not just a re-prompt of the same weights.
 */
import { generateText, Output } from "ai";
import { ClaimOutputSchema, type Claim, type AgentRoleT } from "../schemas/claim";
import type { Evidence } from "../schemas/evidence";
import type { Question } from "../schemas/state";
import { modelForRole } from "../models/provider";
import { toAnnotatedUsage, type AnnotatedUsage } from "./eval";
import { getActiveTrace } from "./trace";
import { getActiveCostTracker } from "./cost-tracker";
import { MAX_EVIDENCE_CHARS_PER_AGENT } from "../params";

/**
 * Calibration rules appended to every role prompt. Kept identical across roles so that a
 * confidence of 0.8 means the same thing whoever said it. This is the single most important
 * instruction in the file — the whole loop keys off calibrated confidence.
 */
const CONFIDENCE_CALIBRATION = `
CONFIDENCE CALIBRATION — read carefully, this is the most important part of your answer.
Your \`confidence\` is a probability (0.0–1.0) that your conclusion is correct. It must be EARNED
by the evidence you were given, not by how plausible your reasoning feels. Follow these rules:

- Anchor LOW and let evidence raise you. With no supporting evidence, you start near 0.2, not 0.5.
- Penalize sparsity: if supportingEvidenceIds has 0–1 entries, your confidence MUST stay below 0.5.
  Two-to-three independent, on-point sources is the floor for confidence above 0.6.
- Penalize contradiction HARD: if contradictingEvidenceIds is non-empty, cap confidence at 0.6, and
  drop further for every credible source that cuts against you. A single strong contradiction that
  you cannot explain away should pull you below 0.4.
- Weak, tangential, or off-topic sources do not count as support. Do not cite an id just to pad the
  list — only include ids that genuinely bear on THIS conclusion.
- If the evidence simply does not let you answer, say so: give a low-confidence conclusion and put the
  real gaps in missingEvidence. A calibrated "I don't know yet" is more valuable than a confident guess.
- Reserve confidence above 0.85 for conclusions with multiple strong, mutually-reinforcing sources and
  no unresolved contradiction. That should be rare.

Only reference evidence by its exact id string. Never invent ids and never inline source text.
`.trim();

/** Distinct incentive for each role. The differences here are the entire point of the committee. */
const ROLE_SYSTEM_PROMPTS: Record<AgentRoleT, string> = {
  historian: `
You are the HISTORIAN on a research committee evaluating a business opportunity.

Your incentive is PRECEDENT. You do not care whether an idea sounds good; you care whether it (or
something close to it) has been tried before, and what actually happened. Your value to the committee
is memory the others lack.

For the question asked, hunt the evidence for:
- Prior attempts, competitors, adjacent products, or historical analogues. Who tried this shape of thing?
- Outcomes: did they succeed, stall, pivot, or die — and specifically WHY. "Too early", "no distribution",
  "regulation changed", "incumbent bundled it for free" are the kinds of answers you look for.
- Repeating patterns across attempts. If three prior entrants all died the same way, that is a strong signal.
- What is genuinely different NOW (technology, cost curve, regulation, behavior) that could change the outcome
  versus what is just this cycle's founders assuming they are smarter than the last cohort.

Be concrete about the historical record. If the evidence contains no real precedent, say that plainly and
keep confidence low — absence of history is itself a finding, not a license to speculate.
`.trim(),

  operator: `
You are the OPERATOR on a research committee evaluating a business opportunity.

Your incentive is REALITY ON THE GROUND. You have run this kind of workflow. You care about what actually
breaks in the day-to-day — the steps that look trivial on a slide and consume hours in practice.

For the question asked, hunt the evidence for:
- The real workflow today: who does what, in what order, with which tools, and where the friction lives.
- The failure modes an outsider misses: edge cases, exceptions, handoffs, compliance steps, "the customer
  always sends it as a scanned PDF", the 20% of cases that are 80% of the pain.
- Adoption friction: switching cost, training, integration with the systems people already refuse to leave,
  and the political reasons a working solution still doesn't get bought.
- Whether a proposed solution survives contact with a messy Tuesday, not a clean demo.

Be specific about mechanism — name the step that breaks and why. If the evidence doesn't actually show you the
operational detail, don't assume it works smoothly; flag the gap and keep confidence low.
`.trim(),

  investor: `
You are the INVESTOR on a research committee evaluating a business opportunity.

Your incentive is RETURN. You are deciding whether to put capital behind this. A real pain point is
necessary but not sufficient — you care whether there is a fundable BUSINESS here and what the return
profile looks like.

For the question asked, hunt the evidence for:
- Market size and structure: how many buyers, how reachable, how concentrated. Is this a venture-scale market
  or a nice lifestyle business?
- Willingness and ability to pay: real budget signals, existing spend, deal sizes, contract lengths. Money
  already changing hands beats stated interest.
- The return shape: margins, defensibility (moat, network effects, switching cost), and a credible path from
  wedge to a much larger outcome. Where does this go if it works?
- The downside: what makes this uninvestable — commoditization, incumbent bundling, regulatory ceilings,
  or a market too small to matter even if you win it.

Think in terms of a portfolio bet, not enthusiasm. If the evidence doesn't support a fundable return, say so;
a well-calibrated "not investable on this evidence" is a valid and useful conclusion.
`.trim(),

  skeptic: `
You are the SKEPTIC on a research committee evaluating a business opportunity.

Your incentive is DISCONFIRMATION. Assume the historian, operator, and investor are all too optimistic —
that is your working prior. Your job is not to be balanced; it is to actively hunt for the reasons this
FAILS. If the idea is genuinely strong it will survive you, and then the committee can trust it.

For the question asked, attack the evidence:
- Find the strongest reason this does not work: no real demand, a workable status quo, a fatal unit economic,
  a regulatory wall, a distribution problem with no answer.
- Interrogate the evidence quality itself: thin sourcing, vendor marketing masquerading as demand, survivorship
  bias, correlation dressed as causation, sample of one. Weak evidence for a claim IS a reason to doubt it.
- Steelman the objections others will wave away. Name the specific scenario in which committing to this is a mistake.
- Refuse to be charitable by default. If something is merely plausible but unproven, treat it as unproven.

Your conclusion should state the most credible way this fails and how likely that is. You may be right that it is
robust — but only say so if the evidence forced you there against your own effort to break it.
`.trim(),
};

const ROLES: AgentRoleT[] = ["historian", "operator", "investor", "skeptic"];

function formatEvidence(evidence: Evidence[]): string {
  if (evidence.length === 0) {
    return "(no evidence was retrieved for this question yet — you must reflect that in low confidence)";
  }
  let totalChars = 0;
  const blocks: string[] = [];
  for (const e of evidence) {
    const block = `[${e.id}] ${e.title}\n  url: ${e.url}\n  snippet: ${e.snippet}\n\n${e.content}`;
    if (totalChars + block.length > MAX_EVIDENCE_CHARS_PER_AGENT && blocks.length > 0) break;
    blocks.push(block);
    totalChars += block.length;
  }
  return blocks.join("\n\n---\n\n");
}

/**
 * One-line-per-source index of already-seen evidence. On a re-debate we don't re-pay for
 * the full content of prior-loop sources — we collapse them to `[id] title — url — snippet`
 * so the ids stay citable while the token cost drops to a fraction of the full text.
 */
function formatEvidenceIndex(evidence: Evidence[]): string {
  if (evidence.length === 0) return "(none)";
  return evidence.map((e) => `[${e.id}] ${e.title} — ${e.url} — ${e.snippet}`).join("\n");
}

/**
 * Partition evidence into what arrived THIS loop (`fresh`) versus earlier loops (`prior`),
 * keyed on Evidence.loopIteration. `currentLoop` is the loop the committee is debating.
 * Exported for direct unit testing.
 */
export function splitEvidence(
  evidence: Evidence[],
  currentLoop: number,
): { fresh: Evidence[]; prior: Evidence[] } {
  const fresh: Evidence[] = [];
  const prior: Evidence[] = [];
  for (const e of evidence) {
    (e.loopIteration === currentLoop ? fresh : prior).push(e);
  }
  return { fresh, prior };
}

/**
 * Build the per-role user prompt.
 *
 * Loop 0 (or any role with no prior claim to update): render the full evidence set, as
 * before — nothing has been seen yet, so everything is fresh context.
 *
 * Re-debate (the role has a prior claim): only the FRESH evidence gets full text (still
 * capped by MAX_EVIDENCE_CHARS_PER_AGENT); prior-loop evidence collapses to a citable
 * id-index, and the role's own prior claim is shown with an instruction to UPDATE it
 * against the new evidence. This is the L1 incremental-debate token saving — a re-debate
 * pays for the delta, not the whole corpus again.
 */
export function buildUserPrompt(
  question: Question,
  evidence: Evidence[],
  currentLoop: number,
  priorClaim?: Claim,
): string {
  if (!priorClaim) {
    return [
      `QUESTION (${question.category}): ${question.text}`,
      "",
      "EVIDENCE — cite only by the bracketed id, e.g. supportingEvidenceIds: [\"<id>\"]:",
      formatEvidence(evidence),
      "",
      CONFIDENCE_CALIBRATION,
      "",
      "Render your Claim now. Keep conclusion to 2-3 sentences (under 400 chars) — be direct.",
      "List up to 3 specific evidence gaps in missingEvidence (each under 100 chars).",
      "Only fill: conclusion, confidence, supportingEvidenceIds, contradictingEvidenceIds, missingEvidence.",
    ].join("\n");
  }

  const { fresh, prior } = splitEvidence(evidence, currentLoop);
  return [
    `QUESTION (${question.category}): ${question.text}`,
    "",
    "NEW EVIDENCE this round — cite only by the bracketed id:",
    formatEvidence(fresh),
    "",
    "PRIOR EVIDENCE (already seen last round; full text omitted, still cite by id):",
    formatEvidenceIndex(prior),
    "",
    "YOUR PRIOR CLAIM — revise it in light of the new evidence above (do not restate it unchanged):",
    `  conclusion: ${priorClaim.conclusion}`,
    `  confidence: ${priorClaim.confidence.toFixed(2)}`,
    `  missingEvidence: ${priorClaim.missingEvidence.join("; ") || "(none noted)"}`,
    "",
    CONFIDENCE_CALIBRATION,
    "",
    "Render your UPDATED Claim now. Keep conclusion to 2-3 sentences (under 400 chars) — be direct.",
    "List up to 3 specific evidence gaps in missingEvidence (each under 100 chars).",
    "Only fill: conclusion, confidence, supportingEvidenceIds, contradictingEvidenceIds, missingEvidence.",
  ].join("\n");
}

/** The four independent role Claims for one question, plus each call's token usage. */
export interface CommitteeResult {
  claims: Claim[];
  usage: AnnotatedUsage[];
}

/**
 * Run the full four-role committee against one question and its relevant evidence.
 * Each role is called in parallel with its own model and produces one calibrated Claim.
 */
export async function runCommittee(
  question: Question,
  evidence: Evidence[],
  priorClaims: Claim[] = [],
): Promise<CommitteeResult> {
  // The loop iteration this claim belongs to = the most recent retrieval round it can see.
  const loopIteration = evidence.reduce((max, e) => Math.max(max, e.loopIteration), 0);

  const results = await Promise.all(
    ROLES.map(async (role): Promise<{ claim: Claim; usage: AnnotatedUsage }> => {
      const costTracker = getActiveCostTracker();
      costTracker?.check();

      const model = modelForRole(role);
      const system = ROLE_SYSTEM_PROMPTS[role];
      // This role's most recent prior claim, if any — drives the incremental re-debate
      // prompt (full fresh evidence + prior-evidence index + "update this claim").
      const priorClaim = priorClaims
        .filter((c) => c.agentRole === role)
        .sort((a, b) => b.loopIteration - a.loopIteration)[0];
      const prompt = buildUserPrompt(question, evidence, loopIteration, priorClaim);
      const { output: object, usage } = await generateText({
        model,
        output: Output.object({ schema: ClaimOutputSchema }),
        system,
        prompt,
      });

      const annotated = toAnnotatedUsage(usage, model.modelId, `committee:${role}`);
      costTracker?.record({ model: model.modelId, promptTokens: annotated.promptTokens, completionTokens: annotated.completionTokens });

      const trace = getActiveTrace();
      if (trace) {
        trace.logLlmCall(`committee:${role}`, { model: model.modelId, prompt, system }, object, usage);
      }

      const claim: Claim = {
        ...object,
        // Schema no longer hard-caps these (providers don't enforce them);
        // clamp here so downstream math and the gate see bounded values.
        confidence: Math.max(0, Math.min(1, object.confidence)),
        missingEvidence: object.missingEvidence.slice(0, 3),
        id: `${question.id}:${role}:${loopIteration}`,
        questionId: question.id,
        agentRole: role,
        loopIteration,
      };

      return { claim, usage: annotated };
    }),
  );

  return { claims: results.map((r) => r.claim), usage: results.map((r) => r.usage) };
}
