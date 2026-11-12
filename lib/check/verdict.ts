import { DateTime } from "luxon";
import { z } from "zod";
import { isOfficialUrl, type CitedSource } from "../search/session";

/**
 * Change check: "Has anything changed since we discussed it?"
 *
 * The model is NOT allowed to decide whether something changed. It only extracts, for each item,
 * the earlier value (with a verbatim quote from our stored messages) and the current value
 * (with a verbatim quote from a numbered search result). Code then:
 *   1. verifies both quotes really appear in their source (otherwise that side is dropped),
 *   2. checks the values are comparable (same currency, billing period, unit),
 *   3. decides the state and computes the difference with exact decimal math,
 *   4. writes the answer with fixed, honest wording.
 * So "nothing changed" can never be produced from a failed search, a hallucinated value or a blog guess.
 */

// ---------- Extraction schema (what the model returns) ----------

const Value = z.object({
  text: z.string().describe("The value as written, e.g. '$19/month per user'"),
  amount: z.string().nullable().describe("Numeric amount only, e.g. '19' or '19.50'; null if not a number"),
  currency: z.string().nullable().describe("Currency code or symbol, e.g. 'USD' or '$'; null if none"),
  period: z.enum(["month", "year", "one_time", "usage", "none"]).nullable().describe("Billing period if stated"),
  unit: z.string().nullable().describe("e.g. 'per user', 'per organization'; null if not stated"),
  quote: z.string().describe("Exact words copied from the record or source that contain this value"),
});

export const VerdictSchema = z.object({
  items: z
    .array(
      z.object({
        item: z.string().describe("What is compared, e.g. 'Neon Launch plan price'"),
        product: z.string().describe("Product or vendor name, e.g. 'Neon'"),
        // Plain string (not nullable): Gemini rejects structured-output schemas past a complexity limit.
        plan: z.string().describe("Plan or tier, e.g. 'Launch'; empty string if not plan-specific"),
        kind: z.enum(["price", "feature", "release", "other"]),
        before: Value.nullable().describe("From STORED FACTS (preferred) or the stored earlier messages; null if not there"),
        now: Value.extend({ source: z.number().int().describe("Number n of the search result quoted") })
          .nullable()
          .describe("From the numbered search results; null if no result states it"),
      }),
    )
    .max(12),
  take: z
    .string()
    .describe("One or two sentences of practical advice only. Do not summarize what changed or stayed the same; the app shows that."),
});
export type Verdict = z.infer<typeof VerdictSchema>;
type VerdictItem = Verdict["items"][number];
type ExtractedValue = z.infer<typeof Value>;

// ---------- Deterministic evaluation ----------

export type ItemState =
  | "changed"
  | "same"
  | "not_comparable"
  | "new_release"
  | "older_release"
  | "release_date_unknown"
  | "no_release_found"
  | "current_only"
  | "couldnt_verify";

export interface RecordMessage {
  /** "web" = a fact captured earlier from a web page (the most reliable baseline). */
  role: "user" | "assistant" | "web";
  content: string;
  created_at: Date | string;
  /** For web facts: the source's domain. */
  source?: string;
}

export interface EvaluatedItem {
  item: string;
  kind: VerdictItem["kind"];
  state: ItemState;
  before?: { text: string; at: Date; role: "user" | "assistant" | "web"; source?: string; official?: boolean };
  now?: { text: string; source: CitedSource; official: boolean };
  delta?: { absolute: string; percent: string | null; currency: string | null };
  reason?: string;
  /** Internal: a candidate the code rejected (logged on the server, not shown to the user). */
  dropped?: string;
}

export interface EvaluationContext {
  records: RecordMessage[];
  sources: CitedSource[];
  searchFailed: boolean;
  /** Releases published after this instant count as new. */
  cutoff: Date;
}

