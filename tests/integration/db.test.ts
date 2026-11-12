import { describe, expect, it } from "vitest";
import {
  addMessage,
  createConversation,
  getMessages,
  getRecentMessages,
  listConversations,
} from "../../lib/db/queries";
import { getDb } from "../../lib/db/client";

const t = (iso: string) => new Date(iso);

describe("database (PGlite)", () => {
  it("creates the schema idempotently", async () => {
    const db = await getDb();
    const res = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(res.rows.map((r) => r.table_name)).toEqual([
      "conversations", "facts", "messages", "search_cache", "sources", "subjects", "usage",
    ]);
  });

  it("stores messages with their original timestamps and returns them in order", async () => {
    const conv = await createConversation("CRM research", t("2026-11-09T04:30:00Z"));
    await addMessage({ conversationId: conv.id, role: "user", content: "first", at: t("2026-11-09T04:30:00Z"), timezone: "Asia/Kolkata" });
    await addMessage({ conversationId: conv.id, role: "assistant", content: "second", at: t("2026-11-09T04:30:05Z") });
    const rows = await getMessages(conv.id);
    expect(rows.map((r) => r.content)).toEqual(["first", "second"]);
    expect(new Date(rows[0].created_at).toISOString()).toBe("2026-11-09T04:30:00.000Z");
    expect(rows[0].timezone).toBe("Asia/Kolkata");
  });

  it("returns only the most recent N messages, oldest first", async () => {
    const conv = await createConversation("window", t("2026-11-10T00:00:00Z"));
    for (let i = 1; i <= 5; i++) {
      await addMessage({ conversationId: conv.id, role: i % 2 ? "user" : "assistant", content: `m${i}`, at: t(`2026-11-10T00:0${i}:00Z`) });
    }
    const recent = await getRecentMessages(conv.id, 3);
    expect(recent.map((r) => r.content)).toEqual(["m3", "m4", "m5"]);
  });

  it("lists conversations by most recent activity", async () => {
    const older = await createConversation("older", t("2026-11-01T00:00:00Z"));
    const newer = await createConversation("newer", t("2026-11-02T00:00:00Z"));
    await addMessage({ conversationId: older.id, role: "user", content: "bump", at: t("2026-11-05T00:00:00Z") });
    const ids = (await listConversations()).map((c) => c.id);
    expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(newer.id));
  });

  it("rejects invalid roles at the database level", async () => {
    const conv = await createConversation("roles", t("2026-11-10T00:00:00Z"));
    await expect(
      addMessage({ conversationId: conv.id, role: "system" as never, content: "x", at: t("2026-11-10T00:00:00Z") }),
    ).rejects.toThrow();
  });

  it("deletes a conversation's messages when the conversation is deleted", async () => {
    const conv = await createConversation("to delete", t("2026-11-10T00:00:00Z"));
    await addMessage({ conversationId: conv.id, role: "user", content: "bye", at: t("2026-11-10T00:00:00Z") });
    const db = await getDb();
    await db.query(`DELETE FROM conversations WHERE id = $1`, [conv.id]);
    expect(await getMessages(conv.id)).toEqual([]);
  });
});
