import { describe, it, expect } from "vitest";
import { LlmReportSchema, ScanReportSchema } from "@/lib/schema";

/** A minimal valid LLM report used as a fixture base. */
const validLlm = {
  industry: "test industry",
  scores: {
    pain: { value: 7, label: "High", evidence: [{ text: "many complaints", sourceIds: [1] }] },
    softwareMaturity: { value: 3, label: "Legacy", evidence: [] },
    laborScarcity: { value: 6, label: "Tight", evidence: [] },
    aiSuitability: { value: 8, label: "Ripe", evidence: [] },
    budgetSignal: { value: 5, label: "Some", evidence: [] },
  },
  snapshot: "A snapshot.",
  bottlenecks: [{ text: "manual review", sourceIds: [2] }],
  softwareEcosystem: { summary: "legacy vendors", vendors: [{ name: "Acme", note: "old", sourceIds: [1] }] },
  frictionSignals: [{ text: "Excel everywhere", sourceIds: [1] }],
  aiOpportunities: [{ title: "auto-triage", why: "manual today", sourceIds: [2] }],
  underservedNiches: [{ text: "rural ops", sourceIds: [] }],
  adjacentMarkets: [{ text: "logistics", sourceIds: [] }],
  startupConcepts: [{ name: "TriageAI", pitch: "automate it", sourceIds: [2] }],
  playfulStats: [{ label: "Excel Dependency", value: "Severe" }],
};

describe("LlmReportSchema", () => {
  it("accepts a well-formed report", () => {
    expect(LlmReportSchema.safeParse(validLlm).success).toBe(true);
  });

  it("rejects an out-of-range score", () => {
    const bad = { ...validLlm, scores: { ...validLlm.scores, pain: { value: 42, label: "x", evidence: [] } } };
    expect(LlmReportSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a missing required section", () => {
    const { snapshot, ...bad } = validLlm;
    expect(LlmReportSchema.safeParse(bad).success).toBe(false);
  });

  it("defaults empty evidence arrays", () => {
    const parsed = LlmReportSchema.parse(validLlm);
    expect(Array.isArray(parsed.scores.softwareMaturity.evidence)).toBe(true);
  });
});

describe("ScanReportSchema", () => {
  it("requires the server-owned fields the LLM schema omits", () => {
    // The LLM fixture lacks sources/generatedAt/opportunityScore, so it must fail the full schema.
    expect(ScanReportSchema.safeParse(validLlm).success).toBe(false);
  });

  it("accepts a fully-assembled report", () => {
    const full = {
      ...validLlm,
      generatedAt: "2026-01-01T00:00:00.000Z",
      opportunityScore: 72,
      sources: [{ id: 1, url: "https://a.com", domain: "a.com", title: "A", intent: "software" }],
    };
    expect(ScanReportSchema.safeParse(full).success).toBe(true);
  });
});