export function evaluateItems(items: VerdictItem[], ctx: EvaluationContext): EvaluatedItem[] {
  return items.map((it) => {
    const record = it.before ? ctx.records.find((r) => containsQuote(r.content, it.before!.quote)) : undefined;
    const source = it.now ? ctx.sources.find((s) => s.n === it.now!.source) : undefined;
    const nowVerified = !!(it.now && source && containsQuote(source.content, it.now.quote));

    const out: EvaluatedItem = { item: it.item, kind: it.kind, state: "couldnt_verify" };
    if (it.before && record) {
      out.before = {
        text: it.before.text,
        at: new Date(record.created_at),
        role: record.role,
        source: record.source,
        official: record.source ? isOfficialUrl(`https://${record.source}`, `${it.product ?? ""} ${it.item}`) : undefined,
      };
    }
    if (it.now && source && nowVerified) {
      out.now = { text: it.now.text, source, official: isOfficialUrl(source.url, `${it.product ?? ""} ${it.item}`) };
    }

    if (!out.now && it.kind === "release" && !ctx.searchFailed && ctx.sources.length > 0) {
      // Searched successfully, but no source showed a release: bounded wording, never "nothing shipped".
      out.state = "no_release_found";
      return out;
    }
    if (!out.now) {
      out.reason = ctx.searchFailed
        ? "web search was unavailable"
        : it.now
          ? "the value could not be confirmed in the cited source"
          : "no current source stated it";
      return out;
    }

    if (it.kind === "release") {
      if (!isRelevantRelease(it.product, it.now!.quote, source!.title, source!.url)) {
        // The model attached text that is not a launch of THIS product (help pages, partner news, prices).
        out.dropped = `“${it.now!.quote}” from ${source!.url} is not a launch of ${it.product}`;
        out.now = undefined;
        out.state = ctx.searchFailed ? "couldnt_verify" : "no_release_found";
        if (ctx.searchFailed) out.reason = "web search was unavailable";
        return out;
      }
      const published = source!.publishedAt ? new Date(source!.publishedAt) : undefined;
      if (!published || Number.isNaN(published.getTime())) {
        out.state = "release_date_unknown";
        out.reason = "the source gives no publication date";
      } else {
        out.state = published > ctx.cutoff ? "new_release" : "older_release";
      }
      return out;
    }

    if (!out.before) {
      out.state = "current_only";
      out.reason = it.before ? "the earlier value could not be found in our stored messages" : "no earlier value was recorded";
      return out;
    }

    const cmp = compareValues(it.before!, it.now!);
    out.state = cmp.state;
    out.delta = cmp.delta;
    out.reason = cmp.reason;
    // Two different sites disagreeing is not a price change. Found live: a Jira price from one community post
    // "changed" to the figure on another blog. A change needs the same site, or the vendor's own page on one side.
    const nowHost = hostname(out.now.source.url);
    if (
      cmp.state === "changed" &&
      out.before.role === "web" &&
      out.before.source !== nowHost &&
      (out.before.official === false || !out.now.official)
    ) {
      out.state = "not_comparable";
      out.delta = undefined;
      out.reason = `the earlier figure came from ${out.before.source} and the current one from ${nowHost}, so the difference may not be a real change`;
    }
    return out;
  });
}

