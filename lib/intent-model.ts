import { z } from "zod";
import type { Intent, Route } from "./intent";
import { generateObject } from "./llm/router";

/**
 * Second opinion for messages the rules are not sure about (one fast model call, only then).
 * The rules stay first: they are instant, free and testable; the model only settles ambiguous phrasing.
 */
const IntentSchema = z.object({ intent: z.enum(["recall", "change_check", "research", "chat"]) });

const SYSTEM = [
  "Classify the user's message for a research assistant that remembers past conversations. Output JSON only.",
  "- recall: asks what was said, asked, chosen or discussed before; no need for current information.",
  "- change_check: refers to something discussed or chosen before AND asks whether it changed, is still correct/good, or how it compares now.",
  "- research: needs current information from the web, not tied to an earlier conversation.",
  "- chat: anything else (greetings, opinions, writing help, maths).",
  "Examples: 'Are the CRMs we picked still a good deal?' → change_check. 'Which CRMs did we pick?' → recall.",
  "'What did you tell me about Neon earlier?' → recall. 'Is Neon cheaper than Supabase?' → research.",
].join("\n");

export async function refineRoute(route: Route, message: string): Promise<Route> {
  if (!route.uncertain) return route;
  try {
    const { object } = await generateObject({ role: "fast", schema: IntentSchema, system: SYSTEM, prompt: message });
    const intent: Intent = object.intent;
    return { ...route, intent, wantsRecall: route.wantsRecall || intent === "recall" || intent === "change_check", uncertain: false };
  } catch {
    return route; // the rules' answer is a safe default
  }
}
