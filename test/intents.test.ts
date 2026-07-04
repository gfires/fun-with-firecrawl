import { describe, it, expect } from "vitest";
import { buildIntents, normalizeIndustry, INTENT_TEMPLATES } from "@/lib/intents";

describe("normalizeIndustry", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeIndustry("  college   athletics ")).toBe("college athletics");
  });
  it("is empty-safe", () => {
    expect(normalizeIndustry("")).toBe("");
  });
});

describe("buildIntents", () => {
  it("produces one intent per template", () => {
    expect(buildIntents("insurance claims")).toHaveLength(INTENT_TEMPLATES.length);
  });

  it("interpolates the industry into every query", () => {
    const intents = buildIntents("insurance claims");
    for (const i of intents) {
      expect(i.query).toContain("insurance claims");
      expect(i.query).not.toContain("{industry}");
    }
  });

  it("keeps human-readable labels stable", () => {
    const labels = buildIntents("x").map((i) => i.label);
    expect(labels).toContain("labor shortage");
    expect(labels).toContain("software");
    expect(labels).toContain("complaints");
  });

  it("normalizes messy input", () => {
    const [first] = buildIntents("  Solar  Installation  ");
    expect(first.query).toContain("Solar Installation");
  });
});
