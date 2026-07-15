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
 * FOR FUTURE AGENTS: All prompt WORDING now lives in one readable place — src/lib/prompts.ts
 * (prompt transparency is a product requirement). This file keeps the state-shaping and the
 * cache/ModelMessage plumbing. Confidence is the load-bearing output — every prompt is explicit
 * that confidence must be *earned* by evidence, not asserted. See CONFIDENCE_CALIBRATION in
 * prompts.ts; it is shared verbatim across all four roles so the calibration bar is identical
 * regardless of model.
 *
 * The skeptic deliberately runs on a different model family (see models/provider.ts) so the
 * adversarial check is not just a re-prompt of the same weights.
 */
import { generateText, Output, type ModelMessage } from "ai";
import { ClaimOutputSchema, DebateTurnOutputSchema, type Claim, type AgentRoleT } from "../schemas/claim";
import type { Evidence } from "../schemas/evidence";
import type { Question } from "../schemas/state";
import { modelForRole, modelForDebateRound } from "../models/provider";
import { toAnnotatedUsage, type AnnotatedUsage } from "./eval";
import { getActiveTrace } from "./trace";
import { getActiveCostTracker } from "./cost-tracker";
import {
  MAX_EVIDENCE_CHARS_PER_AGENT,
  PROMPT_CACHE_MIN_CHARS,
  LLM_MAX_RETRIES,
  MAX_DEBATE_ROUNDS,
  DEBATE_CONSENSUS_SPREAD,
  DEBATE_CONSENSUS_MIN_CONFIDENCE,
  DEBATE_CONFIDENCE_EPSILON,
} from "../params";
// Prompt WORDING lives in one place (src/lib/prompts.ts). This file keeps the state-shaping and
// the cache/ModelMessage plumbing; the shared system prefix and the per-role user messages are
// assembled there from the pieces computed here.
import {
  NO_EVIDENCE_NOTICE,
  stableSystemHead,
  committeeUserMessage,
  debateUserMessage,
} from "../prompts";
import { formatDigestForCommittee, type DigestItem } from "./digest";
import { limiterForModel } from "./limiter";
import { renderTranscript, roundOneConsensus, debateMovement, directedChallenges, type DebateRound } from "./debate";

const ROLES: AgentRoleT[] = ["historian", "operator", "investor", "skeptic"];

function formatEvidence(evidence: Evidence[]): string {
  if (evidence.length === 0) {
    return NO_EVIDENCE_NOTICE;
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
 * Partition evidence into what arrived THIS loop (`fresh`) versus earlier loops (`prior`),
 * keyed on Evidence.loopIteration. `currentLoop` is the loop the committee is debating.
 * The debate node uses `.fresh` to decide what to digest (old evidence is never re-digested).
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
 * Serialize the shared system prefix into AI-SDK `system` messages, placing Anthropic
 * prompt-cache breakpoints for CROSS-round reuse.
 *
 * The bug this fixes: a single `cacheControl` on ONE system message that GROWS every round
 * (stable head + an ever-longer transcript) makes each round write a fresh cache entry keyed to
 * the whole block. Anthropic only re-reads a cached prefix AT a breakpoint, and the sole
 * breakpoint sat at the moving tail — so nothing was ever re-read across rounds and the cache
 * read/write ratio was pinned at exactly 2.0 (within-round only: 1 historian write + 2 reads).
 *
 * The fix adds a second breakpoint at the STABLE head boundary. The head (objective + question +
 * evidence + calibration) is byte-identical across every debate round AND across the opening
 * committee round, so Anthropic serves that large block from cache on every call instead of
 * re-billing it each round. When `tailText` is present (a debate round), the head and the growing
 * transcript become two consecutive `system` messages; @ai-sdk/anthropic merges consecutive
 * system messages into ONE top-level `system` array (one text block + `cache_control` each), so
 * this stays a normal cached system prompt — NOT a mid-conversation system message — with two
 * breakpoints, well under Anthropic's limit of four. The trailing breakpoint on the transcript
 * still gives the within-round reuse across the three Claude roles that already worked.
 *
 * When caching is off (the OpenAI skeptic, or a prefix below PROMPT_CACHE_MIN_CHARS) the prefix
 * stays a single plain `system` message with no providerOptions — byte-for-byte the pre-fix
 * shape (head+tail concatenated), so the skeptic/OpenAI path and small prompts are untouched.
 */
function cacheableSystemMessages(
  headText: string,
  tailText: string | null,
  cacheable: boolean,
): ModelMessage[] {
  if (!cacheable) {
    return [{ role: "system", content: tailText === null ? headText : headText + tailText }];
  }
  const cc = { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } } };
  const head: ModelMessage = { role: "system", content: headText, ...cc };
  return tailText === null ? [head] : [head, { role: "system", content: tailText, ...cc }];
}

