import { describe, expect, it } from "vitest";
import { resolveTimeRanges } from "../../lib/time";

// Wednesday 11 November 2026, 12:00 in India.
const NOW = new Date("2026-11-11T12:00:00+05:30");
const IST = "Asia/Kolkata";

const one = (text: string, now = NOW, tz = IST) => {
  const ranges = resolveTimeRanges(text, now, tz);
  expect(ranges).toHaveLength(1);
  return ranges[0];
};
const iso = (d: Date) => d.toISOString();

describe("resolveTimeRanges", () => {
  it("resolves a date without a year to its most recent occurrence, in the user's timezone", () => {
    const r = one("What did I ask you on 3 November?");
    expect(r.phrase).toBe("3 November");
    expect(r.label).toBe("Tuesday, 3 November 2026");
    expect(iso(r.start)).toBe("2026-11-02T18:30:00.000Z"); // local midnight IST
    expect(iso(r.end)).toBe("2026-11-03T18:30:00.000Z"); // half-open: next local midnight
  });

  it("uses the previous year when the date has not happened yet this year", () => {
    expect(one("What did we say on 15 December?").label).toBe("Monday, 15 December 2025");
  });

  it("keeps an explicit year", () => {
    expect(one("on 3 November 2025").label).toBe("Monday, 3 November 2025");
  });

  it("resolves 'last Tuesday' to the most recent Tuesday before today", () => {
    const r = one("Last Tuesday I asked you about Postgres hosting.");
    expect(r.label).toBe("Tuesday, 10 November 2026");
    expect(iso(r.start)).toBe("2026-11-09T18:30:00.000Z");
  });

  it("resolves 'last Tuesday' asked on a Tuesday to the previous week", () => {
    const tuesday = new Date("2026-11-10T09:00:00+05:30");
    expect(one("last Tuesday", tuesday).label).toBe("Tuesday, 3 November 2026");
  });

  it("resolves 'on Monday' and a bare weekday the same way", () => {
    expect(one("On Monday we shortlisted 5 CRM tools").label).toBe("Monday, 9 November 2026");
    expect(one("the tools from Monday").label).toBe("Monday, 9 November 2026");
  });

  it("'this <weekday>' includes today", () => {
    expect(one("this Wednesday").label).toBe("Wednesday, 11 November 2026");
  });

  it("resolves yesterday, today and N days ago", () => {
    expect(one("yesterday").label).toBe("Tuesday, 10 November 2026");
    expect(one("Is it still correct today?").label).toBe("Wednesday, 11 November 2026");
    expect(one("3 days ago").label).toBe("Sunday, 8 November 2026");
    expect(one("two days ago").label).toBe("Monday, 9 November 2026");
  });

  it("resolves week phrases to Monday-to-Sunday weeks", () => {
    const lastWeek = one("last week");
    expect(lastWeek.kind).toBe("week");
    expect(lastWeek.label).toBe("the week of Monday, 2 November 2026");
    expect(iso(lastWeek.end)).toBe("2026-11-08T18:30:00.000Z");
    expect(one("two weeks ago").label).toBe("the week of Monday, 26 October 2026");
  });

  it("marks ranges preceded by 'since' as cutoffs", () => {
    expect(one("Has pricing changed since Monday?").since).toBe(true);
    expect(one("What did we shortlist on Monday?").since).toBe(false);
  });

  it("handles the 25-hour day when daylight saving time ends (New York, 1 Nov 2026)", () => {
    const r = one("yesterday", new Date("2026-11-02T12:00:00-05:00"), "America/New_York");
    expect(r.label).toBe("Sunday, 1 November 2026");
    expect(iso(r.start)).toBe("2026-11-01T04:00:00.000Z"); // midnight EDT
    expect(iso(r.end)).toBe("2026-11-02T05:00:00.000Z"); // midnight EST
  });

  it("gives different UTC ranges for the same day in different timezones", () => {
    const utc = one("3 November", NOW, "UTC");
    expect(iso(utc.start)).toBe("2026-11-03T00:00:00.000Z");
    expect(iso(utc.end)).toBe("2026-11-04T00:00:00.000Z");
  });

  it("finds several dates in one message, in order", () => {
    const ranges = resolveTimeRanges("Compare what we said on Monday and yesterday", NOW, IST);
    expect(ranges.map((r) => r.label)).toEqual(["Monday, 9 November 2026", "Tuesday, 10 November 2026"]);
  });

  it("returns nothing for messages without a date, including bare times", () => {
    expect(resolveTimeRanges("Hello, how are you?", NOW, IST)).toEqual([]);
    expect(resolveTimeRanges("Let's meet at 10am", NOW, IST)).toEqual([]);
    expect(resolveTimeRanges("How much does Neon cost?", NOW, IST)).toEqual([]);
  });
});
