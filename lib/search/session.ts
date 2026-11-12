import { now } from "../clock";
import { config } from "../config";
import { getDb } from "../db/client";
import { incrementUsage, usageToday } from "../usage";

export { usageToday } from "../usage";
import { SearchUnavailableError, tavilySearch, type SearchHit } from "./tavily";

/**
 * One search session per chat turn:
 * - cache first (6 h for price-like queries, 24 h otherwise), so repeated questions cost no credits;
 * - caps per turn and per day, to stay inside the free plan;
 * - stable citation numbers [1], [2]… across all searches of the turn (same URL = same number);
 * - every source used is stored in `sources` (fact memory in phase 4 points at these rows).
 */

export interface CitedSource {
  n: number;
  sourceId: string;
  title: string;
  url: string;
  publishedAt: string | null;
  /** Trimmed page text the model saw; used to check that quoted values really appear in the source. */
  content: string;
}

export interface SearchToolResult {
  query: string;
  results?: { n: number; title: string; url: string; published: string | null; content: string }[];
  error?: string;
  fromCache?: boolean;
}

const MAX_RESULTS = 5;
const MAX_CHARS_PER_RESULT = 1500;
const PRICE_LIKE = /\b(price|prices|pricing|cost|costs|plan|plans|tier|tiers|fee|fees|subscription|per (user|seat|month))\b/i;

export function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim().replace(/[?.!]+$/, "").trim();
}

export function cacheTtlHours(query: string): number {
  return PRICE_LIKE.test(query) ? 6 : 24;
}

/**
 * Puts likely-official sources first: a result whose domain contains a word from the query
 * ("supabase pricing" → supabase.com) ranks above blogs and aggregators. Otherwise keeps provider order.
 */
export function officialFirst(hits: SearchHit[], query: string, site?: string): SearchHit[] {
  return hits
    .map((hit, i) => ({ hit, i, official: isOfficialUrl(hit.url, query, site) }))
    .sort((a, b) => Number(b.official) - Number(a.official) || a.i - b.i)
    .map((x) => x.hit);
}

/**
 * True when the URL's domain is the given site, or contains a distinctive word of the text
 * (e.g. "supabase" → supabase.com). Used to rank sources and to flag third-party ones.
 */
export function isOfficialUrl(url: string, text: string, site?: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (site && (host === site || host.endsWith(`.${site}`))) return true;
    const words = normalizeQuery(text)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w));
    return words.some((w) => host.split(".").some((label) => label === w || label.startsWith(w)));
  } catch {
    return false;
  }
}

const GENERIC_WORDS = new Set([
  "price", "prices", "pricing", "cost", "costs", "plan", "plans", "month", "monthly", "year", "yearly", "annual",
  "latest", "release", "releases", "changelog", "news", "update", "updates", "version", "free", "best", "review",
  "reviews", "compare", "comparison", "official", "tier", "tiers", "features", "feature", "2025", "2026", "2027",
]);

