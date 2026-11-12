import { describe, expect, it } from "vitest";
import { parseChain } from "../../lib/config";

describe("parseChain", () => {
  it("parses ordered provider:model references", () => {
    expect(parseChain("google:gemini-a, groq:openai/gpt-oss-120b")).toEqual([
      { provider: "google", modelId: "gemini-a" },
      { provider: "groq", modelId: "openai/gpt-oss-120b" },
    ]);
  });

  it("keeps colons inside the model id", () => {
    expect(parseChain("openrouter:openrouter/free:free")).toEqual([
      { provider: "openrouter", modelId: "openrouter/free:free" },
    ]);
  });

  it("returns an empty chain for empty input", () => {
    expect(parseChain(undefined)).toEqual([]);
    expect(parseChain("")).toEqual([]);
  });

  it("rejects unknown providers and malformed entries", () => {
    expect(() => parseChain("acme:model")).toThrow(/Unknown provider/);
    expect(() => parseChain("google")).toThrow(/Invalid model reference/);
    expect(() => parseChain("google:")).toThrow(/Invalid model reference/);
  });
});
