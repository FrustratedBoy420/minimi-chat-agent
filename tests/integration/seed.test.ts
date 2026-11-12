import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getDb } from "../../lib/db/client";
import { getMessages } from "../../lib/db/queries";
import { resolveDaySpec, seedHistory } from "../../lib/seed";

const NOW = new Date("2026-11-11T12:00:00+05:30"); // Wednesday
const IST = "Asia/Kolkata";
const seedFile = JSON.parse(readFileSync(path.join(process.cwd(), "seed", "history.json"), "utf8"));

describe("resolveDaySpec", () => {
  it.each([
    ["previous:monday", "2026-11-09"],
    ["previous:tuesday", "2026-11-10"],
    ["previous:wednesday", "2026-11-04"],
    ["recent:11-03", "2026-11-03"],
    ["recent:12-25", "2025-12-25"],
    ["daysAgo:5", "2026-11-06"],
    ["2026-01-15", "2026-01-15"],
  ])("%s → %s", (spec, expected) => {
    expect(resolveDaySpec(spec, NOW, IST).toISODate()).toBe(expected);
  });

  it("rejects unknown specs", () => {
    expect(() => resolveDaySpec("someday", NOW, IST)).toThrow();
    expect(() => resolveDaySpec("previous:funday", NOW, IST)).toThrow();
  });
});

describe("seedHistory", () => {
  it("inserts conversations with local past timestamps, and is idempotent", async () => {
    const first = await seedHistory(seedFile, { now: NOW, timezone: IST });
    expect(first.inserted).toHaveLength(seedFile.conversations.length);

    const second = await seedHistory(seedFile, { now: NOW, timezone: IST });
    expect(second.inserted).toEqual([]);
    expect(second.skipped).toHaveLength(seedFile.conversations.length);

    const db = await getDb();
    const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM conversations`);
    expect(count.rows[0].n).toBe(seedFile.conversations.length);

    // Postgres hosting conversation: previous Tuesday 16:20 IST = 10:50 UTC on 10 Nov.
    const pg = await getMessages("5eed0000-0000-4000-8000-000000000003");
    expect(new Date(pg[0].created_at).toISOString()).toBe("2026-11-10T10:50:00.000Z");
    expect(new Date(pg[1].created_at).toISOString()).toBe("2026-11-10T10:52:00.000Z");
  });
});
