// Live smoke test: starts `next dev` on a spare port using the keys in .env and a throwaway
// data directory, sends real messages, and checks the answer streams back.
// Uses real provider quota (2 model calls). Run: npm run smoke:live
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Code-written change-check answers open with one of these plain sentences.
const VERDICT = /(?:^|\n)(?:Yes:|I found no confirmed|I couldn't confirm the current details|Here is what current sources say)/;

const port = 3124;
const base = `http://localhost:${port}`;
const dataDir = mkdtempSync(path.join(tmpdir(), "chat-agent-smoke-"));
const env = { ...process.env, DATA_DIR: dataDir, NEXT_DIST_DIR: ".next-smoke" };
const child = spawn("npx next dev -p " + port, { cwd: process.cwd(), env, shell: true });
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures.push(label);
};

async function ready() {
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(`${base}/api/conversations`)).ok) return true;
    } catch {}
    await wait(1000);
  }
  return false;
}

async function chat(body) {
  const started = Date.now();
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const events = [];
  let firstDeltaMs;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const e = JSON.parse(line);
      if (e.type === "delta" && firstDeltaMs === undefined) firstDeltaMs = Date.now() - started;
      events.push(e);
    }
  }
  const text = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
  return { events, text, firstDeltaMs, totalMs: Date.now() - started };
}

