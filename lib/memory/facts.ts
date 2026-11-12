import { DateTime } from "luxon";
import { z } from "zod";
import { containsQuote } from "../check/verdict";
import { getDb } from "../db/client";

/**
 * Fact memory: prices, limits, features, releases, shortlists, decisions and constraints, each stored with
 * - a subject (vendor → product → plan),
 * - qualifiers (plan, region, billing period, unit, currency),
 * - a verbatim quote that MUST appear in its source (web page text or the user's own message),
 * - where it came from (origin web | user_said | assistant_said) and when it was seen.
 *
 * Facts make later change checks faster and more reliable: the baseline is "what neon.tech said on
 * 10 Nov", not a re-reading of old chat.
 */

export const ATTRIBUTES = ["price", "limit", "feature", "release", "shortlist", "decision", "constraint"] as const;
export type Attribute = (typeof ATTRIBUTES)[number];

/**
 * Structured-output schema for fact extraction.
 * No string length limits here: Gemini rejects minLength/maxLength in response schemas
 * (found in a live run). Lengths are enforced in code by storeFacts.
 */
export const FactDraftSchema = z.object({
  product: z.string().describe("Product or vendor name, e.g. 'Neon' or 'HubSpot Sales Hub'"),
  plan: z.string().nullable().describe("Plan or tier, e.g. 'Launch', 'Pro'; null if not plan-specific"),
  attribute: z.enum(ATTRIBUTES),
  value: z.string().describe("The value as written, e.g. '$19/month' or 'shortlisted' or '20 people'"),
  amount: z.string().nullable().describe("Numeric amount only (e.g. '19'); null if none"),
  currency: z.string().nullable(),
  period: z.enum(["month", "year", "one_time", "usage", "none"]).nullable(),
  unit: z.string().nullable().describe("e.g. 'per user'"),
  region: z.string().nullable(),
  origin: z.enum(["web", "user_said"]),
  source: z.number().int().nullable().describe("For origin 'web': the number n of the search result quoted"),
  quote: z.string().describe("Exact words copied from the search result or from the user's message"),
});
export type FactDraft = z.infer<typeof FactDraftSchema>;

export interface FactSourceRef {
  n: number;
  sourceId: string;
  url: string;
  content: string;
}

export interface StoredFact {
  id: string;
  subject: string;
  plan: string | null;
  attribute: Attribute;
  value_text: string;
  value_numeric: string | null;
  currency: string | null;
  qualifiers: { plan?: string; period?: string; unit?: string; region?: string };
  origin: "web" | "user_said" | "assistant_said";
  quote: string;
  seen_at: Date;
  url: string | null;
  conversation_id: string | null;
}

