// Live fallback check: the first model in the chain is broken on purpose (a model id that does not exist),
// so every model call must fall back to the next model and tell the user. Uses ~2 model calls.
// Run: node --env-file=.env scripts/smoke-fallback.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const port = 3125;
const base = `http://localhost:${port}`;
const dataDir = mkdtempSync(path.join(tmpdir(), "chat-agent-fallback-"));
const chain = "google:this-model-does-not-exist,google:gemini-3.5-flash-lite,google:gemini-3.1-flash-lite";
const env = { ...process.env, DATA_DIR: dataDir, NEXT_DIST_DIR: ".next-smoke-fallback", LLM_MAIN_CHAIN: chain, LLM_FAST_CHAIN: chain };
const child = spawn(`npx next dev -p ${port}`, { cwd: process.cwd(), env, shell: true });
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures.push(label);
};

try {
  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    try {
      up = (await fetch(`${base}/api/status`)).ok;
    } catch {}
    if (!up) await wait(1000);
  }
  if (!up) throw new Error("server did not start\n" + log.slice(-1500));

  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Reply with exactly the word: pong", timezone: "UTC" }),
  });
  const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  const status = events.filter((e) => e.type === "status").map((e) => e.text);
  const text = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
  const done = events.find((e) => e.type === "done");

  check(status.some((s) => s.startsWith("Main model (this-model-does-not-exist) failed; using gemini-3.5-flash-lite")), `user is told about the fallback (${JSON.stringify(status)})`);
  check(/pong/i.test(text), `backup model answered (${JSON.stringify(text.slice(0, 40))})`);
  check(done?.model === "google:gemini-3.5-flash-lite", `answer came from the backup (${done?.model})`);

  const quota = await (await fetch(`${base}/api/status`)).json();
  const backup = quota.models.find((m) => m.label === "google:gemini-3.5-flash-lite");
  check(backup?.usedToday === 1, `usage counted for the model that answered (${backup?.usedToday})`);
  check(quota.models.find((m) => m.label === "google:this-model-does-not-exist")?.usedToday === 0, "failed model not counted");
  check(JSON.stringify(quota).includes("tvly") === false && JSON.stringify(quota).includes("AQ.") === false, "status endpoint exposes no keys");
} catch (e) {
  check(false, e.message);
} finally {
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  else child.kill("SIGTERM");
  await wait(1500);
  rmSync(dataDir, { recursive: true, force: true });
  console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nAll fallback checks passed");
  process.exitCode = failures.length ? 1 : 0;
}
