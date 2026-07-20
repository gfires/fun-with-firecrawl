/**
 * prompts.ts — every LLM prompt's WORDING in one place.
 *
 * This file plays for prompt PROSE the role params.ts plays for tunables: it is the single,
 * readable home for the exact text we send to models, so a human can audit and tune voice
 * without spelunking through the orchestration nodes. It holds ONLY wording — no state, no
 * model calls, no cache/ModelMessage plumbing. Every export is either:
 *   - a `const` static block (a persona, the confidence calibration, a fixed notice), or
 *   - a pure builder function that takes the already-computed dynamic pieces a node produced
 *     (an objective string, a joined evidence block, a list of pre-rendered sections) and
 *     returns the assembled prompt text.
 *
 * The nodes keep all the STATE-SHAPING (reading ResearchState, scoping evidence, computing
 * [S#] labels, cache-block construction). They pass the finished pieces in; this file only
 * decides how the words read. Byte-identity matters: the test suite asserts many exact prompt
 * substrings, so treat the text here as load-bearing and change wording deliberately.
 *
 * Sections run in pipeline order: intake → decompose → digest → committee (calibration + roles)
 * → debate → gate → synthesis/answer.
 */
import { MIN_QUESTIONS, MAX_QUESTIONS } from "./params";
import { ROLES } from "./roles";
import type { AgentRoleT, Claim } from "./schemas/claim";
import { STANCE_DEFINITION } from "./schemas/claim";
import type { Question } from "./schemas/state";

// ---------------------------------------------------------------------------
// Shared notice
// ---------------------------------------------------------------------------

/**
 * The evidence block a committee role sees when NOTHING was retrieved yet. Shared verbatim by
 * the raw-evidence path (committee.formatEvidence) and the digest path
 * (digest.formatDigestForCommittee) so an empty question reads identically either way.
 */
export const NO_EVIDENCE_NOTICE =
  "(no evidence was retrieved for this question yet — you must reflect that in low confidence)";

// ---------------------------------------------------------------------------
// intake
// ---------------------------------------------------------------------------

/**
 * The intake manager prompt: read the raw topic into a ResearchBrief. Keeps the PRODUCT MANDATE
 * (opportunity/market analysis, not open-ended research) so a bare phrase yields a survey
 * objective and a thesis yields the extracted ask.
 */
