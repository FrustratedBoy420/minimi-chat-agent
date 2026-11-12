import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, isStepCount, Output, streamText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { z } from "zod";
import { toWireSchema } from "./schema";
import { config, dailyLimitFor, type ModelRef } from "../config";
import { incrementUsage, llmUsageKey, usageTodayMany } from "../usage";

/**
 * Model router: every model call goes through here.
 * - A "role" (main | fast) maps to an ordered chain of provider:model references from .env.
 * - The first configured model is tried; if it fails BEFORE producing any text
 *   (rate limit, 404, auth error), the next model in the chain is tried immediately
 *   (no backoff wait while another model is available). Search results are cached,
 *   so a retry on the next model costs no extra search credits.
 * - A model that answers 429 / quota exhausted is "cooled down" for the time the provider asks
 *   (Retry-After, default 60 s) and moved to the back of the chain, so the next turns go straight
 *   to a model with quota left. Free-tier quotas are per model, so a second model of the same
 *   provider is a real fallback.
 * - Once text has been streamed to the user, we never switch models mid-answer.
 */

export type Role = "main" | "fast";

export class NoModelAvailableError extends Error {
  constructor(public readonly attempts: { model: string; error: string }[]) {
    super(
      attempts.length === 0
        ? "No model provider is configured. Add GEMINI_API_KEY to .env."
        : `All models failed: ${attempts.map((a) => `${a.model} (${a.error})`).join("; ")}`,
    );
  }
}

function resolveModel(ref: ModelRef): LanguageModel | undefined {
  switch (ref.provider) {
    case "google":
      return config.keys.google ? createGoogleGenerativeAI({ apiKey: config.keys.google })(ref.modelId) : undefined;
    case "groq":
      return config.keys.groq ? createGroq({ apiKey: config.keys.groq })(ref.modelId) : undefined;
    case "openrouter":
      return config.keys.openrouter
        ? createOpenAICompatible({
            name: "openrouter",
            baseURL: "https://openrouter.ai/api/v1",
            apiKey: config.keys.openrouter,
          })(ref.modelId)
        : undefined;
  }
}

// ---------- Rate-limit cool-down ----------

const coolingUntil = new Map<string, number>();

/** Seconds to wait if the error is a rate-limit / quota error, otherwise undefined. */
export function rateLimitSeconds(err: unknown): number | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length > 0) {
    const e = queue.shift();
    if (!e || typeof e !== "object" || seen.has(e)) continue;
    seen.add(e);
    const o = e as {
      statusCode?: number;
      responseHeaders?: Record<string, string>;
      message?: string;
      lastError?: unknown;
      cause?: unknown;
      errors?: unknown[];
    };
    const message = typeof o.message === "string" ? o.message : "";
    if (o.statusCode === 429 || /\b429\b|RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(message)) {
      const retryAfter = Number.parseInt(o.responseHeaders?.["retry-after"] ?? "", 10);
      return Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 600) : 60;
    }
    queue.push(o.lastError, o.cause, ...(Array.isArray(o.errors) ? o.errors : []));
  }
  return undefined;
}

export function coolDown(label: string, seconds: number, nowMs = Date.now()): void {
  coolingUntil.set(label, nowMs + seconds * 1000);
}

export function resetCoolDowns(): void {
  coolingUntil.clear();
}

/** Models that are cooling down go to the back of the list (still tried if nothing else works). */
export function orderByAvailability<T extends { label: string }>(models: T[], nowMs = Date.now()): T[] {
  const cooling = (m: T) => (coolingUntil.get(m.label) ?? 0) > nowMs;
  return [...models.filter((m) => !cooling(m)), ...models.filter(cooling)];
}

/** Share of the daily limit after which a model is moved to the back of the line. */
export const NEAR_LIMIT_RATIO = 0.9;

/**
 * Orders models by availability: usable first, then those near their daily free limit, then cooling down.
 * Nothing is dropped: if everything is exhausted, the app still tries rather than refusing outright.
 */
