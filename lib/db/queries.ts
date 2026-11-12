import type { Citation } from "../protocol";
import { getDb } from "./client";

export interface ConversationRow {
  id: string;
  title: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: Date;
  timezone: string | null;
  citations?: Citation[] | null;
}

export async function createConversation(title: string | null, at: Date): Promise<ConversationRow> {
  const db = await getDb();
  const res = await db.query<ConversationRow>(
    `INSERT INTO conversations (title, created_at, updated_at) VALUES ($1, $2, $2) RETURNING *`,
    [title, at],
  );
  return res.rows[0];
}

export async function getConversation(id: string): Promise<ConversationRow | undefined> {
  const db = await getDb();
  const res = await db.query<ConversationRow>(`SELECT * FROM conversations WHERE id = $1`, [id]);
  return res.rows[0];
}

export async function listConversations(limit = 50): Promise<ConversationRow[]> {
  const db = await getDb();
  const res = await db.query<ConversationRow>(
    `SELECT * FROM conversations ORDER BY updated_at DESC LIMIT $1`,
    [limit],
  );
  return res.rows;
}

export async function addMessage(input: {
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  at: Date;
  timezone?: string;
  citations?: Citation[];
}): Promise<MessageRow> {
  const db = await getDb();
  const res = await db.transaction(async (tx) => {
    const inserted = await tx.query<MessageRow>(
      `INSERT INTO messages (conversation_id, role, content, created_at, timezone, citations)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, conversation_id, role, content, created_at, timezone, citations`,
      [
        input.conversationId,
        input.role,
        input.content,
        input.at,
        input.timezone ?? null,
        input.citations && input.citations.length > 0 ? JSON.stringify(input.citations) : null,
      ],
    );
    await tx.query(`UPDATE conversations SET updated_at = $2 WHERE id = $1`, [input.conversationId, input.at]);
    return inserted;
  });
  return res.rows[0];
}

export async function getMessages(conversationId: string): Promise<MessageRow[]> {
  const db = await getDb();
  const res = await db.query<MessageRow>(
    `SELECT id, conversation_id, role, content, created_at, timezone, citations
     FROM messages WHERE conversation_id = $1 ORDER BY created_at, seq`,
    [conversationId],
  );
  return res.rows;
}

export interface RecalledMessage extends MessageRow {
  conversation_title: string | null;
}

/** Messages inside any of the given [start, end) ranges, across all conversations, oldest first. */
export async function getMessagesInRanges(
  ranges: { start: Date; end: Date }[],
  excludeIds: string[],
  limit: number,
): Promise<RecalledMessage[]> {
  if (ranges.length === 0) return [];
  const db = await getDb();
  const params: unknown[] = [excludeIds, limit];
  const conditions = ranges.map((r) => {
    params.push(r.start, r.end);
    return `(m.created_at >= $${params.length - 1} AND m.created_at < $${params.length})`;
  });
  const res = await db.query<RecalledMessage>(
    `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, m.timezone, c.title AS conversation_title
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE (${conditions.join(" OR ")}) AND NOT (m.id = ANY($1::uuid[]))
     ORDER BY m.created_at, m.seq
     LIMIT $2`,
    params,
  );
  return res.rows;
}

/**
 * Full-text search over past messages for any of the given terms (OR), best matches first.
 * Terms must already be sanitized to [a-z0-9] tokens; they are joined into a tsquery.
 */
export async function searchMessages(
  terms: string[],
  excludeIds: string[],
  limit: number,
): Promise<RecalledMessage[]> {
  if (terms.length === 0) return [];
  const db = await getDb();
  const res = await db.query<RecalledMessage>(
    `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, m.timezone, c.title AS conversation_title
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.search @@ to_tsquery('simple', $1) AND NOT (m.id = ANY($2::uuid[]))
     ORDER BY ts_rank(m.search, to_tsquery('simple', $1)) DESC, m.created_at DESC
     LIMIT $3`,
    [terms.join(" | "), excludeIds, limit],
  );
  return res.rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

/** Timestamps of the most recent messages (used to tell the user which days have history). */
export async function getRecentMessageTimes(excludeIds: string[], limit = 2000): Promise<Date[]> {
  const db = await getDb();
  const res = await db.query<{ created_at: Date }>(
    `SELECT created_at FROM messages WHERE NOT (id = ANY($1::uuid[])) ORDER BY created_at DESC LIMIT $2`,
    [excludeIds, limit],
  );
  return res.rows.map((r) => new Date(r.created_at));
}

/** Most recent messages of a conversation, oldest first, for model context. */
export async function getRecentMessages(conversationId: string, limit: number): Promise<MessageRow[]> {
  const db = await getDb();
  const res = await db.query<MessageRow>(
    `SELECT * FROM (
       SELECT id, conversation_id, role, content, created_at, timezone, seq
       FROM messages WHERE conversation_id = $1
       ORDER BY created_at DESC, seq DESC LIMIT $2
     ) recent ORDER BY created_at, seq`,
    [conversationId, limit],
  );
  return res.rows;
}
