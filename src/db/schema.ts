/**
 * SQLite schema, applied idempotently on boot. Kept as a TS string (not a .sql
 * file) so it ships in the compiled `dist/` build with no extra copy step and
 * needs no runtime file I/O.
 *
 * The four tables back the durability requirements:
 *   grants        -> grantId survives restarts
 *   messages      -> de-duplicated ingestion of incoming mail
 *   schedules     -> per-grant cadence, configurable without code changes
 *   sent_windows  -> exactly-once digest per (grant, window)
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS grants (
  grant_id          TEXT PRIMARY KEY,
  email             TEXT NOT NULL,
  destination_email TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  primary_only      INTEGER NOT NULL DEFAULT 0,   -- 1 = summarize only the Primary tab
  owner_id          TEXT                          -- which signed-in owner connected this mailbox (NULL = legacy/unclaimed)
);
CREATE INDEX IF NOT EXISTS idx_grants_owner ON grants(owner_id);

-- Small key/value store for server-managed secrets (e.g. the cookie-signing key),
-- so they persist across restarts without adding new environment variables.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,          -- Nylas message id; PK makes ingest idempotent
  grant_id    TEXT NOT NULL,
  thread_id   TEXT,
  from_name   TEXT NOT NULL,
  from_email  TEXT NOT NULL,
  subject     TEXT NOT NULL,
  snippet     TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  unread      INTEGER NOT NULL,          -- 0/1
  summarized  INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (grant_id) REFERENCES grants(grant_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_grant_recv ON messages(grant_id, received_at);

CREATE TABLE IF NOT EXISTS schedules (
  grant_id   TEXT PRIMARY KEY,
  cadence    TEXT NOT NULL,              -- e.g. "hourly", "every:3h", "daily:09:00"
  timezone   TEXT NOT NULL DEFAULT 'UTC',
  enabled    INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (grant_id) REFERENCES grants(grant_id)
);

-- Idempotency ledger: one row == one digest actually sent for a window.
CREATE TABLE IF NOT EXISTS sent_windows (
  grant_id   TEXT NOT NULL,
  window_key TEXT NOT NULL,
  sent_at    INTEGER NOT NULL,
  PRIMARY KEY (grant_id, window_key)
);
`;