export async function rankModels<T extends { label: string }>(models: T[]): Promise<{ ordered: T[]; nearLimit: Set<string> }> {
  const counts = await usageTodayMany(models.map((m) => llmUsageKey(m.label)));
  const nearLimit = new Set(
    models
      .filter((m) => {
        const limit = dailyLimitFor(m.label);
        return limit !== undefined && (counts.get(llmUsageKey(m.label)) ?? 0) >= limit * NEAR_LIMIT_RATIO;
      })
      .map((m) => m.label),
  );
  const byCooling = orderByAvailability(models);
  const cooling = new Set(byCooling.filter((m) => (coolingUntil.get(m.label) ?? 0) > Date.now()).map((m) => m.label));
  const ordered = [
    ...byCooling.filter((m) => !cooling.has(m.label) && !nearLimit.has(m.label)),
    ...byCooling.filter((m) => !cooling.has(m.label) && nearLimit.has(m.label)),
    ...byCooling.filter((m) => cooling.has(m.label)),
  ];
  return { ordered, nearLimit };
}

export interface FallbackInfo {
  from: string;
  to: string;
  reason: "rate_limited" | "near_daily_limit" | "error";
}

/** Why a model was skipped or failed, in user-safe terms. */
function fallbackReason(label: string, err: unknown, nearLimit: Set<string>): FallbackInfo["reason"] {
  if (err !== undefined) return rateLimitSeconds(err) !== undefined ? "rate_limited" : "error";
  if (nearLimit.has(label)) return "near_daily_limit";
  return (coolingUntil.get(label) ?? 0) > Date.now() ? "rate_limited" : "error";
}

function recordFailure(label: string, err: unknown): void {
  const seconds = rateLimitSeconds(err);
  if (seconds !== undefined) {
    coolDown(label, seconds);
    console.warn(`[llm] ${label} rate-limited; cooling down ${seconds}s`);
  }
}

/** Configured models for a role, in preference order (models without a key are skipped). */
export function candidates(role: Role): { label: string; model: LanguageModel }[] {
  return config.chains[role].flatMap((ref) => {
    const model = resolveModel(ref);
    return model ? [{ label: `${ref.provider}:${ref.modelId}`, model }] : [];
  });
}

export interface StreamRequest {
  role: Role;
  system: string;
  messages: ModelMessage[];
  /** Tools offered to the model (TERA offers only web_search). */
  tools?: ToolSet;
  /** Force a tool call in the first step (used when the turn needs current information). */
  requireToolFirst?: boolean;
  /** Maximum model steps (each step is one model call). The last step must answer in text. */
  maxSteps?: number;
  abortSignal?: AbortSignal;
}

export interface StreamHandlers {
  onText: (text: string) => void;
  /** Called when the answer comes from a backup model (main one rate-limited, near its limit, or failing). */
  onFallback?: (info: FallbackInfo) => void;
  onToolCall?: (call: { toolName: string; input: unknown }) => void;
  onToolResult?: (result: { toolName: string; output: unknown }) => void;
}

export interface StreamOutcome {
  text: string;
  model: string;
  toolCalls: number;
  steps: number;
}

/** Streams an answer with fallback across the role's model chain. */
export function streamAnswer(req: StreamRequest, handlers: StreamHandlers): Promise<StreamOutcome> {
  return streamWithModels(candidates(req.role), req, handlers);
}