/**
 * Build the AI-SDK messages for one committee role, structured for Anthropic prompt-cache
 * hits (L3).
 *
 * The `system` message is a shared prefix — question + evidence/digest block + the
 * confidence calibration — that is BYTE-IDENTICAL across the three Claude roles (nothing
 * role-specific leaks in), so Anthropic serves it from cache after the first role writes it.
 * The role persona and the task instructions (and, on a re-debate, the role's own prior
 * claim) live in the `user` message, where they vary per role without disturbing the cache.
 *
 * cacheControl is attached only above PROMPT_CACHE_MIN_CHARS (a tiny prefix isn't worth
 * caching) and only for the Claude roles — the skeptic runs on OpenAI and gets no anthropic
 * providerOptions. `currentLoop` is part of the signature for callers that key cache reuse
 * on the loop; the prompt text itself doesn't branch on it.
 *
 * `objective` (the intake ResearchBrief's objective) is prepended as a short RESEARCH OBJECTIVE
 * block to the SHARED system prefix. It is topic-level — identical across the three Claude roles —
 * so the byte-identical-across-roles cache invariant (L3) still holds. It is CONTEXT that points
 * the existing roles at the real ask (the skeptic can attack the actual bet); it does NOT touch
 * ROLE_SYSTEM_PROMPTS, which stay in the per-role user message unchanged.
 */
export function buildCommitteeMessages(
  role: AgentRoleT,
  question: Question,
  evidenceBlock: string,
  currentLoop: number,
  priorClaim?: Claim,
  objective = "",
): ModelMessage[] {
  void currentLoop; // reserved: reuse is keyed on prefix identity, not the loop number

  // Round 0 has no transcript, so the stable head IS the whole shared prefix — a single cache
  // block. It is byte-identical to the head the debate rounds emit, so debate round 1 reads this
  // opening round's evidence + calibration from cache. See cacheableSystemMessages.
  const headText = stableSystemHead(objective, question, evidenceBlock).join("\n");

  // Cache the shared prefix for the Claude roles once it's big enough to be worth it.
  // The skeptic (OpenAI) never carries anthropic providerOptions.
  const cacheable = role !== "skeptic" && headText.length > PROMPT_CACHE_MIN_CHARS;
  const system = cacheableSystemMessages(headText, null, cacheable);

  const user: ModelMessage = { role: "user", content: committeeUserMessage(role, priorClaim) };

  return [...system, user];
}

