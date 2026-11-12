import { MockLanguageModelV4 } from "ai/test";

/** A mock model that streams the given text chunks, then finishes normally. */
export function textModel(chunks: string[], modelId = "mock-ok"): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId,
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          for (const delta of chunks) controller.enqueue({ type: "text-delta", id: "t1", delta });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: chunks.length, text: chunks.length, reasoning: 0 },
            },
          } as never);
          controller.close();
        },
      }),
    }),
  });
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/**
 * A mock model that follows a script, one entry per model call (step):
 * e.g. [{ searches: ["neon pricing", "supabase pricing"] }, { text: ["Neon costs $19 [1]."] }]
 */
export function scriptedModel(
  steps: ({ searches: string[] } | { text: string[] })[],
  modelId = "mock-scripted",
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId,
    doStream: steps.map((step, i) => ({
      stream: new ReadableStream({
        start(controller) {
          if ("searches" in step) {
            step.searches.forEach((query, j) =>
              controller.enqueue({
                type: "tool-call",
                toolCallId: `call-${i}-${j}`,
                toolName: "web_search",
                input: JSON.stringify({ query }),
              }),
            );
            controller.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage } as never);
          } else {
            controller.enqueue({ type: "text-start", id: `t${i}` });
            for (const delta of step.text) controller.enqueue({ type: "text-delta", id: `t${i}`, delta });
            controller.enqueue({ type: "text-end", id: `t${i}` });
            controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage } as never);
          }
          controller.close();
        },
      }),
    })),
  });
}

/**
 * A mock model that answers structured-output calls (generateText + Output.object).
 * Pass one object per expected call, in order (e.g. plan, then extraction).
 */
export function jsonModel(...objects: unknown[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: "mock-json",
    doGenerate: objects.map(
      (object) =>
        ({
          content: [{ type: "text", text: JSON.stringify(object) }],
          finishReason: { unified: "stop", raw: "stop" },
          usage,
          warnings: [],
        }) as never,
    ),
  });
}

/**
 * A mock model for change checks that answers by looking at the prompt, so parallel batches each get
 * their own items regardless of call order:
 *  - plan prompts ("You plan a change check") → `plan`;
 *  - extraction prompts ("PLANNED ITEMS:") → the entries of `items` whose `item` is listed in that prompt, in that order;
 *  - fact-extraction prompts ("USER MESSAGE:") → `{ facts }`.
 */
export function changeCheckModel(spec: {
  plan: unknown;
  items: { item: string; [k: string]: unknown }[];
  take?: string;
  facts?: unknown[];
  /** Answer for the intent second-opinion call. */
  intent?: string;
}): MockLanguageModelV4 {
  const reply = (object: unknown) =>
    ({
      content: [{ type: "text", text: JSON.stringify(object) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    }) as never;
  return new MockLanguageModelV4({
    modelId: "mock-change-check",
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      if (prompt.includes("You plan a change check")) return reply(spec.plan);
      if (prompt.includes("PLANNED ITEMS:")) {
        const block = prompt.slice(prompt.indexOf("PLANNED ITEMS:"), prompt.indexOf("STORED RECORDS:"));
        const listed = [...block.matchAll(/- (.+?) \((?:price|feature|release|other)\)/g)].map((m) => m[1]);
        const items = listed.map((name) => spec.items.find((i) => i.item === name)).filter(Boolean);
        return reply({ items, take: spec.take ?? "" });
      }
      if (prompt.includes("USER MESSAGE:")) return reply({ facts: spec.facts ?? [] });
      return reply({ intent: spec.intent ?? "chat" });
    },
  });
}

/** A mock model whose request fails before any text (like a 429 or 404 from a provider). */
export function failingModel(message = "429 rate limited", modelId = "mock-fail"): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId,
    doStream: async () => {
      throw new Error(message);
    },
  });
}

/** A mock model that streams some text and then errors mid-answer. */
export function midStreamFailingModel(firstChunk: string, modelId = "mock-mid-fail"): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId,
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: firstChunk });
          controller.enqueue({ type: "error", error: new Error("connection reset") });
          controller.close();
        },
      }),
    }),
  });
}
