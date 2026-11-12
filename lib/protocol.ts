/**
 * Wire protocol for POST /api/chat: newline-delimited JSON (one event per line).
 * Chosen over a framework-specific stream format so the server can interleave
 * status lines (searching..., comparing...) with answer text, and the client stays tiny.
 */
/** A web source cited in an answer as [n]. */
export interface Citation {
  n: number;
  title: string;
  url: string;
  publishedAt: string | null;
}

export type ChatEvent =
  | { type: "meta"; conversationId: string; userMessageId: string }
  | { type: "status"; text: string }
  | { type: "sources"; sources: Citation[] }
  | { type: "delta"; text: string }
  | { type: "done"; messageId: string; model: string }
  | { type: "error"; message: string; retryable: boolean };

export function encodeEvent(event: ChatEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(event) + "\n");
}

/** Splits an NDJSON byte stream into events. Used by the browser client. */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as ChatEvent;
    }
  }
  const rest = buffer.trim();
  if (rest) yield JSON.parse(rest) as ChatEvent;
}