try {
  if (!(await ready())) throw new Error("server did not start\n" + log.slice(-2000));

  const t1 = await chat({ message: "Reply with exactly the word: pong", timezone: "Asia/Kolkata" });
  const err1 = t1.events.find((e) => e.type === "error");
  if (err1) console.log("  error event:", err1.message, "\n  server log tail:\n", log.slice(-1500));
  check(!err1, "turn 1 has no error event");
  check(t1.events.some((e) => e.type === "done"), "turn 1 ends with done");
  check(/pong/i.test(t1.text), `turn 1 answer contains "pong" (got: ${JSON.stringify(t1.text.slice(0, 80))})`);
  console.log(`  model: ${t1.events.find((e) => e.type === "done")?.model}; first token ${t1.firstDeltaMs} ms; total ${t1.totalMs} ms`);

  const conversationId = t1.events.find((e) => e.type === "meta")?.conversationId;
  const t2 = await chat({ conversationId, message: "What word did you just reply with? One word.", timezone: "Asia/Kolkata" });
  check(/pong/i.test(t2.text), "turn 2 remembers turn 1 (conversation context works)");

  const conv = await (await fetch(`${base}/api/conversations/${conversationId}`)).json();
  check(conv.messages?.length === 4, `4 messages persisted (got ${conv.messages?.length})`);

  // --- Phase 2: date recall on seeded history ---
  const seed = await (await fetch(`${base}/api/dev/seed?timezone=Asia/Kolkata`, { method: "POST" })).json();
  check(seed.inserted?.length === 4, `seed loaded 4 conversations (got ${seed.inserted?.length})`);

  const t3 = await chat({ message: "What did I ask you on 3 November?", timezone: "Asia/Kolkata" });
  const status3 = t3.events.filter((e) => e.type === "status").map((e) => e.text);
  check(status3.some((s) => s.includes("3 November")), `recall status names the date (${JSON.stringify(status3)})`);
  check(/copilot/i.test(t3.text), "recall answer quotes the 3 November question (Copilot)");
  console.log(`  answer: ${JSON.stringify(t3.text.slice(0, 160))}…  (${t3.totalMs} ms)`);

  const t4 = await chat({ message: "What did I ask you on 1 November?", timezone: "Asia/Kolkata" });
  check(t4.events.find((e) => e.type === "done")?.model === "none", "empty day answered without a model call");
  check(/don't have any stored messages/i.test(t4.text), "empty day answer is honest");

  const t5 = await chat({
    message: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    timezone: "Asia/Kolkata",
  });
  const err5 = t5.events.find((e) => e.type === "error");
  if (err5) console.log("  error event:", err5.message, "\n  server log tail:\n", log.slice(-1200));
  check(/neon|supabase|render/i.test(t5.text), "change check recalls Tuesday's Postgres options");
  const sources5 = t5.events.filter((e) => e.type === "sources").at(-1)?.sources ?? [];
  check(sources5.length > 0, `change check searched the web (${sources5.length} sources)`);
  check(VERDICT.test(t5.text), "change check answer is the code-written verdict");
  check(!/has not changed|hasn't changed|nothing (has )?changed|no changes|unchanged/i.test(t5.text), "no blanket 'nothing changed' claim");
  const official5 = sources5.filter((s) => /neon\.tech|supabase\.com|render\.com|aws\.amazon\.com/.test(s.url));
  console.log(`  official sources: ${official5.length}/${sources5.length}`);
  console.log(`  answer:
${t5.text}
  (${t5.totalMs} ms)`);

  // --- Phase 3: web search with citations ---
  const t6 = await chat({ message: "How much does Supabase Pro cost per month?", timezone: "Asia/Kolkata" });
  const status6 = t6.events.filter((e) => e.type === "status").map((e) => e.text);
  const sources6 = t6.events.filter((e) => e.type === "sources").at(-1)?.sources ?? [];
  check(status6.some((s) => s.startsWith("Searching the web")), `research turn searched (${JSON.stringify(status6)})`);
  check(sources6.length > 0, `research turn returned sources (${sources6.map((s) => s.url).join(", ")})`);
  check(/\[\d+\]/.test(t6.text), "answer cites sources as [n]");
  check(/\$\s?\d/.test(t6.text), "answer states a price");
  check(sources6.some((s) => /supabase\.com/.test(s.url)), `an official supabase.com source is included (${sources6.map((s) => new URL(s.url).hostname).join(", ")})`);
  console.log(`  answer: ${JSON.stringify(t6.text.slice(0, 300))}…  (first token ${t6.firstDeltaMs} ms, total ${t6.totalMs} ms)`);

  const t7 = await chat({ message: "How much does Supabase Pro cost per month?", timezone: "Asia/Kolkata" });
  check(!t7.events.some((e) => e.type === "error"), "repeat question answered (search served from cache)");

  // --- Phase 4: fact memory ---
  let facts = [];
  for (let i = 0; i < 30 && !facts.some((f) => /supabase/i.test(f.subject)); i++) {
    await wait(1000); // extraction runs in the background after the answer
    facts = await (await fetch(`${base}/api/facts`)).json();
  }
  const supa = facts.filter((f) => /supabase/i.test(f.subject));
  check(supa.length > 0, `facts remembered after research (${supa.map((f) => `${f.subject} ${f.plan ?? ""} ${f.attribute}=${f.value} @${f.url ? new URL(f.url).hostname : f.origin}`).join("; ")})`);
  check(facts.every((f) => f.quote && f.quote.length >= 3), "every stored fact has a quote");
  console.log(`  total facts stored: ${facts.length}`);

  // A change check about TODAY's research: its baseline must come from the facts remembered above.
  const t8 = await chat({
    message: "Has Supabase Pro pricing changed since I asked you about it today?",
    timezone: "Asia/Kolkata",
  });
  const err8 = t8.events.find((e) => e.type === "error");
  if (err8) console.log("  error event:", err8.message);
  check(/\(per [a-z0-9.-]+\)/.test(t8.text), "second change check compares against a stored web fact (per <domain>)");
  console.log(`  answer:
${t8.text}
  (${t8.totalMs} ms)`);

  // --- Phase 5: the challenge examples ---
  const blanket = /nothing (has )?changed|no changes|unchanged|nothing shipped|has not changed|hasn't changed/i;
  const t9 = await chat({
    message: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    timezone: "Asia/Kolkata",
  });
  const err9 = t9.events.find((e) => e.type === "error");
  if (err9) console.log("  error event:", err9.message);
  const crmCovered = ["HubSpot", "Pipedrive", "Salesforce", "Zoho", "Freshsales"].filter((p) => t9.text.includes(p));
  check(VERDICT.test(t9.text), "CRM: code-written verdict");
  check(crmCovered.length === 5, `CRM: all 5 shortlisted tools covered (${crmCovered.join(", ")})`);
  check(/releas|launch|new since then|No new release found/i.test(t9.text), "CRM: launches/releases checked too");
  check(!blanket.test(t9.text), "CRM: no blanket claims");
  console.log(`  answer:\n${t9.text}\n  (${t9.totalMs} ms)`);
  for (const line of log.split("\n").filter((l) => l.includes("[change-check]")).slice(-12)) {
    console.log(`  server: ${line.trim()}`);
  }

  const t10 = await chat({ message: "What did I ask you on 3 November? Is your answer still correct today?", timezone: "Asia/Kolkata" });
  check(/^On .*3 Nov 2026.* you asked: “What does GitHub Copilot Business cost/.test(t10.text), "still-correct: quotes the 3 November question first");
  check(VERDICT.test(t10.text), "still-correct: re-checks the old answer's claims");
  check(!blanket.test(t10.text), "still-correct: no blanket claims");
  console.log(`  answer:
${t10.text}
  (${t10.totalMs} ms)`);
} catch (e) {
  check(false, e.message);
} finally {
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  else child.kill("SIGTERM");
  await wait(1500);
  rmSync(dataDir, { recursive: true, force: true });
  console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nAll live checks passed");
  process.exitCode = failures.length ? 1 : 0;
}
