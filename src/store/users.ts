import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { DB } from "../db/index.js";
import type { Session } from "../auth/session.js";

/** A registered account. Never carries the password hash outside this module. */
export interface User {
  id: string;
  username: string;
  createdAt: number;
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: number;
}

const SCRYPT_KEYLEN = 64;

/** Hash a password with a per-user random salt: stored as "salt:key" (hex). */
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

/** Constant-time verify of a password against a stored "salt:key" string. */
function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, keyHex] = stored.split(":");
  if (!saltHex || !keyHex) return false;
  const key = Buffer.from(keyHex, "hex");
  const test = scryptSync(password, Buffer.from(saltHex, "hex"), key.length);
  return key.length === test.length && timingSafeEqual(key, test);
}

export class UsernameTakenError extends Error {
  constructor() {
    super("username already taken");
    this.name = "UsernameTakenError";
  }
}

/**
 * Create an account. Usernames are stored lowercased and are unique; the unique
 * index turns a race/duplicate into a clean UsernameTakenError.
 */
export function createUser(db: DB, username: string, password: string): User {
  const id = randomUUID();
  const uname = username.trim().toLowerCase();
  const createdAt = Date.now();
  try {
    db.prepare(
      `INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)`,
    ).run(id, uname, hashPassword(password), createdAt);
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) throw new UsernameTakenError();
    throw err;
  }
  return { id, username: uname, createdAt };
}

/** Return the user id if the username/password match, else undefined. */
export function authenticate(db: DB, username: string, password: string): string | undefined {
  const row = db
    .prepare(`SELECT * FROM users WHERE username = ?`)
    .get(username.trim().toLowerCase()) as UserRow | undefined;
  if (!row) return undefined;
  return verifyPassword(password, row.password_hash) ? row.id : undefined;
}

export function getUser(db: DB, id: string): User | undefined {
  const row = db.prepare(`SELECT id, username, created_at FROM users WHERE id = ?`).get(id) as
    | Omit<UserRow, "password_hash">
    | undefined;
  return row ? { id: row.id, username: row.username, createdAt: row.created_at } : undefined;
}

/** Resolve the logged-in user from the request's session cookie, if any/valid. */
export function currentUser(db: DB, session: Session, req: FastifyRequest): User | undefined {
  const id = session.readUser(req);
  return id ? getUser(db, id) : undefined;
}
