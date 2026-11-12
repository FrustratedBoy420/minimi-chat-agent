import { DateTime } from "luxon";
import { config } from "./config";
import { clip, perItemBudget } from "./llm/budget";
import {
  getMessagesInRanges,
  getRecentMessages,
  getRecentMessageTimes,
  searchMessages,
  type MessageRow,
  type RecalledMessage,
} from "./db/queries";
import type { TimeRange } from "./time";
import { localDayKey, timestampLabel } from "./time";

/**
 * Recall: find past messages for a turn, deterministically (SQL), before any model call.
 * - With dates in the message: every message inside those local-day ranges.
 * - Without dates: full-text search on the message's keywords.
 */

const MAX_MESSAGES = 40;

export interface RecallResult {
  /** dates/keywords: stored history; conversation: this chat; message: only the user's own message. */
  mode: "dates" | "keywords" | "conversation" | "message";
  ranges: TimeRange[];
  terms: string[];
  messages: RecalledMessage[];
}

export async function recall(
  message: string,
  ranges: TimeRange[],
  excludeIds: string[],
): Promise<RecallResult> {
  if (ranges.length > 0) {
    const messages = await getMessagesInRanges(ranges, excludeIds, MAX_MESSAGES);
    return { mode: "dates", ranges, terms: [], messages };
  }
  const terms = keywords(message);
  const messages = await searchMessages(terms, excludeIds, 20);
  return { mode: "keywords", ranges, terms, messages };
}

/** Context block given to the model. Messages are labeled with local time, role and conversation. */
export function formatRecallContext(result: RecallResult, timezone: string): string {
  const header =
    result.mode === "dates"
      ? `Stored messages from ${result.ranges.map((r) => r.label).join(" and ")} (times in ${timezone}):`
      : result.mode === "conversation"
        ? `Earlier messages in this conversation (times in ${timezone}):`
        : result.mode === "message"
          ? "No earlier records. The user's own message:"
          : `Stored past messages matching "${result.terms.join(", ")}" (times in ${timezone}):`;

  const lines: string[] = [header];
  // Many messages → shorter excerpts, so the whole block stays within the prompt budget.
  const perMessage = perItemBudget(config.prompt.recallChars, result.messages.length, 200, 1500);
  let currentConversation: string | undefined;
  for (const m of result.messages) {
    if (m.conversation_id !== currentConversation) {
      currentConversation = m.conversation_id;
      lines.push(`\n[Conversation: ${m.conversation_title ?? "Untitled"}]`);
    }
    const text = m.content.length > perMessage ? `${clip(m.content, perMessage)} [truncated]` : m.content;
    lines.push(`- ${timestampLabel(new Date(m.created_at), timezone)}, ${m.role === "user" ? "the user wrote" : "you (the assistant) replied"}: ${text}`);
  }
  return lines.join("\n");
}

/** Answer used when nothing was found: honest, no model call, with a way forward. */
export async function noHistoryAnswer(
  result: RecallResult,
  timezone: string,
  excludeIds: string[],
  intent: "recall" | "change_check",
): Promise<string> {
  const what =
    result.mode === "dates"
      ? `from ${result.ranges.map((r) => r.label).join(" or ")}`
      : result.terms.length > 0
        ? `about "${result.terms.join(" ")}"`
        : "matching that";

  const days = await daysWithHistory(timezone, excludeIds);
  const parts = [`I don't have any stored messages ${what}.`];
  if (days.length > 0) {
    parts.push(`I do have conversations on: ${days.map((d) => `${d.label} (${d.count} messages)`).join(", ")}.`);
  } else {
    parts.push("I don't have any earlier conversations stored yet.");
  }
  parts.push(
    intent === "change_check"
      ? "If you tell me what we looked at (for example, the product names), I can check them now."
      : "If you tell me roughly what it was about, I can search for it.",
  );
  return parts.join(" ");
}

async function daysWithHistory(timezone: string, excludeIds: string[]) {
  const times = await getRecentMessageTimes(excludeIds);
  const counts = new Map<string, number>();
  for (const t of times) {
    const key = localDayKey(t, timezone);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 5)
    .map(([day, count]) => ({
      label: DateTime.fromISO(day, { zone: timezone }).toFormat("ccc d LLL"),
      count,
    }));
}

