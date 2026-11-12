import { describe, expect, it } from "vitest";
import { figures, normalizeNumber, unsupportedFigures, unsupportedNote } from "../../lib/check/numbers";

describe("number check", () => {
  it("normalizes numbers", () => {
    expect(normalizeNumber("1,200.50")).toBe("1200.5");
    expect(normalizeNumber("19.00")).toBe("19");
    expect(normalizeNumber("0.106")).toBe("0.106");
  });

  it("finds money amounts and percentages, not plain numbers or citations", () => {
    expect(figures("Pro is $25/month [1], up 15.8% from last year; 20 users; €6 per month; 30 USD").map((f) => f.raw)).toEqual([
      "$25",
      "15.8%",
      "€6",
      "30 USD",
    ]);
  });

  it("flags figures that appear in no source", () => {
    const sources = ["Pro: $25 per month per organization.", "Team: $599 per month"];
    expect(unsupportedFigures("Supabase Pro is $25/month [1].", sources)).toEqual([]);
    expect(unsupportedFigures("Supabase Pro is $25/month and Team is $499 [2].", sources)).toEqual(["$499"]);
    expect(unsupportedFigures("That is $25.00 per month.", sources)).toEqual([]);
  });

  it("writes an honest note", () => {
    expect(unsupportedNote(["$499"])).toContain("“$499” doesn't appear in the sources I used");
  });
});