/** Compares two extracted values. Numbers: exact decimal math; text: normalized equality. */
export function compareValues(
  before: ExtractedValue,
  now: ExtractedValue,
): { state: "changed" | "same" | "not_comparable"; delta?: EvaluatedItem["delta"]; reason?: string } {
  if (RANGE.test(before.text) || RANGE.test(now.text)) {
    return {
      state: "not_comparable",
      reason: RANGE.test(before.text) ? "it was a price range then, not one price" : "the current source gives a price range, not one price",
    };
  }
  const a = parseAmount(before.amount);
  const b = parseAmount(now.amount);

  if (a !== undefined && b !== undefined) {
    const mismatches: string[] = [];
    const curA = normCurrency(before.currency);
    const curB = normCurrency(now.currency);
    if (!curA || !curB) mismatches.push("currency not stated on both sides");
    else if (curA !== curB) mismatches.push(`currency ${curA} vs ${curB}`);
    if (!before.period || !now.period) mismatches.push("billing period not stated on both sides");
    else if (before.period !== now.period) mismatches.push(`billing period ${before.period} vs ${now.period}`);
    const unitA = normUnit(before.unit);
    const unitB = normUnit(now.unit);
    if (unitA && unitB && unitA !== unitB) mismatches.push(`unit ${unitA} vs ${unitB}`);
    if (mismatches.length > 0) return { state: "not_comparable", reason: mismatches.join("; ") };

    if (a.scaled === b.scaled) return { state: "same" };
    const diff = b.scaled - a.scaled;
    return {
      state: "changed",
      delta: {
        absolute: formatScaled(diff, true),
        percent: a.scaled === 0n ? null : formatPercent(diff, a.scaled),
        currency: curA ?? null,
      },
    };
  }

  if ((a === undefined) !== (b === undefined)) {
    return {
      state: "not_comparable",
      reason:
        a !== undefined
          ? "it was a fixed amount then; the current source gives no fixed amount"
          : "it had no fixed amount then; the current source gives one",
    };
  }
  return normText(before.text) === normText(now.text) ? { state: "same" } : { state: "changed" };
}

/** "$7.00 to $9.05", "$5–$17.50", "10-20 USD": a range, not one price. */
const RANGE = /\d\s*(?:to|-|–|—)\s*(?:US)?[$€£₹]?\s*\d/i;

// ---------- Rendering (fixed, honest wording; written by code, never by the model) ----------

