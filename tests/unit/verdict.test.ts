import { describe, expect, it } from "vitest";
import { compareValues, containsQuote, evaluateItems, isRelevantRelease, renderVerdict, type Verdict } from "../../lib/check/verdict";
import type { CitedSource } from "../../lib/search/session";

const RECORD_AT = new Date("2026-11-10T10:52:00Z");
const records = [
  {
    role: "assistant" as const,
    created_at: RECORD_AT,
    content: "- Neon Launch: $19/month, usage-based compute\n- Supabase Pro: $25/month per organization\n- Render Postgres Basic-256mb: $6/month",
  },
];
const src = (n: number, url: string, content: string, publishedAt: string | null = null): CitedSource => ({
  n, sourceId: `s${n}`, title: `T${n}`, url, publishedAt, content,
});
const sources = [
  src(1, "https://neon.tech/pricing", "Launch plan: $22/month. Scale: $69/month."),
  src(2, "https://supabase.com/pricing", "Pro: $25 per month per organization."),
  src(3, "https://someblog.example/render-pricing", "Render Basic-256mb costs €6 per month."),
  src(4, "https://neon.tech/changelog", "Neon: Branch restore GA is now available.", "2026-11-11T08:00:00Z"),
  src(5, "https://neon.tech/blog/old", "Neon autoscaling launched.", "2026-01-15T08:00:00Z"),
  src(6, "https://neon.tech/blog/branching", "Neon announces faster branching."),
];
const ctx = { records, sources, searchFailed: false, cutoff: RECORD_AT };

type Item = Verdict["items"][number];
const price = (text: string, amount: string, currency: string | null, period: "month" | "year" | null, quote: string, unit: string | null = null) => ({
  text, amount, currency, period, unit, quote,
});
const item = (over: Partial<Item>): Item => ({ item: "Neon Launch plan price", product: "Neon", plan: "Launch", kind: "price", before: null, now: null, ...over });

describe("compareValues", () => {
  it("computes an exact decimal difference", () => {
    const r = compareValues(price("$19/month", "19", "$", "month", "x"), price("$22/month", "22", "USD", "month", "y"));
    expect(r).toEqual({ state: "changed", delta: { absolute: "+3", percent: "+15.7%", currency: "USD" } });
  });

  it("handles cents without floating-point error", () => {
    const r = compareValues(price("$0.10", "0.10", "$", "month", "x"), price("$0.30", "0.30", "$", "month", "y"));
    expect(r.delta).toEqual({ absolute: "+0.20", percent: "+200.0%", currency: "USD" });
  });

  it("reports equal amounts as same", () => {
    expect(compareValues(price("$25", "25", "USD", "month", "x"), price("$25", "25.00", "$", "month", "y")).state).toBe("same");
  });

  it.each([
    ["currency", price("$6", "6", "$", "month", "x"), price("€6", "6", "€", "month", "y"), /currency USD vs EUR/],
    ["billing period", price("$19/mo", "19", "$", "month", "x"), price("$190/yr", "190", "$", "year", "y"), /billing period month vs year/],
    ["missing period", price("$19", "19", "$", null, "x"), price("$19/mo", "19", "$", "month", "y"), /billing period not stated/],
    ["unit", price("$25", "25", "$", "month", "x", "per organization"), price("$25", "25", "$", "month", "y", "per user"), /unit organization vs user/],
  ])("refuses to compare when %s differs", (_label, before, now, reason) => {
    const r = compareValues(before, now);
    expect(r.state).toBe("not_comparable");
    expect(r.reason).toMatch(reason);
    expect(r.delta).toBeUndefined();
  });

  it("explains a switch between a fixed price and a non-numeric description", () => {
    const r = compareValues(price("$19/month", "19", "$", "month", "x"), { text: "usage-based", amount: null, currency: null, period: "usage", unit: null, quote: "y" });
    expect(r).toEqual({ state: "not_comparable", reason: "it was a fixed amount then; the current source gives no fixed amount" });
  });

  it("never compares a price range with one price", () => {
    expect(compareValues(price("$7.00 to $9.05 per user/month", "7", "$", "month", "x"), price("$9.05", "9.05", "$", "month", "y")).state).toBe("not_comparable");
    expect(compareValues(price("$9", "9", "$", "month", "x"), price("$5–$17.50", "5", "$", "month", "y")).state).toBe("not_comparable");
  });

  it("treats seat and user as the same unit", () => {
    expect(compareValues(price("$9", "9", "$", "month", "x", "per seat"), price("$9", "9", "$", "month", "y", "per user")).state).toBe("same");
    expect(compareValues(price("$19", "19", "$", "month", "x", "per user"), price("$19", "19", "$", "month", "y", "per granted seat")).state).toBe("same");
    expect(compareValues(price("$25", "25", "$", "month", "x", "per organization"), price("$25", "25", "$", "month", "y", "per project")).state).toBe("not_comparable");
  });

  it("does not report a percentage change from a zero baseline", () => {
    expect(compareValues(price("$0", "0", "$", "month", "x"), price("$5", "5", "$", "month", "y")).delta?.percent).toBeNull();
  });
});

