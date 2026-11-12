import { beforeEach, describe, expect, it, vi } from "vitest";

const { tavilySearch } = vi.hoisted(() => ({ tavilySearch: vi.fn() }));
vi.mock("../../lib/search/tavily", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/search/tavily")>()),
  tavilySearch,
}));

const { createSearchSession, usageToday } = await import("../../lib/search/session");
const { SearchUnavailableError } = await import("../../lib/search/tavily");
const { getDb } = await import("../../lib/db/client");

const hit = (url: string, content = "Plan costs $19/month") => ({ title: `Title ${url}`, url, content, publishedAt: null, score: 1 });

beforeEach(async () => {
  tavilySearch.mockReset();
  process.env.AGENT_NOW = "2026-11-11T06:00:00Z";
  const db = await getDb();
  await db.exec("DELETE FROM search_cache; DELETE FROM usage;");
});

describe("search session", () => {
  it("numbers sources across searches and reuses the number for the same URL", async () => {
    tavilySearch
      .mockResolvedValueOnce([hit("https://neon.tech/pricing"), hit("https://example.com/a")])
      .mockResolvedValueOnce([hit("https://supabase.com/pricing"), hit("https://neon.tech/pricing")]);
    const s = createSearchSession({});

    const r1 = await s.search("neon pricing");
    const r2 = await s.search("supabase pricing");

    expect(r1.results!.map((r) => r.n)).toEqual([1, 2]);
    expect(r2.results!.map((r) => r.n)).toEqual([3, 1]);
    expect(s.sources().map((c) => c.url)).toEqual([
      "https://neon.tech/pricing",
      "https://example.com/a",
      "https://supabase.com/pricing",
    ]);
  });

  it("gives a URL one citation number even when parallel searches return it at the same time", async () => {
    tavilySearch.mockResolvedValue([hit("https://github.com/features/copilot/plans")]);
    const s = createSearchSession({});
    const [a, b] = await Promise.all([s.search("copilot business price"), s.search("copilot enterprise price")]);
    expect(a.results![0].n).toBe(1);
    expect(b.results![0].n).toBe(1);
    expect(s.sources().map((c) => c.n)).toEqual([1]);
  });

  it("stores each cited source in the database", async () => {
    tavilySearch.mockResolvedValueOnce([hit("https://render.com/pricing", "Basic $6/month")]);
    const s = createSearchSession({});
    await s.search("render postgres price");
    const db = await getDb();
    const rows = await db.query<{ content: string }>(`SELECT content FROM sources WHERE id = $1`, [s.sources()[0].sourceId]);
    expect(rows.rows[0].content).toBe("Basic $6/month");
  });

  it("serves repeated queries from cache without spending a credit", async () => {
    tavilySearch.mockResolvedValue([hit("https://neon.tech/pricing")]);
    await createSearchSession({}).search("Neon pricing");
    const second = await createSearchSession({}).search("  neon PRICING? ");
    expect(tavilySearch).toHaveBeenCalledTimes(1);
    expect(second.fromCache).toBe(true);
    expect(await usageToday("tavily")).toBe(1);
  });

  it("expires price-like cache entries after 6 hours", async () => {
    tavilySearch.mockResolvedValue([hit("https://neon.tech/pricing")]);
    await createSearchSession({}).search("neon pricing");
    process.env.AGENT_NOW = "2026-11-11T12:30:00Z"; // 6.5 hours later
    await createSearchSession({}).search("neon pricing");
    expect(tavilySearch).toHaveBeenCalledTimes(2);
  });

  it("enforces the per-turn cap", async () => {
    tavilySearch.mockResolvedValue([hit("https://x.com")]);
    const s = createSearchSession({ maxPerTurn: 2 });
    await s.search("a one");
    await s.search("b two");
    const third = await s.search("c three");
    expect(third.error).toMatch(/Search limit for this answer reached/);
    expect(tavilySearch).toHaveBeenCalledTimes(2);
  });

  it("enforces the daily cap (cache hits still work)", async () => {
    tavilySearch.mockResolvedValue([hit("https://x.com")]);
    await createSearchSession({ maxPerDay: 1 }).search("first query");
    const blocked = await createSearchSession({ maxPerDay: 1 }).search("second query");
    expect(blocked.error).toMatch(/Daily search limit reached/);
    const cached = await createSearchSession({ maxPerDay: 1 }).search("first query");
    expect(cached.fromCache).toBe(true);
  });

  it("reports provider failure as an error result (never as empty results) and does not cache it", async () => {
    tavilySearch.mockRejectedValueOnce(new SearchUnavailableError("rate_limited", "429"));
    const s = createSearchSession({});
    const failed = await s.search("hubspot pricing");
    expect(failed.results).toBeUndefined();
    expect(failed.error).toMatch(/unavailable \(rate_limited\)/);

    tavilySearch.mockResolvedValueOnce([hit("https://hubspot.com/pricing")]);
    const retried = await createSearchSession({}).search("hubspot pricing");
    expect(retried.results).toHaveLength(1);
  });

  it("caches searches with and without a preferred site separately, and passes the site on", async () => {
    tavilySearch.mockResolvedValue([hit("https://neon.tech/pricing")]);
    await createSearchSession({}).search("neon pricing");
    await createSearchSession({}).search("neon pricing", "https://neon.tech");
    expect(tavilySearch).toHaveBeenCalledTimes(2);
    expect(tavilySearch.mock.calls[1][1]).toMatchObject({ site: "neon.tech" });
  });

  it("passes news mode and start date through, with their own cache entry", async () => {
    tavilySearch.mockResolvedValue([hit("https://news.example/hubspot")]);
    await createSearchSession({}).search("hubspot new features");
    await createSearchSession({}).search("hubspot new features", undefined, { news: true, since: new Date("2026-11-09T05:00:00Z") });
    expect(tavilySearch).toHaveBeenCalledTimes(2);
    expect(tavilySearch.mock.calls[1][1]).toMatchObject({ news: true, startDate: "2026-11-09" });
  });

  it("returns an empty result list (not an error) when search worked but found nothing", async () => {
    tavilySearch.mockResolvedValueOnce([]);
    const r = await createSearchSession({}).search("zzqx nonexistent product pricing");
    expect(r.results).toEqual([]);
    expect(r.error).toBeUndefined();
  });
});
