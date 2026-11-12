import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../../lib/protocol";

/**
 * Scenario: full turn pipeline with seeded history and a frozen clock.
 * Only the model call is mocked; routing, dates, recall, DB and events are real.
 */
const { streamAnswer, generateObject } = vi.hoisted(() => {
  process.env.AGENT_NOW = "2026-11-11T12:00:00+05:30"; // Wednesday
  return { streamAnswer: vi.fn(), generateObject: vi.fn() };
});
vi.mock("../../lib/llm/router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/llm/router")>()),
  streamAnswer,
  generateObject,
}));

const { runTurn } = await import("../../lib/chat/turn");
const { seedHistory } = await import("../../lib/seed");
const { now } = await import("../../lib/clock");

const IST = "Asia/Kolkata";

async function ask(message: string) {
  const events: ChatEvent[] = [];
  await runTurn({ message, timezone: IST }, (e) => events.push(e));
  const text = events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
  const status = events.filter((e) => e.type === "status").map((e) => (e as { text: string }).text);
  const system: string | undefined = streamAnswer.mock.calls.at(-1)?.[0]?.system;
  return { events, text, status, system };
}

beforeAll(async () => {
  const raw = JSON.parse(readFileSync(path.join(process.cwd(), "seed", "history.json"), "utf8"));
  await seedHistory(raw, { now: now(), timezone: IST });
});

beforeEach(() => {
  generateObject.mockReset();
  generateObject.mockResolvedValue({ object: { items: [], take: "" }, model: "mock:json" });
  streamAnswer.mockReset();
  streamAnswer.mockImplementation(async (_req, h) => {
    h.onText("ok");
    return { text: "ok", model: "mock:main" };
  });
});

describe("recall scenarios", () => {
  it("'What did I ask you on 3 November?' gives the model that day's messages and the resolved date", async () => {
    const { status, system } = await ask("What did I ask you on 3 November?");
    expect(status).toEqual(["Looking up our messages from Tuesday, 3 November 2026…"]);
    expect(system).toContain('"3 November" = Tuesday, 3 November 2026');
    expect(system).toContain("What does GitHub Copilot Business cost per user per month?");
    expect(system).not.toContain("Postgres"); // other days are not included
  });

  it("answers an empty day without calling the model, and lists days that have history", async () => {
    const { text, events } = await ask("What did I ask you on 1 November?");
    expect(streamAnswer).not.toHaveBeenCalled();
    expect(text).toContain("I don't have any stored messages from Sunday, 1 November 2026.");
    expect(text).toContain("Tue 10 Nov");
    expect(events.at(-1)).toMatchObject({ type: "done", model: "none" });
  });

  it("'Last Tuesday … has any pricing changed?' recalls Tuesday's Postgres conversation (change check)", async () => {
    await ask("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
    const planPrompt: string = generateObject.mock.calls[0][0].prompt;
    expect(planPrompt).toContain("Neon Launch: $19/month");
    expect(streamAnswer).not.toHaveBeenCalled(); // change checks are planned and written by code, not streamed prose
  });

  it("'On Monday we shortlisted 5 CRM tools…' recalls Monday's shortlist", async () => {
    await ask(
      "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    );
    const planPrompt: string = generateObject.mock.calls[0][0].prompt;
    expect(planPrompt).toContain("Your shortlist: HubSpot Sales Hub, Pipedrive, Salesforce Sales Cloud, Zoho CRM and Freshsales.");
  });

  it("finds a past topic by keywords when no date is given", async () => {
    const { status, system } = await ask("What did we discuss about Postgres hosting?");
    expect(status).toEqual(["Searching our earlier conversations…"]);
    expect(system).toContain("[Conversation: Managed Postgres hosting]");
  });

  it("does not search memory for plain chat", async () => {
    const { status, system } = await ask("Tell me a joke");
    expect(status).toEqual([]);
    expect(system).not.toContain("Stored records");
  });

  it("'What did you just say?' uses the conversation itself, not a 'no records' reply", async () => {
    const { text } = await ask("What did you just say?");
    expect(streamAnswer).toHaveBeenCalled();
    expect(text).toBe("ok");
  });
});
