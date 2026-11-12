import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "../config";
import { SCHEMA_SQL } from "./schema";

type Db = Awaited<ReturnType<typeof createDb>>;

async function createDb() {
  const dir = path.resolve(config.dataDir, "pglite");
  mkdirSync(dir, { recursive: true });
  const db = await PGlite.create({ dataDir: dir, extensions: { pg_trgm } });
  await db.exec(SCHEMA_SQL);
  return db;
}

// One database instance per process. Stored on globalThis so Next.js hot reload in dev
// does not open a second PGlite instance on the same directory.
const globalForDb = globalThis as unknown as { __chatAgentDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  if (!globalForDb.__chatAgentDb) {
    globalForDb.__chatAgentDb = createDb().catch((err) => {
      globalForDb.__chatAgentDb = undefined; // allow a retry on the next request
      throw err;
    });
  }
  return globalForDb.__chatAgentDb;
}

/** Closes the database (tests and graceful shutdown); the next getDb() opens it again. */
export async function closeDb(): Promise<void> {
  const pending = globalForDb.__chatAgentDb;
  globalForDb.__chatAgentDb = undefined;
  if (!pending) return;
  try {
    await (await pending).close();
  } catch {
    // already closed or never opened
  }
}
