import { DateTime } from "luxon";
import { z } from "zod";
import { getDb } from "./db/client";
import { addMessage } from "./db/queries";

/**
 * Loads demo history with realistic past timestamps, so dated questions
 * ("last Tuesday", "on Monday", "3 November") can be tried on any day.
 * Idempotent: a conversation whose id already exists is skipped.
 */

const SeedFile = z.object({
  conversations: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      day: z.string(),
      time: z.string().regex(/^\d{2}:\d{2}$/),
      messages: z.array(
        z.object({
          role: z.enum(["user", "assistant"]),
          text: z.string().min(1),
          offsetMinutes: z.number().int().min(0),
        }),
      ),
    }),
  ),
});
export type SeedData = z.infer<typeof SeedFile>;

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** Resolves a day spec to a local calendar day strictly before today (or an absolute date). */
export function resolveDaySpec(spec: string, now: Date, timezone: string): DateTime {
  const today = DateTime.fromJSDate(now, { zone: timezone }).startOf("day");
  const [kind, value] = spec.split(":");

  if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) return DateTime.fromISO(spec, { zone: timezone });
  if (kind === "daysAgo") return today.minus({ days: Number.parseInt(value, 10) });
  if (kind === "previous") {
    const weekday = WEEKDAYS.indexOf(value.toLowerCase()) + 1;
    if (weekday === 0) throw new Error(`Unknown weekday in day spec "${spec}"`);
    const diff = (today.weekday - weekday + 7) % 7 || 7;
    return today.minus({ days: diff });
  }
  if (kind === "recent") {
    const [month, day] = value.split("-").map((n) => Number.parseInt(n, 10));
    let date = today.set({ month, day });
    if (date >= today) date = date.minus({ years: 1 });
    return date;
  }
  throw new Error(`Unknown day spec "${spec}"`);
}

export async function seedHistory(
  raw: unknown,
  opts: { now: Date; timezone: string },
): Promise<{ inserted: string[]; skipped: string[] }> {
  const data = SeedFile.parse(raw);
  const db = await getDb();
  const inserted: string[] = [];
  const skipped: string[] = [];

  for (const conv of data.conversations) {
    const [hour, minute] = conv.time.split(":").map((n) => Number.parseInt(n, 10));
    const base = resolveDaySpec(conv.day, opts.now, opts.timezone).set({ hour, minute });

    const res = await db.query<{ id: string }>(
      `INSERT INTO conversations (id, title, created_at, updated_at) VALUES ($1, $2, $3, $3)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [conv.id, conv.title, base.toJSDate()],
    );
    if (res.rows.length === 0) {
      skipped.push(conv.title);
      continue;
    }
    for (const m of conv.messages) {
      await addMessage({
        conversationId: conv.id,
        role: m.role,
        content: m.text,
        at: base.plus({ minutes: m.offsetMinutes }).toJSDate(),
        timezone: opts.timezone,
      });
    }
    inserted.push(conv.title);
  }
  return { inserted, skipped };
}
