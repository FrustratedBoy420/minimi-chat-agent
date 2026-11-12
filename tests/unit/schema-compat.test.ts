import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PlanSchema } from "../../lib/check/plan";
import { VerdictSchema } from "../../lib/check/verdict";
import { toWireSchema } from "../../lib/llm/schema";
import { FactDraftSchema } from "../../lib/memory/facts";

/**
 * Guard for structured-output schemas sent to Gemini (found in live runs): length limits, array limits and
 * descriptions push a schema past Gemini's complexity limit (400 INVALID_ARGUMENT). The wire schema must be
 * structure-only. Mocked tests cannot catch provider rejections, so the rules are asserted here
 * (and tests/live/schemas.live.test.ts checks the real provider).
 */
const schemas = {
  plan: PlanSchema,
  verdict: VerdictSchema,
  facts: z.object({ facts: z.array(FactDraftSchema) }),
};

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
  else if (node && typeof node === "object") {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((v) => walk(v, visit));
  }
}

describe.each(Object.entries(schemas))("%s schema is Gemini-compatible on the wire", (_name, schema) => {
  const { json, guide } = toWireSchema(schema as z.ZodType<unknown>);

  it("keeps the field descriptions in the prompt guide instead of the schema", () => {
    expect(guide.length).toBeGreaterThan(0);
    walk(json, (n) => {
      expect(n).not.toHaveProperty("description");
      expect(n).not.toHaveProperty("maxItems");
    });
  });

  it("has no string length limits", () => {
    walk(json, (n) => {
      expect(n).not.toHaveProperty("minLength");
      expect(n).not.toHaveProperty("maxLength");
    });
  });

  it("has at most 10 nullable fields", () => {
    let nullable = 0;
    walk(json, (n) => {
      const variants = (n.anyOf ?? n.oneOf) as { type?: string }[] | undefined;
      if (variants?.some((v) => v.type === "null")) nullable++;
    });
    expect(nullable).toBeLessThanOrEqual(10);
  });
});
