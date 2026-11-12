import { describe, expect, it } from "vitest";
import { planSearches, type Plan } from "../../lib/check/plan";

const item = (query: string, site: string | null = null): Plan["items"][number] => ({ item: query, product: query.split(" ")[0], kind: "price", query, site });

describe("planSearches", () => {
  it("keeps one search per planned item, in order", () => {
    expect(planSearches({ items: [item("Neon pricing", "neon.tech"), item("Supabase pricing")] }, 10)).toEqual([
      { query: "Neon pricing", site: "neon.tech", product: "Neon", news: false },
      { query: "Supabase pricing", site: null, product: "Supabase", news: false },
    ]);
  });

  it("searches release items in news mode (dated results)", () => {
    const plan: Plan = { items: [{ item: "HubSpot releases", product: "HubSpot", kind: "release", query: "HubSpot Sales Hub new features", site: "hubspot.com" }] };
    expect(planSearches(plan, 10)).toEqual([{ query: "HubSpot Sales Hub new features", site: "hubspot.com", product: "HubSpot", news: true }]);
  });

  it("removes duplicate queries", () => {
    expect(planSearches({ items: [item("Neon pricing"), item("neon pricing "), item("Neon pricing", "neon.tech")] }, 10)).toHaveLength(2);
  });

  it("caps the number of searches", () => {
    const items = Array.from({ length: 12 }, (_, i) => item(`product ${i} pricing`));
    expect(planSearches({ items }, 10)).toHaveLength(10);
  });
});
