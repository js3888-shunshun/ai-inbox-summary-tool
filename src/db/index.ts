import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

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
  const schema = readFileSync(join(here, "schema.sql"), "utf8");
  db.exec(schema);
  return db;
}
