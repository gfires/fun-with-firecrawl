import type { Claim, AgentRoleT } from "@/lib/schemas/claim";
import type { Evidence } from "@/lib/schemas/evidence";

const ROLES: AgentRoleT[] = ["historian", "operator", "investor", "skeptic"];

export function confidenceColor(c: number): string {
  if (c >= 0.6) return "bg-accent";
  if (c >= 0.3) return "bg-amber";
  return "bg-danger";
}

export function confidenceTextColor(c: number): string {
  if (c >= 0.6) return "text-accent";
  if (c >= 0.3) return "text-amber";
  return "text-danger";
}

export function latestClaimsByRole(
  claims: Claim[],
  questionId: string,
): Partial<Record<AgentRoleT, Claim>> {
  const result: Partial<Record<AgentRoleT, Claim>> = {};
  for (const c of claims) {
    if (c.questionId !== questionId) continue;
    const existing = result[c.agentRole];
    if (!existing || c.loopIteration > existing.loopIteration) {
      result[c.agentRole] = c;
    }
  }
  return result;
}

export interface AgentNode {
  role: AgentRoleT;
  confidence: number;
  conclusion: string;
}

export interface EvidenceNode {
  id: string;
  label: string;
  domain?: string;
  contested: boolean;
}

export interface ArenaEdge {
  role: AgentRoleT;
  evidenceId: string;
  kind: "support" | "contradict";
}

export interface ArenaGraph {
  agents: AgentNode[];
  evidence: EvidenceNode[];
  edges: ArenaEdge[];
}

export function buildArenaGraph(
  claims: Claim[],
  evidence: Evidence[],
  questionId: string,
): ArenaGraph {
  const latest = latestClaimsByRole(claims, questionId);
  const agents: AgentNode[] = [];
  const edges: ArenaEdge[] = [];
  const evidenceIds = new Set<string>();

  for (const role of ROLES) {
    const claim = latest[role];
    if (!claim) continue;
    agents.push({ role, confidence: claim.confidence, conclusion: claim.conclusion });
    for (const eid of claim.supportingEvidenceIds) {
      edges.push({ role, evidenceId: eid, kind: "support" });
      evidenceIds.add(eid);
    }
    for (const eid of claim.contradictingEvidenceIds) {
      edges.push({ role, evidenceId: eid, kind: "contradict" });
      evidenceIds.add(eid);
    }
  }

  const evidenceMap = new Map(evidence.map(e => [e.id, e]));
  const evidenceNodes: EvidenceNode[] = [];

  for (const eid of evidenceIds) {
    const ev = evidenceMap.get(eid);
    const hasSupport = edges.some(e => e.evidenceId === eid && e.kind === "support");
    const hasContradict = edges.some(e => e.evidenceId === eid && e.kind === "contradict");
    evidenceNodes.push({
      id: eid,
      label: ev?.title ?? eid,
      domain: ev?.domain,
      contested: hasSupport && hasContradict,
    });
  }

  return { agents: agents, evidence: evidenceNodes, edges };
}

export interface SwimCell {
  loop: number;
  confidence: number | null;
  delta: "up" | "down" | "flat" | null;
}

export interface SwimlaneResult {
  maxLoop: number;
  rows: Record<AgentRoleT, SwimCell[]>;
}

export function swimlaneCells(claims: Claim[], questionId: string): SwimlaneResult {
  const filtered = claims.filter(c => c.questionId === questionId);
  if (filtered.length === 0) {
    return {
      maxLoop: 0,
      rows: { historian: [], operator: [], investor: [], skeptic: [] },
    };
  }

  const maxLoop = Math.max(...filtered.map(c => c.loopIteration));

  const rows = {} as Record<AgentRoleT, SwimCell[]>;
  for (const role of ROLES) {
    const roleClaims = filtered.filter(c => c.agentRole === role);
    const byLoop = new Map<number, Claim[]>();
    for (const c of roleClaims) {
      const arr = byLoop.get(c.loopIteration) ?? [];
      arr.push(c);
      byLoop.set(c.loopIteration, arr);
    }

    const cells: SwimCell[] = [];
    let prevConfidence: number | null = null;
    for (let loop = 0; loop <= maxLoop; loop++) {
      const loopClaims = byLoop.get(loop);
      if (!loopClaims || loopClaims.length === 0) {
        cells.push({ loop, confidence: null, delta: null });
        continue;
      }
      const confidence = loopClaims.reduce((s, c) => s + c.confidence, 0) / loopClaims.length;
      let delta: SwimCell["delta"] = null;
      if (prevConfidence !== null) {
        if (confidence > prevConfidence) delta = "up";
        else if (confidence < prevConfidence) delta = "down";
        else delta = "flat";
      }
      cells.push({ loop, confidence, delta });
      prevConfidence = confidence;
    }
    rows[role] = cells;
  }

  return { maxLoop, rows };
}
