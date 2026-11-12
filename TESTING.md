# Testing

Every phase ends with its tests designed, implemented and passing before the next phase starts.

## Test layers

| Layer | What it uses | Where | Command | Runs |
|---|---|---|---|---|
| Unit | Pure functions only | `tests/unit/` | `npm test` | Always |
| Integration | Real PGlite database (throwaway dir per file) + **mock models** (`ai/test`) | `tests/integration/` | `npm test` | Always |
| Scenario | Full turn pipeline + recorded search fixtures + mock models with scripted outputs | `tests/scenarios/` (from phase 2) | `npm test` | Always |
| Live smoke | Real dev server + real keys from `.env` | `scripts/smoke-live.mjs` | `npm run smoke:live` | Manually, at the end of each phase |

Rules:
- `npm test` never calls a real provider or uses free-tier quota. `tests/setup.ts` blanks every API key and gives each file its own database.
- Live smoke tests use a throwaway database and a few model calls. Run them once per phase, not in a loop.
- Every bug found gets a regression test before the fix.

## Phase 1: skeleton ✅

| Test | Layer | Checks |
|---|---|---|
| `config.test.ts` | Unit | Model chain parsing; colons inside model IDs; bad providers rejected |
| `protocol.test.ts` | Unit | NDJSON round trip; events split across chunks; multi-byte characters split across chunks |
| `router.test.ts` | Unit | First model used; fallback when a model fails before text; **no switch after text was shown**; all-fail error lists attempts; missing config explained |
| `db.test.ts` | Integration | Schema created (7 tables); original timestamps kept; recent-N window oldest-first; list order by activity; role CHECK; cascade delete |
| `turn.test.ts` | Integration | Event order meta→delta→done; **user message saved before the model call**; error keeps the user message and is retryable; context includes prior turns; unknown conversation ID starts a new one |
| `smoke-live.mjs` | Live | Real Gemini answers; second turn remembers the first; 4 messages persisted; first-token time printed |

**Result (2026-11-11):** 23/23 automated tests pass. Live smoke passed (`google:gemini-3.5-flash-lite`, first token ≈ 3.3 s including first compile).

## Phase 2: date recall ✅

| Test | Layer | Checks |
|---|---|---|
| `time.test.ts` | Unit | "3 November", "last Tuesday", "on Monday", "yesterday", "two weeks ago" against a fixed `AGENT_NOW` in `Asia/Kolkata`, `America/New_York`, `UTC`; half-open `[start,end)`; DST change days (New York 8 Mar / 1 Nov); month/year boundaries; "last Tuesday" asked on a Tuesday; an unparseable phrase returns null instead of guessing |
| `intent.test.ts` | Unit | Router rules: recall vs change check vs research vs chat for 30 labeled example messages (including the 3 challenge examples) |
| `recall.test.ts` | Integration | Messages found only inside the local-day range (a 23:30 IST message belongs to that IST day, not the UTC day); empty day → no-LLM template answer |
| `seed.test.ts` | Integration | `npm run seed` loads history with original timestamps; running it twice does not duplicate |
| `scenario-recall.test.ts` | Scenario | "What did I ask you on 3 November?" quotes the seeded question with date and time |
| Live smoke | Live | Seeded recall question answered correctly with `AGENT_NOW` set |

**Result (2026-11-11):** 93/93 automated tests pass (time 14, intent 32, recall 9, seed 9, scenario 7, plus phase 1). Live smoke passed on real Gemini:
- "What did I ask you on 3 November?" quoted the seeded question with date and time (1.3 s).
- The empty day was answered with no model call.
- "Last Tuesday … has any pricing changed?" recalled the Postgres options and stated it can't verify changes yet; web search arrives in phase 3.

Found while building: chrono includes a leading "on" in its matches, so phrases are trimmed. A `beforeEach` returning a function is run by Vitest as cleanup. A second `next dev` in the same folder is blocked by Next 16, so the smoke test uses its own build folder (`NEXT_DIST_DIR`).

## Phase 3: web search ✅

