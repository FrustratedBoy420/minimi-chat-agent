import { jsonSchema, type Schema } from "ai";
import { z } from "zod";

/**
 * Provider-safe structured output.
 *
 * Gemini rejects response schemas above a complexity limit (400 INVALID_ARGUMENT). Found in live runs:
 * string length limits, array size limits and field descriptions all count against it, and our richer
 * schemas crossed the line while a bare version of the same schema was accepted.
 *
 * So the provider gets a "wire" schema with only structure (types, enums, required fields), the field
 * descriptions move into the system prompt as a short field guide, and the model's output is still
 * validated locally against the FULL zod schema (lengths, limits and all).
 */

const STRIP_KEYS = new Set([
  "description",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "pattern",
  "format",
  "default",
  "examples",
  "$schema",
  "title",
]);

type JsonNode = Record<string, unknown>;

export function toWireSchema<T>(schema: z.ZodType<T>): { wire: Schema<T>; guide: string; json: JsonNode } {
  const full = z.toJSONSchema(schema) as JsonNode;
  const guide = fieldGuide(full);
  const json = strip(full) as JsonNode;
  const wire = jsonSchema<T>(json as never, {
    validate: (value) => {
      const parsed = schema.safeParse(value);
      return parsed.success ? { success: true, value: parsed.data } : { success: false, error: parsed.error };
    },
  });
  return { wire, guide, json };
}

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (!node || typeof node !== "object") return node;
  const out: JsonNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRIP_KEYS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object") {
      // property NAMES are data here, not schema keywords: keep them all
      out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strip(v)]));
    } else {
      out[key] = strip(value);
    }
  }
  return out;
}

/** "- items[].plan: Plan or tier…" lines from schema descriptions (and enum choices). */
function fieldGuide(root: JsonNode): string {
  const lines: string[] = [];
  const visit = (node: unknown, path: string) => {
    if (!node || typeof node !== "object") return;
    const n = node as JsonNode;
    if (typeof n.description === "string" && path) lines.push(`- ${path}: ${n.description}`);
    if (n.properties && typeof n.properties === "object") {
      for (const [key, child] of Object.entries(n.properties as JsonNode)) visit(child, path ? `${path}.${key}` : key);
    }
    if (n.items) visit(n.items, `${path}[]`);
    for (const variant of [...((n.anyOf as unknown[]) ?? []), ...((n.oneOf as unknown[]) ?? [])]) {
      const v = variant as JsonNode;
      if (v.type !== "null") visit({ ...v, description: undefined }, path);
    }
  };
  visit(root, "");
  return lines.join("\n");
}