describe("evaluateItems", () => {
  it("marks a verified price difference as changed", () => {
    const [e] = evaluateItems(
      [item({ before: price("$19/month", "19", "$", "month", "Neon Launch: $19/month"), now: { ...price("$22/month", "22", "$", "month", "Launch plan: $22/month"), source: 1 } })],
      ctx,
    );
    expect(e.state).toBe("changed");
    expect(e.before?.role).toBe("assistant");
    expect(e.now?.official).toBe(true);
  });

  it("drops a current value whose quote is not in the cited source (no hallucinated prices)", () => {
    const [e] = evaluateItems(
      [item({ before: price("$19/month", "19", "$", "month", "Neon Launch: $19/month"), now: { ...price("$29/month", "29", "$", "month", "Launch: $29/month"), source: 1 } })],
      ctx,
    );
    expect(e.state).toBe("couldnt_verify");
    expect(e.reason).toMatch(/could not be confirmed/);
  });

  it("never says 'same' when there is no current source", () => {
    const [e] = evaluateItems([item({ before: price("$19/month", "19", "$", "month", "Neon Launch: $19/month"), now: null })], ctx);
    expect(e.state).toBe("couldnt_verify");
    const failed = evaluateItems([item({ before: price("$19", "19", "$", "month", "Neon Launch: $19/month") })], { ...ctx, sources: [], searchFailed: true });
    expect(failed[0].reason).toBe("web search was unavailable");
  });

  it("shows only the current value when the earlier one is not in our records", () => {
    const [e] = evaluateItems(
      [item({ before: price("$15", "15", "$", "month", "Neon Launch: $15/month"), now: { ...price("$22/month", "22", "$", "month", "Launch plan: $22/month"), source: 1 } })],
      ctx,
    );
    expect(e.state).toBe("current_only");
  });

  it("flags third-party sources", () => {
    const [e] = evaluateItems(
      [item({ item: "Render Postgres Basic-256mb price", before: price("$6/month", "6", "$", "month", "Render Postgres Basic-256mb: $6/month"), now: { ...price("€6 per month", "6", "€", "month", "costs €6 per month"), source: 3 } })],
      ctx,
    );
    expect(e.state).toBe("not_comparable");
    expect(e.now?.official).toBe(false);
  });

  it("classifies releases by publication date against the cutoff", () => {
    const rel = (source: number, quote: string): Item => ({ item: "Neon release", product: "Neon", plan: "", kind: "release", before: null, now: { text: quote, amount: null, currency: null, period: null, unit: null, quote, source } });
    const [fresh, old] = evaluateItems([rel(4, "Neon: Branch restore GA is now available"), rel(5, "Neon autoscaling launched")], ctx);
    expect(fresh.state).toBe("new_release");
    expect(old.state).toBe("older_release");
    const undated = evaluateItems([rel(6, "Neon announces faster branching")], ctx);
    expect(undated[0].state).toBe("release_date_unknown");
  });

  it("says 'no new release found in the sources I checked' (never 'nothing shipped') when search worked", () => {
    const none: Item = { item: "Pipedrive releases", product: "Pipedrive", plan: "", kind: "release", before: null, now: null };
    const [e] = evaluateItems([none], ctx);
    expect(e.state).toBe("no_release_found");
    expect(renderVerdict([e], "", { timezone: "UTC", now: new Date("2026-11-11T00:00:00Z") })).toContain(
      "No new release found in the sources I checked for Pipedrive.",
    );
    const failed = evaluateItems([none], { ...ctx, sources: [], searchFailed: true });
    expect(failed[0].state).toBe("couldnt_verify");
  });
});

