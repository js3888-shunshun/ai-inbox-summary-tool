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
  return db;
}
