/**
 * Number check for normal (streamed) answers.
 *
 * After the answer has streamed, every money amount and percentage in it must appear somewhere in what
 * the model was given (search results, remembered records, the conversation). Figures that don't are
 * listed in a visible note, so an invented or miscalculated price is never presented as sourced.
 * Change checks don't need this: their numbers are computed by code.
 */

const FIGURE =
  /(?:[$€£₹]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b|USD\b|EUR\b|GBP\b|INR\b|dollars?\b|euros?\b))/gi;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

/** "1,200.50" → "1200.5", "19.00" → "19". */
export function normalizeNumber(raw: string): string {
  const clean = raw.replace(/,/g, "");
  if (!clean.includes(".")) return clean.replace(/^0+(?=\d)/, "");
  const [whole, frac] = clean.split(".");
  const f = frac.replace(/0+$/, "");
  return `${whole.replace(/^0+(?=\d)/, "") || "0"}${f ? `.${f}` : ""}`;
}

/** Money amounts and percentages mentioned in a text, with their numeric value. */
export function figures(text: string): { raw: string; value: string }[] {
  return [...text.matchAll(FIGURE)].map((m) => {
    const num = m[0].match(/\d[\d,]*(?:\.\d+)?/)![0];
    return { raw: m[0].trim(), value: normalizeNumber(num) };
  });
}

/** Figures in the answer whose number appears nowhere in the given context. */
export function unsupportedFigures(answer: string, context: string[]): string[] {
  const known = new Set<string>();
  for (const text of context) for (const m of text.matchAll(NUMBER)) known.add(normalizeNumber(m[0]));
  const out: string[] = [];
  for (const f of figures(answer)) {
    if (!known.has(f.value) && !out.includes(f.raw)) out.push(f.raw);
  }
  return out;
}

export function unsupportedNote(unsupported: string[]): string {
  return (
    `\n\nNote: ${unsupported.map((u) => `“${u}”`).join(", ")} ${unsupported.length === 1 ? "doesn't" : "don't"} ` +
    "appear in the sources I used (it may be my own calculation), so please double-check before relying on it."
  );
}