| Test | Layer | Checks |
|---|---|---|
| `search.test.ts` | Unit | Query normalization for the cache key; result trimming (3 chunks, 1,500 characters); per-turn cap (5) and per-day cap (40) |
| `search-cache.test.ts` | Integration | The same query within 6 h hits the cache (no provider call); expiry respected |
| `tavily-adapter.test.ts` | Unit | Maps a recorded Tavily response to results; handles 401/429/timeout as `search_unavailable`, never as "no results" |
| `scenario-research.test.ts` | Scenario | A pricing question → mock model calls `web_search` (parallel calls) → status lines emitted → answer cites `[n]` with a source list |
| Live smoke | Live | One real search question returns cited sources; Tavily credits used ≤ 3 |
| `search-session.test.ts` (extra) | Integration | Stable citation numbers across parallel searches; sources stored; daily cap still allows cache hits; failure never cached; "found nothing" ≠ "search failed" |
| `research.scenario.test.ts` | Scenario | Search forced on research/change-check (`toolChoice: required`), offered on chat (`auto`), absent on pure recall; parallel searches; failure reaches the model as an error |

**Result (2026-11-11):** 119/119 automated tests pass. Live smoke passed (real Gemini + Tavily):
- "How much does Supabase Pro cost per month?" searched once and answered "$25 per month per organization [1]" (first token 4.8 s).
- The repeat question was served from cache.
- The change check searched (20 sources, 12 s).

Found by the live run, not the tests:
- (a) The change-check answer opened with "No, pricing has not changed": an overclaim. The prompt is tightened now; phase 5 replaces this with code-computed comparisons.
- (b) All Supabase sources were third-party blogs. Added `officialFirst` ranking (vendor domain first). It can only reorder what the provider returns.

Bug found by tests: with a frozen clock, a question and its answer had equal timestamps and could swap order, so messages now have an insertion `seq` tie-breaker.

### Phase 3 fixes (after live review) ✅

| Problem found live | Fix | Test |
|---|---|---|
| Change check said "No, pricing has not changed" | Change checks are now: search-only step → JSON extraction with verbatim quotes → **code** verifies quotes, checks currency/period/unit, computes decimal deltas and writes fixed wording (`lib/check/verdict.ts`). Blanket "no change" text cannot be produced, and a "My take" line containing it is dropped | `verdict.test.ts` (20 cases), 2 change-check scenarios |
| Sources were third-party blogs | `web_search` has a `site` argument → Tavily `include_domains` with `prefer`; official domains rank first; third-party sources are labeled in verdicts | `tavily.test.ts`, `search.test.ts`, `search-session.test.ts` |
| Model copied the "USER:" record label | Records are labeled "the user wrote / you (the assistant) replied" and the prompt asks for natural wording | `recall.test.ts` |
| Hallucinated current price | A value whose quote is not in the cited source becomes "couldn't verify" | `verdict.test.ts`, scenario |

**Result:** 144/144 automated tests pass. Live, "Last Tuesday … Postgres … has any pricing changed?" checked 4 of 4 items in 7.8 s:
- Neon: not comparable, because it is now usage-based;
- Supabase: same in the sources checked, flagged as third-party;
- Render and AWS: couldn't verify, because no current source stated them.

There was no blanket claim. The Supabase research question now cites supabase.com first.

One live run failed the change check with an error after about 2 s, and the next run passed. This is probably Gemini's free-tier per-minute limit, since the smoke test makes about 8 calls quickly. The smoke script now prints the error event; the Groq fallback in phase 6 addresses it.

### Phase 3 fixes, round 2 ✅

| Problem | Fix | Test |
|---|---|---|
| A change check failed once, probably due to the Gemini free-tier rate limit | The model router falls back immediately (no backoff wait) while another model is available. A model that answers 429 / RESOURCE_EXHAUSTED is cooled down for its Retry-After time (default 60 s) and tried last. Default chain: Gemini 3.5 Flash-Lite → 3.1 Flash-Lite → 3.6 Flash (separate free quotas, all verified with the key) → Groq → OpenRouter. The Groq and OpenRouter adapters are now wired, so free keys just work | `router.test.ts` (cool-down, Retry-After parsing, wrapped errors) |
| The change check covered only some products | The model *plans* the items (JSON) and **code** runs one search per item in parallel, so coverage no longer depends on the model calling the tool for each product. Cap: 10 searches per change check | `plan.test.ts`, change-check scenario asserts every planned item was searched |
| A third-party source was quoted when the vendor page existed | The extraction prompt prefers the vendor's own page | live run |
| "My take" summarized changes ("remained consistent") | "My take" is advice only; the filter also blocks "remained consistent/stable" and "stayed the same" | `verdict.test.ts` |

**Result:** 151/151 automated tests pass. Live: the Postgres change check covered **4/4 items** in 13.4 s (Neon: not comparable, now usage-based; Supabase, Render, AWS: same in the sources checked, with AWS flagged as third-party). Before this round, 1/4. The rate-limit fallback was not triggered live in this run; it is covered by unit tests.

## Phase 4: fact memory ✅