/** Fallback logic over an explicit model list (separated so tests can inject mock models). */
export async function streamWithModels(
  models: { label: string; model: LanguageModel }[],
  req: Omit<StreamRequest, "role">,
  handlers: StreamHandlers,
): Promise<StreamOutcome> {
  const attempts: { model: string; error: string }[] = [];
  // maxSteps = 1 with requireToolFirst is a search-only step: the model issues searches, they run, and we stop.
  const maxSteps = req.tools ? Math.max(1, req.maxSteps ?? 3) : 1;

  const { ordered, nearLimit } = await rankModels(models);
  const preferred = models[0]?.label;
  let lastError: unknown;
  for (const [index, { label, model }] of ordered.entries()) {
    if (index > 0 || (preferred && label !== preferred)) {
      const from = index > 0 ? ordered[index - 1].label : preferred!;
      handlers.onFallback?.({ from, to: label, reason: fallbackReason(from, index > 0 ? lastError : undefined, nearLimit) });
    }
    let text = "";
    let toolCalls = 0;
    let steps = 0;
    let failure: unknown;

    const result = streamText({
      model,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      stopWhen: isStepCount(maxSteps),
      // Step 0: search is required when the turn needs current facts.
      // Last step: no tools, so the model must write an answer instead of searching forever.
      prepareStep: req.tools
        ? ({ stepNumber }) => {
            if (stepNumber === 0 && req.requireToolFirst) return { toolChoice: "required" };
            if (maxSteps > 1 && stepNumber >= maxSteps - 1) return { toolChoice: "none" };
            return { toolChoice: "auto" };
          }
        : undefined,
      abortSignal: req.abortSignal,
      // Fall back immediately while another model is available; only the last one retries with backoff.
      maxRetries: index < ordered.length - 1 ? 0 : 1,
    });

    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        text += part.text;
        handlers.onText(part.text);
      } else if (part.type === "tool-call") {
        toolCalls++;
        handlers.onToolCall?.({ toolName: part.toolName, input: part.input });
      } else if (part.type === "tool-result") {
        handlers.onToolResult?.({ toolName: part.toolName, output: part.output });
      } else if (part.type === "finish-step") {
        steps++;
      } else if (part.type === "error") {
        failure = part.error;
        break;
      }
    }

    if (failure === undefined) {
      for (let i = 0; i < Math.max(1, steps); i++) await incrementUsage(llmUsageKey(label));
      return { text, model: label, toolCalls, steps };
    }
    lastError = failure;
    recordFailure(label, failure);
    if (text.length > 0) {
      // Text already reached the user: do not switch models mid-answer.
      throw new Error(`Model ${label} failed mid-answer: ${describeError(failure)}`);
    }
    attempts.push({ model: label, error: describeError(failure) });
  }

  throw new NoModelAvailableError(attempts);
}

/**
 * Structured output (JSON matching a zod schema) with the same fallback chain.
 * Used where code, not prose, must decide: e.g. extracting before/after values for a change check.
 */
export function generateObject<T>(req: {
  role: Role;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  abortSignal?: AbortSignal;
  onFallback?: (info: FallbackInfo) => void;
}): Promise<{ object: T; model: string }> {
  return generateObjectWithModels(candidates(req.role), req);
}

export async function generateObjectWithModels<T>(
  models: { label: string; model: LanguageModel }[],
  req: {
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    abortSignal?: AbortSignal;
    onFallback?: (info: FallbackInfo) => void;
  },
): Promise<{ object: T; model: string }> {
  const attempts: { model: string; error: string }[] = [];
  // Provider gets a structure-only schema; descriptions become a field guide; output is validated locally.
  const { wire, guide } = toWireSchema(req.schema);
  const system = guide ? `${req.system}

Field guide:
${guide}` : req.system;
  const { ordered, nearLimit } = await rankModels(models);
  const preferred = models[0]?.label;
  let lastError: unknown;
  for (const [index, { label, model }] of ordered.entries()) {
    if (index > 0 || (preferred && label !== preferred)) {
      const from = index > 0 ? ordered[index - 1].label : preferred!;
      req.onFallback?.({ from, to: label, reason: fallbackReason(from, index > 0 ? lastError : undefined, nearLimit) });
    }
    try {
      const result = await generateText({
        model,
        system,
        prompt: req.prompt,
        output: Output.object({ schema: wire }),
        abortSignal: req.abortSignal,
        maxRetries: index < ordered.length - 1 ? 0 : 1,
      });
      await incrementUsage(llmUsageKey(label));
      return { object: result.output as T, model: label };
    } catch (err) {
      if (req.abortSignal?.aborted) throw err;
      lastError = err;
      recordFailure(label, err);
      attempts.push({ model: label, error: describeError(err) });
    }
  }
  throw new NoModelAvailableError(attempts);
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 300);
  return String(err).slice(0, 300);
}
