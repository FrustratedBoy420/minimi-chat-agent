import { now } from "./clock";
import { getDb } from "./db/client";

/**
 * Daily request counters (UTC day) for free-tier quotas: "tavily" for search, "llm:<provider:model>" for models.
 * Free quotas reset daily, so counting locally lets the app avoid a provider BEFORE it starts failing.
 */

export function utcDay(): string {
  return now().toISOString().slice(0, 10);
}

export async function usageToday(key: string): Promise<number> {
  return (await usageTodayMany([key])).get(key) ?? 0;
}

export async function usageTodayMany(keys: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (keys.length === 0) return out;
  const db = await getDb();
  const res = await db.query<{ provider: string; requests: number }>(
    `SELECT provider, requests FROM usage WHERE day = $1 AND provider = ANY($2::text[])`,
    [utcDay(), keys],
  );
  for (const row of res.rows) out.set(row.provider, row.requests);
  return out;
}

export async function incrementUsage(key: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO usage (provider, day, requests) VALUES ($1, $2, 1)
     ON CONFLICT (provider, day) DO UPDATE SET requests = usage.requests + 1`,
    [key, utcDay()],
  );
}

export const llmUsageKey = (label: string) => `llm:${label}`;
