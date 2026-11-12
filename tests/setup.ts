import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// Runs before each test file is imported: isolate the database and make sure
// automated tests never call a real provider or spend free-tier quota.
const dataDir = mkdtempSync(path.join(tmpdir(), "chat-agent-test-"));
process.env.DATA_DIR = dataDir;

// LIVE=1 keeps real keys for tests/live (provider checks); every other test runs offline.
if (process.env.LIVE !== "1") {
  process.env.GEMINI_API_KEY = "";
  process.env.GROQ_API_KEY = "";
  process.env.OPENROUTER_API_KEY = "";
  process.env.TAVILY_API_KEY = "";
}

// AGENT_NOW is left as-is: scenario tests set it in vi.hoisted before importing app code.
if (!process.env.AGENT_NOW?.startsWith("2026")) process.env.AGENT_NOW = "";

// Each file's throwaway database is closed and deleted when the file finishes
// (left behind, they filled the disk: ~30 MB per file per run).
afterAll(async () => {
  const { closeDb } = await import("../lib/db/client");
  await closeDb();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // a file still held open on Windows: the OS temp cleanup will remove it
  }
});
