/**
 * Prompt budgets. Free tiers limit tokens per minute (Groq ≈ 8k tokens/min) and long prompts are slow,
 * so variable-size context (recalled messages, search results) shares a fixed character budget.
 * ~4 characters ≈ 1 token.
 */

/** Characters each of `count` items may use so that all fit in `total` (bounded per item). */
export function perItemBudget(total: number, count: number, min = 300, max = 1500): number {
  if (count <= 0) return max;
  return Math.max(min, Math.min(max, Math.floor(total / count)));
}

export function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export const approxTokens = (text: string) => Math.ceil(text.length / 4);

const FIGURE_HINT = /[$€£₹]\s?\d|\d+(?:\.\d+)?\s?(?:%|usd|eur|per\b|\/\s?(?:mo|month|user|seat|yr|year))|\b(?:20\d\d|launch\w*|releas\w*|introduc\w*|announc\w*|new\b|now available|general availability|ga\b)/i;

/**
 * Keeps the most relevant passages of a long text within `max` characters: sentences that mention the given
 * terms (product/plan names) or contain prices, percentages, dates or launch words score highest; they are
 * kept in their original order. A plain "first N characters" cut tends to drop exactly the price line.
 */
export function focusExcerpt(text: string, terms: string[], max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const sentences = clean.split(/(?<=[.!?;|])\s+|\s+(?=[-•*]\s)/).filter((s) => s.length > 0);
  const lowered = terms.map((t) => t.toLowerCase()).filter((t) => t.length >= 3);
  const scored = sentences.map((s, i) => {
    const l = s.toLowerCase();
    const termHits = lowered.filter((t) => l.includes(t)).length;
    return { i, s, score: termHits * 2 + (FIGURE_HINT.test(s) ? 3 : 0) };
  });
  const picked = new Set<number>();
  let used = 0;
  for (const c of [...scored].sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (c.score === 0 && picked.size > 0) break;
    const len = Math.min(c.s.length, max) + 1;
    if (used + len > max) continue;
    picked.add(c.i);
    used += len;
  }
  if (picked.size === 0) return clip(clean, max);
  return scored
    .filter((c) => picked.has(c.i))
    .map((c) => (c.s.length > max ? clip(c.s, max) : c.s))
    .join(" … ");
}

/** Numbered search results for a prompt, within a total character budget. */
export function formatSourcesForPrompt(
  sources: { n: number; title?: string; url: string; publishedAt?: string | null; content: string }[],
  totalChars: number,
  /** Product/plan names in play: passages mentioning them are kept first. */
  focusTerms: string[] = [],
): string {
  if (sources.length === 0) return "(no results: web search failed or found nothing)";
  const per = perItemBudget(totalChars, sources.length);
  return sources
    .map((s) => {
      const head = `[${s.n}] ${s.title ? `${s.title} ` : ""}(${s.url})${s.publishedAt ? ` published ${s.publishedAt}` : ""}`;
      return `${head}\n${focusExcerpt(s.content, focusTerms, per)}`;
    })
    .join("\n\n");
}