const BLANKET_NO_CHANGE =
  /\b(?:has(?: not|n't)|have(?: not|n't)|did(?: not|n't)) changed\b|\bno (?:price |pricing )?changes?\b|\bnothing (?:has )?changed\b|\bunchanged\b|\b(?:remain(?:s|ed)?|stay(?:s|ed)?) (?:the same|consistent|stable|steady|flat)\b|\bstill the same\b|\b(?:remains?|is still|are still|still) (?:correct|accurate|valid|true|current|up[- ]to[- ]date)\b|\bstill holds?\b|\bcontinues? (?:at|to cost)\b/i;

export interface RenderOptions {
  timezone: string;
  now: Date;
  /** Shown first, e.g. "I don't have any stored messages from Sunday, 8 November 2026, so…". */
  preface?: string;
}

/**
 * Answer layout:
 *   1. one plain-English sentence with the answer (what changed, what is new, what could not be confirmed);
 *   2. where the earlier values come from, stated once ("Compared with what I told you on Tue 10 Nov.");
 *   3. short groups: Changed · New since then · Not directly comparable · Couldn't confirm · Same in the sources I checked
 *      · Current only · No new release found (one line);
 *   4. "My take" advice, dropped if it slips into a blanket "nothing changed" claim.
 */
export function renderVerdict(evaluated: EvaluatedItem[], take: string, opts: RenderOptions): string {
  const preface = opts.preface ? `${opts.preface}\n\n` : "";
  if (evaluated.length === 0) {
    return (
      preface +
      "I couldn't find specific products, prices or features to compare. Tell me which products and plans to check and I'll look them up."
    );
  }

  const today = DateTime.fromJSDate(opts.now, { zone: opts.timezone }).toISODate();
  const day = (d: Date) => DateTime.fromJSDate(d, { zone: opts.timezone }).toFormat("ccc d LLL");
  // "on Tue 10 Nov", or "earlier today" when the earlier value is from today.
  const when = (d: Date) => (DateTime.fromJSDate(d, { zone: opts.timezone }).toISODate() === today ? "earlier today" : `on ${day(d)}`);
  const by = (...states: ItemState[]) => evaluated.filter((e) => states.includes(e.state));
  const changed = by("changed");
  const fresh = by("new_release");
  const same = by("same");
  const notComparable = by("not_comparable");
  const unconfirmed = by("couldnt_verify", "release_date_unknown");
  const currentOnly = by("current_only");
  const noRelease = by("no_release_found", "older_release");

  // Where the "before" values come from: say it once if they share one origin and day.
  const origins = new Set(evaluated.filter((e) => e.before).map((e) => originLabel(e, when)));
  const sharedOrigin = origins.size === 1 ? [...origins][0] : undefined;
  const sinceWhen = sharedOrigin ? when(evaluated.find((e) => e.before)!.before!.at) : undefined;
  const since = sinceWhen === undefined ? "then" : sinceWhen === "earlier today" ? "earlier today" : sinceWhen.replace(/^on /, "");

  // 1. The answer in one or two sentences.
  const headline: string[] = [];
  if (changed.length > 0) {
    headline.push(`Yes: ${names(changed)} ${changed.length === 1 ? "has" : "have"} changed since ${since}.`);
  } else if (fresh.length > 0) {
    headline.push(`Yes: ${names(fresh)} shipped something new since ${since}: ${fresh.map((e) => e.now!.text).join("; ")}.`);
    if (same.length > 0) headline.push("I found no confirmed price changes in the sources I checked.");
  } else if (same.length + noRelease.length > 0) {
    headline.push(`I found no confirmed changes since ${since} in the sources I checked.`);
  } else if (currentOnly.length > 0) {
    headline.push("Here is what current sources say.");
  } else {
    headline.push(`I couldn't confirm the current details, so I can't say whether anything changed since ${since}.`);
  }
  if (fresh.length > 0 && changed.length > 0) headline.push(`New since then: ${fresh.map((e) => releaseName(e)).join("; ")}.`);
  if (notComparable.length > 0) {
    headline.push(`${names(notComparable)} ${notComparable.length === 1 ? "is" : "are"} priced differently now, so I couldn't compare directly.`);
  }
  if (unconfirmed.length > 0 && (changed.length > 0 || same.length > 0 || fresh.length > 0)) {
    headline.push(`I couldn't confirm ${names(unconfirmed)}.`);
  }

  const lines: string[] = [preface + headline.join(" ")];
  if (sharedOrigin) lines.push("", `Compared with ${sharedOrigin}.`);

  // 2. Groups.
  const group = (title: string, items: EvaluatedItem[], render: (e: EvaluatedItem) => string) => {
    if (items.length === 0) return;
    lines.push("", `**${title}**`);
    for (const e of items) lines.push(`- ${render(e)}`);
  };
  const then = (e: EvaluatedItem) => (e.before ? `${tidy(e.before.text)}${sharedOrigin ? "" : ` (${originLabel(e, when)})`}` : "");
  const nowText = (e: EvaluatedItem) => tidy(e.now!.text);

  group("Changed", changed, (e) => `**${short(e)}**: ${then(e)} → ${nowText(e)}${deltaText(e)} ${cite(e)}`);
  group("New since then", fresh, (e) => `**${short(e)}**: ${nowText(e)} ${cite(e)}, published ${day(new Date(e.now!.source.publishedAt!))}`);
  group("Not directly comparable", notComparable, (e) => `**${short(e)}**: was ${then(e)}; now ${nowText(e)} ${cite(e)}. ${capitalize(plainReason(e.reason))}.`);
  group("Couldn't confirm", unconfirmed, (e) =>
    e.state === "release_date_unknown"
      ? `**${short(e)}**: found "${nowText(e)}" ${cite(e)}, but the source has no date, so I can't tell if it's new`
      : `**${short(e)}**: ${plainReason(e.reason)}${e.before ? `; earlier: ${then(e)}` : ""}`,
  );
  group("Same in the sources I checked", same, (e) => `**${short(e)}**: ${nowText(e)} ${cite(e)}`);
  group(currentOnlyTitle(evaluated), currentOnly, (e) => `**${short(e)}**: ${nowText(e)} ${cite(e)}`);
  if (noRelease.length > 0) lines.push("", `No new release found in the sources I checked for ${names(noRelease.map((e) => ({ ...e, item: productOf(e) })))}.`);

  const safeTake = take.trim();
  if (safeTake && !BLANKET_NO_CHANGE.test(safeTake)) lines.push("", `My take: ${safeTake}`);
  return lines.join("\n").replace(/ +\n/g, "\n").trim();
}

function originLabel(e: EvaluatedItem, when: (d: Date) => string): string {
  const b = e.before!;
  if (b.role === "web") return `what ${b.source}${b.official === false ? " (third-party)" : ""} showed ${when(b.at)}`;
  return `${b.role === "assistant" ? "what I told you" : "what you told me"} ${when(b.at)}`;
}

/** Every item current-only → a plain heading; mixed with comparisons → say why these have no comparison. */
function currentOnlyTitle(evaluated: EvaluatedItem[]): string {
  return evaluated.every((e) => e.state === "current_only" || !e.before) ? "Current prices" : "Current only (no earlier value to compare)";
}

/** Source text glitches: "Plus$10" → "Plus $10", collapsed whitespace. */
function tidy(t: string): string {
  return t.replace(/([A-Za-z])([$€£₹])/g, "$1 $2").replace(/\s+/g, " ").trim();
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function cite(e: EvaluatedItem): string {
  return e.now ? `[${e.now.source.n}]${e.now.official ? "" : " (third-party source)"}` : "";
}

function deltaText(e: EvaluatedItem): string {
  if (!e.delta) return "";
  const sign = e.delta.absolute.startsWith("-") ? "-" : "+";
  const amount = e.delta.absolute.replace(/^[+-]/, "");
  const money = e.delta.currency === "USD" ? `${sign}$${amount}` : `${sign}${amount}${e.delta.currency ? ` ${e.delta.currency}` : ""}`;
  return ` (${money}${e.delta.percent ? `, ${e.delta.percent}` : ""})`;
}

/** "Neon Launch plan price" → "Neon Launch"; keeps names short in lists. */
function short(e: EvaluatedItem): string {
  return e.item.replace(/\s+(?:plan\s+)?(?:price|pricing|prices)$/i, "").replace(/\s+releases?$/i, "").trim() || e.item;
}

function productOf(e: EvaluatedItem): string {
  return short(e);
}

function releaseName(e: EvaluatedItem): string {
  return `${short(e)}: ${e.now!.text}`;
}

function names(items: { item: string }[]): string {
  const list = [...new Set(items.map((e) => short(e as EvaluatedItem)))];
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/** Internal reasons → plain words. */
function plainReason(reason: string | undefined): string {
  if (!reason) return "not confirmed";
  return reason
    .replace("the value could not be confirmed in the cited source", "the source didn't confirm the value")
    .replace(/billing period (\w+) vs (\w+)/, (_m, a, b) => `billed per ${a} then, per ${b} now`)
    .replace(/billing period not stated on both sides/, "the billing period isn't stated on both sides")
    .replace(/currency (\w+) vs (\w+)/, "different currency ($1 then, $2 now)")
    .replace(/unit (\w+) vs (\w+)/, "priced per $1 then, per $2 now");
}

// ---------- Helpers ----------

const LAUNCH_WORDS =
  /\b(?:launch(?:es|ed|ing)?|introduc(?:es|ed|ing)|releas(?:es|ed)|announc(?:es|ed)|unveil(?:s|ed)|debut(?:s|ed)?|roll(?:s|ed)? out|rolling out|now available|generally available|\bGA\b|ships?|shipped|adds?|added|new features?|beta)\b/i;

/**
 * A release counts only if the quote or source title names the product, AND it either uses launch wording
 * or comes from the vendor's own domain (a dated page there is typically a changelog/release note).
 * Found live: the model attached partner news, help-page text and price lines to "release" items.
 */
export function isRelevantRelease(product: string, quote: string, title: string, url = ""): boolean {
  const words = product
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !["crm", "the", "app", "cloud", "suite", "sales", "hub", "plan"].includes(w));
  const haystack = `${title} ${quote}`.toLowerCase();
  const namesProduct = words.length === 0 || words.some((w) => haystack.includes(w));
  const officialSource = url !== "" && isOfficialUrl(url, product);
  if (namesSiblingProduct(product, `${title} ${quote}`)) return false;
  return (namesProduct || officialSource) && (LAUNCH_WORDS.test(`${title} ${quote}`) || officialSource);
}

/**
 * "Zoho Analytics …" when checking "Zoho CRM": the vendor name followed by a different product name, and the
 * product's own name (e.g. "CRM") nowhere in the text. Found live: Zoho Analytics news offered as a Zoho CRM release.
 */
function namesSiblingProduct(product: string, text: string): boolean {
  const parts = product.trim().split(/\s+/);
  if (parts.length < 2) return false;
  const [vendor, ...line] = parts;
  const lower = text.toLowerCase();
  if (line.some((w) => w.length >= 2 && lower.includes(w.toLowerCase()))) return false;
  const escaped = vendor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const next = new RegExp(`\\b${escaped}\\s+([A-Z][A-Za-z0-9]+)`).exec(text)?.[1];
  return next !== undefined && !LAUNCH_WORDS.test(next) && !/^(?:AI|Inc|Corp|Ltd|Is|Has|Now|Today|Will|And)$/i.test(next);
}

/** Quote check: the quoted words must appear in the text (case, whitespace and markdown insensitive). */
export function containsQuote(text: string, quote: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
  const q = norm(quote);
  if (q.length < 3) return false;
  if (norm(text).includes(q)) return true;
  // Tolerate punctuation/spacing differences ("$90 /seat/mo" vs "$90/seat/mo"); letters, digits,
  // decimal points and currency symbols must still match exactly and in order.
  const strict = (s: string) => s.toLowerCase().replace(/[^a-z0-9.$€£₹]/g, "");
  const qs = strict(quote);
  return qs.length >= 6 && strict(text).includes(qs);
}

const SCALE = 10_000n; // 4 decimal places: exact for money

function parseAmount(raw: string | null): { scaled: bigint } | undefined {
  if (!raw) return undefined;
  const clean = raw.replace(/[,\s]/g, "");
  const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec(clean);
  if (!m) return undefined;
  return { scaled: BigInt(m[1]) * SCALE + BigInt((m[2] ?? "").padEnd(4, "0")) };
}

function formatScaled(v: bigint, signed: boolean): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(4, "0").replace(/0+$/, "");
  const body = frac ? `${whole}.${frac.padEnd(2, "0")}` : `${whole}`;
  return `${neg ? "-" : signed ? "+" : ""}${body}`;
}

function formatPercent(diff: bigint, base: bigint): string {
  const tenths = (diff * 1000n) / base; // percent with one decimal, truncated toward zero
  const neg = tenths < 0n;
  const abs = neg ? -tenths : tenths;
  return `${neg ? "-" : "+"}${abs / 10n}.${abs % 10n}%`;
}

const CURRENCY: Record<string, string> = { $: "USD", "us$": "USD", "€": "EUR", "£": "GBP", "₹": "INR", "¥": "JPY", "a$": "AUD", "c$": "CAD" };

function normCurrency(c: string | null): string | undefined {
  if (!c) return undefined;
  const t = c.trim().toLowerCase();
  return CURRENCY[t] ?? (/^[a-z]{3}$/.test(t) ? t.toUpperCase() : undefined);
}

/**
 * Billing unit, by meaning rather than wording: "per user", "per seat", "per granted seat", "user/month" → user.
 * "per project" is deliberately NOT treated as organization: they are priced differently.
 */
function normUnit(u: string | null): string | undefined {
  if (!u) return undefined;
  const t = u.toLowerCase();
  if (/\b(?:users?|seats?|members?|editors?|licen[cs]es?|agents?)\b/.test(t)) return "user";
  if (/\b(?:organi[sz]ations?|orgs?|workspaces?|teams?|accounts?)\b/.test(t)) return "organization";
  const rest = t.replace(/\bper\b/g, "").replace(/\b(?:month|monthly|year|yearly|annually)\b/g, "").replace(/\s+/g, " ").trim();
  return rest.replace(/s$/, "") || undefined;
}

function normText(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
