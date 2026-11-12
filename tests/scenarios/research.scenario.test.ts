import { readFileSync } from "node:fs";
import path from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../../lib/protocol";
import { changeCheckModel, jsonModel, scriptedModel } from "../helpers/mock-model";

/**
 * Scenario: full turn with the real router + tool loop, a scripted mock model, and recorded search results.
 * Only the model and the Tavily HTTP call are faked.
 */
const mocks = vi.hoisted(() => {
  process.env.AGENT_NOW = "2026-11-11T12:00:00+05:30";
  return {
    model: undefined as MockLanguageModelV4 | undefined,
    /** Models tried before the main mock (e.g. a rate-limited primary). */
    before: [] as { label: string; model: MockLanguageModelV4 }[],
    json: undefined as MockLanguageModelV4 | undefined,
    tavilySearch: vi.fn(),
  };
});

vi.mock("../../lib/llm/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/llm/router")>();
  return {
    ...actual,
    streamAnswer: (req: Parameters<typeof actual.streamAnswer>[0], h: Parameters<typeof actual.streamAnswer>[1]) =>
      actual.streamWithModels([...mocks.before, { label: "mock:main", model: mocks.model! }], req, h),
    generateObject: (req: Parameters<typeof actual.generateObject>[0]) =>
      actual.generateObjectWithModels([{ label: "mock:json", model: mocks.json! }], req),
  };
});
vi.mock("../../lib/search/tavily", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/search/tavily")>()),
  tavilySearch: mocks.tavilySearch,
}));

const { runTurn } = await import("../../lib/chat/turn");
const { seedHistory } = await import("../../lib/seed");
const { getMessages } = await import("../../lib/db/queries");
const { getDb } = await import("../../lib/db/client");
const { now } = await import("../../lib/clock");
const { SearchUnavailableError } = await import("../../lib/search/tavily");

const IST = "Asia/Kolkata";
const fixtures: Record<string, { title: string; url: string; content: string; publishedAt: string | null; score: number }[]> = {
  "supabase pro pricing": [
    { title: "Pricing & Fees | Supabase", url: "https://supabase.com/pricing", content: "Pro: $25 per month per organization.", publishedAt: null, score: 0.95 },
  ],
  "neon pricing": [
    { title: "Neon Pricing", url: "https://neon.tech/pricing", content: "Launch: $22/month. Scale: $69/month.", publishedAt: null, score: 0.9 },
  ],
};

async function ask(message: string) {
  const events: ChatEvent[] = [];
  await runTurn({ message, timezone: IST }, (e) => events.push(e));
  const text = events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
  const status = events.filter((e) => e.type === "status").map((e) => (e as { text: string }).text);
  const sources = events.filter((e) => e.type === "sources").at(-1) as Extract<ChatEvent, { type: "sources" }> | undefined;
  return { events, text, status, sources: sources?.sources ?? [] };
}

beforeAll(async () => {
  const raw = JSON.parse(readFileSync(path.join(process.cwd(), "seed", "history.json"), "utf8"));
  await seedHistory(raw, { now: now(), timezone: IST });
});

beforeEach(async () => {
  mocks.before = [];
  mocks.tavilySearch.mockReset();
  mocks.tavilySearch.mockImplementation(async (q: string) => fixtures[q.toLowerCase()] ?? []);
  const db = await getDb();
  await db.exec("DELETE FROM search_cache; DELETE FROM usage;");
});

