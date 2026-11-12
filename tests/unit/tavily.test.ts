import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchUnavailableError, tavilySearch } from "../../lib/search/tavily";

function mockFetch(status: number, body: unknown = {}) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tavilySearch", () => {
  it("sends a basic (1-credit) search with a Bearer key and maps results", async () => {
    const fetch = mockFetch(200, {
      results: [
        { title: "Pricing | Supabase", url: "https://supabase.com/pricing", content: "Pro $25/month", score: 0.9, published_date: "2026-10-01" },
        { title: "bad", url: "javascript:alert(1)", content: "x", score: 0.1 },
      ],
    });

    const hits = await tavilySearch("supabase pricing", { apiKey: "tvly-test", maxResults: 5 });

    expect(hits).toEqual([
      { title: "Pricing | Supabase", url: "https://supabase.com/pricing", content: "Pro $25/month", publishedAt: "2026-10-01", score: 0.9 },
    ]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.tavily.com/search");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tvly-test");
    expect(JSON.parse(init.body as string)).toMatchObject({
      query: "supabase pricing",
      search_depth: "basic",
      max_results: 5,
      include_published_date: true,
    });
  });

  it("prefers the vendor's domain when a site is given (others still allowed)", async () => {
    const fetch = mockFetch(200, { results: [] });
    await tavilySearch("supabase pricing", { apiKey: "k", maxResults: 5, site: "supabase.com" });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ include_domains: ["supabase.com"], include_domains_mode: "prefer" });
  });

  it("uses news mode with a start date for release searches", async () => {
    const fetch = mockFetch(200, { results: [] });
    await tavilySearch("hubspot new features", { apiKey: "k", maxResults: 5, news: true, startDate: "2026-11-09" });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ topic: "news", start_date: "2026-11-09" });
  });

  it.each([
    [401, "auth"],
    [429, "rate_limited"],
    [432, "quota"],
    [433, "quota"],
    [500, "error"],
  ])("maps HTTP %i to an unavailable error (%s), never to 'no results'", async (status, reason) => {
    mockFetch(status);
    const err = await tavilySearch("q", { apiKey: "k", maxResults: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(SearchUnavailableError);
    expect((err as SearchUnavailableError).reason).toBe(reason);
  });

  it("fails fast without an API key and makes no request", async () => {
    const fetch = mockFetch(200);
    const err = await tavilySearch("q", { apiKey: undefined, maxResults: 5 }).catch((e) => e);
    expect((err as SearchUnavailableError).reason).toBe("no_key");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("times out instead of hanging", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))),
      ),
    );
    const err = await tavilySearch("q", { apiKey: "k", maxResults: 5, timeoutMs: 50 }).catch((e) => e);
    expect((err as SearchUnavailableError).reason).toBe("timeout");
  });
});