/**
 * Build the AI-SDK messages for one role's CONVERSATIONAL turn (debate round ≥1), structured to
 * preserve the L3 prompt cache exactly as the opening round does.
 *
 * The `system` prefix is the stable head (objective + question + evidence/digest block + confidence
 * calibration) followed by the rendered transcript of all PRIOR rounds — BYTE-IDENTICAL across the
 * three Claude roles. For the Claude roles it is emitted as TWO consecutive `system` messages so the
 * head carries its OWN Anthropic cache breakpoint (served from cache across ALL rounds, including the
 * opening committee round) in addition to the trailing breakpoint on the transcript (within-round
 * reuse across roles). See cacheableSystemMessages for why the head breakpoint is the cross-round win.
 * The transcript is deterministic, role-independent, and append-only (see renderTranscript /
 * stableSystemHead). The per-role material (the challenges aimed at this role, this role's own prior
 * turn, and the task) all lives in the `user` message. cacheControl is attached only above
 * PROMPT_CACHE_MIN_CHARS and never for the skeptic (OpenAI).
 *
 * `transcript` is every round rendered so far; its LAST round supplies the challenges this role must
 * answer. `priorTurn` is this role's most recent claim, which it is revising.
 */
export function buildDebateMessages(
  role: AgentRoleT,
  question: Question,
  evidenceBlock: string,
  transcript: DebateRound[],
  priorTurn: Claim | undefined,
  currentLoop: number,
  objective = "",
): ModelMessage[] {
  void currentLoop; // reserved: reuse is keyed on prefix identity, not the loop number

  // Stable head first (objective + question + evidence + calibration), then the GROWING transcript
  // as a SEPARATE cache block. The head gets its OWN breakpoint (cacheableSystemMessages), so
  // Anthropic serves it from cache on every round — and from the opening committee round — instead
  // of re-billing the whole ~16k-char prefix every round behind a single trailing breakpoint (the
  // read/write-ratio-stuck-at-2.0 bug). The trailing breakpoint on the transcript keeps within-round
  // reuse across the three Claude roles. `tailText` reproduces the pre-fix bytes (head + tail is the
  // exact old single-string prefix) so nothing but the breakpoint placement changes.
  const headText = stableSystemHead(objective, question, evidenceBlock).join("\n");
  const tailText = ["", "", "DEBATE SO FAR (all prior rounds):", renderTranscript(transcript)].join("\n");

  const cacheable =
    role !== "skeptic" && headText.length + tailText.length > PROMPT_CACHE_MIN_CHARS;
  const system = cacheableSystemMessages(headText, tailText, cacheable);

  // Challenges aimed at THIS role, in the latest round — directedChallenges is the single source of
  // truth and tags each with the peer that raised it (its `from`), so we render who challenged whom.
  const latestRound = transcript[transcript.length - 1];
  const challengeLines = (latestRound ? directedChallenges(latestRound, role) : []).map(
    ({ from, response }) => `[${from}] ${response.stance}s your position (${response.stance}): ${response.point}`,
  );

  const user: ModelMessage = {
    role: "user",
    content: debateUserMessage({ role, challengeLines, priorTurn }),
  };

  return [...system, user];
}

/** The four independent role Claims for one question, plus each call's token usage. */
export interface CommitteeResult {
  claims: Claim[];
  usage: AnnotatedUsage[];
}

/**
 * Run the full four-role committee against one question and its relevant evidence.
 * Each role produces one calibrated Claim on its own model.
 *
 * Execution is STAGGERED for cache hits: the historian runs first and WRITES the shared
 * system prefix into Anthropic's cache; operator, investor and skeptic then run together,
 * with the two remaining Claude roles READING that cached prefix. (The skeptic is OpenAI
 * and unaffected by the cache, but runs in the same second wave.)
 */
