import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateObject } = vi.hoisted(() => ({ generateObject: vi.fn() }));
vi.mock("../../lib/llm/router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/llm/router")>()),
  generateObject,
}));

const { extractFactsFromTurn, MEMORY_CUES, rememberInBackground, settleMemoryWrites } = await import("../../lib/memory/extract");
const { addMessage, createConversation } = await import("../../lib/db/queries");
const { listFacts } = await import("../../lib/memory/facts");
const { getDb } = await import("../../lib/db/client");

beforeEach(() => {
  generateObject.mockReset();
});

async function setup(userText: string) {
  const conv = await createConversation("t", new Date("2026-11-11T06:00:00Z"));
  const msg = await addMessage({ conversationId: conv.id, role: "user", content: userText, at: new Date("2026-11-11T06:00:00Z") });
  const db = await getDb();
  const src = await db.query<{ id: string }>(
    `INSERT INTO sources (url, title, content) VALUES ('https://supabase.com/pricing', 'Pricing', 'Pro: $25 per month per organization.') RETURNING id`,
  );
  return {
    conversationId: conv.id,
    userMessage: { id: msg.id, content: userText, at: new Date("2026-11-11T06:00:00Z") },
    sources: [{ n: 1, sourceId: src.rows[0].id, url: "https://supabase.com/pricing", content: "Pro: $25 per month per organization." }],
    seenAt: new Date("2026-11-11T06:00:05Z"),
  };
}

describe("extractFactsFromTurn", () => {
  it("skips the model call when there are no sources and no decision/constraint in the message", async () => {
    const ctx = await setup("Tell me a joke");
    const r = await extractFactsFromTurn({ ...ctx, sources: [] });
    expect(r.skipped).toBe(true);
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("stores verified web and user facts and drops invented ones", async () => {
    const ctx = await setup("We're a 20-person sales team. How much is Supabase Pro?");
    generateObject.mockResolvedValue({
      model: "mock",
      object: {
        facts: [
          { product: "Supabase", plan: "Pro", attribute: "price", value: "$25 per month", amount: "25", currency: "$", period: "month", unit: "per organization", region: null, origin: "web", source: 1, quote: "Pro: $25 per month per organization" },
          { product: "Our team", plan: null, attribute: "constraint", value: "20-person sales team", amount: "20", currency: null, period: null, unit: null, region: null, origin: "user_said", source: null, quote: "We're a 20-person sales team" },
          { product: "Supabase", plan: "Team", attribute: "price", value: "$599", amount: "599", currency: "$", period: "month", unit: null, region: null, origin: "web", source: 1, quote: "Team: $599 per month" },
        ],
      },
    });

    const r = await extractFactsFromTurn(ctx);

    expect(r.stored).toBe(2);
    expect(r.rejected).toEqual([{ fact: "Supabase Team price=$599", reason: "quote not found in source" }]);
    const prompt: string = generateObject.mock.calls[0][0].prompt;
    expect(prompt).toContain("USER MESSAGE:\nWe're a 20-person sales team.");
    expect(prompt).toContain("[1] (https://supabase.com/pricing)");
    expect(generateObject.mock.calls[0][0].role).toBe("fast");
    const values = (await listFacts()).map((f) => f.value_text);
    expect(values).toContain("$25 per month");
    expect(values).toContain("20-person sales team");
  });
});

describe("memory cues", () => {
  it.each([
    ["Great, let's go with those five.", true],
    ["We're a 20-person sales team", true],
    ["Shortlist 5 CRM tools for us", true],
    ["Our budget is $50 per user", true],
    ["Tell me a joke", false],
    ["What's the capital of France?", false],
  ])("%s → %s", (text, expected) => {
    expect(MEMORY_CUES.test(text)).toBe(expected);
  });
});

describe("background writes", () => {
  it("never throws into the caller and can be awaited", async () => {
    let ran = false;
    rememberInBackground(async () => {
      ran = true;
      throw new Error("boom");
    });
    await settleMemoryWrites();
    expect(ran).toBe(true);
  });
});
