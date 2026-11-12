import { tool } from "ai";
import { z } from "zod";
import type { SearchSession } from "./session";

/** The agent's one and only tool. */
export function webSearchTool(session: SearchSession) {
  return tool({
    description:
      "Search the web for current information (prices, plans, versions, releases, news, availability). " +
      "Use one focused query per product or question; call it several times in parallel for several products. " +
      "Set `site` to the vendor's official domain when you know it, so the vendor's own pages rank first. " +
      "Results are numbered; cite them as [n].",
    inputSchema: z.object({
      query: z.string().min(2).max(300).describe("A focused search query, e.g. 'Supabase Pro plan price per month'"),
      site: z
        .string()
        .max(100)
        .optional()
        .describe("The vendor's official domain to prefer when you know it, e.g. 'supabase.com'. Omit if unsure."),
    }),
    execute: async ({ query, site }) => session.search(query, site),
  });
}
