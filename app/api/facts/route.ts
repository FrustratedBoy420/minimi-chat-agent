import { listFacts } from "@/lib/memory/facts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Facts the agent remembers (most recent first), each with its quote and source. */
export async function GET(): Promise<Response> {
  const facts = await listFacts(200);
  return Response.json(
    facts.map((f) => ({
      id: f.id,
      subject: f.subject,
      plan: f.plan,
      attribute: f.attribute,
      value: f.value_text,
      origin: f.origin,
      quote: f.quote,
      url: f.url,
      seenAt: f.seen_at,
      conversationId: f.conversation_id,
    })),
  );
}
