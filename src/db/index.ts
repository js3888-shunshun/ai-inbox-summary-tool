import Database from "better-sqlite3";
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
}

function ensureColumn(db: DB, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
