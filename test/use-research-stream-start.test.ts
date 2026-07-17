/**
 * start()'s POST body construction is the one piece of logic worth unit-testing here; the rest
 * of start() is a thin fetch/SSE-reading wrapper that needs a DOM/fetch-stream harness this repo
 * doesn't have (see use-research-replay.test.ts). Test the pure body-builder instead.
 */
import { describe, it, expect } from "vitest";
import { buildResearchRequestBody } from "@/lib/useResearchStream";

describe("buildResearchRequestBody", () => {
  it("includes only topic when budget/usdBudget are omitted", () => {
    expect(buildResearchRequestBody("freight brokerage")).toEqual({
      topic: "freight brokerage",
      budget: undefined,
      usdBudget: undefined,
    });
  });

  it("includes budget when provided", () => {
    expect(buildResearchRequestBody("freight brokerage", 40)).toEqual({
      topic: "freight brokerage",
      budget: 40,
      usdBudget: undefined,
    });
  });

  it("includes usdBudget alongside budget when both provided", () => {
    expect(buildResearchRequestBody("freight brokerage", 40, 0.5)).toEqual({
      topic: "freight brokerage",
      budget: 40,
      usdBudget: 0.5,
    });
  });

  it("allows usdBudget without budget", () => {
    expect(buildResearchRequestBody("x", undefined, 0.25)).toEqual({
      topic: "x",
      budget: undefined,
      usdBudget: 0.25,
    });
  });
});