| Test | Layer | Checks |
|---|---|---|
| `facts.test.ts` | Integration | Web fact stored only if its quote is in the source; user facts only if the quote is in the user's own message; unknown source number rejected; duplicates (incl. spacing variants) not stored; product → plan subjects; formatting; latest baseline **before a cutoff**; facts deleted with their conversation |
| `extract.test.ts` | Integration | No model call when there are no sources and no decision/constraint; verified facts stored and an invented one rejected; `fast` role; memory-cue regex; background writes never throw into the caller |
| `schema-compat.test.ts` | Unit | Wire schemas sent to the provider are structure-only (no descriptions, length or size limits); field guide kept for the prompt |
| `schemas.live.test.ts` | Live (opt-in `LIVE=1`) | The real plan/verdict/facts schemas are accepted by Gemini |
| `memory.scenario.test.ts` | Scenario | Day 1 research → fact remembered; day 2 change check uses it ("per supabase.com") and remembers the new value; a fact captured **after** the recalled day is never the baseline; recalled conversations include their remembered facts |

**Result (2026-11-11):** 182/182 automated tests pass (+3 opt-in live). Live smoke passed:
- Facts were remembered in the background after a research turn, all from supabase.com, all with quotes.
- "Has Supabase Pro pricing changed since I asked you about it today?" compared against the stored fact (per supabase.com) in 5.3 s.
- "Since last Tuesday" still compares against what was said on Tuesday.

Found by live runs, not by mocked tests:
1. **Gemini rejected the structured-output schemas (400 INVALID_ARGUMENT).** Length limits, array limits and descriptions push a schema past Gemini's complexity limit. Now the provider gets a structure-only "wire" schema, descriptions become a field guide in the prompt, and output is validated locally with the full zod schema (`lib/llm/schema.ts`).
2. **The fallback for a failed change check was a free-form answer, and it overclaimed** ("remains the same"). It is replaced with an honest "couldn't compare reliably" reply plus the sources found.
3. **"Since last Tuesday" used today's facts as its baseline.** The baseline is now what we knew then: facts seen up to the end of the recalled day, in both the baseline lookup and the remembered-facts block.
4. **"$25/month" and "$25/ month" were stored twice.** Values are normalized now.

Flaky test seen once: `recall.test.ts` hook timeout under parallel PGlite start-up; `hookTimeout` raised to 60 s, and two full runs were clean after that.

## Phase 4 (old plan, kept for reference)

| Test | Layer | Checks |
|---|---|---|
| `facts-block.test.ts` | Unit | The hidden `<facts>` block is stripped from the stream even when split across chunks; malformed JSON ignored safely |
| `quote-check.test.ts` | Unit | A fact is kept only if its quote appears verbatim (whitespace-normalized) in the source or message |
| `subjects.test.ts` | Integration | Exact/alias match reuses a subject; trigram-only match is never auto-merged; plans attach to their product |
| `facts.test.ts` | Integration | Facts stored with origin, qualifiers, `seen_at`; unknown `published_at` stays null; DB CHECKs reject a web fact without a source |
| `backfill.test.ts` | Integration | Old messages without facts → one extraction call → facts with `user_said` / `assistant_said` origins |

## Phase 5: change checks ✅

| Test | Layer | Checks |
|---|---|---|
| `challenge.scenario.test.ts` | Scenario | **Example 1 (CRM):** all 5 tools × price + releases = 10 searches, releases in news mode from Monday; HubSpot +10 USD (+11.1%); a release dated after Monday is "new", one from 2024 is not; "no new release found" for tools without one. **Example 2:** original question quoted first, then the old answer re-checked. **Example 3:** "last Tuesday" resolved, per-option diff. **No history:** honest reply, no model call. **Number check:** an unsourced "$499" gets a visible note |
| `numbers.test.ts` | Unit | Money/percent extraction (not plain numbers or citations), normalization ("19.00" = "19"), unsupported-figure note |
| `verdict.test.ts` (extra) | Unit | `no_release_found` only when search worked; "couldn't verify" when it failed |
| `search-session.test.ts` (extra) | Integration | News mode + start date passed through and cached separately; **one citation number per URL under parallel searches** |
| `plan.test.ts`, `tavily.test.ts`, `intent.test.ts` (extra) | Unit | Release items searched in news mode; `topic: news` + `start_date` sent; "what did I ask" detected |

