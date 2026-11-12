import { resolveTimeRanges, type TimeRange } from "./time";

/**
 * Deterministic turn router: no model call. Decides what the turn needs before any LLM runs.
 *
 * - recall:        "What did I ask you on 3 November?"            → look up past messages
 * - change_check:  "Has pricing changed since last Tuesday?"       → past facts vs current web (phase 5)
 *                  "Is your answer still correct today?"
 * - research:      needs current information from the web (phase 3)
 * - chat:          everything else
 */
export type Intent = "recall" | "change_check" | "research" | "chat";

export interface Route {
  intent: Intent;
  timeRanges: TimeRange[];
  /** The turn needs past messages from memory. */
  wantsRecall: boolean;
  /**
   * Dates to look up in memory. When the message names a past date, "today"/"this week" refer to now
   * ("What did I ask on 3 November? Is it still correct today?"), not to something to recall.
   */
  recallRanges: TimeRange[];
  /** The user asks what was said/asked (e.g. "What did I ask you on 3 November?"). */
  asksWhatWasSaid: boolean;
  /** The rules are not sure (memory words without a clear cue, or recall plus evaluation): ask the model. */
  uncertain: boolean;
}

const RECALL_CUES: RegExp[] = [
  /\bwhat (?:did|have|was it) (?:i|we)\b[^?.!]*\b(?:ask|asked|say|said|discuss|discussed|talk|talked|tell|told|search|searched|look|looked|decide|decided|choose|chose|pick|picked|shortlist|shortlisted)\b/i,
  /\bwhat (?:did|have) you (?:tell|told|say|said|recommend|recommended|answer|answered|suggest|suggested)\b/i,
  /\bremind me\b/i,
  /\b(?:earlier|previous|last|old|past) (?:conversation|chat|question|answer|discussion)s?\b/i,
  /\b(?:we|i) (?:discussed|talked about|looked at|compared|shortlisted|chose|picked|selected|decided on|asked you about|asked about)\b/i,
  /\bi asked you\b/i,
  /\byour (?:answer|recommendation|reply|suggestion)\b/i,
  /\bdid (?:i|we|you)\b[^?.!]*\b(?:ask|discuss|talk|mention|shortlist|choose|pick|decide|recommend|suggest|compare|look at|say)\b/i,
];

const VERIFY_CUES: RegExp[] = [
  /\bstill (?:correct|true|valid|accurate|right|the case|up[- ]to[- ]date|current|good|the best)\b/i,
  /\b(?:has|have|did)\b[^?.!]*\b(?:chang\w*|updat\w*|increas\w*|decreas\w*|dropp\w*|rais\w*|ship\w*|launch\w*|releas\w*)\b/i,
  /\bany (?:change|changes|update|updates|news|difference)\b/i,
  /\bwhat(?:'s| has| is) (?:changed|new)\b/i,
  /\bsince (?:then|last|on|we|i|you|\d|monday|tuesday|wednesday|thursday|friday|saturday|sunday|yesterday|january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
];

const ASKS_WHAT_WAS_SAID =
  /\bwhat (?:did|have) (?:i|we) (?:ask|asked|say|said|tell|told)\b|\bwhat (?:was|were) (?:my|our) (?:question|questions)\b/i;

/** Words that refer to shared history without a clear recall/change cue. */
const MEMORY_HINT =
  /\b(?:we|our|us)\b[^?.!]*\b(?:picked|chose|shortlisted|looked at|talked|discussed|compared|decided|went with)\b|\byou (?:said|told|recommended|suggested)\b|\b(?:earlier|last time|previously|before)\b/i;

/** Evaluation words that turn "what did we pick?" into "is what we picked still good?". */
const EVALUATIVE = /\b(?:good deal|worth|better|best|cheaper|pricier|more expensive|still|now|currently|today)\b/i;

const SEARCH_CUES =
  /\b(?:price|prices|pricing|cost|costs|cheap\w*|expensive|plan|plans|tier|tiers|latest|current|currently|today|now|news|release|released|version|versions|compare|comparison|versus|vs\.?|best|top|alternatives?|reviews?|benchmark|available|availability|weather|stock|who is|who won|when is|when does|how much|changelog|announc\w*)\b/i;

export function routeMessage(message: string, now: Date, timezone: string): Route {
  const timeRanges = resolveTimeRanges(message, now, timezone);
  const recallCue = RECALL_CUES.some((re) => re.test(message));
  const verifyCue = VERIFY_CUES.some((re) => re.test(message));
  // A past date reference alone (not "today") also implies memory, e.g. "the CRMs from Monday".
  // Ranges ending at or before now are fully in the past ("yesterday" ends at today's local midnight).
  const pastReference = timeRanges.some((r) => r.end.getTime() <= now.getTime());

  const asksWhatWasSaid = ASKS_WHAT_WAS_SAID.test(message);
  const past = timeRanges.filter((r) => r.end.getTime() <= now.getTime());
  const recallRanges = past.length > 0 ? past : timeRanges;
  const route = (intent: Intent, wantsRecall: boolean, uncertain = false): Route => ({
    intent,
    timeRanges,
    wantsRecall,
    asksWhatWasSaid,
    recallRanges,
    uncertain,
  });

  if (verifyCue && (recallCue || pastReference || /\bsince\b/i.test(message))) return route("change_check", true);
  // "Are the CRMs we picked still a good deal?": memory plus evaluation → could be a change check.
  if (recallCue) return route("recall", true, EVALUATIVE.test(message) || SEARCH_CUES.test(message));
  if (verifyCue) return route("change_check", true);
  if (SEARCH_CUES.test(message)) return route("research", pastReference, MEMORY_HINT.test(message));
  return route("chat", pastReference, MEMORY_HINT.test(message));
}
