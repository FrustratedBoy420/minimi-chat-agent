import { describe, expect, it } from "vitest";
import { routeMessage, type Intent } from "../../lib/intent";

const NOW = new Date("2026-11-11T12:00:00+05:30");

const cases: [string, Intent][] = [
  // The three challenge examples
  ["On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?", "change_check"],
  ["What did I ask you on 3 November? Is your answer still correct today?", "change_check"],
  ["Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", "change_check"],

  // Recall
  ["What did I ask you on 3 November?", "recall"],
  ["What did we discuss about Postgres hosting?", "recall"],
  ["Remind me what you recommended for our CRM", "recall"],
  ["What did I ask you yesterday?", "recall"],
  ["Which CRMs did we shortlist on Monday?", "recall"],
  ["What was my last question?", "recall"],
  ["Did we ever talk about Supabase?", "recall"],

  // Change checks
  ["Is your recommendation still the best?", "change_check"],
  ["Has Neon raised its prices since last month?", "change_check"],
  ["Any updates on the CRMs we looked at?", "change_check"],
  ["Has HubSpot changed its pricing recently?", "change_check"],
  ["What's changed with Supabase since Monday?", "change_check"],

  // Research (needs current web information)
  ["How much does Supabase Pro cost?", "research"],
  ["What's the latest version of Node.js?", "research"],
  ["Compare Neon vs Supabase for a small app", "research"],
  ["Best CRM for a 10-person team?", "research"],
  ["Who won the F1 race last weekend?", "research"],
  ["Is Render cheaper than Railway?", "research"],
  ["What's the weather in Mumbai today?", "research"],

  // Chat
  ["Hi!", "chat"],
  ["Thanks, that's helpful", "chat"],
  ["Can you suggest a name for my habit tracker?", "chat"],
  ["Explain how a B-tree index works", "chat"],
  ["Write a haiku about Postgres", "chat"],
  ["Tell me a joke", "chat"],
  ["What is 15% of 240?", "chat"],
  ["Rewrite this sentence to sound more formal: we gotta ship it", "chat"],
];

describe("routeMessage", () => {
  it.each(cases)("%s → %s", (message, expected) => {
    expect(routeMessage(message, NOW, "Asia/Kolkata").intent).toBe(expected);
  });

  it("asks for recall on every recall and change-check turn", () => {
    for (const [message, intent] of cases) {
      if (intent === "recall" || intent === "change_check") {
        expect(routeMessage(message, NOW, "Asia/Kolkata").wantsRecall, message).toBe(true);
      }
    }
  });

  it("flags unclear phrasing for a model second opinion, and only that", () => {
    const tz = "Asia/Kolkata";
    expect(routeMessage("Are the CRMs we picked still a good deal?", NOW, tz).uncertain).toBe(true);
    expect(routeMessage("Is it cheaper now than what you told me before?", NOW, tz).uncertain).toBe(true);
    expect(routeMessage("What did I ask you on 3 November?", NOW, tz).uncertain).toBe(false);
    expect(routeMessage("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", NOW, tz).uncertain).toBe(false);
    expect(routeMessage("Tell me a joke", NOW, tz).uncertain).toBe(false);
    expect(routeMessage("How much does Supabase Pro cost?", NOW, tz).uncertain).toBe(false);
  });

  it("notices when the user also asks what was said", () => {
    expect(routeMessage("What did I ask you on 3 November? Is your answer still correct today?", NOW, "Asia/Kolkata").asksWhatWasSaid).toBe(true);
    expect(routeMessage("Has Neon pricing changed since Monday?", NOW, "Asia/Kolkata").asksWhatWasSaid).toBe(false);
  });

  it("does not treat 'today' as something to recall when a past date is named", () => {
    const route = routeMessage("What did I ask you on 3 November? Is your answer still correct today?", NOW, "Asia/Kolkata");
    expect(route.timeRanges.map((r) => r.label)).toEqual(["Tuesday, 3 November 2026", "Wednesday, 11 November 2026"]);
    expect(route.recallRanges.map((r) => r.label)).toEqual(["Tuesday, 3 November 2026"]);
    expect(routeMessage("What did I ask you today?", NOW, "Asia/Kolkata").recallRanges.map((r) => r.label)).toEqual([
      "Wednesday, 11 November 2026",
    ]);
  });

  it("returns resolved dates with the route", () => {
    const route = routeMessage("Last Tuesday I asked you about Postgres hosting.", NOW, "Asia/Kolkata");
    expect(route.timeRanges.map((r) => r.label)).toEqual(["Tuesday, 10 November 2026"]);
  });
});
