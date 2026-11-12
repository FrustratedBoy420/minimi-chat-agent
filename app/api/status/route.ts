import { config, dailyLimitFor } from "@/lib/config";
import { NEAR_LIMIT_RATIO } from "@/lib/llm/router";
import { llmUsageKey, usageTodayMany } from "@/lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Free-tier status: which providers are configured and how much of today's quota is used. No secrets. */
export async function GET(): Promise<Response> {
  const labels = [...new Set([...config.chains.main, ...config.chains.fast].map((r) => `${r.provider}:${r.modelId}`))];
  const counts = await usageTodayMany([...labels.map(llmUsageKey), "tavily"]);
  const configured = (label: string) => Boolean(config.keys[label.split(":")[0] as keyof typeof config.keys]);

  return Response.json({
    models: labels.map((label) => {
      const used = counts.get(llmUsageKey(label)) ?? 0;
      const limit = dailyLimitFor(label) ?? null;
      return {
        label,
        configured: configured(label),
        usedToday: used,
        dailyLimit: limit,
        nearLimit: limit !== null && used >= limit * NEAR_LIMIT_RATIO,
      };
    }),
    search: {
      configured: Boolean(config.keys.tavily),
      usedToday: counts.get("tavily") ?? 0,
      dailyLimit: config.search.maxPerDay,
    },
  });
}
