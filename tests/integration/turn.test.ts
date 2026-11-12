import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../../lib/protocol";

// Replace the model call with a controllable fake; everything else (DB, persistence) is real.
const { streamAnswer } = vi.hoisted(() => ({ streamAnswer: vi.fn() }));
vi.mock("../../lib/llm/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/llm/router")>();
  return { ...actual, streamAnswer };
});

const { runTurn } = await import("../../lib/chat/turn");
const { getMessages } = await import("../../lib/db/queries");
const { NoModelAvailableError } = await import("../../lib/llm/router");

async function run(input: Parameters<typeof runTurn>[0]) {
  const events: ChatEvent[] = [];
  await runTurn(input, (e) => events.push(e));
  return events;
}

describe("runTurn", () => {
  // Block body on purpose: a function returned from beforeEach is run by Vitest as cleanup.
  beforeEach(() => {
    streamAnswer.mockReset();
  });

  it("emits meta, deltas and done, and persists both messages", async () => {
    streamAnswer.mockImplementation(async (_req, h) => {
      h.onText("Hi ");
      h.onText("there");
      return { text: "Hi there", model: "mock:a" };
    });

    const events = await run({ message: "hello", timezone: "Asia/Kolkata" });

    expect(events.map((e) => e.type)).toEqual(["meta", "delta", "delta", "done"]);
    const meta = events[0] as Extract<ChatEvent, { type: "meta" }>;
    const rows = await getMessages(meta.conversationId);
    expect(rows.map((r) => [r.role, r.content])).toEqual([["user", "hello"], ["assistant", "Hi there"]]);
    expect(rows[0].timezone).toBe("Asia/Kolkata");
  });

  it("saves the user message before calling the model", async () => {
    let savedBeforeModel = false;
    streamAnswer.mockImplementation(async (req) => {
      const userTurns = req.messages.filter((m: { role: string }) => m.role === "user");
      savedBeforeModel = userTurns.at(-1)?.content === "persist me first";
      return { text: "ok", model: "mock:a" };
    });
    await run({ message: "persist me first" });
    expect(savedBeforeModel).toBe(true);
  });

  it("keeps the user message and reports a retryable error when no model is available", async () => {
    streamAnswer.mockRejectedValue(new NoModelAvailableError([{ model: "google:x", error: "429" }]));
    const events = await run({ message: "are you there?" });

    const error = events.find((e) => e.type === "error") as Extract<ChatEvent, { type: "error" }>;
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/message was saved/);
    const meta = events[0] as Extract<ChatEvent, { type: "meta" }>;
    const rows = await getMessages(meta.conversationId);
    expect(rows.map((r) => r.role)).toEqual(["user"]);
  });

  it("continues an existing conversation and sends prior messages as context", async () => {
    streamAnswer.mockResolvedValueOnce({ text: "first answer", model: "mock:a" });
    const first = await run({ message: "first question" });
    const conversationId = (first[0] as Extract<ChatEvent, { type: "meta" }>).conversationId;

    streamAnswer.mockResolvedValueOnce({ text: "second answer", model: "mock:a" });
    await run({ conversationId, message: "second question" });

    const sent = streamAnswer.mock.calls.at(-1)![0].messages.map((m: { content: string }) => m.content);
    expect(sent).toEqual(["first question", "first answer", "second question"]);
  });

  it("starts a new conversation when the given conversation id does not exist", async () => {
    streamAnswer.mockResolvedValue({ text: "ok", model: "mock:a" });
    const events = await run({ conversationId: "00000000-0000-4000-8000-000000000000", message: "hi" });
    const meta = events[0] as Extract<ChatEvent, { type: "meta" }>;
    expect(meta.conversationId).not.toBe("00000000-0000-4000-8000-000000000000");
  });
});
