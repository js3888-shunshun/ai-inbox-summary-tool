import type { DB } from "../db/index.js";
import type { Grant } from "../domain/types.js";

/** Raw column shape as stored in SQLite. */
interface GrantRow {
  grant_id: string;
  email: string;
  destination_email: string;
  created_at: number;
  primary_only: number;
  owner_id: string | null;
}

function toGrant(row: GrantRow): Grant {
  return {
    grantId: row.grant_id,
    email: row.email,
    destinationEmail: row.destination_email,
    createdAt: row.created_at,
    primaryOnly: row.primary_only === 1,
    ownerId: row.owner_id,
  };
}

/**
 * Persist a grant (idempotent on grantId). Reconnecting the same mailbox
 * refreshes the email but preserves the chosen destination and primary-only flag.
 *
 * Ownership: on conflict we COALESCE the owner — a legacy/unclaimed grant
 * (owner_id IS NULL) is adopted by the owner who reconnects it (which required
 * passing that account's OAuth, i.e. proof of ownership), while an already-owned
 * grant keeps its original owner.
 */
export function saveGrant(db: DB, grant: Grant): void {
  db.prepare(
    `INSERT INTO grants (grant_id, email, destination_email, created_at, primary_only, owner_id)
     VALUES (@grant_id, @email, @destination_email, @created_at, @primary_only, @owner_id)
     ON CONFLICT(grant_id) DO UPDATE SET
       email = excluded.email,
       owner_id = COALESCE(grants.owner_id, excluded.owner_id)`,
  ).run({
    grant_id: grant.grantId,
    email: grant.email,
    destination_email: grant.destinationEmail,
    created_at: grant.createdAt,
    primary_only: grant.primaryOnly ? 1 : 0,
    owner_id: grant.ownerId ?? null,
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

/**
 * Fetch a grant only if it belongs to `ownerId`. Used by every owner-facing
 * mutation so one tenant cannot act on another's mailbox by guessing a grantId.
 */
export function getOwnedGrant(db: DB, grantId: string, ownerId: string): Grant | undefined {
  const row = db
    .prepare(`SELECT * FROM grants WHERE grant_id = ? AND owner_id = ?`)
    .get(grantId, ownerId) as GrantRow | undefined;
  return row ? toGrant(row) : undefined;
}

/** All grants, regardless of owner. For server-side use (scheduler), never the UI. */
export function listGrants(db: DB): Grant[] {
  const rows = db.prepare(`SELECT * FROM grants`).all() as GrantRow[];
  return rows.map(toGrant);
}

/** Grants connected by one owner — the only mailboxes that owner may see/control. */
export function listGrantsByOwner(db: DB, ownerId: string): Grant[] {
  const rows = db
    .prepare(`SELECT * FROM grants WHERE owner_id = ? ORDER BY created_at`)
    .all(ownerId) as GrantRow[];
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
