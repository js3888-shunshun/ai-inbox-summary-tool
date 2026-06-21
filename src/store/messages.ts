import type { DB } from "../db/index.js";
import type { EmailMessage } from "../domain/types.js";

interface MessageRow {
  id: string;
  grant_id: string;
  thread_id: string | null;
  from_name: string;
  from_email: string;
  subject: string;
  snippet: string;
  received_at: number;
  unread: number;
}

function toEmailMessage(row: MessageRow): EmailMessage {
  return {
    id: row.id,
    grantId: row.grant_id,
    threadId: row.thread_id,
    from: row.from_name,
    fromEmail: row.from_email,
    subject: row.subject,
    snippet: row.snippet,
    receivedAt: row.received_at,
    unread: row.unread === 1,
  };
}

/**
 * Idempotent insert keyed on the message id (PK). Safe against duplicate and
 * out-of-order webhook deliveries — re-delivering the same message is a no-op
 * apart from refreshing its read state. Returns true if a new row was inserted.
 */
export function upsertMessage(db: DB, m: EmailMessage): boolean {
  const info = db
    .prepare(
      `INSERT INTO messages
         (id, grant_id, thread_id, from_name, from_email, subject, snippet, received_at, unread, summarized)
       VALUES
         (@id, @grantId, @threadId, @from, @fromEmail, @subject, @snippet, @receivedAt, @unread, 0)
       ON CONFLICT(id) DO UPDATE SET unread = excluded.unread`,
    )
    .run({
      id: m.id,
      grantId: m.grantId,
      threadId: m.threadId,
      from: m.from,
      fromEmail: m.fromEmail,
      subject: m.subject,
      snippet: m.snippet,
      receivedAt: m.receivedAt,
      unread: m.unread ? 1 : 0,
    });
  return info.changes > 0 && info.lastInsertRowid !== 0;
}

/** Messages collected since the last digest for a grant (not yet summarized). */
export function listUnsummarized(db: DB, grantId: string): EmailMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE grant_id = ? AND summarized = 0 ORDER BY received_at ASC`,
    )
    .all(grantId) as MessageRow[];
  return rows.map(toEmailMessage);
}

/** Mark the given message ids as included in a sent digest. */
export function markSummarized(db: DB, ids: string[]): void {
  if (ids.length === 0) return;
  const stmt = db.prepare(`UPDATE messages SET summarized = 1 WHERE id = ?`);
  const tx = db.transaction((batch: string[]) => {
    for (const id of batch) stmt.run(id);
  });
  tx(ids);
}