/** "$25/ month" and "$25 /month" are the same value: normalize spacing so duplicates are not stored. */
export function normalizeValue(value: string): string {
  return value.trim().replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ");
}

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Finds or creates a subject by exact normalized name (fuzzy matches never auto-merge). */
export async function upsertSubject(name: string, kind: "product" | "plan", parentId: string | null): Promise<string> {
  const db = await getDb();
  const normalized = normalizeName(name);
  const found = await db.query<{ id: string }>(
    `SELECT id FROM subjects
     WHERE kind = $1 AND parent_id IS NOT DISTINCT FROM $3 AND (normalized = $2 OR $2 = ANY(aliases))
     LIMIT 1`,
    [kind, normalized, parentId],
  );
  if (found.rows[0]) return found.rows[0].id;
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO subjects (kind, name, normalized, parent_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (kind, normalized, parent_id) DO UPDATE SET name = subjects.name
     RETURNING id`,
    [kind, name.trim(), normalized, parentId],
  );
  return inserted.rows[0].id;
}

/**
 * Stores fact drafts after verifying each quote against its source.
 * Returns how many were stored and why others were rejected (for logs and tests).
 */
export async function storeFacts(
  drafts: FactDraft[],
  ctx: {
    conversationId: string;
    userMessage?: { id: string; content: string; at: Date };
    sources: FactSourceRef[];
    seenAt: Date;
  },
): Promise<{ stored: number; rejected: { fact: string; reason: string }[] }> {
  const db = await getDb();
  let stored = 0;
  const rejected: { fact: string; reason: string }[] = [];

  for (const raw of drafts) {
    const d = { ...raw, product: raw.product.trim().slice(0, 120), plan: raw.plan?.trim().slice(0, 120) || null, value: normalizeValue(raw.value).slice(0, 300) };
    const label = `${d.product}${d.plan ? ` ${d.plan}` : ""} ${d.attribute}=${d.value}`;
    if (!d.product || !d.value) {
      rejected.push({ fact: label, reason: "empty product or value" });
      continue;
    }
    if (d.quote.length > 500) {
      rejected.push({ fact: label, reason: "quote too long" });
      continue;
    }
    let sourceId: string | null = null;
    let messageId: string | null = null;
    let seenAt = ctx.seenAt;

    if (d.origin === "web") {
      const src = ctx.sources.find((s) => s.n === d.source);
      if (!src) {
        rejected.push({ fact: label, reason: "unknown source number" });
        continue;
      }
      if (!containsQuote(src.content, d.quote)) {
        rejected.push({ fact: label, reason: "quote not found in source" });
        continue;
      }
      sourceId = src.sourceId;
    } else {
      if (!ctx.userMessage || !containsQuote(ctx.userMessage.content, d.quote)) {
        rejected.push({ fact: label, reason: "quote not found in the user's message" });
        continue;
      }
      messageId = ctx.userMessage.id;
      seenAt = ctx.userMessage.at;
    }

    const productId = await upsertSubject(d.product, "product", null);
    const subjectId = d.plan ? await upsertSubject(d.plan, "plan", productId) : productId;
    const qualifiers = Object.fromEntries(
      Object.entries({ plan: d.plan, period: d.period, unit: d.unit, region: d.region }).filter(([, v]) => v),
    );

    const res = await db.query(
      `INSERT INTO facts (subject_id, attribute, qualifiers, value_numeric, value_text, currency, origin, quote,
                          message_id, source_id, seen_at, conversation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT DO NOTHING`,
      [
        subjectId,
        d.attribute,
        JSON.stringify(qualifiers),
        parseAmount(d.amount),
        d.value,
        normalizeCurrency(d.currency),
        d.origin,
        d.quote,
        messageId,
        sourceId,
        seenAt,
        ctx.conversationId,
      ],
    );
    if ((res.affectedRows ?? 0) > 0) stored++;
  }
  return { stored, rejected };
}

const FACT_SELECT = `
  SELECT f.id, coalesce(parent.name, s.name) AS subject,
         CASE WHEN s.kind = 'plan' THEN s.name END AS plan,
         f.attribute, f.value_text, f.value_numeric::text AS value_numeric, f.currency, f.qualifiers, f.origin,
         f.quote, f.seen_at, src.url, f.conversation_id
  FROM facts f
  JOIN subjects s ON s.id = f.subject_id
  LEFT JOIN subjects parent ON parent.id = s.parent_id
  LEFT JOIN sources src ON src.id = f.source_id`;

/** Facts recorded in the given conversations (shortlists, constraints, prices seen there). */
export async function factsForConversations(
  conversationIds: string[],
  opts: { seenBefore?: Date; limit?: number } = {},
): Promise<StoredFact[]> {
  if (conversationIds.length === 0) return [];
  const db = await getDb();
  const res = await db.query<StoredFact>(
    `${FACT_SELECT}
     WHERE f.conversation_id = ANY($1::uuid[]) AND ($2::timestamptz IS NULL OR f.seen_at <= $2)
     ORDER BY f.seen_at DESC LIMIT $3`,
    [conversationIds, opts.seenBefore ?? null, opts.limit ?? 40],
  );
  return res.rows;
}

/**
 * Latest fact per (subject, attribute, qualifiers) for products whose name appears in the text,
 * seen strictly before the cutoff. This is the baseline for change checks.
 */
export async function baselineFactsMentionedIn(text: string, cutoff: Date, limit = 30): Promise<StoredFact[]> {
  const db = await getDb();
  const products = await db.query<{ id: string; name: string; normalized: string }>(
    `SELECT id, name, normalized FROM subjects WHERE kind = 'product'`,
  );
  const haystack = ` ${normalizeName(text)} `;
  const ids = products.rows.filter((p) => haystack.includes(` ${p.normalized} `)).map((p) => p.id);
  if (ids.length === 0) return [];
  const res = await db.query<StoredFact>(
    `${FACT_SELECT}
     WHERE (s.id = ANY($1::uuid[]) OR s.parent_id = ANY($1::uuid[])) AND f.seen_at < $2
     ORDER BY f.seen_at DESC
     LIMIT 300`,
    [ids, cutoff],
  );
  // Keep only the latest fact per subject/plan/attribute/qualifiers.
  const latest = new Map<string, StoredFact>();
  for (const f of res.rows) {
    const key = `${f.subject}|${f.plan ?? ""}|${f.attribute}|${JSON.stringify(f.qualifiers)}`;
    if (!latest.has(key)) latest.set(key, f);
  }
  return [...latest.values()].slice(0, limit);
}

/** Recent facts for the memory view. */
export async function listFacts(limit = 100): Promise<StoredFact[]> {
  const db = await getDb();
  const res = await db.query<StoredFact>(`${FACT_SELECT} ORDER BY f.seen_at DESC LIMIT $1`, [limit]);
  return res.rows;
}

/** One line per fact for model context; the quote is what later quote checks are verified against. */
export function formatFacts(facts: StoredFact[], timezone: string): string {
  return facts
    .map((f) => {
      const day = DateTime.fromJSDate(new Date(f.seen_at), { zone: timezone }).toFormat("d LLL yyyy");
      const who = f.origin === "web" ? `source ${hostOf(f.url)}` : f.origin === "user_said" ? "the user said" : "you said";
      const name = f.plan ? `${f.subject} ${f.plan}` : f.subject;
      return `- ${name}, ${f.attribute}: ${f.value_text} (seen ${day}, ${who}; quote: "${f.quote}")`;
    })
    .join("\n");
}

export function hostOf(url: string | null): string {
  if (!url) return "unknown";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function parseAmount(raw: string | null): string | null {
  if (!raw) return null;
  const clean = raw.replace(/[,\s]/g, "");
  return /^\d+(\.\d+)?$/.test(clean) ? clean : null;
}

const CURRENCY: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "₹": "INR", "¥": "JPY" };
function normalizeCurrency(c: string | null): string | null {
  if (!c) return null;
  const t = c.trim();
  if (CURRENCY[t]) return CURRENCY[t];
  return /^[a-z]{3}$/i.test(t) ? t.toUpperCase() : null;
}
