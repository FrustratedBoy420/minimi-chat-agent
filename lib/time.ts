import * as chrono from "chrono-node";
import { DateTime } from "luxon";

/**
 * Deterministic date resolution. The model never does calendar math.
 *
 * Turns phrases like "3 November", "last Tuesday", "on Monday", "yesterday", "two weeks ago"
 * into exact half-open UTC ranges [start, end) of the user's local calendar days.
 *
 * Conventions (shown back to the user as explicit dates, so they can correct us):
 * - "last Tuesday", "on Tuesday", "Tuesday": the most recent Tuesday BEFORE today.
 * - "this Tuesday": the most recent Tuesday on or before today.
 * - A date without a year ("3 November"): its most recent occurrence on or before today.
 * - "N weeks ago": the Monday-to-Sunday week containing the day N weeks ago.
 */

export interface TimeRange {
  /** The text that was matched, e.g. "last Tuesday". */
  phrase: string;
  start: Date;
  end: Date;
  /** Human label in the user's timezone, e.g. "Tuesday, 10 November 2026". */
  label: string;
  kind: "day" | "week";
  /** True when the phrase was preceded by "since" (used as a cutoff for change checks). */
  since: boolean;
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

interface Match {
  index: number;
  length: number;
  range: Omit<TimeRange, "since">;
}

export function resolveTimeRanges(text: string, now: Date, timezone: string): TimeRange[] {
  const today = DateTime.fromJSDate(now, { zone: timezone }).startOf("day");
  const matches: Match[] = [];

  const add = (index: number, phrase: string, start: DateTime, kind: "day" | "week") => {
    const end = kind === "day" ? start.plus({ days: 1 }) : start.plus({ weeks: 1 });
    if (overlaps(matches, index, phrase.length)) return;
    matches.push({
      index,
      length: phrase.length,
      range: {
        phrase,
        start: start.toUTC().toJSDate(),
        end: end.toUTC().toJSDate(),
        label: kind === "day" ? dayLabel(start) : `the week of ${dayLabel(start)}`,
        kind,
      },
    });
  };

  // Order matters: longer, more specific phrases first; later matches skip overlapping text.
  for (const m of text.matchAll(/\bday before yesterday\b/gi)) add(m.index!, m[0], today.minus({ days: 2 }), "day");
  for (const m of text.matchAll(/\byesterday\b/gi)) add(m.index!, m[0], today.minus({ days: 1 }), "day");
  for (const m of text.matchAll(/\btoday\b|\bthis (?:morning|afternoon|evening)\b|\btonight\b/gi)) {
    add(m.index!, m[0], today, "day");
  }

  const numberPattern = `(\\d{1,2}|${Object.keys(NUMBER_WORDS).join("|")})`;
  for (const m of text.matchAll(new RegExp(`\\b${numberPattern} days? ago\\b`, "gi"))) {
    add(m.index!, m[0], today.minus({ days: toNumber(m[1]) }), "day");
  }
  for (const m of text.matchAll(new RegExp(`\\b${numberPattern} weeks? ago\\b`, "gi"))) {
    add(m.index!, m[0], today.minus({ weeks: toNumber(m[1]) }).startOf("week"), "week");
  }
  for (const m of text.matchAll(/\blast week\b/gi)) add(m.index!, m[0], today.minus({ weeks: 1 }).startOf("week"), "week");
  for (const m of text.matchAll(/\bthis week\b/gi)) add(m.index!, m[0], today.startOf("week"), "week");

  const weekdayPattern = new RegExp(`\\b(?:(last|this|on|past|previous)\\s+)?(${WEEKDAYS.join("|")})\\b`, "gi");
  for (const m of text.matchAll(weekdayPattern)) {
    const qualifier = m[1]?.toLowerCase();
    const weekday = WEEKDAYS.indexOf(m[2].toLowerCase() as (typeof WEEKDAYS)[number]) + 1; // Luxon: Monday = 1
    add(m.index!, m[0], mostRecentWeekday(today, weekday, qualifier === "this"), "day");
  }

  // Explicit calendar dates ("3 November", "Nov 3", "3 November 2025"), day-first (en-GB).
  for (const r of chrono.en.GB.parse(text, now)) {
    if (!r.start.isCertain("day") || !r.start.isCertain("month")) continue;
    const day = r.start.get("day")!;
    const month = r.start.get("month")!;
    let date = DateTime.fromObject(
      { year: r.start.isCertain("year") ? r.start.get("year")! : today.year, month, day },
      { zone: timezone },
    );
    if (!date.isValid) continue;
    if (!r.start.isCertain("year") && date > today) date = date.minus({ years: 1 });
    const lead = /^on\s+/i.exec(r.text)?.[0].length ?? 0; // chrono includes a leading "on"
    add(r.index + lead, r.text.slice(lead), date.startOf("day"), "day");
  }

  return matches
    .sort((a, b) => a.index - b.index)
    .map((m) => ({ ...m.range, since: /\bsince\s+(?:on\s+)?$/i.test(text.slice(0, m.index)) }));
}

/** Most recent given weekday before today (or on/before today when includeToday). */
function mostRecentWeekday(today: DateTime, weekday: number, includeToday: boolean): DateTime {
  let diff = (today.weekday - weekday + 7) % 7;
  if (diff === 0 && !includeToday) diff = 7;
  return today.minus({ days: diff });
}

function toNumber(token: string): number {
  const lower = token.toLowerCase();
  return NUMBER_WORDS[lower] ?? Number.parseInt(lower, 10);
}

function overlaps(existing: Match[], index: number, length: number): boolean {
  return existing.some((m) => index < m.index + m.length && m.index < index + length);
}

export function dayLabel(d: DateTime): string {
  return d.toFormat("cccc, d LLLL yyyy");
}

/** Local time label for a stored timestamp, e.g. "Tue 10 Nov 2026, 10:32". */
export function timestampLabel(at: Date, timezone: string): string {
  return DateTime.fromJSDate(at, { zone: timezone }).toFormat("ccc d LLL yyyy, HH:mm");
}

/** Local calendar day key (yyyy-MM-dd) for grouping. */
export function localDayKey(at: Date, timezone: string): string {
  return DateTime.fromJSDate(at, { zone: timezone }).toISODate()!;
}
