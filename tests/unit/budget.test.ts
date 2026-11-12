import { describe, expect, it } from "vitest";
import { approxTokens, focusExcerpt, formatSourcesForPrompt, perItemBudget } from "../../lib/llm/budget";
import { formatRecallContext } from "../../lib/recall";

describe("prompt budgets", () => {
  it("shares a budget across items within per-item bounds", () => {
    expect(perItemBudget(14_000, 4)).toBe(1500);
    expect(perItemBudget(14_000, 20)).toBe(700);
    expect(perItemBudget(14_000, 100)).toBe(300);
  });

  it("keeps a 10-search change check (50 results) within the source budget", () => {
    const sources = Array.from({ length: 50 }, (_, i) => ({ n: i + 1, url: `https://site${i}.example/pricing`, content: "x ".repeat(2000) }));
    const text = formatSourcesForPrompt(sources, 20_000);
    // 400 chars per result at most + headers: far below the ~75k characters sent before this phase.
    expect(text.length).toBeLessThan(50 * (400 + 60));
    expect(approxTokens(text)).toBeLessThan(6_000);
  });

  it("keeps the price line when trimming a long page, instead of cutting it off", () => {
    const page =
      "Welcome to our website. We help teams of all sizes. Our customers love us. ".repeat(10) +
      "Sales Hub Professional costs $100 per seat per month, billed annually. " +
      "Read our blog for tips. Contact sales for enterprise deals. ".repeat(10);
    const excerpt = focusExcerpt(page, ["Sales Hub", "Professional"], 200);
    expect(excerpt).toContain("Sales Hub Professional costs $100 per seat per month");
    expect(excerpt.length).toBeLessThanOrEqual(220);
    expect(focusExcerpt("short text", [], 200)).toBe("short text");
  });

  it("prefers launch/release sentences for release searches", () => {
    const news = "Company overview and history. ".repeat(20) + "HubSpot launches Breeze AI agents for Sales Hub on 10 Nov 2026. " + "Stock info. ".repeat(20);
    expect(focusExcerpt(news, ["HubSpot"], 150)).toContain("HubSpot launches Breeze AI agents");
  });

  it("keeps a 40-message recall block within the recall budget", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`, conversation_id: "c1", conversation_title: "Long chat", role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
      content: "word ".repeat(1000), created_at: new Date(Date.UTC(2026, 10, 3, 10, i)), timezone: null,
    }));
    const text = formatRecallContext({ mode: "keywords", ranges: [], terms: ["long"], messages }, "UTC");
    expect(text.length).toBeLessThan(9_000 + 40 * 80); // budget + per-line labels
    expect(text).toContain("[truncated]");
  });
});
