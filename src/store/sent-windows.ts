import type { DB } from "../db/index.js";

/**
 * Exactly-once ledger. `claimWindow` atomically inserts the (grant, window) row;
 * because of the PRIMARY KEY, only one caller can win — across restarts, double
 * runs, or multiple instances. The scheduler claims a window BEFORE sending, so
 * a concurrent run cannot also send. If the send then fails, `releaseWindow`
 * removes the claim so a later tick can retry.
 */
export function claimWindow(db: DB, grantId: string, windowKey: string, atMs: number): boolean {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO sent_windows (grant_id, window_key, sent_at) VALUES (?, ?, ?)`,
    )
    .run(grantId, windowKey, atMs);
  return info.changes === 1;
}

export function releaseWindow(db: DB, grantId: string, windowKey: string): void {
  db.prepare(`DELETE FROM sent_windows WHERE grant_id = ? AND window_key = ?`).run(
    grantId,
    windowKey,
  );
}
