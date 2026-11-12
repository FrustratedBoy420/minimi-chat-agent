/**
 * Tavily search adapter (https://docs.tavily.com). Basic search = 1 credit; free plan = 1,000 credits/month.
 * Tavily returns relevant page chunks with each result, so we need no page fetcher of our own
 * (and therefore no SSRF surface).
 */

export interface SearchHit {
  title: string;
  url: string;
  content: string;
  publishedAt: string | null;
  score: number;
}

export type SearchFailureReason = "no_key" | "auth" | "rate_limited" | "quota" | "timeout" | "error";

/** Search could not run. Never to be confused with "searched and found nothing". */
export class SearchUnavailableError extends Error {
  constructor(
    public readonly reason: SearchFailureReason,
    message: string,
  ) {
    super(message);
  }
}

const ENDPOINT = "https://api.tavily.com/search";

export async function tavilySearch(
  query: string,
  opts: {
    apiKey: string | undefined;
    maxResults: number;
    /** Official domain to prefer (results from it rank first; others are still allowed). */
    site?: string;
    /** News mode: dated articles (used for releases/launches). */
    news?: boolean;
    /** Only results published on or after this date (YYYY-MM-DD). */
    startDate?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<SearchHit[]> {
  if (!opts.apiKey) throw new SearchUnavailableError("no_key", "TAVILY_API_KEY is not set.");

  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: opts.maxResults,
        chunks_per_source: 3,
        include_published_date: true,
        topic: opts.news ? "news" : "general",
        ...(opts.startDate ? { start_date: opts.startDate } : {}),
        ...(opts.site ? { include_domains: [opts.site], include_domains_mode: "prefer" } : {}),
      }),
      signal,
    });
  } catch (err) {
    if (timeout.aborted) throw new SearchUnavailableError("timeout", "Search timed out.");
    throw new SearchUnavailableError("error", `Search request failed: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const reason: SearchFailureReason =
      res.status === 401 || res.status === 403
        ? "auth"
        : res.status === 429
          ? "rate_limited"
          : res.status === 432 || res.status === 433
            ? "quota"
            : "error";
    throw new SearchUnavailableError(reason, `Search provider returned HTTP ${res.status}.`);
  }

  const body = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string; published_date?: string | null; score?: number }[];
  };
  return (body.results ?? [])
    .filter((r) => typeof r.url === "string" && /^https?:\/\//.test(r.url))
    .map((r) => ({
      title: (r.title ?? r.url!).slice(0, 300),
      url: r.url!,
      content: r.content ?? "",
      publishedAt: r.published_date ?? null,
      score: r.score ?? 0,
    }));
}
