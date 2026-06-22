import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Owner identity for multi-tenancy. There is no password login: a visitor is
 * identified by an opaque, server-signed "owner" id carried in a cookie. The
 * OAuth consent flow is the only way to attach a mailbox to that owner, so the
 * connected Google account is the real proof of identity — the cookie just
 * remembers which owner this browser is.
 *
 * The cookie is HMAC-signed (so a client cannot forge another owner's id),
 * HttpOnly (not readable from JS), and SameSite=Lax (so it still rides the
 * top-level redirect back from Nylas to /oauth/callback).
 */
const OWNER_COOKIE = "owner";
const MAX_AGE_S = 60 * 60 * 24 * 365; // 1 year

export interface Session {
  /** The owner id from a valid cookie, or undefined if absent/tampered. */
  readOwner(req: FastifyRequest): string | undefined;
  /** Return the current owner, minting and setting a new one if none exists. */
  currentOrIssue(req: FastifyRequest, reply: FastifyReply): string;
}

export function createSession(secret: string, secure: boolean): Session {
  return {
    readOwner(req) {
      const raw = parseCookies(req.headers.cookie)[OWNER_COOKIE];
      return raw ? unsign(raw, secret) : undefined;
    },
    currentOrIssue(req, reply) {
      const existing = this.readOwner(req);
      if (existing) return existing;
      const id = randomUUID();
      setOwnerCookie(reply, sign(id, secret), secure);
      return id;
    },
  };
}

function sign(value: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(value).digest("base64url");
  return `${value}.${mac}`;
}

function unsign(signed: string, secret: string): string | undefined {
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const value = signed.slice(0, dot);
  const mac = Buffer.from(signed.slice(dot + 1));
  const expected = Buffer.from(createHmac("sha256", secret).update(value).digest("base64url"));
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return undefined;
  return value;
}

function setOwnerCookie(reply: FastifyReply, signed: string, secure: boolean): void {
  const attrs = [
    `${OWNER_COOKIE}=${signed}`,
    "Path=/",
    `Max-Age=${MAX_AGE_S}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) attrs.push("Secure");
  reply.header("set-cookie", attrs.join("; "));
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k) out[k] = part.slice(eq + 1).trim();
  }
  return out;
}
