import { describe, it, expect } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { openDb, getOrCreateCookieSecret, type DB } from "../src/db/index.js";
import { createSession } from "../src/auth/session.js";
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
  return `owner=${setCookie.split(";")[0].split("=").slice(1).join("=")}`;
}

describe("owner session cookie", () => {
  const session = createSession("test-secret-0123456789", true);

  it("issues an owner, then reads the same owner back from the cookie it set", () => {
    const reply = fakeReply();
    const issued = session.currentOrIssue(fakeReq(), reply);
    expect(issued).toMatch(/[0-9a-f-]{36}/);
    expect(reply.setCookieHeader).toContain("HttpOnly");
    expect(reply.setCookieHeader).toContain("Secure");

    const read = session.readOwner(fakeReq(cookieFrom(reply.setCookieHeader!)));
    expect(read).toBe(issued);
  });

  it("rejects a tampered cookie and a foreign signature", () => {
    expect(session.readOwner(fakeReq("owner=someone.deadbeef"))).toBeUndefined();
    const other = createSession("a-different-secret-value", true);
    const reply = fakeReply();
    other.currentOrIssue(fakeReq(), reply);
    expect(session.readOwner(fakeReq(cookieFrom(reply.setCookieHeader!)))).toBeUndefined();
  });

  it("does not mark the cookie Secure when not served over HTTPS", () => {
    const insecure = createSession("test-secret-0123456789", false);
    const reply = fakeReply();
    insecure.currentOrIssue(fakeReq(), reply);
    expect(reply.setCookieHeader).not.toContain("Secure");
  });
});

describe("grant ownership isolation", () => {
  function db(): DB {
    return openDb(":memory:");
  }
  const base = { destinationEmail: "d@x.com", createdAt: 1, primaryOnly: false };

  it("each owner only sees their own grants", () => {
    const d = db();
    saveGrant(d, { grantId: "ga", email: "a@x.com", ownerId: "owner-1", ...base });
    saveGrant(d, { grantId: "gb", email: "b@x.com", ownerId: "owner-1", ...base });
    saveGrant(d, { grantId: "gc", email: "c@x.com", ownerId: "owner-2", ...base });

    expect(listGrantsByOwner(d, "owner-1").map((g) => g.grantId)).toEqual(["ga", "gb"]);
    expect(listGrantsByOwner(d, "owner-2").map((g) => g.grantId)).toEqual(["gc"]);
  });

  it("getOwnedGrant refuses a grant owned by someone else", () => {
    const d = db();
    saveGrant(d, { grantId: "gc", email: "c@x.com", ownerId: "owner-2", ...base });
    expect(getOwnedGrant(d, "gc", "owner-2")).toBeDefined();
    expect(getOwnedGrant(d, "gc", "owner-1")).toBeUndefined();
  });

  it("claims a legacy unclaimed grant on reconnect but never reassigns an owned one", () => {
    const d = db();
    // Legacy row: no owner.
    saveGrant(d, { grantId: "leg", email: "l@x.com", ...base });
    expect(getGrant(d, "leg")?.ownerId).toBeNull();

    // Reconnect (same grantId) with an owner -> claimed.
    saveGrant(d, { grantId: "leg", email: "l@x.com", ownerId: "owner-1", ...base });
    expect(getOwnedGrant(d, "leg", "owner-1")).toBeDefined();

    // A later reconnect cannot steal it for a different owner.
    saveGrant(d, { grantId: "leg", email: "l@x.com", ownerId: "owner-2", ...base });
    expect(getOwnedGrant(d, "leg", "owner-2")).toBeUndefined();
    expect(getOwnedGrant(d, "leg", "owner-1")).toBeDefined();
  });

  it("persists and reuses a generated cookie secret", () => {
    const d = db();
    const s1 = getOrCreateCookieSecret(d);
    const s2 = getOrCreateCookieSecret(d);
    expect(s1).toBe(s2);
    expect(s1.length).toBeGreaterThan(20);
  });
});
