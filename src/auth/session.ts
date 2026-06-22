import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Login sessions for multi-tenancy. A logged-in user is identified by their
 * user id carried in an HMAC-signed cookie:
 *   - signed, so a client cannot forge another user's id;
 *   - HttpOnly, so it is not readable from page JavaScript;
 *   - SameSite=Lax, so it still rides the top-level redirect back from Nylas to
 *     /oauth/callback;
 *   - Secure when served over HTTPS.
 *
 * The cookie only proves "this browser is logged in as user X". Authentication
 * (username + password) happens in the account routes, which call `login` to
 * set it and `logout` to clear it.
 */
const SID_COOKIE = "sid";
const MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

export interface Session {
  /** The authenticated user id from a valid cookie, or undefined. */
  readUser(req: FastifyRequest): string | undefined;
  /** Set the signed session cookie for a freshly authenticated user. */
  login(reply: FastifyReply, userId: string): void;
  /** Clear the session cookie. */
  logout(reply: FastifyReply): void;
}

export function createSession(secret: string, secure: boolean): Session {
  return {
    readUser(req) {
      const raw = parseCookies(req.headers.cookie)[SID_COOKIE];
      return raw ? unsign(raw, secret) : undefined;
    },
    login(reply, userId) {
      setCookie(reply, sign(userId, secret), MAX_AGE_S, secure);
    },
    logout(reply) {
      setCookie(reply, "", 0, secure);
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

function setCookie(reply: FastifyReply, value: string, maxAge: number, secure: boolean): void {
  const attrs = [`${SID_COOKIE}=${value}`, "Path=/", `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Lax"];
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
