import { beforeAll, describe, expect, it } from "vitest";
import { addMessage, createConversation } from "../../lib/db/queries";
import { distinctiveKeywords, formatRecallContext, keywords, noHistoryAnswer, recall } from "../../lib/recall";
import { resolveTimeRanges } from "../../lib/time";

const NOW = new Date("2026-11-11T12:00:00+05:30");
const IST = "Asia/Kolkata";

beforeAll(async () => {
  const pg = await createConversation("Postgres hosting", new Date("2026-11-03T23:30:00+05:30"));
  // 23:30 IST on 3 Nov is 18:00 UTC on 3 Nov.
  await addMessage({ conversationId: pg.id, role: "user", content: "Which managed Postgres hosting is cheapest?", at: new Date("2026-11-03T23:30:00+05:30") });
  await addMessage({ conversationId: pg.id, role: "assistant", content: "Render Postgres starts at $6/month.", at: new Date("2026-11-03T23:31:00+05:30") });
  // 00:10 IST on 4 Nov is still 3 Nov in UTC (18:40Z).
  await addMessage({ conversationId: pg.id, role: "user", content: "And Neon?", at: new Date("2026-11-04T00:10:00+05:30") });

  const crm = await createConversation("CRM", new Date("2026-11-09T11:30:00+05:30"));
  await addMessage({ conversationId: crm.id, role: "user", content: "Shortlist 5 CRM tools for a 20-person sales team", at: new Date("2026-11-09T11:30:00+05:30") });
});

describe("recall by date", () => {
  it("returns only messages inside the user's local day", async () => {
    const ranges = resolveTimeRanges("What did I ask on 3 November?", NOW, IST);
    const result = await recall("What did I ask on 3 November?", ranges, []);
    expect(result.mode).toBe("dates");
    expect(result.messages.map((m) => m.content)).toEqual([
      "Which managed Postgres hosting is cheapest?",
      "Render Postgres starts at $6/month.",
    ]);
  });

  it("uses a different day boundary for a UTC user", async () => {
    const ranges = resolveTimeRanges("3 November", NOW, "UTC");
    const result = await recall("3 November", ranges, []);
    expect(result.messages.map((m) => m.content)).toContain("And Neon?");
  });

  it("excludes the current turn's own message", async () => {
    const ranges = resolveTimeRanges("on Monday", NOW, IST);
    const all = await recall("on Monday", ranges, []);
    const excluded = await recall("on Monday", ranges, [all.messages[0].id]);
    expect(excluded.messages).toHaveLength(all.messages.length - 1);
  });
});

describe("recall by keywords", () => {
  it("extracts searchable keywords without stopwords or punctuation", () => {
    expect(keywords("What did we discuss about Postgres hosting?")).toEqual(["postgres", "hosting"]);
    expect(keywords("What did you just say?")).toEqual([]);
    expect(keywords("'; DROP TABLE messages; --")).toEqual(["drop", "table", "messages"]);
  });

  it("finds past messages by topic across conversations", async () => {
    const result = await recall("What did we discuss about Postgres hosting?", [], []);
    expect(result.mode).toBe("keywords");
    expect(result.messages[0].conversation_title).toBe("Postgres hosting");
  });
});

describe("distinctive keywords for the no-history fallback", () => {
  it("keeps product-like names and drops words generic to the question", () => {
    expect(distinctiveKeywords("On Sunday we shortlisted Notion, Asana and Trello for our team. Has any of them changed pricing since?")).toEqual([
      "notion",
      "asana",
      "trello",
    ]);
    expect(distinctiveKeywords("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?")).toEqual([]);
    expect(distinctiveKeywords("On Sunday we shortlisted 3 project management tools. Has any of them changed pricing since?")).toEqual([]);
  });
});

describe("recall output", () => {
  it("labels messages with local time, role and conversation", async () => {
    const ranges = resolveTimeRanges("3 November", NOW, IST);
    const text = formatRecallContext(await recall("3 November", ranges, []), IST);
    expect(text).toContain("Stored messages from Tuesday, 3 November 2026");
    expect(text).toContain("[Conversation: Postgres hosting]");
    expect(text).toContain("Tue 3 Nov 2026, 23:30, the user wrote: Which managed Postgres hosting is cheapest?");
  });

  it("answers honestly when a day has no messages, listing days that do", async () => {
    const ranges = resolveTimeRanges("1 November", NOW, IST);
    const result = await recall("1 November", ranges, []);
    expect(result.messages).toEqual([]);
    const text = await noHistoryAnswer(result, IST, [], "recall");
    expect(text).toContain("I don't have any stored messages from Sunday, 1 November 2026.");
    expect(text).toMatch(/I do have conversations on: .*Mon 9 Nov \(1 messages\)/);
  });

  it("offers to check named products when a change check has no history", async () => {
    const result = { mode: "dates" as const, ranges: resolveTimeRanges("1 November", NOW, IST), terms: [], messages: [] };
    expect(await noHistoryAnswer(result, IST, [], "change_check")).toMatch(/tell me what we looked at/);
  });
});
