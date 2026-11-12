import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PlanSchema } from "../../lib/check/plan";
import { VerdictSchema } from "../../lib/check/verdict";
import { generateObject } from "../../lib/llm/router";
import { FactDraftSchema } from "../../lib/memory/facts";

/**
 * LIVE test (real Gemini, uses quota). Skipped unless LIVE=1:
 *   LIVE=1 npx vitest run tests/live   (with keys in the environment)
 * Mocked tests cannot catch provider-side schema rejections, so the real schemas are sent here.
 */
const live = process.env.LIVE === "1";

describe.skipIf(!live)("structured-output schemas against the real provider", () => {
  const cases = [
    { name: "plan", schema: PlanSchema, prompt: "Records: we compared Neon Launch ($19/month) and Supabase Pro ($25/month). Plan a price re-check." },
    {
      name: "verdict",
      schema: VerdictSchema,
      prompt:
        "STORED RECORDS: Neon Launch: $19/month\nSEARCH RESULTS:\n[1] https://neon.tech/pricing\nLaunch: $22/month\nExtract before/now for Neon Launch price.",
    },
    {
      name: "facts",
      schema: z.object({ facts: z.array(FactDraftSchema).max(20) }),
      prompt: "USER MESSAGE:\nWe're a 20-person team.\n\nSEARCH RESULTS:\n[1] https://supabase.com/pricing\nPro: $25 per month per organization.",
    },
  ];

  it.each(cases)("$name schema is accepted and returns valid JSON", async ({ schema, prompt }) => {
    const { object, model } = await generateObject({
      role: "fast",
      schema: schema as z.ZodType<unknown>,
      system: "Extract as instructed. Output JSON only.",
      prompt,
    });
    console.log(model, JSON.stringify(object).slice(0, 300));
    expect(object).toBeTruthy();
  }, 60_000);
});
