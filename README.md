# Chat Agent

A chat agent with one tool, web search, that remembers your conversations and tells you, with sources and dates, what has changed since you last talked about something.

> "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
> "What did I ask you on 3 November? Is your answer still correct today?"
> "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"

How it works and why: [`DESIGN.md`](DESIGN.md). How it is tested: [`TESTING.md`](TESTING.md).

## Run it

Requires Node.js 20.9+.

```bash
npm install
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
# add your keys to .env (both free, no card needed):
#   GEMINI_API_KEY  https://aistudio.google.com/apikey
#   TAVILY_API_KEY  https://app.tavily.com
npm run dev
```

Open http://localhost:3000. Everything runs locally; data is stored in `./data` (Postgres compiled to WebAssembly, so there is no database to install). Delete that folder to start fresh.

Optional: `GROQ_API_KEY` and/or `OPENROUTER_API_KEY` add free fallback models. The sidebar shows today's free-quota use.

## Try the example questions

The examples refer to earlier conversations. To try them on a fresh install, load demo history while the app is running:

```bash
npm run seed
```

This adds four synthetic past conversations on recent days: a Copilot price question on 3 November, a CRM shortlist on the last Monday, Postgres hosting options on the last Tuesday, and a naming chat. The prices in them are illustrative "what the assistant said then"; the agent re-checks them against the web. Then ask the three questions above.

Set `AGENT_NOW` in `.env` (e.g. `2026-11-11T12:00:00+05:30`) to freeze "today" for reproducible demos.

## What you will see

- Answers stream in, with status lines while it works ("Looking up our messages from Tuesday, 10 November 2026…", "Searching the web: …").
- Sources are listed under each answer; [n] in the text links to them.
- Change checks open with a plain answer ("Yes: Neon Launch has changed since Tue 10 Nov."), say once where the earlier values come from, then group items: changed (old → new, difference), new since then, not directly comparable (why), couldn't confirm (why), same in the sources I checked. Products are checked in up to 3 parallel batches with a progress line each.
- If the day you name has no stored messages, a change check uses this chat, other chats about the products you name, or just the names (current prices, clearly labelled).
- **What I remember** (`/memory`): every remembered fact with its source and date.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the app |
| `npm run seed` | Load demo history into the running app |
| `npm test` | 221 unit, integration and scenario tests; offline, no API keys or quota used |
| `npm run typecheck` | TypeScript check |
| `npm run build` | Production build |
| `npm run smoke:live` | End-to-end check against the real providers with your `.env` keys (uses ~20 search credits) |
| `node --env-file=.env scripts/smoke-fallback.mjs` | Live check that a broken main model falls back and the user is told |
| `LIVE=1 npx vitest run tests/live` | Checks the real provider accepts the structured-output schemas |

## Project layout

```text
app/                 UI (chat, /memory) and API routes (/api/chat streams NDJSON events)
lib/chat/turn.ts     the turn pipeline: route → recall → research or change check → answer → remember
lib/intent.ts        rule-based routing          lib/time.ts       date phrases → exact ranges
lib/recall.ts        SQL / full-text recall      lib/memory/       facts: storage, extraction
lib/search/          Tavily adapter, cache, caps lib/check/        change-check plan, verdict, number check
lib/llm/             model chain with fallback, usage counters, prompt budgets, provider-safe schemas
lib/db/              PGlite client, schema, queries
tests/               unit, integration, scenario, live (opt-in)
scripts/             seed, live smoke tests
```

## Limitations

- Free-tier limits change often. Model IDs and daily limits are settings in `.env`, not code.
- Some current prices come from third-party pages; these are labeled "(third-party source)".
- Release detection depends on dated news results, which vary from day to day. When none qualify, the answer says "no new release found in the sources I checked".
- Single user, no authentication (as the challenge allows).
