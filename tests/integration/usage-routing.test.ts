import { beforeEach, describe, expect, it } from "vitest";
import { dailyLimitFor, parseLimits } from "../../lib/config";
import { getDb } from "../../lib/db/client";
import { rankModels, resetCoolDowns, streamWithModels, type FallbackInfo } from "../../lib/llm/router";
import { incrementUsage, llmUsageKey, usageToday, usageTodayMany } from "../../lib/usage";
import { failingModel, scriptedModel, textModel } from "../helpers/mock-model";

const req = { system: "test", messages: [{ role: "user" as const, content: "hi" }] };

beforeEach(async () => {
  resetCoolDowns();
  const db = await getDb();
  await db.exec("DELETE FROM usage;");
});

describe("daily limits config", () => {
  it("parses limits and falls back to provider wildcards", () => {
    const limits = parseLimits("google:gemini-a=450, groq:*=900, bad, x=0");
    expect(dailyLimitFor("google:gemini-a", limits)).toBe(450);
    expect(dailyLimitFor("groq:openai/gpt-oss-120b", limits)).toBe(900);
    expect(dailyLimitFor("openrouter:free", limits)).toBeUndefined();
  });
});

describe("usage counters", () => {
  it("counts per key and day", async () => {
    await incrementUsage("tavily");
    await incrementUsage("tavily");
    await incrementUsage(llmUsageKey("google:x"));
    const counts = await usageTodayMany(["tavily", llmUsageKey("google:x"), "missing"]);
    expect(counts.get("tavily")).toBe(2);
    expect(counts.get(llmUsageKey("google:x"))).toBe(1);
    expect(counts.has("missing")).toBe(false);
  });
});

describe("usage-aware routing", () => {
  it("moves a model at 90% of its daily limit to the back, and says why", async () => {
    // gemini-3.6-flash has a default limit of 18/day: 17 used is past 90%.
    for (let i = 0; i < 17; i++) await incrementUsage(llmUsageKey("google:gemini-3.6-flash"));
    const ranked = await rankModels([{ label: "google:gemini-3.6-flash" }, { label: "google:gemini-3.1-flash-lite" }]);
    expect(ranked.ordered.map((m) => m.label)).toEqual(["google:gemini-3.1-flash-lite", "google:gemini-3.6-flash"]);

    const notices: FallbackInfo[] = [];
    const out = await streamWithModels(
      [{ label: "google:gemini-3.6-flash", model: textModel(["should be skipped"]) }, { label: "google:gemini-3.1-flash-lite", model: textModel(["ok"]) }],
      req,
      { onText: () => {}, onFallback: (i) => notices.push(i) },
    );
    expect(out.model).toBe("google:gemini-3.1-flash-lite");
    expect(notices).toEqual([{ from: "google:gemini-3.6-flash", to: "google:gemini-3.1-flash-lite", reason: "near_daily_limit" }]);
  });

  it("reports a rate-limit fallback once, with the reason", async () => {
    const notices: FallbackInfo[] = [];
    await streamWithModels(
      [{ label: "google:a", model: failingModel("429 RESOURCE_EXHAUSTED") }, { label: "google:b", model: textModel(["ok"]) }],
      req,
      { onText: () => {}, onFallback: (i) => notices.push(i) },
    );
    expect(notices).toEqual([{ from: "google:a", to: "google:b", reason: "rate_limited" }]);
  });

  it("counts one request per model step, only for successful calls", async () => {
    await streamWithModels(
      [{ label: "google:fail", model: failingModel("500 boom") }, { label: "google:ok", model: scriptedModel([{ text: ["hello"] }]) }],
      req,
      { onText: () => {} },
    );
    expect(await usageToday(llmUsageKey("google:ok"))).toBe(1);
    expect(await usageToday(llmUsageKey("google:fail"))).toBe(0);
  });

  it("still tries exhausted models when nothing else is left (never refuses outright)", async () => {
    for (let i = 0; i < 17; i++) await incrementUsage(llmUsageKey("google:gemini-3.6-flash"));
    const out = await streamWithModels([{ label: "google:gemini-3.6-flash", model: textModel(["still works"]) }], req, { onText: () => {} });
    expect(out.text).toBe("still works");
  });
});
