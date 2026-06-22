import type { DB } from "../db/index.js";
import type { Grant } from "../domain/types.js";

/** Raw column shape as stored in SQLite. */
interface GrantRow {
  grant_id: string;
  email: string;
  destination_email: string;
  created_at: number;
  primary_only: number;
}

function toGrant(row: GrantRow): Grant {
  return {
    grantId: row.grant_id,
    email: row.email,
    destinationEmail: row.destination_email,
    createdAt: row.created_at,
    primaryOnly: row.primary_only === 1,
  };
}

/**
 * Persist a grant (idempotent on grantId). Reconnecting the same mailbox
 * refreshes the email but preserves the chosen destination and primary-only flag.
 */
export function saveGrant(db: DB, grant: Grant): void {
  db.prepare(
    `INSERT INTO grants (grant_id, email, destination_email, created_at, primary_only)
     VALUES (@grant_id, @email, @destination_email, @created_at, @primary_only)
     ON CONFLICT(grant_id) DO UPDATE SET email = excluded.email`,
  ).run({
    grant_id: grant.grantId,
    email: grant.email,
    destination_email: grant.destinationEmail,
    created_at: grant.createdAt,
    primary_only: grant.primaryOnly ? 1 : 0,
  });
}

/** Toggle whether only the Primary tab is summarized for this mailbox. */
export function setPrimaryOnly(db: DB, grantId: string, primaryOnly: boolean): void {
  db.prepare(`UPDATE grants SET primary_only = ? WHERE grant_id = ?`).run(primaryOnly ? 1 : 0, grantId);
}

export function getGrant(db: DB, grantId: string): Grant | undefined {
  const row = db
    .prepare(`SELECT * FROM grants WHERE grant_id = ?`)
    .get(grantId) as GrantRow | undefined;
  return row ? toGrant(row) : undefined;
}

export function listGrants(db: DB): Grant[] {
  const rows = db.prepare(`SELECT * FROM grants`).all() as GrantRow[];
  return rows.map(toGrant);
}

/** Set where digests are delivered (may differ from the connected mailbox). */
export function setDestinationEmail(db: DB, grantId: string, destinationEmail: string): void {
  db.prepare(`UPDATE grants SET destination_email = ? WHERE grant_id = ?`).run(
    destinationEmail,
    grantId,
  );
}

/** Remove a grant and all of its local data (messages/schedule/windows). */
export function deleteGrantCascade(db: DB, grantId: string): void {
  const tx = db.transaction((id: string) => {
    db.prepare(`DELETE FROM messages WHERE grant_id = ?`).run(id);
    db.prepare(`DELETE FROM schedules WHERE grant_id = ?`).run(id);
    db.prepare(`DELETE FROM sent_windows WHERE grant_id = ?`).run(id);
    db.prepare(`DELETE FROM grants WHERE grant_id = ?`).run(id);
  });
  tx(grantId);
}
