import { describe, it, expect } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { openDb, getOrCreateCookieSecret, type DB } from "../src/db/index.js";
import { createSession } from "../src/auth/session.js";
import {
  authenticate,
  createUser,
  currentUser,
  getUser,
  UsernameTakenError,
} from "../src/store/users.js";
import {
  saveGrant,
  getOwnedGrant,
  listGrantsByOwner,
  getGrant,
} from "../src/store/grants.js";

/** Minimal Fastify request/reply doubles: a cookie header in, a set-cookie out. */
function fakeReq(cookie?: string): FastifyRequest {
  return { headers: cookie ? { cookie } : {} } as unknown as FastifyRequest;
}
function fakeReply(): FastifyReply & { setCookieHeader?: string } {
  const r = {
    header(name: string, value: string) {
      if (name === "set-cookie") (r as { setCookieHeader?: string }).setCookieHeader = value;
      return r;
    },
  };
  return r as unknown as FastifyReply & { setCookieHeader?: string };
}
/** Pull the raw cookie value out of a Set-Cookie header so it can be replayed. */
function cookieFrom(setCookie: string): string {
  return setCookie.split(";")[0];
}

describe("login session cookie", () => {
  const session = createSession("test-secret-0123456789", true);

  it("logs a user in, then reads the same user id back from the cookie it set", () => {
    const reply = fakeReply();
    session.login(reply, "user-123");
    expect(reply.setCookieHeader).toContain("HttpOnly");
    expect(reply.setCookieHeader).toContain("Secure");
    expect(session.readUser(fakeReq(cookieFrom(reply.setCookieHeader!)))).toBe("user-123");
  });

  it("logout clears the cookie", () => {
    const reply = fakeReply();
    session.logout(reply);
    expect(reply.setCookieHeader).toContain("Max-Age=0");
  });

  it("rejects a tampered cookie and a foreign signature", () => {
    expect(session.readUser(fakeReq("sid=someone.deadbeef"))).toBeUndefined();
    const other = createSession("a-different-secret-value", true);
    const reply = fakeReply();
    other.login(reply, "user-123");
    expect(session.readUser(fakeReq(cookieFrom(reply.setCookieHeader!)))).toBeUndefined();
  });

  it("omits Secure when not served over HTTPS", () => {
    const insecure = createSession("test-secret-0123456789", false);
    const reply = fakeReply();
    insecure.login(reply, "u");
    expect(reply.setCookieHeader).not.toContain("Secure");
  });
});

describe("user accounts", () => {
  function db(): DB {
    return openDb(":memory:");
  }

  it("registers a user and authenticates with the right password only", () => {
    const d = db();
    const u = createUser(d, "Alice", "correct horse battery");
    expect(u.username).toBe("alice"); // stored lowercased
    expect(authenticate(d, "alice", "correct horse battery")).toBe(u.id);
    expect(authenticate(d, "ALICE", "correct horse battery")).toBe(u.id); // case-insensitive login
    expect(authenticate(d, "alice", "wrong")).toBeUndefined();
    expect(authenticate(d, "nobody", "x")).toBeUndefined();
  });

  it("never stores the password in plaintext", () => {
    const d = db();
    createUser(d, "bob", "s3cret-password");
    const row = d.prepare("SELECT password_hash FROM users WHERE username='bob'").get() as {
      password_hash: string;
    };
    expect(row.password_hash).not.toContain("s3cret-password");
    expect(row.password_hash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/); // salt:key hex
  });

  it("rejects a duplicate username", () => {
    const d = db();
    createUser(d, "carol", "password-1");
    expect(() => createUser(d, "carol", "password-2")).toThrow(UsernameTakenError);
  });

  it("resolves the current user from a session cookie", () => {
    const d = db();
    const session = createSession(getOrCreateCookieSecret(d), false);
    const u = createUser(d, "dave", "password-xyz");
    const reply = fakeReply();
    session.login(reply, u.id);
    const resolved = currentUser(d, session, fakeReq(cookieFrom(reply.setCookieHeader!)));
    expect(resolved?.username).toBe("dave");
    expect(getUser(d, u.id)?.id).toBe(u.id);
    // A signed cookie for a now-deleted user resolves to nobody.
    expect(currentUser(d, session, fakeReq("sid=ghost.deadbeef"))).toBeUndefined();
  });
});

describe("grant ownership isolation", () => {
  function db(): DB {
    return openDb(":memory:");
  }
  const base = { destinationEmail: "d@x.com", createdAt: 1, primaryOnly: false };

  it("each user only sees their own grants", () => {
    const d = db();
    saveGrant(d, { grantId: "ga", email: "a@x.com", ownerId: "user-1", ...base });
    saveGrant(d, { grantId: "gb", email: "b@x.com", ownerId: "user-1", ...base });
    saveGrant(d, { grantId: "gc", email: "c@x.com", ownerId: "user-2", ...base });

    expect(listGrantsByOwner(d, "user-1").map((g) => g.grantId)).toEqual(["ga", "gb"]);
    expect(listGrantsByOwner(d, "user-2").map((g) => g.grantId)).toEqual(["gc"]);
  });

  it("getOwnedGrant refuses a grant owned by someone else", () => {
    const d = db();
    saveGrant(d, { grantId: "gc", email: "c@x.com", ownerId: "user-2", ...base });
    expect(getOwnedGrant(d, "gc", "user-2")).toBeDefined();
    expect(getOwnedGrant(d, "gc", "user-1")).toBeUndefined();
  });

  it("reconnecting binds a (legacy or owned) grant to the connecting user", () => {
    const d = db();
    // Legacy row: no owner yet.
    saveGrant(d, { grantId: "leg", email: "l@x.com", ...base });
    expect(getGrant(d, "leg")?.ownerId).toBeNull();

    // Reconnect with a user -> claimed.
    saveGrant(d, { grantId: "leg", email: "l@x.com", ownerId: "user-1", ...base });
    expect(getOwnedGrant(d, "leg", "user-1")).toBeDefined();

    // Reconnecting under another account (which required passing OAuth) moves it.
    saveGrant(d, { grantId: "leg", email: "l@x.com", ownerId: "user-2", ...base });
    expect(getOwnedGrant(d, "leg", "user-2")).toBeDefined();
    expect(getOwnedGrant(d, "leg", "user-1")).toBeUndefined();
  });

  it("persists and reuses a generated cookie secret", () => {
    const d = db();
    expect(getOrCreateCookieSecret(d)).toBe(getOrCreateCookieSecret(d));
  });
});