export async function runCommittee(
  question: Question,
  evidence: Evidence[],
  priorClaims: Claim[] = [],
  digestItems: DigestItem[] = [],
  objective = "",
): Promise<CommitteeResult> {
  // The loop iteration this claim belongs to = the most recent retrieval round it can see.
  const loopIteration = evidence.reduce((max, e) => Math.max(max, e.loopIteration), 0);

  // Every role sees the same evidence block: the digest when we have one, else raw
  // evidence (digest disabled or the digest call failed — a run must survive either).
  const evidenceBlock = digestItems.length > 0
    ? formatDigestForCommittee(evidence, digestItems)
    : formatEvidence(evidence);

  const runRole = async (role: AgentRoleT): Promise<{ claim: Claim; usage: AnnotatedUsage }> => {
    const costTracker = getActiveCostTracker();
    costTracker?.check();

    // Loop 0 uses the full model mix; re-debates drop the Claude roles to Haiku (L4).
    const model = modelForRole(role, loopIteration);
    // This role's most recent prior claim, if any — drives the incremental re-debate
    // prompt ("update this claim against the new evidence").
    const priorClaim = priorClaims
      .filter((c) => c.agentRole === role)
      .sort((a, b) => b.loopIteration - a.loopIteration)[0];
    const messages = buildCommitteeMessages(role, question, evidenceBlock, loopIteration, priorClaim, objective);
    // Cap concurrency per model (L6) so a committee fan-out can't trip gpt-4o's TPM limit,
    // and retry transient provider errors.
    const { output: object, usage } = await limiterForModel(model.modelId)(() =>
      generateText({
        model,
        output: Output.object({ schema: ClaimOutputSchema }),
        messages,
        // buildCommitteeMessages puts the cacheable shared prefix in a `system` message so
        // Anthropic can cache it; the SDK forbids system messages in `messages` unless we
        // opt in here (otherwise: AI_InvalidPromptError "System messages are not allowed").
        allowSystemInMessages: true,
        maxRetries: LLM_MAX_RETRIES,
      }),
    );

    const annotated = toAnnotatedUsage(usage, model.modelId, `committee:${role}`);
    costTracker?.record(annotated);

    const trace = getActiveTrace();
    if (trace) {
      trace.logLlmCall(`committee:${role}`, { model: model.modelId, loopIteration, prompt: messages }, object, usage);
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
      // runCommittee produces the independent OPENING round; runDebate (D4) drives the
      // conversational rounds that populate responses.
      debateRound: 0,
      responses: [],
    };

    return { claim, usage: annotated };
  };

  // Historian first (cache write), then the rest in parallel (cache read for the Claude roles).
  const historian = await runRole("historian");
  const rest = await Promise.all(
    ROLES.filter((r) => r !== "historian").map(runRole),
  );
  const results = [historian, ...rest];

  return { claims: results.map((r) => r.claim), usage: results.map((r) => r.usage) };
}

/** The full debate for one question: durable final claims, every round's transcript, and usages. */
export interface DebateResult {
  /** The FINAL round's claims — the durable positions that cross the retrieval boundary. */
  claims: Claim[];
  /** Every round (0 = opening, then conversational), for the transcript channel + reporting. */
  rounds: DebateRound[];
  usage: AnnotatedUsage[];
}

/**
 * Run the committee as a REAL debate over one question and its (frozen) evidence.
 *
 * Round 0 is the existing independent opening (runCommittee): four blind claims, which preserves the
 * historian-confabulation fix and makes cross-role agreement real signal. If those openings already
 * AGREE (roundOneConsensus) we stop there — no debate is worth running. Otherwise each role reads the
 * full prior transcript and the challenges aimed at it and revises across conversational rounds,
 * conceding ONLY to evidence. Each round is staggered exactly like round 0 (historian first to write
 * the shared cached prefix, the rest in parallel to read it) so the L3 cache still hits, and uses the
 * declining-cost model mix (modelForDebateRound). The debate stops when a round doesn't move any
 * position or open a fresh rebuttal (debateMovement) or at MAX_DEBATE_ROUNDS. Evidence never changes
 * mid-debate; only the outer retrieval loop adds evidence.
 */