/** Keeps search results small: free-tier models have tight tokens-per-minute limits. */
export function trimContent(content: string, max = MAX_CHARS_PER_RESULT): string {
  const clean = content.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export interface SearchOptions {
  /** News mode with publication dates (releases, launches). */
  news?: boolean;
  /** Only results published on or after this day. */
  since?: Date;
}

export interface SearchSession {
  search(query: string, site?: string, options?: SearchOptions): Promise<SearchToolResult>;
  sources(): CitedSource[];
  stats(): { calls: number; providerCalls: number; cacheHits: number; failures: number };
}

export function createSearchSession(opts: {
  maxPerTurn?: number;
  maxPerDay?: number;
  signal?: AbortSignal;
}): SearchSession {
  const maxPerTurn = opts.maxPerTurn ?? config.search.maxPerTurn;
  const maxPerDay = opts.maxPerDay ?? config.search.maxPerDay;
  // Searches run in parallel, so a URL's citation number is reserved synchronously (before any await);
  // otherwise two searches returning the same page could give it two different numbers.
  const byUrl = new Map<string, Promise<CitedSource>>();
  const resolved: CitedSource[] = [];
  const stats = { calls: 0, providerCalls: 0, cacheHits: 0, failures: 0 };

  function citeOne(hit: SearchHit, content: string): Promise<CitedSource> {
    let cited = byUrl.get(hit.url);
    if (!cited) {
      const n = byUrl.size + 1;
      cited = (async () => {
        const db = await getDb();
        const row = await db.query<{ id: string }>(
          `INSERT INTO sources (url, title, content, published_at, fetched_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [hit.url, hit.title, content, parseDate(hit.publishedAt), now()],
        );
        const source: CitedSource = { n, sourceId: row.rows[0].id, title: hit.title, url: hit.url, publishedAt: hit.publishedAt, content };
        resolved.push(source);
        return source;
      })();
      byUrl.set(hit.url, cited);
    }
    return cited;
  }

  async function cite(hits: SearchHit[]): Promise<NonNullable<SearchToolResult["results"]>> {
    const out: NonNullable<SearchToolResult["results"]> = [];
    for (const hit of hits.slice(0, MAX_RESULTS)) {
      const content = trimContent(hit.content);
      const cited = await citeOne(hit, content);
      // The model sees a shorter excerpt (prompt budget); the stored text stays longer for quote checks.
      out.push({ n: cited.n, title: hit.title, url: hit.url, published: hit.publishedAt, content: trimContent(content, config.prompt.toolResultChars) });
    }
    return out;
  }

  return {
    async search(rawQuery, rawSite, options = {}) {
      const query = rawQuery.trim().slice(0, 300);
      const site = normalizeSite(rawSite);
      stats.calls++;
      if (stats.calls > maxPerTurn) {
        return { query, error: `Search limit for this answer reached (${maxPerTurn}). Answer with what you have.` };
      }

      const startDate = options.since ? options.since.toISOString().slice(0, 10) : undefined;
      const key = [normalizeQuery(query), site && `@${site}`, options.news && "#news", startDate && `>${startDate}`]
        .filter(Boolean)
        .join(" ");
      const cached = await readCache(key, cacheTtlHours(query));
      if (cached) {
        stats.cacheHits++;
        return { query, results: await cite(officialFirst(cached, query, site)), fromCache: true };
      }

      if ((await usageToday("tavily")) >= maxPerDay) {
        stats.failures++;
        return { query, error: `Daily search limit reached (${maxPerDay}). Say that current information could not be checked.` };
      }

      try {
        stats.providerCalls++;
        await incrementUsage("tavily");
        const hits = await tavilySearch(query, {
          apiKey: config.keys.tavily,
          maxResults: MAX_RESULTS,
          site,
          news: options.news,
          startDate,
          signal: opts.signal,
        });
        await writeCache(key, hits);
        if (hits.length === 0) return { query, results: [] };
        return { query, results: await cite(officialFirst(hits, query, site)) };
      } catch (err) {
        stats.failures++;
        const reason = err instanceof SearchUnavailableError ? err.reason : "error";
        return {
          query,
          error: `Web search is unavailable (${reason}). Do not guess current facts; say they could not be checked.`,
        };
      }
    },
    sources: () => [...resolved].sort((a, b) => a.n - b.n),
    stats: () => ({ ...stats }),
  };
}

async function readCache(key: string, ttlHours: number): Promise<SearchHit[] | undefined> {
  const db = await getDb();
  const res = await db.query<{ results: SearchHit[]; created_at: Date }>(
    `SELECT results, created_at FROM search_cache WHERE query_key = $1`,
    [key],
  );
  const row = res.rows[0];
  if (!row) return undefined;
  const ageMs = now().getTime() - new Date(row.created_at).getTime();
  return ageMs >= 0 && ageMs < ttlHours * 3_600_000 ? row.results : undefined;
}

async function writeCache(key: string, hits: SearchHit[]): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO search_cache (query_key, results, created_at) VALUES ($1, $2, $3)
     ON CONFLICT (query_key) DO UPDATE SET results = EXCLUDED.results, created_at = EXCLUDED.created_at`,
    [key, JSON.stringify(hits), now()],
  );
}

/** Accepts a bare domain like "supabase.com" (from the model); anything else is ignored. */
export function normalizeSite(site: string | undefined): string | undefined {
  if (!site) return undefined;
  const host = site.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : undefined;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
