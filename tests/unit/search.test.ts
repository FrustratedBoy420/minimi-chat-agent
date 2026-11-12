import { describe, expect, it } from "vitest";
import { cacheTtlHours, isOfficialUrl, normalizeQuery, normalizeSite, officialFirst, trimContent } from "../../lib/search/session";

describe("search helpers", () => {
  it("normalizes queries so equivalent searches share a cache entry", () => {
    expect(normalizeQuery("  Supabase   Pro PRICING? ")).toBe("supabase pro pricing");
    expect(normalizeQuery("Neon pricing!!")).toBe(normalizeQuery("neon pricing"));
  });

  it("caches price-like queries for 6 hours and others for 24", () => {
    expect(cacheTtlHours("Supabase Pro pricing")).toBe(6);
    expect(cacheTtlHours("HubSpot cost per user")).toBe(6);
    expect(cacheTtlHours("Node.js latest LTS release")).toBe(24);
  });

  it("puts the vendor's own domain first, keeping provider order otherwise", () => {
    const hit = (url: string) => ({ title: url, url, content: "", publishedAt: null, score: 1 });
    const hits = [
      hit("https://www.jetadmin.io/blog/supabase-pricing"),
      hit("https://schematichq.com/blog/supabase-pricing"),
      hit("https://supabase.com/pricing"),
      hit("https://docs.supabase.com/billing"),
    ];
    expect(officialFirst(hits, "Supabase Pro plan price per month").map((h) => h.url)).toEqual([
      "https://supabase.com/pricing",
      "https://docs.supabase.com/billing",
      "https://www.jetadmin.io/blog/supabase-pricing",
      "https://schematichq.com/blog/supabase-pricing",
    ]);
    // Generic words ("pricing") never make a blog look official.
    expect(officialFirst([hit("https://pricing.example.com"), hit("https://neon.tech/pricing")], "neon pricing")[0].url).toBe(
      "https://neon.tech/pricing",
    );
  });

  it("treats the given site (and its subdomains) as official", () => {
    expect(isOfficialUrl("https://docs.render.com/pricing", "postgres hosting", "render.com")).toBe(true);
    expect(isOfficialUrl("https://notrender.com/pricing", "postgres hosting", "render.com")).toBe(false);
    expect(isOfficialUrl("https://www.g2.com/products/neon", "Neon Launch plan price")).toBe(false);
  });

  it("accepts only bare domains for `site`", () => {
    expect(normalizeSite("https://www.Supabase.com/pricing")).toBe("supabase.com");
    expect(normalizeSite("supabase")).toBeUndefined();
    expect(normalizeSite("not a domain")).toBeUndefined();
    expect(normalizeSite(undefined)).toBeUndefined();
  });

  it("trims result content to keep prompts small", () => {
    const long = "word ".repeat(1000);
    const trimmed = trimContent(long, 100);
    expect(trimmed.length).toBe(101);
    expect(trimmed.endsWith("…")).toBe(true);
    expect(trimContent("  a \n\n b  ")).toBe("a b");
  });
});
