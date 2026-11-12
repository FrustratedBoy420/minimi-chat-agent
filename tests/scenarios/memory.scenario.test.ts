import type { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../../lib/protocol";
import { changeCheckModel, jsonModel, scriptedModel } from "../helpers/mock-model";

/**
 * Memory across turns:
 *   day 1: research question → answer → facts remembered in the background
 *   day 2: change check → baseline comes from the stored web fact ("per supabase.com"), not from chat text
 *          → the newly verified value is remembered too.
 */
const mocks = vi.hoisted(() => {
  process.env.AGENT_NOW = "2026-11-10T06:00:00Z";
  return {
    model: undefined as MockLanguageModelV4 | undefined,
    json: undefined as MockLanguageModelV4 | undefined,
    tavilySearch: vi.fn(),
  };
});

vi.mock("../../lib/llm/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/llm/router")>();
  return {
    ...actual,
    streamAnswer: (req: Parameters<typeof actual.streamAnswer>[0], h: Parameters<typeof actual.streamAnswer>[1]) =>
      actual.streamWithModels([{ label: "mock:main", model: mocks.model! }], req, h),
    generateObject: (req: Parameters<typeof actual.generateObject>[0]) =>
      actual.generateObjectWithModels([{ label: "mock:json", model: mocks.json! }], req),
  };
});
vi.mock("../../lib/search/tavily", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/search/tavily")>()),
  tavilySearch: mocks.tavilySearch,
}));

const { runTurn } = await import("../../lib/chat/turn");
const { settleMemoryWrites } = await import("../../lib/memory/extract");
const { listFacts } = await import("../../lib/memory/facts");
const { getDb } = await import("../../lib/db/client");

async function ask(message: string, conversationId?: string) {
  const events: ChatEvent[] = [];
  await runTurn({ message, conversationId, timezone: "UTC" }, (e) => events.push(e));
  await settleMemoryWrites();
  const text = events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
  const meta = events[0] as Extract<ChatEvent, { type: "meta" }>;
  return { text, conversationId: meta.conversationId };
}

beforeEach(async () => {
  const db = await getDb();
  await db.exec("DELETE FROM search_cache;");
});

