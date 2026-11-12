import { readFile } from "node:fs/promises";
import path from "node:path";
import { now, validTimezone } from "@/lib/clock";
import { seedHistory } from "@/lib/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Loads seed/history.json into the running app's database.
 * Seeding goes through the server (not a separate process) because PGlite must have a single owner.
 * Disabled in production unless ALLOW_SEED=1.
 */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_SEED !== "1") {
    return Response.json({ error: "Seeding is disabled in production." }, { status: 403 });
  }
  const url = new URL(req.url);
  const timezone = validTimezone(url.searchParams.get("timezone")) ?? "UTC";
  const raw = JSON.parse(await readFile(path.join(process.cwd(), "seed", "history.json"), "utf8"));
  const result = await seedHistory(raw, { now: now(), timezone });
  return Response.json({ timezone, ...result });
}
