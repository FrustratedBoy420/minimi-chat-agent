import { describe, expect, it } from "vitest";
import { encodeEvent, readEvents, type ChatEvent } from "../../lib/protocol";

function streamOf(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of readEvents(stream)) out.push(e);
  return out;
}

describe("NDJSON chat protocol", () => {
  const events: ChatEvent[] = [
    { type: "meta", conversationId: "c1", userMessageId: "m1" },
    { type: "status", text: "Searching…" },
    { type: "delta", text: "Hello\nworld" },
    { type: "done", messageId: "m2", model: "google:x" },
  ];

  it("round-trips events, including text with newlines", async () => {
    expect(await collect(streamOf(events.map(encodeEvent)))).toEqual(events);
  });

  it("reassembles events split across arbitrary chunk boundaries", async () => {
    const bytes = new Uint8Array(events.flatMap((e) => [...encodeEvent(e)]));
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.slice(i, i + 7));
    expect(await collect(streamOf(chunks))).toEqual(events);
  });

  it("handles multi-byte characters split across chunks", async () => {
    const event: ChatEvent = { type: "delta", text: "₹19 · 東京 · ü" };
    const bytes = encodeEvent(event);
    const chunks = [bytes.slice(0, 22), bytes.slice(22)];
    expect(await collect(streamOf(chunks))).toEqual([event]);
  });
});
