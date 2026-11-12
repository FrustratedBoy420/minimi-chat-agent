# DESIGN

A chat agent with one tool, web search, that remembers what you discussed and can tell you, with sources and dates, what has changed since. It runs on free tiers: Gemini (with Groq/OpenRouter as optional fallbacks), Tavily search, and Postgres compiled to WebAssembly (PGlite) inside the Node process.

## How it works

Every message goes through the same pipeline. Code does everything that has a right answer; the model only reads and writes.

```text
message → route (code; model only if unsure) → resolve dates (code) → recall (SQL) → ┬ chat / research: stream answer (model + web_search) → number check (code)
                                                                                     └ change check:   plan (model, JSON) → up to 3 product batches in parallel:
                                                                                                       search every item (code) → extract values with quotes (model, JSON)
                                                                                                       → verdict (code) → answer written by code
        → save answer → remember facts in the background (model, JSON; quotes verified by code)
```

1. **Route.** Rules decide whether a message is chat, recall ("what did I ask on…"), research (needs current facts) or a change check ("has it changed since…"). Only when the rules are unsure ("are the CRMs we picked still a good deal?") does one fast model call classify the message.
2. **Dates.** "Last Tuesday", "3 November", "on Monday" become exact ranges in the user's timezone (DST-safe), always shown back as explicit dates.
3. **Recall.** SQL over past messages by date, or full-text search by topic, plus facts remembered from those conversations. If the requested day has nothing, a change check falls back to this chat, then to other chats about the products named, then to the names alone ("I can't compare with what you saw then; here are current prices"). With nothing to go on, it says so without a model call.
4. **Research.** The model calls `web_search` (Tavily); it is required for research turns. Results are cached (6 h for prices), capped per turn and per day, numbered for citations, and the vendor's own domain is preferred.
5. **Change checks.** Products are split into up to 3 batches that run in parallel, each reporting progress; a failed batch only marks its own items "couldn't confirm". The model only *extracts* each value with a verbatim quote. Code checks that every quote exists in its source and refuses to compare different currencies, billing periods, units, price ranges, or two different third-party sites. It computes differences with exact decimal math and writes the answer: one plain sentence first ("Yes: HubSpot Sales Hub has changed since Mon 9 Nov."), where the earlier values come from, then grouped items. Releases are searched in news mode from the date of the earlier conversation; another product of the same vendor does not count.
6. **Memory.** Prices, releases, shortlists and constraints are stored as facts with their quote, source and date. A later "has it changed since then?" compares against what was known *then*, never against something learned later.

## Why this way

- **Correct where it matters.** Calendars, comparisons and arithmetic are code; quotes are verified; an unsupported number in a normal answer gets a visible note. Because the verdict is written by code, "nothing changed" can't come out of a failed search or a blog post.
- **Fast.** Chat is one call (first token ≈ 2 s). A change check is one plan call plus parallel batches. Measured live: 3–6 s for 1–2 items, 7–8 s for 4, 11–14 s for the 10-item CRM check (was 16–22 s before batching). Fact extraction runs after the answer is sent.
- **Good to talk to.** Answers lead with the result, give explicit dates, cite sources [n], quote your original question when you ask what you asked, and admit missing history plainly.
- **Free and resilient.** A chain of free models with daily usage counters, rate-limit cool-down and immediate fallback (the user is told). Prompts stay within budgets (~6k tokens for a 10-item check) by keeping the sentences that mention the product, prices or dates.

## Considered and rejected

| Option | Why not |
|---|---|
| Let the model compare old and new answers itself | In testing it said "pricing has not changed", compared a flat fee with usage pricing, and summarized from blogs. The verdict is now code |
| Vector database for memory | The test questions are about dates and product names; SQL and full-text search are exact and free |
| Postgres in Docker, worker queue | Breaks `npm install && npm run dev`; PGlite gives real Postgres in-process |
| Model calls `web_search` for change checks | It skipped products (1 of 4 checked). Code now runs one search per planned item (4 of 4, 10 of 10) |
| Rich JSON schemas sent to Gemini | Rejected with 400 above a complexity limit; the wire schema is structure-only and full validation happens locally |
| Buffering answers until fully validated | Costs seconds per turn; streamed answers are number-checked afterwards and change-check numbers are computed by code |
| One extraction call per product | 5–10 parallel calls hit free-tier rate limits; up to 3 batches is the measured balance |
| A model call to route every message | Adds ~1 s to every turn; rules are exact for the common phrasings, the model is asked only when they are unsure |

## With another week

- Stream each batch's items into the answer as it finishes (today only a progress line is shown per batch).
- Read pricing tables from the HTML before any model call, so fewer prices end as "couldn't verify".
- An eval set of ~50 conversations built from the three example questions, scored on state accuracy, latency and calls per turn.
- Scheduled re-checks of remembered prices, with a "something changed" notice.