export function intakePrompt(topic: string): string {
  return [
    "You are the research manager for an OPPORTUNITY / MARKET ANALYSIS product (a committee",
    "of a historian, operator, investor and skeptic will evaluate the business case). Read the",
    "input below and produce a brief that points that machinery at the REAL ask.",
    "",
    `INPUT: ${topic}`,
    "",
    "Infer three things:",
    "- subject: the entity or space to search ABOUT (a short noun phrase).",
    "- objective: ONE statement of what output would satisfy THIS input, in the product's terms.",
    "  A bare industry phrase → a survey of the opportunity landscape. A sharper niche → a survey",
    "  scoped to it. A thesis or investment decision → the specific bet to adjudicate (a go/no-go,",
    "  a verdict). Do NOT turn it into generic open-ended research — keep the business-opportunity lens.",
    "- constraints: explicit scope boundaries, requirements, or decision criteria the INPUT stated",
    "  (budget, geography, timeframe, buyer segment, the specific claim to test). If the input is a",
    "  bare phrase that states none, return an EMPTY list — do not invent constraints.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// decompose
// ---------------------------------------------------------------------------

/**
 * The decompose manager prompt: break the intake OBJECTIVE into MIN..MAX concrete questions,
 * scoped inside the CONSTRAINTS. The generic-facet list survives only as a fallback hint for a
 * broad survey objective. `constraintsBlock` is the caller's pre-rendered constraint list (or a
 * "(none stated)" placeholder).
 */
export function decomposePrompt(args: {
  subject: string;
  objective: string;
  constraintsBlock: string;
  currentYear: number;
}): string {
  const { subject, objective, constraintsBlock, currentYear } = args;
  return [
    "You are the research manager scoping an investigation for an opportunity/market analysis",
    "committee (a historian, operator, investor and skeptic will evaluate the business case).",
    "",
    `SUBJECT: ${subject}`,
    `OBJECTIVE: ${objective}`,
    "CONSTRAINTS (respect these — scope every question inside them):",
    constraintsBlock,
    "",
    `The current year is ${currentYear}. When a question is about the CURRENT state of the market`,
    `(size, pricing, vendors, regulation), use ${currentYear} in its search query, not an older year —`,
    "we want the latest data. Only use a specific past year when the question is genuinely historical.",
    "",
    `Generate ${MIN_QUESTIONS}–${MAX_QUESTIONS} distinct, researchable questions whose answers`,
    "would together SATISFY the objective. Each must be answerable from web evidence, and the set",
    "must serve the objective's actual altitude: a broad survey wants wide coverage of the space;",
    "a go/no-go or thesis wants the questions that would actually settle that specific bet. Stay",
    "opinionated toward actionable market/opportunity analysis — do NOT drift into generic research.",
    "",
    "If (and only if) the objective is a broad survey with no sharper ask, default to covering the",
    "core facets: market, customers, competition, economics, risks.",
    "",
    "For EACH question also give ONE short keyword search query (not the sentence) — the literal",
    "string we will search — using the space's real jargon, named tools, and specifics.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// digest (L2)
// ---------------------------------------------------------------------------

/**
 * The per-question digest prompt: compress each source into ONE item keyed by its exact
 * bracketed id, preserving concrete substance and flagging off-topic sources rather than padding.
 * `sourcesBlock` is the caller's already-assembled `[id] title — url\ncontent` block (digest.ts
 * owns that source rendering; this file owns only the instruction prose around it).
 */
export function digestPrompt(args: { question: Question; sourcesBlock: string }): string {
  const { question, sourcesBlock } = args;
  return [
    `QUESTION (${question.category}): ${question.text}`,
    "",
    "Compress each source below into ONE digest item, keyed by its EXACT bracketed id.",
    "Preserve the concrete substance: numbers, named entities, dates, and short direct quotes.",
    "If a source is off-topic for this question, say so in one clause — do not pad it.",
    "Return exactly one item per source id. Do not merge, split, or invent ids.",
    "",
    "SOURCES:",
    sourcesBlock,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// committee — confidence calibration
// ---------------------------------------------------------------------------

/**
 * Calibration rules appended to every role prompt. Kept identical across roles so that a
 * confidence of 0.8 means the same thing whoever said it. This is the single most important
 * instruction in the committee — the whole loop keys off calibrated confidence.
 */
export const CONFIDENCE_CALIBRATION = `
CONFIDENCE CALIBRATION — read carefully, this is the most important part of your answer.
Your \`confidence\` is a probability (0.0–1.0) that your conclusion is correct. It must be EARNED
by the evidence you were given, not by how plausible your reasoning feels. Follow these rules:

- Anchor LOW and let evidence raise you. With no supporting evidence, you start near 0.2, not 0.5.
- Penalize sparsity: if supportingEvidenceIds has 0–1 entries, your confidence MUST stay below 0.5.
  Two-to-three independent, on-point sources is the floor for confidence above 0.6.
- Credit PROXY and circumstantial evidence toward that floor — it need not be the ideal datum. A firm
  that has sustained subscription revenue across years and segments, a validated accuracy benchmark, a
  structural spending pattern are real signal about THIS question even when the perfect number is absent.
  Do NOT hold your confidence hostage to an IDEAL datum (exact ARR, private churn, a named competitor's
  documented fate) that is unlikely to ever be public: reason from the best available evidence to the
  most warranted call, and say what it implies rather than withholding judgment.
- Penalize contradiction HARD: if contradictingEvidenceIds is non-empty, cap confidence at 0.6, and
  drop further for every credible source that cuts against you. A single strong contradiction that
  you cannot explain away should pull you below 0.4.
- Weak, tangential, or off-topic sources do not count as support. Do not cite an id just to pad the
  list — only include ids that genuinely bear on THIS conclusion.
- Name gaps in missingEvidence ONLY when they are load-bearing for THIS conclusion AND plausibly PUBLIC
  — a named entity, a published benchmark, a documented outcome that more searching could actually
  surface. Do NOT pad to a fixed count. If the missing datum is structurally PRIVATE (internal
  financials, churn, exit interviews, proprietary thresholds), note it as a limitation in your
  conclusion but do NOT list it as a gap to chase (more retrieval will not find it) and do NOT let its
  absence alone cap your confidence — reason from the best proxy you do have.
- If the evidence simply does not let you answer, say so: give a low-confidence conclusion and put the
  real gaps in missingEvidence. A calibrated "I don't know yet" is more valuable than a confident guess.
- Reserve confidence above 0.85 for conclusions with multiple strong, mutually-reinforcing sources and
  no unresolved contradiction. That should be rare.

Only reference evidence by its exact id string. Never invent ids and never inline source text.
`.trim();

// ---------------------------------------------------------------------------
// committee — shared system prefix (objective + question + evidence + calibration)
// ---------------------------------------------------------------------------

/**
 * The RESEARCH OBJECTIVE lines prepended to the committee's SHARED system prefix (the intake
 * brief's objective). Kept in one place so the opening round and the conversational rounds
 * render it identically. Empty objective → no block (the prefix is unchanged from pre-A4), so a
 * run with no brief behaves exactly as before. The block is topic-level and role-independent,
 * so it never breaks the byte-identical-across-roles cache invariant.
 */
export function objectivePrefix(objective: string): string[] {
  const trimmed = objective.trim();
  if (!trimmed) return [];
  return [
    "RESEARCH OBJECTIVE — the committee's shared goal for this whole investigation. Aim your",
    "role's analysis at THIS ask (do not restate it; use it to sharpen what you look for):",
    trimmed,
    "",
  ];
}

/**
 * The STABLE head of the committee's shared system prefix: objective + question + evidence block +
 * confidence calibration. For a fixed evidence snapshot (evidence is FROZEN during a debate) this is
 * byte-identical across the opening round (buildCommitteeMessages) and every conversational round
 * (buildDebateMessages), and identical across the three Claude roles.
 *
 * Calibration is the LAST thing in the head — deliberately BEFORE the transcript — so that the head,
 * and then each successive round's transcript, form an APPEND-ONLY prefix: round r's full system
 * message is a byte-prefix of round r+1's. That lets Anthropic's incremental prompt cache serve the
 * head + all prior rounds from cache and bill only the newest round's delta, across rounds, not just
 * across roles within a round. (Before this, calibration trailed the growing transcript, so the
 * cacheable prefix collapsed to the head and every round re-billed the whole transcript.)
 */
export function stableSystemHead(objective: string, question: Question, evidenceBlock: string): string[] {
  return [
    ...objectivePrefix(objective),
    `QUESTION (${question.category}): ${question.text}`,
    "",
    "EVIDENCE — cite only by the bracketed id, e.g. supportingEvidenceIds: [\"<id>\"]:",
    evidenceBlock,
    "",
    CONFIDENCE_CALIBRATION,
  ];
}

// ---------------------------------------------------------------------------
// committee — per-role user message (opening round)
// ---------------------------------------------------------------------------

/**
 * The per-role `user` message for the opening committee round: the evidence anchor, the role
 * persona, an optional prior-claim block (on a re-debate), and the closing task instructions.
 * This lives in the user message (not the shared system prefix) because it varies per role, so
 * it must never disturb the byte-identical-across-roles cache invariant. `priorClaim`, when
 * present, drives the incremental "revise your prior claim" wording.
 */
export function committeeUserMessage(role: AgentRoleT, priorClaim?: Claim): string {
  const priorClaimBlock = priorClaim
    ? [
        "YOUR PRIOR CLAIM — revise it in light of the evidence above (do not restate it unchanged):",
        `  conclusion: ${priorClaim.conclusion}`,
        `  confidence: ${priorClaim.confidence.toFixed(2)}`,
        `  missingEvidence: ${priorClaim.missingEvidence.join("; ") || "(none noted)"}`,
        "",
      ]
    : [];

  return [
    // Anchor to the system evidence. The L3 cache split put QUESTION + EVIDENCE in the system
    // message; without this pointer a role can wrongly conclude nothing was supplied. Uniform
    // across roles and kept in the user message so the shared system prefix stays cache-identical.
    "The QUESTION and its EVIDENCE are provided in the system message above. Base your answer only on",
    "that evidence block, cite sources by their exact bracketed id, and never claim evidence was",
    "missing when the block is non-empty.",
    "",
    ROLES[role].systemPrompt,
    "",
    ...priorClaimBlock,
    priorClaim
      ? "Render your UPDATED Claim now. Keep conclusion to 2-3 sentences (under 400 chars) — be direct."
      : "Render your Claim now. Keep conclusion to 2-3 sentences (under 400 chars) — be direct.",
    STANCE_DEFINITION,
    "List the load-bearing evidence gaps (0-3) in missingEvidence (each under 100 chars) — only ones more",
    "searching could plausibly close, never structurally-private data; leave it empty if none qualify.",
    "Only fill: conclusion, confidence, stance, supportingEvidenceIds, contradictingEvidenceIds, missingEvidence.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// debate — per-role conversational user message
// ---------------------------------------------------------------------------

/**
 * The per-role `user` message for a conversational debate turn (round ≥1): the transcript anchor,
 * the role persona, the challenges aimed at this role, an optional prior-turn block, and the
 * closing task instructions. As with the opening round, this is the per-role material kept OUT of
 * the shared (cacheable) system prefix.
 *
 * `challengeLines` are the pre-rendered, directed challenge lines the caller computed from the
 * latest round (directedChallenges owns that structural rendering); this builder only frames them.
 * An empty list yields the "no peer challenged you" note instead. `priorTurn` is this role's most
 * recent claim, which it is revising.
 */
export function debateUserMessage(args: {
  role: AgentRoleT;
  challengeLines: string[];
  priorTurn?: Claim;
}): string {
  const { role, challengeLines, priorTurn } = args;

  const challengeBlock = challengeLines.length
    ? ["CHALLENGES AIMED AT YOU — you MUST answer each below:", ...challengeLines, ""]
    : ["No peer challenged you directly last round — revise only if the evidence itself warrants it.", ""];

  const priorTurnBlock = priorTurn
    ? [
        "YOUR PRIOR TURN — revise it in light of the debate above (do not restate it unchanged):",
        `  conclusion: ${priorTurn.conclusion}`,
        `  confidence: ${priorTurn.confidence.toFixed(2)}`,
        `  missingEvidence: ${priorTurn.missingEvidence.join("; ") || "(none noted)"}`,
        "",
      ]
    : [];

  return [
    // Same anchor as the opening round: the QUESTION + EVIDENCE + transcript live in the system
    // message; point the role at them so it never confabulates that nothing was supplied.
    "The QUESTION, its EVIDENCE, and the debate transcript are in the system message above. Base your",
    "answer only on that evidence block, cite sources by their exact bracketed id, and never claim",
    "evidence was missing when the block is non-empty.",
    "",
    ROLES[role].systemPrompt,
    "",
    ...challengeBlock,
    ...priorTurnBlock,
    "Respond to EACH challenge above: concede (cite the exact evidence id that moves you) or hold (cite",
    "the id that backs you). You may ONLY concede to evidence, never to consensus — if you move, name the",
    "id that moved you. Then render your UPDATED Claim (conclusion 2-3 sentences, under 400 chars) and your",
    "`responses` (one directed reply per peer you engage: rebut / concede / extend, each citing an id).",
    STANCE_DEFINITION,
    "List the load-bearing evidence gaps (0-3) in missingEvidence (each under 100 chars) — only ones more",
    "searching could plausibly close, never structurally-private data; leave it empty if none qualify.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// gate — retrieval classifier
// ---------------------------------------------------------------------------

/**
 * The gate-classifier prompt: decide, per question, whether more evidence retrieval is warranted.
 * `sections` is the caller's pre-rendered per-question block (computed gap/spread signals + claim
 * summaries); this builder frames the decision rules around it.
 */
export function gatePrompt(args: {
  loopIteration: number;
  budgetRemaining: number;
  sections: string[];
}): string {
  const { loopIteration, budgetRemaining, sections } = args;
  return `You are a research gate classifier deciding which questions need more evidence retrieval.

Current state: loop iteration ${loopIteration}, budget remaining ${budgetRemaining} calls.

Decision rules (apply in order):
- If this is iteration 0 (first pass): default to YES unless agents already agree directionally and no specific evidence gaps are named.
- If 3+ agents name overlapping missing evidence (similar data/sources): YES.
- If agents reach opposing conclusions on the same sub-question: YES.
- If all agents agree directionally and gaps are vague ("more data would help"): NO.
- If budget remaining is low (≤2 calls): only YES for the single highest-gap question.

For each question, decide: should we retrieve more evidence (true) or mark as resolved (false)?
Explain your decision in one sentence per question.

${sections.join("\n\n")}

Return a decision for every question ID listed above.`;
}

// ---------------------------------------------------------------------------
// synthesis — objective-level answer (A5)
// ---------------------------------------------------------------------------

/**
 * The synthesis ANSWER prompt: write the final adjudication at the objective's altitude, grounded
 * strictly in the committee's positions and the CITED sources, citing every concrete fact by its
 * [S#] label. `sections` (the per-question committee positions tagged with their [S#] sources) and
 * `sourceLines` (the SOURCES block) are computed by the recommend node's [S#] labelling logic and
 * passed in; this builder owns only the voice and grounding instructions around them.
 */
// ---------------------------------------------------------------------------
// researcher agent (agentic retrieval, P3)
// ---------------------------------------------------------------------------

/** Tool `description` for the researcher's web-search tool (ONE keyword query, ONCE per pass). */
export const WEBSEARCH_TOOL_DESCRIPTION =
  "Search the web with ONE focused keyword query and get back ~10 {title, url, snippet} hits. You " +
  "get ONE search this pass, so make the query count. Those snippets are your shortlist — judge " +
  "relevance from them, then READ the best ones. Do NOT search again to refine the query; if the " +
  "evidence is still thin after reading, the research loop will search again later.";

/** Tool `description` for the researcher's source-reading tool (multi-URL). */
export const READSOURCE_TOOL_DESCRIPTION =
  "Read the full text of the MOST PROMISING URLs from your search hits — this is where evidence " +
  "actually comes from. Pass an array of one or more urls; you get back each source's title and the " +
  "head of its content as a working memo. The full page is captured as evidence regardless. Read the " +
  "genuinely relevant hits rather than searching again — reading is the job, not searching.";

/**
 * System prompt for the researcher agent: it works ONE question, alternating webSearch (plan a
 * query, judge snippets) and readSource (read the best hits), and stops when it has enough. The
 * MISSION for this pass (recon on loop 0, contested gaps later) arrives as the user message.
 */
export function researcherSystemPrompt(question: Question, currentYear: number): string {
  return [
    "You are a research analyst gathering evidence for ONE specific question. Work only this question:",
    `QUESTION: ${question.text}`,
    question.category ? `CATEGORY: ${question.category}` : "",
    `The current year is ${currentYear}: when you need the latest market/pricing/vendor/regulation data,`,
    `search ${currentYear} (or "latest"), not an older year — only reach for a past year for genuinely historical facts.`,
    "",
    "You have two tools:",
    "- webSearch(query): run ONE keyword query and get ~10 {title, url, snippet} hits. You get exactly",
    "  ONE search this pass — make it count.",
    "- readSource(urls): read the full text of the most promising URLs from that search.",
    "",
    "Workflow: issue your ONE search, judge the snippet hits (that judgement IS your triage), then READ",
    "the genuinely relevant ones — reading is where evidence comes from. Do NOT reformulate and search",
    "again; if the evidence is still thin after reading your best hits, STOP — the research loop will run",
    "another, sharper search on the next pass. Working with one good search's results is the point.",
    "",
    "The MISSION below tells you what to look for on THIS pass.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The recon-floor nudge: appended by the CODE (not relied on as enforcement) when a loop-0 agent
 * tried to stop before gathering RECON_FLOOR sources. The floor is enforced by re-driving the
 * loop in researcher.ts; this text just tells the model why it's being asked to continue.
 */
export function researcherReconNudge(have: number, floor: number): string {
  return `You have READ ${have} source(s); this is reconnaissance — read at least ${floor} of your ` +
    `relevant hits before finishing (do not search again; read more of the hits you already have).`;
}

/**
 * The loop-0 RECONNAISSANCE mission (the user message handed to a researcher agent on the first
 * pass). Broad, shallow coverage seeded from the question's decompose keyword queries — enough
 * grounded sources for the committee's opening claims and to let it name its own gaps. `question`
 * and `queries` are the state-derived pieces missionForQuestion computes; this builder only frames
 * them. Never empty.
 */
export function researcherReconMission(args: { question: string; queries: string[] }): string {
  const { question, queries } = args;
  return [
    `RECONNAISSANCE for this question: ${question}`,
    "",
    `Run ONE search — start from this keyword query: ${queries.join(" / ")}.`,
    "Then READ several on-topic sources from the hits to ground an opening committee assessment and",
    "surface where the evidence is thin. Breadth here means reading a handful of DIFFERENT relevant",
    "sources, not running more queries — you get one search, so spend the rest of your effort reading.",
  ].join("\n");
}

/**
 * The loop-≥1 GAP-TARGETED mission: the committee has debated and is contested on a specific
 * EVIDENTIAL gap — find the sources that would settle it, and do not re-chase what the run already
 * holds. `gaps` are the contested claims' named missingEvidence; `seenSources` are the titles/urls
 * already gathered for this question. missionForQuestion computes both; this builder only frames them.
 */
export function researcherGapMission(args: {
  question: string;
  gaps: string[];
  seenSources: string[];
}): string {
  const { question, gaps, seenSources } = args;
  const seenBlock = seenSources.length
    ? ["", "You ALREADY have these sources — do NOT re-chase them:", ...seenSources.map((s) => `  - ${s}`)]
    : [];
  return [
    `For this question: ${question}`,
    "",
    "the committee is contested on a specific EVIDENTIAL gap it needs settled:",
    ...gaps.map((g) => `  - ${g}`),
    "",
    "Find sources that would settle that gap specifically — go deep and targeted, not broad.",
    ...seenBlock,
  ].join("\n");
}

export function answerPrompt(args: {
  objective: string;
  constraintsLine: string;
  sections: string[];
  sourceLines: string;
}): string {
  const { objective, constraintsLine, sections, sourceLines } = args;
  return [
    "You are the research manager writing the FINAL adjudication for an opportunity/market analysis.",
    "",
    `OBJECTIVE (write the answer that satisfies THIS): ${objective}`,
    `CONSTRAINTS: ${constraintsLine}`,
    "",
    "WRITE WITH THE AUTHORITY THE EVIDENCE SUPPORTS. Lead with a clear directional VERDICT, then state",
    "plainly what the evidence DOES establish (cited), and only THEN the fault lines and what is missing.",
    "Reason from the BEST AVAILABLE evidence to a firm call: a multi-year survivor on subscription pricing,",
    "a validated accuracy figure, a structural spending pattern are real signal even when the IDEAL datum",
    "(exact ARR, private churn, a named competitor's fate) is absent and unlikely to ever be public. Do NOT",
    "withhold or water down the verdict because ideal data is missing, and do NOT thread hedges through",
    "every sentence — make the well-supported claims confidently and confine uncertainty to where it",
    "actually changes the decision. A calibrated but DECISIVE read beats an evenhanded recitation of gaps.",
    "",
    "Ground your answer in the committee's positions AND the SOURCES below. CITE specific evidence by",
    "its [S#] label wherever you state a concrete fact, figure, named entity, or outcome — the reader",
    "must be able to trace every claim to a source. Reach for the specific data in the SOURCES (the",
    "numbers, names, and findings), not the committee's paraphrase — use the nuance, do not flatten it.",
    "Do NOT introduce any fact absent from the SOURCES, and NEVER cite an [S#] that is not listed below",
    "(invent no sources and no figures). Where the committee named a GAP (a claim with no source cited),",
    "say what specific evidence is missing rather than papering over it.",
    "",
    "Match the objective's ALTITUDE:",
    "- a broad survey → a landscape map: the shape of the opportunity across the questions.",
    "- a go/no-go or thesis → a graded verdict (e.g. lean go / no-go / not yet) AND the fault lines the",
    "  decision turns on.",
    "Wherever the committee split, say so explicitly and name whether the split is EVIDENTIAL (a gap more",
    "evidence could close) or INTERPRETIVE (the roles read the same evidence differently) — do not paper over it.",
    "",
    "COMMITTEE FINDINGS (each position tagged with the [S#] sources it rests on):",
    ...sections,
    "",
    "SOURCES (cite these by [S#]; each is a real retrieved source with its distilled findings and url):",
    sourceLines,
  ].join("\n");
}
