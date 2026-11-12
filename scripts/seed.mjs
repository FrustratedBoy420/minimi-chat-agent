// Loads demo history (seed/history.json) into the running app.
// Usage: start the app with `npm run dev`, then in another terminal: `npm run seed`
const port = process.env.PORT || 3000;
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const url = `http://localhost:${port}/api/dev/seed?timezone=${encodeURIComponent(timezone)}`;

try {
  const res = await fetch(url, { method: "POST" });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  console.log(`Seeded in ${body.timezone}.`);
  if (body.inserted.length) console.log(`  added:   ${body.inserted.join("; ")}`);
  if (body.skipped.length) console.log(`  skipped (already present): ${body.skipped.join("; ")}`);
} catch (err) {
  const refused = err?.cause?.code === "ECONNREFUSED";
  console.error(refused ? `The app is not running on port ${port}. Start it with "npm run dev" first.` : `Seeding failed: ${err.message}`);
  process.exitCode = 1;
}