describe("renderVerdict", () => {
  const evaluated = evaluateItems(
    [
      item({ before: price("$19/month", "19", "$", "month", "Neon Launch: $19/month"), now: { ...price("$22/month", "22", "$", "month", "Launch plan: $22/month"), source: 1 } }),
      item({ item: "Supabase Pro price", before: price("$25/month", "25", "$", "month", "Supabase Pro: $25/month"), now: { ...price("$25 per month", "25", "$", "month", "Pro: $25 per month"), source: 2 } }),
      item({ item: "Render price", before: price("$6/month", "6", "$", "month", "Render Postgres Basic-256mb: $6/month"), now: null }),
    ],
    ctx,
  );
  const text = renderVerdict(evaluated, "Neon got pricier; Supabase may now be the better deal.", { timezone: "Asia/Kolkata", now: new Date("2026-11-11T06:30:00Z") });

  it("answers in one plain sentence first, names the baseline once, then groups items", () => {
    expect(text.split("\n")[0]).toBe("Yes: Neon Launch has changed since Tue 10 Nov. I couldn't confirm Render.");
    expect(text).toContain("Compared with what I told you on Tue 10 Nov.");
    expect(text).toContain("**Changed**\n- **Neon Launch**: $19/month → $22/month (+$3, +15.7%) [1]");
    expect(text).toContain("**Couldn't confirm**\n- **Render**: no current source stated it");
    expect(text).toContain("**Same in the sources I checked**\n- **Supabase Pro**: $25 per month [2]");
    expect(text.indexOf("**Changed**")).toBeLessThan(text.indexOf("**Same in the sources I checked**"));
    expect(text).toContain("My take: Neon got pricier");
    expect(text).not.toContain("item(s)");
  });

  it("says 'no confirmed changes … in the sources I checked' when nothing changed", () => {
    const sameOnly = evaluated.filter((e) => e.state === "same");
    expect(renderVerdict(sameOnly, "", { timezone: "Asia/Kolkata", now: new Date("2026-11-11T06:30:00Z") }).split("\n")[0]).toBe(
      "I found no confirmed changes since Tue 10 Nov in the sources I checked.",
    );
  });

  it("puts a preface first when the requested history was missing", () => {
    expect(renderVerdict(evaluated, "", { timezone: "UTC", now: new Date(), preface: "I don't have stored messages from Sunday." })).toMatch(
      /^I don't have stored messages from Sunday\.\n\nYes: /,
    );
  });

  it("never claims that nothing changed", () => {
    expect(text).not.toMatch(/has not changed|hasn't changed|nothing changed|no changes|unchanged/i);
    for (const take of [
      "Pricing has not changed, you're good.",
      "Most pricing has remained consistent.",
      "Prices stayed the same.",
      "That answer remains correct today.",
      "Both tiers continue at $19 and $39.",
    ]) {
      expect(renderVerdict(evaluated, take, { timezone: "UTC", now: new Date() })).not.toContain("My take");
    }
  });

  it("asks for details when nothing could be extracted", () => {
    expect(renderVerdict([], "", { timezone: "UTC", now: new Date() })).toMatch(/Tell me which products and plans to check/);
  });
});

describe("baseline from stored web facts", () => {
  it("labels a web baseline with its domain, and flags third-party ones", () => {
    const webRecords = [
      { role: "web" as const, content: "Launch: $19/month", created_at: RECORD_AT, source: "neon.tech" },
      { role: "web" as const, content: "Render Basic-256mb: $6/month", created_at: RECORD_AT, source: "checkthat.ai" },
    ];
    const evaluated = evaluateItems(
      [
        item({ before: price("$19/month", "19", "$", "month", "Launch: $19/month"), now: { ...price("$22/month", "22", "$", "month", "Launch plan: $22/month"), source: 1 } }),
        item({ item: "Render Basic-256mb price", product: "Render", before: price("$6/month", "6", "$", "month", "Render Basic-256mb: $6/month"), now: null }),
      ],
      { ...ctx, records: webRecords },
    );
    const text = renderVerdict(evaluated, "", { timezone: "UTC", now: new Date("2026-11-11T00:00:00Z") });
    expect(text).toContain("**Neon Launch**: $19/month (what neon.tech showed on Tue 10 Nov) → $22/month (+$3, +15.7%) [1]");
    expect(text).toContain("earlier: $6/month (what checkthat.ai (third-party) showed on Tue 10 Nov)");
  });
});

describe("release relevance", () => {
  it.each([
    ["HubSpot Sales Hub", "HubSpot launches Breeze AI agents for Sales Hub", "News", true],
    ["Salesforce Sales Cloud", "Agentforce for Revenue", "Salesforce Launches Agentforce for Revenue", true],
    ["Pipedrive", "MySQL, Gmail, Ashby, Pipedrive, Reddit Ads, and Zoom are now Airbyte certified", "Airbyte connectors", false],
    ["Zoho CRM", "Configure and test the solution in a sandbox", "Sandbox help", false],
    ["Freshsales", "Growth plan now starts at $9/user/month, billed annually", "Pricing guide", false],
  ])("%s: %s → %s", (product, quote, title, expected) => {
    expect(isRelevantRelease(product, quote, title)).toBe(expected);
  });

  it("accepts a dated page on the vendor's own domain even without launch words", () => {
    expect(isRelevantRelease("HubSpot Sales Hub", "Revenue Hub Professional, Enterprise", "Product updates", "https://www.hubspot.com/product-updates/revenue-hub")).toBe(true);
    expect(isRelevantRelease("Zoho CRM", "Configure and test the solution in a sandbox", "Help", "https://help.example.com/zoho")).toBe(false);
  });

  it("turns an irrelevant 'release' into 'no new release found'", () => {
    const rel: Item = { item: "Zoho CRM releases", product: "Zoho CRM", plan: "", kind: "release", before: null, now: { text: "sandbox", amount: null, currency: null, period: null, unit: null, quote: "Branch restore GA is now available", source: 4 } };
    expect(evaluateItems([rel], ctx)[0].state).toBe("no_release_found");
  });
});

describe("containsQuote", () => {
  it("ignores case, whitespace and markdown, but requires the words to be present", () => {
    expect(containsQuote("**Pro**: $25  per month", "pro: $25 per month")).toBe(true);
    expect(containsQuote("Pro: $25 per month", "Pro: $30 per month")).toBe(false);
    expect(containsQuote("anything", "an")).toBe(false); // too short to prove anything
  });

  it("tolerates punctuation and spacing differences but never different numbers", () => {
    expect(containsQuote("Sales Hub Professional: $90 /seat/mo, billed annually", "Professional: $90/seat/mo")).toBe(true);
    expect(containsQuote("US$ 39 per seat", "US$39 per seat")).toBe(true);
    expect(containsQuote("Launch: $190/month", "Launch: $19/month")).toBe(false);
    expect(containsQuote("Pro: $25.00 per month", "Pro: $25.50 per month")).toBe(false);
  });
});

describe("release relevance: sibling products", () => {
  it("rejects another product of the same vendor, keeps the product's own launches", () => {
    expect(isRelevantRelease("Zoho CRM", "Zoho Analytics has expanded its platform with 50 new features", "Zoho Analytics update")).toBe(false);
    expect(isRelevantRelease("Zoho CRM", "Zoho CRM introduces Zia insights", "What's new")).toBe(true);
    expect(isRelevantRelease("Salesforce Sales Cloud", "Salesforce Launches Agentforce for Revenue", "Agentforce")).toBe(true);
    expect(isRelevantRelease("HubSpot Sales Hub", "HubSpot launches Breeze AI agents for Sales Hub", "Breeze")).toBe(true);
  });
});

describe("different sites disagreeing", () => {
  it("is not a change unless the vendor's own page is on both sides or the site is the same", () => {
    const records = [{ role: "web" as const, content: "Jira Standard: $9.05 per user per month", created_at: RECORD_AT, source: "community.atlassian.com" }];
    const sources = [{ n: 1, title: "Jira pricing 2026", url: "https://someblog.example/jira", content: "Jira Standard costs $9.70 per user per month", publishedAt: null }] as CitedSource[];
    const [e] = evaluateItems(
      [
        {
          item: "Jira Standard price", product: "Jira", plan: "Standard", kind: "price",
          before: price("$9.05", "9.05", "$", "month", "Jira Standard: $9.05 per user per month"),
          now: { ...price("$9.70", "9.70", "$", "month", "Jira Standard costs $9.70 per user per month"), source: 1 },
        },
      ],
      { records, sources, searchFailed: false, cutoff: new Date(RECORD_AT) },
    );
    expect(e.state).toBe("not_comparable");
    expect(e.reason).toContain("may not be a real change");
  });
});
