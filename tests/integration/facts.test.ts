import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../lib/db/client";
import { addMessage, createConversation } from "../../lib/db/queries";
import {
  baselineFactsMentionedIn,
  factsForConversations,
  formatFacts,
  listFacts,
  storeFacts,
  type FactDraft,
  type FactSourceRef,
} from "../../lib/memory/facts";

let conversationId: string;
let neonSource: FactSourceRef;

const draft = (over: Partial<FactDraft>): FactDraft => ({
  product: "Neon",
  plan: "Launch",
  attribute: "price",
  value: "$19/month",
  amount: "19",
  currency: "$",
  period: "month",
  unit: null,
  region: null,
  origin: "web",
  source: 1,
  quote: "Launch: $19/month",
  ...over,
});

async function sourceRow(url: string, content: string): Promise<string> {
  const db = await getDb();
  const r = await db.query<{ id: string }>(`INSERT INTO sources (url, title, content) VALUES ($1, 'x', $2) RETURNING id`, [url, content]);
  return r.rows[0].id;
}

beforeAll(async () => {
  conversationId = (await createConversation("Postgres hosting", new Date("2026-11-10T10:00:00Z"))).id;
  neonSource = { n: 1, sourceId: await sourceRow("https://neon.tech/pricing", "Launch: $19/month. Scale: $69/month."), url: "https://neon.tech/pricing", content: "Launch: $19/month. Scale: $69/month." };
});

describe("storeFacts", () => {
  it("stores a web fact whose quote appears in the source, with subject → plan hierarchy", async () => {
    const r = await storeFacts([draft({})], { conversationId, sources: [neonSource], seenAt: new Date("2026-11-10T10:05:00Z") });
    expect(r).toEqual({ stored: 1, rejected: [] });
    const [f] = (await listFacts()).filter((x) => x.subject === "Neon");
    expect(f).toMatchObject({ subject: "Neon", plan: "Launch", attribute: "price", value_text: "$19/month", currency: "USD", origin: "web", url: "https://neon.tech/pricing" });
    expect(f.qualifiers).toEqual({ plan: "Launch", period: "month" });
  });

  it("rejects facts whose quote is not in the cited source (no invented values)", async () => {
    const r = await storeFacts([draft({ value: "$15/month", quote: "Launch: $15/month" })], { conversationId, sources: [neonSource], seenAt: new Date() });
    expect(r.stored).toBe(0);
    expect(r.rejected[0].reason).toBe("quote not found in source");
  });

  it("rejects a web fact pointing at an unknown source number", async () => {
    const r = await storeFacts([draft({ source: 9 })], { conversationId, sources: [neonSource], seenAt: new Date() });
    expect(r.rejected[0].reason).toBe("unknown source number");
  });

  it("treats spacing variants of a value as the same fact", async () => {
    const spaced = await storeFacts([draft({ value: "$19 / month" })], { conversationId, sources: [neonSource], seenAt: new Date() });
    expect(spaced.stored).toBe(0);
  });

  it("does not store the same fact twice (retries are safe)", async () => {
    const again = await storeFacts([draft({})], { conversationId, sources: [neonSource], seenAt: new Date("2026-11-10T10:06:00Z") });
    expect(again.stored).toBe(0);
    expect((await listFacts()).filter((x) => x.subject === "Neon" && x.value_text === "$19/month")).toHaveLength(1);
  });

  it("stores user decisions only when the quote is in the user's own message", async () => {
    const msg = await addMessage({ conversationId, role: "user", content: "Great, let's shortlist Neon and Supabase.", at: new Date("2026-11-10T10:07:00Z") });
    const userMessage = { id: msg.id, content: msg.content, at: new Date(msg.created_at) };
    const ok = await storeFacts(
      [draft({ product: "Supabase", plan: null, attribute: "shortlist", value: "shortlisted", amount: null, currency: null, period: null, origin: "user_said", source: null, quote: "let's shortlist Neon and Supabase" })],
      { conversationId, userMessage, sources: [], seenAt: new Date() },
    );
    expect(ok.stored).toBe(1);
    const bad = await storeFacts(
      [draft({ product: "Railway", plan: null, attribute: "decision", value: "selected", origin: "user_said", source: null, quote: "we picked Railway" })],
      { conversationId, userMessage, sources: [], seenAt: new Date() },
    );
    expect(bad.rejected[0].reason).toBe("quote not found in the user's message");
  });
});

describe("reading facts", () => {
  it("returns facts of a conversation and formats them with date, source and quote", async () => {
    const facts = await factsForConversations([conversationId]);
    expect(facts.map((f) => f.attribute).sort()).toEqual(["price", "shortlist"]);
    const text = formatFacts(facts, "UTC");
    expect(text).toContain('- Neon Launch, price: $19/month (seen 10 Nov 2026, source neon.tech; quote: "Launch: $19/month")');
    expect(text).toContain("- Supabase, shortlist: shortlisted (seen 10 Nov 2026, the user said;");
  });

  it("finds the latest baseline before a cutoff for products named in the text", async () => {
    const later = { n: 1, sourceId: await sourceRow("https://neon.tech/pricing", "Launch: $22/month"), url: "https://neon.tech/pricing", content: "Launch: $22/month" };
    await storeFacts([draft({ value: "$22/month", amount: "22", quote: "Launch: $22/month" })], { conversationId, sources: [later], seenAt: new Date("2026-11-12T09:00:00Z") });

    const before12 = await baselineFactsMentionedIn("Options were Neon Launch and Render.", new Date("2026-11-11T00:00:00Z"));
    expect(before12.map((f) => f.value_text)).toEqual(["$19/month"]);
    const after12 = await baselineFactsMentionedIn("Options were Neon Launch and Render.", new Date("2026-11-13T00:00:00Z"));
    expect(after12.map((f) => f.value_text)).toEqual(["$22/month"]);
    expect(await baselineFactsMentionedIn("We talked about Railway only.", new Date("2026-11-13T00:00:00Z"))).toEqual([]);
  });

  it("deletes a conversation's facts with the conversation", async () => {
    const tmp = await createConversation("tmp", new Date());
    await storeFacts([draft({ product: "Temp Product", plan: null })], { conversationId: tmp.id, sources: [neonSource], seenAt: new Date() });
    const db = await getDb();
    await db.query(`DELETE FROM conversations WHERE id = $1`, [tmp.id]);
    expect(await factsForConversations([tmp.id])).toEqual([]);
  });
});