**Result (2026-11-11):** 197/197 automated tests pass (+3 opt-in live). Live smoke passed all three challenge questions on real Gemini + Tavily:
- **CRM:** 10 items, all 5 tools covered, 3 dated launches found (HubSpot AI agents, Salesforce Agentforce, Zoho Teamspaces), 4 prices same in the sources checked, 2 "no new release found", 1 couldn't verify. No blanket claims. 21 s.
- **"What did I ask you on 3 November? Is your answer still correct today?":** quoted the question, then re-checked the Copilot prices.
- **Postgres since last Tuesday:** per-option verdict, as before.

Bug found by the new scenario test: parallel searches returning the same page gave it two citation numbers (a race in `cite`), so a correct quote was rejected as "couldn't verify". Numbers are now reserved synchronously.

### Phase 5 fixes after the live run ✅

| Problem found live | Fix | Test |
|---|---|---|
| The "still correct today?" recap quoted today's unrelated messages ("today" was treated as a date to recall) | `recallRanges`: when a past date is named, "today" means now, not memory | `intent.test.ts`, stricter scenario assertion |
| "per user" vs "per granted seat" was called not comparable | Units are matched by meaning (user/seat/licence → user; org/workspace/team → organization); "per project" is deliberately kept separate | `verdict.test.ts` |
| "My take: that answer remains correct today" overclaimed | Filter also drops "remains correct / still holds / continues at" | `verdict.test.ts` |

Final live run: all checks passed. The still-correct answer quotes only the 3 Nov question; Copilot Business $19 and Enterprise $39 are same in the sources checked (6.8 s). Timings this run: chat 1.9 s, research first token 2.8 s, change checks 11–14 s, still-correct 6.8 s; in the previous run the 10-item CRM check took 21 s.

## Phase 5 (old plan, kept for reference)

| Test | Layer | Checks |
|---|---|---|
| `compare.test.ts` | Unit | One test per rules-table row in `ARCHITECTURE.md` §5: changed with decimal delta, baseline 0 → no %, unchanged, monthly vs yearly → incomparable, USD vs EUR → incomparable, conflicting sources, release after cutoff, undated release → unknown, changelog with nothing new → no change found, search failure → unknown (never "no change") |
| `validate.test.ts` | Unit | Numbers, prices and dates in an answer must exist in the provided facts/sources; unsupported ones produce the visible note |
| `scenario-crm.test.ts` | Scenario | Challenge example 1: Monday shortlist of 5 CRMs (seeded) → 5 parallel searches → per-tool result with state |
| `scenario-postgres.test.ts` | Scenario | Challenge example 3: "last Tuesday" resolved → baseline from what the assistant said → price diff labeled "what I told you on <date>" |
| `scenario-still-correct.test.ts` | Scenario | Challenge example 2: 3 November question recalled → its claims re-checked → each marked changed/unchanged/unknown |
| `scenario-no-history.test.ts` | Scenario | "On Monday we shortlisted 5 CRMs" with an empty DB → says there's no record, offers a path, invents nothing |
| Live smoke | Live | All 3 challenge examples on seeded history, with time per turn and model calls per turn printed |

## Phase 6: free-tier resilience ✅

| Test | Layer | Checks |
|---|---|---|
| `usage-routing.test.ts` | Integration | Limits parsing with `provider:*` wildcard; per-key daily counters; a model at 90% of its daily limit is ranked last and the user is told why; a rate-limit fallback is reported once with its reason; usage counted per model step, only for successful calls; an exhausted model is still tried when nothing else is left |
| `budget.test.ts` | Unit | Per-item budget; a 10-search change check (50 results) stays under ~6k tokens (was ~75k characters); 40 recalled messages stay within the recall budget; **focused excerpts keep the price/launch sentence** instead of cutting it off |
| `verdict.test.ts` (extra) | Unit | Release relevance: a launch counts only if it names the product and uses launch wording, or comes from the vendor's own domain; partner news, help text and price lines are rejected |
| `research.scenario.test.ts` (extra) | Scenario | A rate-limited main model gives the status "Main model (…) is rate-limited right now; using … instead." |
| `smoke-fallback.mjs` | Live | With a broken first model in the chain: the user is told, the backup answers, usage is counted only for the model that answered, and `/api/status` exposes no keys |

**Result (2026-11-12):** 217/217 automated tests pass (+3 opt-in live). Both live smokes passed. CRM check: 10 items in about 10–18 s (was 21 s).

