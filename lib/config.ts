/**
 * Reads and validates configuration from environment variables once.
 * Keys are read only on the server; nothing here is exposed to the browser.
 */

export type ProviderName = "google" | "groq" | "openrouter";

export interface ModelRef {
  provider: ProviderName;
  modelId: string;
}

const PROVIDERS: readonly ProviderName[] = ["google", "groq", "openrouter"];

/** Parses "google:model-a,groq:model-b" into ordered model references. */
export function parseChain(raw: string | undefined): ModelRef[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf(":");
      if (idx <= 0 || idx === part.length - 1) {
        throw new Error(`Invalid model reference "${part}". Expected "provider:model-id".`);
      }
      const provider = part.slice(0, idx) as ProviderName;
      if (!PROVIDERS.includes(provider)) {
        throw new Error(`Unknown provider "${provider}" in "${part}". Use one of: ${PROVIDERS.join(", ")}.`);
      }
      return { provider, modelId: part.slice(idx + 1) };
    });
}

/**
 * Free-tier requests per day, per model (or "provider:*"). Reported limits vary and change;
 * these are conservative defaults, overridable with LLM_DAILY_LIMITS="google:model=450,groq:*=900".
 */
const DEFAULT_DAILY_LIMITS =
  "google:gemini-3.5-flash-lite=450,google:gemini-3.1-flash-lite=450,google:gemini-3.6-flash=18,groq:*=900,openrouter:*=45";

export function parseLimits(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of (raw ?? "").split(",")) {
    const eq = part.lastIndexOf("=");
    if (eq <= 0) continue;
    const n = Number.parseInt(part.slice(eq + 1), 10);
    if (Number.isFinite(n) && n > 0) out.set(part.slice(0, eq).trim(), n);
  }
  return out;
}

/** Daily limit for "provider:model": exact entry first, then "provider:*". */
export function dailyLimitFor(label: string, limits = config.llm.dailyLimits): number | undefined {
  return limits.get(label) ?? limits.get(`${label.split(":")[0]}:*`);
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const DEFAULT_CHAIN = [
  "google:gemini-3.5-flash-lite",
  "google:gemini-3.1-flash-lite",
  "google:gemini-3.6-flash",
  "groq:openai/gpt-oss-120b",
  "openrouter:openrouter/free",
].join(",");

export const config = {
  keys: {
    google: process.env.GEMINI_API_KEY || undefined,
    groq: process.env.GROQ_API_KEY || undefined,
    openrouter: process.env.OPENROUTER_API_KEY || undefined,
    tavily: process.env.TAVILY_API_KEY || undefined,
  },
  chains: {
    // Free-tier quotas are per model, so several models are real fallbacks. Models without a key are skipped.
    main: parseChain(process.env.LLM_MAIN_CHAIN || DEFAULT_CHAIN),
    fast: parseChain(process.env.LLM_FAST_CHAIN || DEFAULT_CHAIN),
  },
  llm: {
    dailyLimits: parseLimits(process.env.LLM_DAILY_LIMITS || DEFAULT_DAILY_LIMITS),
  },
  /**
   * Prompt size budgets (characters; ~4 characters per token). Free tiers limit tokens per minute
   * (Groq: ~8k tokens/min), and smaller prompts are also faster.
   */
  prompt: {
    recallChars: positiveInt(process.env.PROMPT_RECALL_CHARS, 9_000),
    sourceChars: positiveInt(process.env.PROMPT_SOURCE_CHARS, 20_000),
    toolResultChars: positiveInt(process.env.PROMPT_TOOL_RESULT_CHARS, 1_000),
  },
  search: {
    maxPerTurn: positiveInt(process.env.SEARCH_MAX_PER_TURN, 5),
    /** Change checks search once per product (e.g. 5 CRMs x price + releases). */
    maxPerChangeCheck: positiveInt(process.env.SEARCH_MAX_PER_CHANGE_CHECK, 10),
    maxPerDay: positiveInt(process.env.SEARCH_MAX_PER_DAY, 40),
  },
  dataDir: process.env.DATA_DIR || "./data",
  /** Number of recent messages sent to the model as conversation context. */
  recentWindow: 12,
};
