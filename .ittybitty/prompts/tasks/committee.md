Build src/lib/orchestration/committee.ts. For each of the four roles
(historian, operator, investor, skeptic), write a distinct system prompt
capturing that role's incentive:
  - historian: has similar things been tried before, and what happened
  - operator: what actually breaks in the day-to-day workflow
  - investor: is there a fundable business here, what's the return profile
  - skeptic: actively hunt for reasons this fails; assume the others are too optimistic

Export async function runCommittee(question: Question, evidence: Evidence[]): Promise<Claim[]>
that calls generateObject with modelForRole(role) and ClaimSchema for each of the
four roles in parallel (Promise.all), passing the question text and the evidence
subset relevant to it. Each claim's confidence must be genuinely calibrated —
prompt the model explicitly to penalize confidence when supportingEvidenceIds is
sparse or when contradictingEvidenceIds is non-empty.