Found while running live, not by the mocked tests:
1. **Trimming hurt quality.** After cutting each source to its first ~300 characters, 3 CRM prices became "couldn't verify" (was 1). Fix: `focusExcerpt` keeps the sentences that mention the product/plan, prices, dates or launches, and the source budget was raised to 20k characters.
2. **Irrelevant "releases".** The model attached partner news ("…are now Airbyte certified"), help-page text and a price line as "new releases". Fix: a code rule on release relevance; rejected candidates are logged on the server (`[change-check] dropped release candidate`).
3. **Release recall varies between runs**, because news results change. The last run found no qualifying launch since Monday and said so in bounded wording; the server log confirmed nothing was dropped by the filter.
4. **Spurious test timeouts.** Running all test files' in-process Postgres instances at once on a low-memory machine timed out; `maxWorkers: 4`.

## Phase 6 (old plan, kept for reference)

| Test | Layer | Checks |
|---|---|---|
| `router-chain.test.ts` | Unit | Gemini 429 → Groq; Groq 429 → OpenRouter; paid key in chain goes first |
| `usage.test.ts` | Integration | Daily counters increment; a provider at ≥ 90% of its limit is skipped; counters reset per day |
| `token-diet.test.ts` | Unit | Prompt + context stays under the configured token budget for Groq (≈ 8k tokens per minute) |
| `degrade.test.ts` | Scenario | Search quota exhausted → answer from cache or memory with a clear limit message |
| Live smoke | Live | Run with `GEMINI_API_KEY` removed → answer still arrives via Groq |

## Phase 7: polish and submission ✅

| Check | Result |
|---|---|
| `markdown.test.ts` (new) | Answers render bold, lists and [n] links to sources; `<script>`, `<img onerror>` and `javascript:` links are never rendered as HTML |
| Typecheck + all tests | 221/221 pass (+3 opt-in live) |
| `next build` | Production build succeeds (all routes compile) |
| Fresh clone | Only tracked files copied to an empty folder → `npm install` (23 s) → `npm run dev` → page 200, `/api/status` OK, chat without keys gives a clear "no AI model available" error |
| Secret scan of staged files | No API keys; `.env` ignored |

## Phase 7 (old plan, kept for reference)

- A clean-clone check: delete `node_modules`, `.next` and `data`, then `npm install && npm run dev` from the README steps works.
- Full `npm test` plus `npm run typecheck`, and `next build` succeeds.
- Final live smoke on all scenarios; record per-turn latency and call counts in `DESIGN.md`.
- A manual conversation script (10 messages a judge might send), checked by hand for tone, brevity and honesty.

## Judge review loop (2026-11-12) ✅

A live "judge" session (`scratchpad/judge-session.mjs`, real Gemini + Tavily) was run after each fix round: the opener, the three example questions, products named with no stored history, open research, a follow-up, history given inside the chat, and unclear phrasing.

| Found in the judge run | Fix | Test |
|---|---|---|
| No stored history for the day, but the user named the products: refused in 29 ms | Fallback: this chat → other chats about the names → the names alone ("I can't compare with what you saw then"), current prices labelled as such | `challenge.scenario` "real users deviating" (3 cases), `distinctiveKeywords` |
| Change-check answers read like a report ("I checked 10 item(s)…") | One plain first sentence, the baseline stated once, grouped items, "earlier today" for same-day values | `verdict.test.ts` render cases |
| 10-item check took 16–22 s | Up to 3 product batches in parallel, a progress line each, failures isolated per batch: now 11–14 s | `challenge.scenario` (3 batches), `research.scenario` (failed batch) |
| "My take" on a greeting | Prompt: only for recommendations; contradictions with earlier turns must be flagged | live opener |
| Unclear phrasing ("still a good deal?") misrouted | Rules flag `uncertain`; one fast model call classifies only then | `intent.test.ts`, scenario |
| A range ("$7.00 to $9.05") compared as one price: "+29.2%" | Ranges are never compared | `verdict.test.ts` |
| Two third-party sites disagreeing reported as a change | Change needs the same site, or the vendor's own page | `verdict.test.ts` |
| "Zoho Analytics" news counted as a Zoho CRM release | Sibling products of the same vendor are rejected | `verdict.test.ts` |
| The same question asked earlier was treated as history | Earlier copies of the question and "I don't have stored messages" replies are skipped | live |
| Test databases were never deleted (529 folders, 15.8 GB, disk full) | Each test file closes and deletes its database | `tests/setup.ts` |

**Result:** 233/233 automated tests pass (+3 opt-in live). Live, last round: example 2 in 3.2 s, example 3 in 7–8 s, example 1 (10 items) in 11–12 s. Known limit: Pipedrive's pricing page often has no readable price, so it ends as "couldn't confirm"; when the user states a price in the chat and the agent quotes a different one in its reply, the model may take the agent's figure as the baseline.
