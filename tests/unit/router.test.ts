import { beforeEach, describe, expect, it } from "vitest";
import {
  coolDown,
  NoModelAvailableError,
  orderByAvailability,
  rateLimitSeconds,
  resetCoolDowns,
  streamWithModels,
} from "../../lib/llm/router";
import { failingModel, midStreamFailingModel, textModel } from "../helpers/mock-model";

const req = { system: "test", messages: [{ role: "user" as const, content: "hi" }] };

beforeEach(() => {
  resetCoolDowns();
});

describe("model router fallback", () => {
  it("streams text from the first working model", async () => {
    const chunks: string[] = [];
    const result = await streamWithModels(
      [{ label: "a", model: textModel(["Hel", "lo"]) }],
      req,
      { onText: (t) => chunks.push(t) },
    );
    expect(result).toMatchObject({ text: "Hello", model: "a", toolCalls: 0 });
    expect(chunks).toEqual(["Hel", "lo"]);
  });

  it("falls back to the next model when the first fails before any text", async () => {
    const result = await streamWithModels(
      [
        { label: "broken", model: failingModel("429 quota exceeded") },
        { label: "backup", model: textModel(["ok"]) },
      ],
      req,
      { onText: () => {} },
    );
    expect(result.model).toBe("backup");
    expect(result.text).toBe("ok");
  });

  it("does not switch models after text has reached the user", async () => {
    const backup = textModel(["should not run"]);
    await expect(
      streamWithModels(
        [
          { label: "flaky", model: midStreamFailingModel("partial ") },
          { label: "backup", model: backup },
        ],
        req,
        { onText: () => {} },
      ),
    ).rejects.toThrow(/failed mid-answer/);
    expect(backup.doStreamCalls).toHaveLength(0);
  });

  it("reports every failed attempt when all models fail", async () => {
    const err = await streamWithModels(
      [
        { label: "a", model: failingModel("429") },
        { label: "b", model: failingModel("404 model not found") },
      ],
      req,
      { onText: () => {} },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(NoModelAvailableError);
    expect((err as NoModelAvailableError).attempts.map((a) => a.model)).toEqual(["a", "b"]);
  });

  it("cools down a rate-limited model so the next turn goes straight to the backup", async () => {
    const limited = failingModel("429 RESOURCE_EXHAUSTED: quota exceeded");
    const first = await streamWithModels(
      [{ label: "gemini-a", model: limited }, { label: "gemini-b", model: textModel(["ok"]) }],
      req,
      { onText: () => {} },
    );
    expect(first.model).toBe("gemini-b");

    const fresh = failingModel("should not be tried first");
    const second = await streamWithModels(
      [{ label: "gemini-a", model: fresh }, { label: "gemini-b", model: textModel(["ok"]) }],
      req,
      { onText: () => {} },
    );
    expect(second.model).toBe("gemini-b");
    expect(fresh.doStreamCalls).toHaveLength(0);
  });

  it("does not cool down a model for non-rate-limit errors", async () => {
    await streamWithModels(
      [{ label: "a", model: failingModel("404 model not found") }, { label: "b", model: textModel(["ok"]) }],
      req,
      { onText: () => {} },
    );
    expect(orderByAvailability([{ label: "a" }, { label: "b" }]).map((m) => m.label)).toEqual(["a", "b"]);
  });

  it("explains missing configuration when no model is configured", async () => {
    const err = await streamWithModels([], req, { onText: () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(NoModelAvailableError);
    expect((err as Error).message).toMatch(/GEMINI_API_KEY/);
  });
});

describe("rate-limit detection", () => {
  it("reads 429 and Retry-After from provider errors, including wrapped ones", () => {
    expect(rateLimitSeconds({ statusCode: 429, responseHeaders: { "retry-after": "17" } })).toBe(17);
    expect(rateLimitSeconds({ message: "Failed after 2 attempts", lastError: { statusCode: 429 } })).toBe(60);
    expect(rateLimitSeconds(new Error("RESOURCE_EXHAUSTED: Quota exceeded for metric generate_content"))).toBe(60);
    expect(rateLimitSeconds(new Error("400 invalid argument"))).toBeUndefined();
  });

  it("orders cooling models last until their cool-down ends", () => {
    coolDown("a", 30, 1_000);
    expect(orderByAvailability([{ label: "a" }, { label: "b" }], 2_000).map((m) => m.label)).toEqual(["b", "a"]);
    expect(orderByAvailability([{ label: "a" }, { label: "b" }], 40_000).map((m) => m.label)).toEqual(["a", "b"]);
  });
});
