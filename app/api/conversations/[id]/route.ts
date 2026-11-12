import { z } from "zod";
import { getConversation, getMessages } from "@/lib/db/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Not found" }, { status: 404 });

  const conversation = await getConversation(id);
  if (!conversation) return Response.json({ error: "Not found" }, { status: 404 });

  const messages = await getMessages(id);
  return Response.json({
    id: conversation.id,
    title: conversation.title ?? "Untitled",
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at,
      citations: m.citations ?? [],
    })),
  });
}