export async function runDebate(
  question: Question,
  evidence: Evidence[],
  priorClaims: Claim[] = [],
  digestItems: DigestItem[] = [],
  objective = "",
): Promise<DebateResult> {
  const loopIteration = evidence.reduce((max, e) => Math.max(max, e.loopIteration), 0);
  const evidenceBlock = digestItems.length > 0
    ? formatDigestForCommittee(evidence, digestItems)
    : formatEvidence(evidence);

  // Round 0 — the independent opening (blind), identical to today's committee pass.
  const opening = await runCommittee(question, evidence, priorClaims, digestItems, objective);
  const rounds: DebateRound[] = [{ round: 0, claims: opening.claims }];
  const usage: AnnotatedUsage[] = [...opening.usage];

  // Consensus fast-path: genuine agreement on the openings → no debate, no gate retrieval.
  if (roundOneConsensus(opening.claims, {
    spread: DEBATE_CONSENSUS_SPREAD,
    minConfidence: DEBATE_CONSENSUS_MIN_CONFIDENCE,
  })) {
    return { claims: opening.claims, rounds, usage };
  }

  // One role's conversational turn in debate round `r`: revise against the full prior transcript
  // and the challenges aimed at it. Mirrors runCommittee's per-role wiring (limiter, retries, cost,
  // trace) but emits a DebateTurnOutput (claim + directed responses).
  const runTurn = async (
    role: AgentRoleT,
    r: number,
    priorRounds: DebateRound[],
  ): Promise<{ claim: Claim; usage: AnnotatedUsage }> => {
    const costTracker = getActiveCostTracker();
    costTracker?.check();

    const model = modelForDebateRound(role, r, loopIteration);
    const priorTurn = priorRounds[priorRounds.length - 1].claims.find((c) => c.agentRole === role);
    const messages = buildDebateMessages(role, question, evidenceBlock, priorRounds, priorTurn, loopIteration, objective);

    const { output: object, usage: rawUsage } = await limiterForModel(model.modelId)(() =>
      generateText({
        model,
        output: Output.object({ schema: DebateTurnOutputSchema }),
        messages,
        allowSystemInMessages: true,
        maxRetries: LLM_MAX_RETRIES,
      }),
    );

    const annotated = toAnnotatedUsage(rawUsage, model.modelId, `debate:${role}`);
    costTracker?.record(annotated);

    getActiveTrace()?.logLlmCall(`debate:${role}`, { model: model.modelId, loopIteration, debateRound: r, prompt: messages }, object, rawUsage);

    const claim: Claim = {
      ...object,
      confidence: Math.max(0, Math.min(1, object.confidence)),
      missingEvidence: object.missingEvidence.slice(0, 3),
      id: `${question.id}:${role}:${loopIteration}:d${r}`,
      questionId: question.id,
      agentRole: role,
      loopIteration,
      debateRound: r,
      responses: object.responses,
    };
    return { claim, usage: annotated };
  };

  // Conversational rounds 1..MAX. Same stagger as round 0 (historian writes the cache, rest read),
  // and stop the moment a round produces no movement.
  for (let r = 1; r <= MAX_DEBATE_ROUNDS; r++) {
    const priorRounds = [...rounds];
    const historian = await runTurn("historian", r, priorRounds);
    const rest = await Promise.all(
      ROLES.filter((role) => role !== "historian").map((role) => runTurn(role, r, priorRounds)),
    );
    const turns = [historian, ...rest];
    usage.push(...turns.map((t) => t.usage));

    const thisRound: DebateRound = { round: r, claims: turns.map((t) => t.claim) };
    const movement = debateMovement(rounds[rounds.length - 1], thisRound, DEBATE_CONFIDENCE_EPSILON);
    getActiveTrace()?.log("debate:round", {
      questionId: question.id,
      round: r,
      moved: movement.moved,
      newRebuttals: movement.newRebuttals,
      converged: movement.converged,
    });
    rounds.push(thisRound);
    if (movement.converged) break;
  }

  // The final round's claims are the durable positions; the full transcript is ephemeral to this
  // evidence snapshot.
  return { claims: rounds[rounds.length - 1].claims, rounds, usage };
}
