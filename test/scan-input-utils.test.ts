import { describe, it, expect } from "vitest";
import { shouldSubmitOnKeyDown, parseBudgetInput } from "@/lib/scan-input-utils";

describe("shouldSubmitOnKeyDown", () => {
  it("submits on bare Enter", () => {
    expect(shouldSubmitOnKeyDown("Enter", false)).toBe(true);
  });

  it("does not submit on Shift+Enter", () => {
    expect(shouldSubmitOnKeyDown("Enter", true)).toBe(false);
  });

  it("does not submit on other keys", () => {
    expect(shouldSubmitOnKeyDown("a", false)).toBe(false);
    expect(shouldSubmitOnKeyDown("Tab", false)).toBe(false);
  });
});

describe("parseBudgetInput", () => {
  const opts = { max: 500 };

  it("returns undefined for empty/whitespace-only input", () => {
    expect(parseBudgetInput("", opts)).toBeUndefined();
    expect(parseBudgetInput("   ", opts)).toBeUndefined();
  });

  it("returns undefined for non-numeric input", () => {
    expect(parseBudgetInput("abc", opts)).toBeUndefined();
    expect(parseBudgetInput("NaN", opts)).toBeUndefined();
  });

  it("returns undefined for zero or negative input", () => {
    expect(parseBudgetInput("0", opts)).toBeUndefined();
    expect(parseBudgetInput("-5", opts)).toBeUndefined();
  });

  it("parses a valid positive number", () => {
    expect(parseBudgetInput("120", opts)).toBe(120);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseBudgetInput("  42  ", opts)).toBe(42);
  });

  it("clamps values above max", () => {
    expect(parseBudgetInput("999999", opts)).toBe(500);
  });

  it("allows values exactly at max", () => {
    expect(parseBudgetInput("500", opts)).toBe(500);
  });

  it("supports decimal values (e.g. USD cap)", () => {
    expect(parseBudgetInput("2.5", { max: 7.5 })).toBe(2.5);
  });
});