describe("research scenarios", () => {
  it("a pricing question searches first, shows status and sources, and stores citations", async () => {
    mocks.model = scriptedModel([{ searches: ["Supabase Pro pricing"] }, { text: ["Supabase Pro is $25/month per organization [1]."] }]);

    const { status, sources, text, events } = await ask("How much does Supabase Pro cost?");

    expect(status).toContain("Searching the web: “Supabase Pro pricing”");
    expect(sources).toEqual([{ n: 1, title: "Pricing & Fees | Supabase", url: "https://supabase.com/pricing", publishedAt: null }]);
    expect(text).toBe("Supabase Pro is $25/month per organization [1].");

    // The first model call was forced to search; the last allowed step forbids more tools.
    expect(mocks.model.doStreamCalls[0].toolChoice).toEqual({ type: "required" });

    const meta = events[0] as Extract<ChatEvent, { type: "meta" }>;
    const saved = await getMessages(meta.conversationId);
    expect(saved.map((m) => m.role)).toEqual(["user", "assistant"]); // order holds with a frozen clock
    expect(saved[1].citations).toEqual(sources);
  });

  it("runs parallel searches for several products with one citation number per URL", async () => {
    mocks.model = scriptedModel([
      { searches: ["Neon pricing", "Supabase Pro pricing"] },
      { text: ["Neon Launch is $19/month [1]; Supabase Pro is $25/month [2]."] },
    ]);
    const { sources, status } = await ask("Compare Neon vs Supabase pricing");
    expect(status.filter((s) => s.startsWith("Searching the web"))).toHaveLength(2);
    expect(sources.map((s) => s.url).sort()).toEqual(["https://neon.tech/pricing", "https://supabase.com/pricing"]);
    expect(new Set(sources.map((s) => s.n))).toEqual(new Set([1, 2]));
  });

  it("tells the model search failed (instead of returning empty results) and surfaces it", async () => {
    mocks.tavilySearch.mockRejectedValue(new SearchUnavailableError("quota", "432"));
    mocks.model = scriptedModel([{ searches: ["Supabase Pro pricing"] }, { text: ["I couldn't check current pricing."] }]);

    const { status, sources } = await ask("How much does Supabase Pro cost?");

    expect(status.some((s) => s.startsWith("Search problem: Web search is unavailable (quota)"))).toBe(true);
    expect(sources).toEqual([]);
    const toolResultMessage = JSON.stringify(mocks.model.doStreamCalls[1].prompt);
    expect(toolResultMessage).toContain("Do not guess current facts");
  });

  it("change check: plan, parallel batches searching EVERY item, JSON extraction, then a code-written verdict", async () => {
    mocks.model = scriptedModel([{ text: ["should not be called"] }]);
    const value = (text: string, amount: string, quote: string, unit: string | null = null) => ({
      text, amount, currency: "$", period: "month", unit, quote,
    });
    const plan = {
      items: [
        { item: "Neon Launch plan price", product: "Neon", kind: "price", query: "Neon pricing", site: "neon.tech" },
        { item: "Supabase Pro price", product: "Supabase", kind: "price", query: "Supabase Pro pricing", site: "supabase.com" },
        { item: "Render Postgres price", product: "Render", kind: "price", query: "Render Postgres pricing", site: "render.com" },
        { item: "AWS RDS price", product: "AWS RDS", kind: "price", query: "AWS RDS db.t4g.micro price", site: "aws.amazon.com" },
      ],
    };
    mocks.json = changeCheckModel({
      plan,
      items: [
        { item: "Neon Launch plan price", product: "Neon", plan: "Launch", kind: "price", before: value("$19/month", "19", "Neon Launch: $19/month"), now: { ...value("$22/month", "22", "Launch: $22/month"), source: 1 } },
        { item: "Supabase Pro price", product: "Supabase", plan: "Pro", kind: "price", before: value("$25/month", "25", "Supabase Pro: $25/month per organization", "per organization"), now: { ...value("$25 per month", "25", "Pro: $25 per month per organization", "per organization"), source: 2 } },
        { item: "Render Postgres price", product: "Render", plan: "Basic-256mb", kind: "price", before: value("$6/month", "6", "Render Postgres Basic-256mb: $6/month"), now: null },
        // A hallucinated current price: its quote is not in any source, so code must drop it.
        { item: "AWS RDS price", product: "AWS RDS", plan: "db.t4g.micro", kind: "price", before: null, now: { ...value("$9/month", "9", "db.t4g.micro: $9/month"), source: 1 } },
      ],
      take: "Neon's Launch plan went up; Supabase Pro may now be the better value.",
    });

    const { text, status, sources, events } = await ask(
      "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    );

    // No streaming tool loop: one plan call + one extraction call per batch (4 products → 2 batches).
    expect(mocks.model.doStreamCalls).toHaveLength(0);
    expect(mocks.json.doGenerateCalls).toHaveLength(3);
    expect(JSON.stringify(mocks.json.doGenerateCalls[0].prompt)).toContain("Neon Launch: $19/month"); // plan sees records

    // Coverage: every planned item was searched, with its official site preferred.
    expect(mocks.tavilySearch.mock.calls.map((c) => c[0]).sort()).toEqual(
      ["AWS RDS db.t4g.micro price", "Neon pricing", "Render Postgres pricing", "Supabase Pro pricing"],
    );
    expect(mocks.tavilySearch.mock.calls.find((c) => c[0] === "Neon pricing")?.[1]).toMatchObject({ site: "neon.tech" });
    expect(status).toContain("Searching the web: “Render Postgres pricing” (preferring render.com)");
    expect(status.filter((s) => /^Checked .+ \(\d of 2\)…$/.test(s))).toHaveLength(2);
    expect(sources.map((s) => s.url).sort()).toEqual(["https://neon.tech/pricing", "https://supabase.com/pricing"]);

    // Each batch's extraction prompt holds the stored record and only that batch's numbered results.
    const neonPrompt = mocks.json.doGenerateCalls.map((c) => JSON.stringify(c.prompt)).find((p) => p.includes("- Neon Launch plan price (price)"))!;
    expect(neonPrompt).toContain("Neon Launch: $19/month");
    expect(neonPrompt).toContain("[1] Neon Pricing");

    expect(text.split("\n")[0]).toBe("Yes: Neon Launch has changed since Tue 10 Nov. I couldn't confirm Render Postgres and AWS RDS.");
    expect(text).toContain("Compared with what I told you on Tue 10 Nov.");
    expect(text).toContain("- **Neon Launch**: $19/month → $22/month (+$3, +15.7%) [1]");
    expect(text).toContain("- **Supabase Pro**: $25 per month [2]");
    expect(text).toContain("- **Render Postgres**: no current source stated it; earlier: $6/month");
    expect(text).toContain("- **AWS RDS**: the source didn't confirm the value");
    expect(text).not.toMatch(/has not changed|hasn't changed|nothing changed|unchanged/i);
    expect(events.filter((e) => e.type === "delta")).toHaveLength(1);
  });

  it("change check with search down: every item is 'couldn't confirm', never 'same'", async () => {
    mocks.tavilySearch.mockRejectedValue(new SearchUnavailableError("quota", "432"));
    mocks.json = changeCheckModel({
      plan: { items: [{ item: "Neon Launch plan price", product: "Neon", kind: "price", query: "Neon pricing", site: null }] },
      items: [{ item: "Neon Launch plan price", product: "Neon", plan: "Launch", kind: "price", before: { text: "$19/month", amount: "19", currency: "$", period: "month", unit: null, quote: "Neon Launch: $19/month" }, now: null }],
    });
    const { text } = await ask("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
    expect(text.split("\n")[0]).toBe("I couldn't confirm the current details, so I can't say whether anything changed since Tue 10 Nov.");
    expect(text).toContain("- **Neon Launch**: web search was unavailable; earlier: $19/month");
    expect(text).not.toMatch(/Same in the sources/);
  });

  it("a failed extraction batch only affects its own items", async () => {
    mocks.tavilySearch.mockResolvedValue([]);
    const failing = (await import("../helpers/mock-model")).failingModel("500 boom");
    // Plan succeeds, then every extraction call fails.
    const planModel = changeCheckModel({
      plan: { items: [{ item: "Neon Launch plan price", product: "Neon", kind: "price", query: "Neon pricing", site: null }] },
      items: [],
    });
    let calls = 0;
    mocks.json = new (await import("ai/test")).MockLanguageModelV4({
      doGenerate: async (o) => {
        calls++;
        if (calls === 1) return planModel.doGenerate(o);
        return failing.doGenerate(o);
      },
    });
    const { text } = await ask("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
    expect(text).toContain("- **Neon Launch**: the comparison step failed for this item");
  });

  it("tells the user when a backup model answers because the main one is rate-limited", async () => {
    const { failingModel } = await import("../helpers/mock-model");
    mocks.before = [{ label: "google:gemini-3.5-flash-lite", model: failingModel("429 RESOURCE_EXHAUSTED: quota") }];
    mocks.model = scriptedModel([{ text: ["Hi there."] }]);
    const { status, text } = await ask("Hello!");
    expect(status).toContain("Main model (gemini-3.5-flash-lite) is rate-limited right now; using main instead."); // "mock:main" → "main"
    expect(text).toBe("Hi there.");
  });

  it("chat turns offer search but do not force it", async () => {
    mocks.model = scriptedModel([{ text: ["Why did the database break up? Too many relationships."] }]);
    const { status } = await ask("Tell me a joke");
    expect(mocks.model.doStreamCalls[0].toolChoice).toEqual({ type: "auto" });
    expect(status).toEqual([]);
    expect(mocks.tavilySearch).not.toHaveBeenCalled();
  });

  it("pure recall turns get no tools at all (saves quota)", async () => {
    mocks.model = scriptedModel([{ text: ["On 3 Nov you asked about Copilot."] }]);
    await ask("What did I ask you on 3 November?");
    expect(mocks.model.doStreamCalls[0].tools ?? []).toHaveLength(0);
  });
});