describe("fact memory across turns", () => {
  it("remembers a researched price and uses it as the baseline in a later change check", async () => {
    // Day 1: research.
    mocks.tavilySearch.mockResolvedValue([
      { title: "Supabase Pricing", url: "https://supabase.com/pricing", content: "Pro: $25 per month per organization.", publishedAt: null, score: 1 },
    ]);
    mocks.model = scriptedModel([{ searches: ["Supabase Pro pricing"] }, { text: ["Supabase Pro is $25 per month per organization [1]."] }]);
    const factValue = { amount: "25", currency: "$", period: "month", unit: "per organization", region: null };
    mocks.json = jsonModel({
      facts: [{ product: "Supabase", plan: "Pro", attribute: "price", value: "$25 per month", ...factValue, origin: "web", source: 1, quote: "Pro: $25 per month per organization" }],
    });
    const day1 = await ask("We use Supabase. How much is Supabase Pro?");

    const remembered = await listFacts();
    expect(remembered.map((f) => `${f.subject} ${f.plan} ${f.value_text} ${f.url}`)).toContain(
      "Supabase Pro $25 per month https://supabase.com/pricing",
    );

    // Day 2: change check against the stored fact.
    process.env.AGENT_NOW = "2026-11-11T06:00:00Z";
    mocks.tavilySearch.mockResolvedValue([
      { title: "Supabase Pricing", url: "https://supabase.com/pricing", content: "Pro: $30 per month per organization.", publishedAt: null, score: 1 },
    ]);
    mocks.json = changeCheckModel({
      plan: { items: [{ item: "Supabase Pro price", product: "Supabase", kind: "price", query: "Supabase Pro pricing", site: "supabase.com" }] },
      items: [
        {
          item: "Supabase Pro price",
          product: "Supabase",
          plan: "Pro",
          kind: "price",
          before: { text: "$25 per month", amount: "25", currency: "$", period: "month", unit: "per organization", quote: "Pro: $25 per month per organization" },
          now: { text: "$30 per month", amount: "30", currency: "$", period: "month", unit: "per organization", quote: "Pro: $30 per month per organization", source: 1 },
        },
      ],
      take: "Budget for the higher price.",
    });
    const day2 = await ask("Has Supabase pricing changed since yesterday?", day1.conversationId);

    // The plan + extraction prompts saw the stored fact, and the verdict cites it as a web baseline.
    expect(JSON.stringify(mocks.json.doGenerateCalls[0].prompt)).toContain("STORED FACTS");
    expect(day2.text).toContain("Compared with what supabase.com showed on Tue 10 Nov.");
    expect(day2.text).toContain("- **Supabase Pro**: $25 per month → $30 per month (+$5, +20.0%) [1]");

    // And the new verified value is remembered for next time.
    const values = (await listFacts()).filter((f) => f.subject === "Supabase").map((f) => f.value_text);
    expect(values).toEqual(expect.arrayContaining(["$25 per month", "$30 per month"]));
  });

  it("never uses facts captured after the recalled conversation as its baseline", async () => {
    // A fresh conversation on 20 Nov, then a fact about Neon captured on 21 Nov (e.g. by another check).
    process.env.AGENT_NOW = "2026-11-20T06:00:00Z";
    mocks.model = scriptedModel([{ text: ["Noted, Neon Launch at $19/month."] }]);
    mocks.json = jsonModel({ facts: [] });
    await ask("I'm comparing Neon Launch at $19/month for my side project.");

    const { getDb } = await import("../../lib/db/client");
    const { storeFacts } = await import("../../lib/memory/facts");
    const db = await getDb();
    const src = await db.query<{ id: string }>(
      `INSERT INTO sources (url, title, content) VALUES ('https://neon.tech/pricing', 'Neon', 'Launch: $25/month') RETURNING id`,
    );
    const conv = await db.query<{ id: string }>(`SELECT id FROM conversations ORDER BY created_at DESC LIMIT 1`);
    await storeFacts(
      [{ product: "Neon", plan: "Launch", attribute: "price", value: "$25/month", amount: "25", currency: "$", period: "month", unit: null, region: null, origin: "web", source: 1, quote: "Launch: $25/month" }],
      { conversationId: conv.rows[0].id, sources: [{ n: 1, sourceId: src.rows[0].id, url: "https://neon.tech/pricing", content: "Launch: $25/month" }], seenAt: new Date("2026-11-21T06:00:00Z") },
    );

    // On 22 Nov: "has it changed since the 20th?" must not compare against the 21 Nov fact.
    process.env.AGENT_NOW = "2026-11-22T06:00:00Z";
    mocks.json = jsonModel({ items: [] }, { items: [], take: "" });
    await ask("Has Neon pricing changed since 20 November?");
    expect(JSON.stringify(mocks.json.doGenerateCalls[0].prompt)).not.toContain("$25/month");
  });

  it("includes remembered facts (e.g. a shortlist) when recalling a conversation", async () => {
    process.env.AGENT_NOW = "2026-11-12T06:00:00Z";
    mocks.model = scriptedModel([{ text: ["Noted."] }]);
    mocks.json = jsonModel({
      facts: [
        { product: "Pipedrive", plan: null, attribute: "shortlist", value: "shortlisted", amount: null, currency: null, period: null, unit: null, region: null, origin: "user_said", source: null, quote: "shortlist Pipedrive and Zoho CRM" },
      ],
    });
    await ask("Please shortlist Pipedrive and Zoho CRM for our sales team.");

    process.env.AGENT_NOW = "2026-11-13T06:00:00Z";
    mocks.model = scriptedModel([{ text: ["You shortlisted Pipedrive."] }]);
    await ask("Which CRMs did we shortlist yesterday?");
    const system = JSON.stringify(mocks.model.doStreamCalls[0].prompt);
    expect(system).toContain("Facts remembered from these conversations");
    expect(system).toContain("Pipedrive, shortlist: shortlisted");
  });
});
