import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "./schema.js";

export type DB = Database.Database;

/**
 * Opens (and creates if needed) the SQLite database, enables WAL for safe
 * concurrent reads while the scheduler writes, and applies the schema.
 */
export function openDb(databasePath: string): DB {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  migrate(db);
  return db;
}

/** Lightweight, idempotent column migrations for databases created before a field existed. */
function migrate(db: DB): void {
  ensureColumn(db, "grants", "primary_only", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "grants", "owner_id", "TEXT"); // multi-tenant: NULL on legacy rows until claimed
  // Index created here (not in SCHEMA_SQL) so it never references owner_id before
  // the column exists on a database created by an earlier version.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_grants_owner ON grants(owner_id)`);
}

function ensureColumn(db: DB, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/**
 * Return the persisted cookie-signing secret, generating and storing one on first
 * use. Keeping it in the DB (rather than an env var) means signed sessions survive
 * restarts without extra deployment configuration.
 */
export function getOrCreateCookieSecret(db: DB): string {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'cookie_secret'`).get() as
    | { value: string }
    | undefined;
  if (row) return row.value;
  const secret = randomBytes(32).toString("base64url");
  db.prepare(`INSERT INTO meta (key, value) VALUES ('cookie_secret', ?)`).run(secret);
  return secret;
}
