import { readFileSync } from "node:fs";
import path from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../../lib/protocol";
import { changeCheckModel, scriptedModel } from "../helpers/mock-model";

/**
 * The three example questions from the challenge, end to end on seeded history, plus the ways real users
 * deviate from them (history given in the chat, products named without stored history, unclear phrasing).
 * Only the model output and the Tavily HTTP call are faked.
 */
const mocks = vi.hoisted(() => {
  process.env.AGENT_NOW = "2026-11-11T12:00:00+05:30"; // Wednesday
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
const { seedHistory } = await import("../../lib/seed");
const { now } = await import("../../lib/clock");
const { settleMemoryWrites } = await import("../../lib/memory/extract");
const { getDb } = await import("../../lib/db/client");

const IST = "Asia/Kolkata";
const hit = (url: string, content: string, publishedAt: string | null = null) => ({ title: url, url, content, publishedAt, score: 1 });

async function ask(message: string, conversationId?: string) {
  const events: ChatEvent[] = [];
  await runTurn({ message, conversationId, timezone: IST }, (e) => events.push(e));
  await settleMemoryWrites();
  const text = events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
  const status = events.filter((e) => e.type === "status").map((e) => (e as { text: string }).text);
  const meta = events.find((e) => e.type === "meta") as Extract<ChatEvent, { type: "meta" }>;
  return { events, text, status, conversationId: meta.conversationId };
}

const v = (text: string, amount: string | null, quote: string, period: string | null = "month", unit: string | null = "per user") => ({
  text, amount, currency: amount ? "$" : null, period, unit, quote,
});

beforeAll(async () => {
  const raw = JSON.parse(readFileSync(path.join(process.cwd(), "seed", "history.json"), "utf8"));
  await seedHistory(raw, { now: now(), timezone: IST });
});

beforeEach(async () => {
  mocks.tavilySearch.mockReset();
  const db = await getDb();
  await db.exec("DELETE FROM search_cache; DELETE FROM usage;");
});

describe("challenge example 1: CRM shortlist — pricing changes and big launches", () => {
  it("checks all 5 shortlisted tools for price AND releases in parallel batches, with dated release detection", async () => {
    const products = [
      ["HubSpot Sales Hub", "hubspot.com"],
      ["Pipedrive", "pipedrive.com"],
      ["Salesforce Sales Cloud", "salesforce.com"],
      ["Zoho CRM", "zoho.com"],
      ["Freshsales", "freshworks.com"],
    ];
    const plan = {
      items: products.flatMap(([p, site]) => [
        { item: `${p} price`, product: p, kind: "price", query: `${p} pricing`, site },
        { item: `${p} releases`, product: p, kind: "release", query: `${p} new features announcement`, site },
      ]),
    };
    mocks.tavilySearch.mockImplementation(async (q: string, opts: { news?: boolean }) => {
      if (q === "HubSpot Sales Hub pricing") return [hit("https://www.hubspot.com/pricing/sales", "Sales Hub Professional: $100/seat/month billed annually")];
      if (q === "Pipedrive pricing") return [hit("https://www.pipedrive.com/en/pricing", "Advanced $39 per seat/month billed annually")];
      if (q === "HubSpot Sales Hub new features announcement" && opts.news)
        return [hit("https://www.hubspot.com/company-news/breeze-agents", "HubSpot launches Breeze AI agents for Sales Hub", "2026-11-10T09:00:00Z")];
      if (q === "Zoho CRM new features announcement" && opts.news)
        return [hit("https://www.zoho.com/crm/whats-new/zia-2024.html", "Zoho CRM introduces Zia insights", "2024-03-01T00:00:00Z")];
      return [];
    });
    mocks.json = changeCheckModel({
      plan,
      items: [
        { item: "HubSpot Sales Hub price", product: "HubSpot Sales Hub", plan: "Professional", kind: "price", before: v("$90", "90", "HubSpot Sales Hub Professional: $90"), now: { ...v("$100/seat/month", "100", "Sales Hub Professional: $100/seat/month"), source: 1 } },
        { item: "HubSpot Sales Hub releases", product: "HubSpot Sales Hub", plan: "", kind: "release", before: null, now: { ...v("Breeze AI agents for Sales Hub", null, "HubSpot launches Breeze AI agents for Sales Hub", null, null), source: 2 } },
        { item: "Pipedrive price", product: "Pipedrive", plan: "Advanced", kind: "price", before: v("$39", "39", "Pipedrive Advanced: $39"), now: { ...v("$39 per seat/month", "39", "Advanced $39 per seat/month"), source: 3 } },
        { item: "Pipedrive releases", product: "Pipedrive", plan: "", kind: "release", before: null, now: null },
        { item: "Salesforce Sales Cloud price", product: "Salesforce Sales Cloud", plan: "Pro Suite", kind: "price", before: v("$100", "100", "Salesforce Sales Cloud Pro Suite: $100"), now: null },
        { item: "Salesforce Sales Cloud releases", product: "Salesforce Sales Cloud", plan: "", kind: "release", before: null, now: null },
        { item: "Zoho CRM price", product: "Zoho CRM", plan: "Professional", kind: "price", before: v("$23", "23", "Zoho CRM Professional: $23"), now: null },
        { item: "Zoho CRM releases", product: "Zoho CRM", plan: "", kind: "release", before: null, now: { ...v("Zia insights", null, "Zoho CRM introduces Zia insights", null, null), source: 4 } },
        { item: "Freshsales price", product: "Freshsales", plan: "Growth", kind: "price", before: v("$9", "9", "Freshsales Growth: $9"), now: null },
        { item: "Freshsales releases", product: "Freshsales", plan: "", kind: "release", before: null, now: null },
      ],
      take: "HubSpot got pricier and shipped AI agents; worth a closer look before renewing.",
    });

    const { text, status } = await ask(
      "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    );

    // Coverage: 10 searches, releases in news mode from Monday's conversation; 3 parallel batches + 1 plan call.
    expect(mocks.tavilySearch).toHaveBeenCalledTimes(10);
    const newsCalls = mocks.tavilySearch.mock.calls.filter((c) => c[1].news);
    expect(newsCalls).toHaveLength(5);
    expect(newsCalls[0][1].startDate).toBe("2026-11-09");
    expect(mocks.json.doGenerateCalls).toHaveLength(4);
    expect(status.filter((s) => /^Checked .+ \(\d of 3\)…$/.test(s))).toHaveLength(3);

    // A plain answer first, then groups.
    expect(text.split("\n")[0]).toBe(
      "Yes: HubSpot Sales Hub has changed since Mon 9 Nov. New since then: HubSpot Sales Hub: Breeze AI agents for Sales Hub. " +
        "I couldn't confirm Salesforce Sales Cloud, Zoho CRM and Freshsales.",
    );
    expect(text).toContain("Compared with what I told you on Mon 9 Nov.");
    expect(text).toContain("- **HubSpot Sales Hub**: $90 → $100/seat/month (+$10, +11.1%) [1]");
    expect(text).toContain("- **HubSpot Sales Hub**: Breeze AI agents for Sales Hub [2], published Tue 10 Nov");
    expect(text).toContain("- **Pipedrive**: $39 per seat/month [3]");
    expect(text).toMatch(/No new release found in the sources I checked for Pipedrive, Salesforce Sales Cloud and Zoho CRM\./); // 2024 Zoho item is not "new"
    expect(text).not.toMatch(/nothing (has )?changed|no changes|unchanged|nothing shipped|item\(s\)/i);
  });
});

describe("challenge example 2: 'What did I ask you on 3 November? Is your answer still correct today?'", () => {
  it("quotes the original question, then re-checks the old answer's claims", async () => {
    mocks.tavilySearch.mockResolvedValue([hit("https://github.com/features/copilot/plans", "Copilot Business $19 per user / month. Copilot Enterprise $39 per user / month.")]);
    mocks.json = changeCheckModel({
      plan: {
        items: [
          { item: "Copilot Business price", product: "GitHub Copilot", kind: "price", query: "GitHub Copilot Business price", site: "github.com" },
          { item: "Copilot Enterprise price", product: "GitHub Copilot", kind: "price", query: "GitHub Copilot Enterprise price", site: "github.com" },
        ],
      },
      items: [
        { item: "Copilot Business price", product: "GitHub Copilot", plan: "Business", kind: "price", before: v("$19 per user per month", "19", "GitHub Copilot Business costs $19 per user per month"), now: { ...v("$19 per user / month", "19", "Copilot Business $19 per user / month"), source: 1 } },
        { item: "Copilot Enterprise price", product: "GitHub Copilot", plan: "Enterprise", kind: "price", before: v("$39 per user per month", "39", "Copilot Enterprise is $39 per user per month"), now: { ...v("$39 per user / month", "39", "Copilot Enterprise $39 per user / month"), source: 1 } },
      ],
      take: "Your earlier answer still holds on price.", // blanket → must be dropped
    });

    const { text } = await ask("What did I ask you on 3 November? Is your answer still correct today?");

    expect(text).toMatch(
      /^On Tue 3 Nov 2026, 10:05 you asked: “What does GitHub Copilot Business cost per user per month\?”\n\nI found no confirmed changes since Tue 3 Nov in the sources I checked\./,
    );
    expect(text).toContain("**Same in the sources I checked**\n- **Copilot Business**: $19 per user / month [1]\n- **Copilot Enterprise**: $39 per user / month [1]");
    expect(text).not.toContain("My take"); // "still holds" is a blanket claim
  });
});

describe("challenge example 3: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?'", () => {
  it("resolves last Tuesday, uses what I told you as the baseline and reports per option", async () => {
    mocks.tavilySearch.mockResolvedValue([hit("https://neon.tech/pricing", "Launch: $22/month.")]);
    mocks.json = changeCheckModel({
      plan: { items: [{ item: "Neon Launch price", product: "Neon", kind: "price", query: "Neon pricing", site: "neon.tech" }] },
      items: [
        { item: "Neon Launch price", product: "Neon", plan: "Launch", kind: "price", before: v("$19/month", "19", "Neon Launch: $19/month", "month", null), now: { ...v("$22/month", "22", "Launch: $22/month.", "month", null), source: 1 } },
      ],
    });
    const { text, status } = await ask("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
    expect(status[0]).toBe("Looking up our messages from Tuesday, 10 November 2026…");
    expect(text.split("\n")[0]).toBe("Yes: Neon Launch has changed since Tue 10 Nov.");
    expect(text).toContain("- **Neon Launch**: $19/month → $22/month (+$3, +15.7%) [1]");
  });
});

describe("real users deviating from the examples", () => {
  it("no stored history for the day, but the user names the products: checks them now and says why it can't compare", async () => {
    mocks.tavilySearch.mockImplementation(async (q: string) =>
      q.startsWith("Notion") ? [hit("https://www.notion.com/pricing", "Plus: $10 per seat/month billed annually")] : [],
    );
    mocks.json = changeCheckModel({
      plan: {
        items: [
          { item: "Notion price", product: "Notion", kind: "price", query: "Notion pricing", site: "notion.com" },
          { item: "Asana price", product: "Asana", kind: "price", query: "Asana pricing", site: "asana.com" },
          { item: "Trello price", product: "Trello", kind: "price", query: "Trello pricing", site: "trello.com" },
        ],
      },
      items: [
        { item: "Notion price", product: "Notion", plan: "Plus", kind: "price", before: null, now: { ...v("$10 per seat/month", "10", "Plus: $10 per seat/month"), source: 1 } },
        { item: "Asana price", product: "Asana", plan: "", kind: "price", before: null, now: null },
        { item: "Trello price", product: "Trello", plan: "", kind: "price", before: null, now: null },
      ],
    });
    const { text } = await ask("On Sunday we shortlisted Notion, Asana and Trello for our team. Has any of them changed pricing since?");
    expect(text).toMatch(/^I don't have stored messages from Sunday, 8 November 2026, so I can't compare with what you saw then\./);
    expect(text).toContain("**Current prices**\n- **Notion**: $10 per seat/month [1]");
    expect(text).not.toMatch(/current sources say.*current sources say/s);
    expect(text).toContain("**Couldn't confirm**");
    expect(mocks.tavilySearch).toHaveBeenCalledTimes(3);
  });

  it("history given earlier in the same chat: uses it as the baseline", async () => {
    mocks.model = scriptedModel([{ text: ["Noted: Linear Standard at $8 per user per month."] }]);
    mocks.json = changeCheckModel({ plan: { items: [] }, items: [] });
    const first = await ask("We're comparing Linear and Jira for our 15-person team. Linear Standard is $8 per user per month.");

    mocks.tavilySearch.mockResolvedValue([hit("https://linear.app/pricing", "Standard: $10 per user/month billed annually")]);
    mocks.json = changeCheckModel({
      plan: { items: [{ item: "Linear Standard price", product: "Linear", kind: "price", query: "Linear pricing", site: "linear.app" }] },
      items: [
        { item: "Linear Standard price", product: "Linear", plan: "Standard", kind: "price", before: v("$8 per user per month", "8", "Linear Standard is $8 per user per month"), now: { ...v("$10 per user/month", "10", "Standard: $10 per user/month"), source: 1 } },
      ],
    });
    const { text } = await ask("On Sunday we shortlisted Linear. Has its pricing changed since?", first.conversationId);
    expect(text).toMatch(/^I don't have stored messages from Sunday, 8 November 2026, so I'm using what you told me earlier in this conversation\./);
    expect(text).toContain("- **Linear Standard**: $8 per user per month → $10 per user/month (+$2, +25.0%) [1]");
    expect(text).toContain("Compared with what you told me earlier today.");
    expect(text).toContain("Yes: Linear Standard has changed since earlier today.");
  });

  it("no stored history and no product names: honest reply without any model call", async () => {
    mocks.json = changeCheckModel({ plan: { items: [] }, items: [] });
    const { text, events } = await ask("On Sunday we shortlisted 3 project management tools. Has any of them changed pricing since?");
    expect(text).toContain("I don't have any stored messages from Sunday, 8 November 2026.");
    expect(text).toContain("If you tell me what we looked at");
    expect(events.at(-1)).toMatchObject({ type: "done", model: "none" });
    expect(mocks.json.doGenerateCalls).toHaveLength(0);
  });

  it("unclear phrasing gets a second opinion from the model ('are the CRMs we picked still a good deal?')", async () => {
    mocks.tavilySearch.mockResolvedValue([]);
    mocks.json = changeCheckModel({ intent: "change_check", plan: { items: [] }, items: [] });
    const { status } = await ask("Are the CRMs we picked on Monday still a good deal?");
    expect(JSON.stringify(mocks.json.doGenerateCalls[0].prompt)).toContain("Classify the user's message");
    expect(status).toContain("Working out what to re-check…"); // routed to a change check
  });
});

describe("number check on normal answers", () => {
  it("adds a visible note when a sourced answer states a price that is not in the sources", async () => {
    mocks.tavilySearch.mockResolvedValue([hit("https://supabase.com/pricing", "Pro: $25 per month per organization.")]);
    mocks.model = scriptedModel([{ searches: ["Supabase Pro pricing"] }, { text: ["Supabase Pro is $25/month [1]; Team is $499/month."] }]);
    mocks.json = changeCheckModel({ plan: { items: [] }, items: [] });
    const { text } = await ask("How much does Supabase Pro cost?");
    expect(text).toContain("Note: “$499” doesn't appear in the sources I used");
    expect(text).not.toContain("“$25”");
  });
});
