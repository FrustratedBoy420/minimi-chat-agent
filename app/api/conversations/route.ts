import { listConversations } from "@/lib/db/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const rows = await listConversations();
  return Response.json(
    rows.map((c) => ({ id: c.id, title: c.title ?? "Untitled", updatedAt: c.updated_at })),
  );
}
