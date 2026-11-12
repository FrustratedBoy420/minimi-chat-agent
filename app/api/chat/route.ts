import { z } from "zod";
import { validTimezone } from "@/lib/clock";
import { runTurn } from "@/lib/chat/turn";
import { encodeEvent, type ChatEvent } from "@/lib/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  conversationId: z.uuid().optional(),
  message: z.string().trim().min(1).max(20_000),
  timezone: z.string().optional(),
});

export async function POST(req: Request): Promise<Response> {
  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch {
    return Response.json({ error: "Invalid request: 'message' is required (max 20,000 characters)." }, { status: 400 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ChatEvent) => {
        try {
          controller.enqueue(encodeEvent(event));
        } catch {
          // Client went away; the turn keeps running only until it checks the abort signal.
        }
      };
      try {
        await runTurn(
          {
            conversationId: parsed.conversationId,
            message: parsed.message,
            timezone: validTimezone(parsed.timezone),
            abortSignal: req.signal,
          },
          emit,
        );
      } catch (err) {
        console.error("[api/chat] unexpected failure:", err);
        emit({ type: "error", message: "The server failed to process this message.", retryable: true });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