/**
 * When a change check names a day with no stored messages ("On Sunday we shortlisted Notion, Asana and Trello…"),
 * don't stop at "no record". In order:
 *   1. this conversation (the user may have given the history earlier in this chat),
 *   2. other conversations mentioning the same distinctive names,
 *   3. the user's own message (products named there are checked against current sources).
 * The preface tells the user which one was used.
 */
export async function recallFallback(o: {
  message: MessageRow;
  conversationId: string;
  ranges: TimeRange[];
  conversationTitle: string | null;
}): Promise<{ result: RecallResult; preface: string } | undefined> {
  const what = o.ranges.length > 0 ? `from ${o.ranges.map((r) => r.label).join(" or ")}` : "about that";
  const exclude = [o.message.id];

  const thisChat = (await getRecentMessages(o.conversationId, 30)).filter((m) => !exclude.includes(m.id));
  if (thisChat.length > 0) {
    return {
      result: {
        mode: "conversation",
        ranges: o.ranges,
        terms: [],
        messages: thisChat.map((m) => ({ ...m, conversation_title: o.conversationTitle ?? "this conversation" })),
      },
      preface: `I don't have stored messages ${what}, so I'm using what you told me earlier in this conversation.`,
    };
  }

  const terms = distinctiveKeywords(o.message.content);
  if (terms.length > 0) {
    // Earlier copies of this same question, and earlier "I don't have stored messages…" answers, are not history.
    const asked = normalizeQuestion(o.message.content);
    const hits = (await searchMessages(terms, exclude, 20)).filter(
      (m) => !(m.role === "user" && normalizeQuestion(m.content) === asked) && !(m.role === "assistant" && /^I don't have (?:any )?stored messages/.test(m.content)),
    );
    if (hits.length > 0) {
      return {
        result: { mode: "keywords", ranges: o.ranges, terms, messages: hits },
        preface: `I don't have stored messages ${what}, but I found earlier messages about ${listNames(displayTerms(terms, o.message.content))}.`,
      };
    }
    return {
      result: { mode: "message", ranges: o.ranges, terms, messages: [{ ...o.message, conversation_title: o.conversationTitle }] },
      preface: `I don't have stored messages ${what}, so I can't compare with what you saw then.`,
    };
  }
  return undefined;
}

function normalizeQuestion(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Lower-cased search terms → the user's own spelling ("notion" → "Notion"). */
function displayTerms(terms: string[], message: string): string[] {
  return terms.map((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").exec(message)?.[0] ?? t);
}

function listNames(list: string[]): string {
  return list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/** Words generic to the question itself (not product names) never drive a fallback search. */
const GENERIC = new Set(
  (
    "price prices pricing priced cost costs plan plans tier tiers changed change changes update updates shipped ship " +
    "something anything big new release releases launch launched since shortlisted shortlist tools tool team teams " +
    "person people sales crm crms company companies hosting options option compare compared better best cheaper " +
    "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august " +
    "september october november december week weeks month months year years ago yesterday today still correct " +
    "answer chose picked selected looked discussed project projects management software app apps platform " +
    "platforms service services product products vendor vendors subscription subscriptions free paid"
  ).split(" "),
);

/** Distinctive keywords (likely product names): no stopwords, no generic words, no bare numbers. */
export function distinctiveKeywords(message: string): string[] {
  return keywords(message).filter((t) => !GENERIC.has(t) && !/^\d+$/.test(t));
}

const STOPWORDS = new Set(
  (
    "a about above after again all am an and any are as at be been before being below between both but by can could " +
    "did do does doing down during each few for from further had has have having he her here hers him his how i if in " +
    "into is it its itself just me more most my no nor not now of off on once only or other our ours out over own same " +
    "she should so some such than that the their them then there these they this those through to too under until up " +
    "very was we were what when where which while who whom why will with would you your yours ask asked tell told say " +
    "said talk talked discuss discussed remember remind earlier previous last chat conversation question answer us " +
    "please thanks thank hey hi hello"
  ).split(" "),
);

/** Up to 8 searchable keywords: lowercase alphanumeric tokens, no stopwords. Safe for to_tsquery. */
export function keywords(message: string): string[] {
  const tokens = message
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return [...new Set(tokens)].slice(0, 8);
}
