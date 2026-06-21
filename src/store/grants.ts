import type { DB } from "../db/index.js";
import type { Grant } from "../domain/types.js";

/** Raw column shape as stored in SQLite. */
interface GrantRow {
  grant_id: string;
  email: string;
  destination_email: string;
  created_at: number;
}

function toGrant(row: GrantRow): Grant {
  return {
    grantId: row.grant_id,
    email: row.email,
    destinationEmail: row.destination_email,
    createdAt: row.created_at,
  };
}

/**
 * Persist a grant (idempotent on grantId). Reconnecting the same mailbox
 * refreshes the email but preserves any chosen destination address.
 */
export function saveGrant(db: DB, grant: Grant): void {
  db.prepare(
    `INSERT INTO grants (grant_id, email, destination_email, created_at)
     VALUES (@grantId, @email, @destinationEmail, @createdAt)
     ON CONFLICT(grant_id) DO UPDATE SET email = excluded.email`,
  ).run(grant);
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
