import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { openDb, type DB } from "../src/db/index.js";
import { webhookPlugin } from "../src/routes/webhook.js";
import { saveGrant } from "../src/store/grants.js";
import { upsertMessage } from "../src/store/messages.js";
import type { MailProvider } from "../src/mail/provider.js";
import type { EmailMessage } from "../src/domain/types.js";

const SECRET = "test-webhook-secret";

function fakeMail(): MailProvider {
  return {
    authUrl: () => "https://auth.example",
    exchangeCode: async () => ({ grantId: "g1", email: "u@example.com" }),
    listMessages: async () => [],
    // Simulates the refetch of a (possibly truncated) message by id.
    getMessage: async (grantId, messageId): Promise<EmailMessage> => ({
      id: messageId,
      grantId,
      threadId: "t1",
      from: "Alice",
      fromEmail: "alice@example.com",
      subject: "Hello",
      snippet: "hi there",
      receivedAt: 1_750_000_000,
      unread: true,
    }),
    sendEmail: async () => {},
    revokeGrant: async () => {},
  };
}

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(Buffer.from(body, "utf8")).digest("hex");
}

async function flush(): Promise<void> {
  // let the setImmediate ingest + async getMessage settle
  await new Promise((r) => setTimeout(r, 30));
}

let app: FastifyInstance;
let db: DB;

beforeEach(async () => {
  db = openDb(":memory:");
  // messages.grant_id is a FK; the connected grant must exist first.
  saveGrant(db, { grantId: "g1", email: "u@example.com", destinationEmail: "u@example.com", createdAt: Date.now() });
  app = Fastify();
  await app.register(webhookPlugin({ db, mail: fakeMail(), webhookSecret: SECRET }));
  await app.ready();
});

function countMessages(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
}

describe("webhook", () => {
  it("completes the challenge handshake on GET", async () => {
    const res = await app.inject({ method: "GET", url: "/webhooks/nylas?challenge=abc123" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("abc123");
  });

  it("rejects a payload with an invalid signature (401)", async () => {
    const body = JSON.stringify({ type: "message.created", data: { object: { id: "m1", grant_id: "g1" } } });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/nylas",
      headers: { "content-type": "application/json", "x-nylas-signature": "deadbeef" },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    await flush();
    expect(countMessages()).toBe(0);
  });

  it("accepts a valid signature, returns 200 fast, and ingests the message", async () => {
    const body = JSON.stringify({ type: "message.created", data: { object: { id: "m1", grant_id: "g1" } } });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/nylas",
      headers: { "content-type": "application/json", "x-nylas-signature": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    await flush();
    expect(countMessages()).toBe(1);
  });

  it("is idempotent across duplicate deliveries", async () => {
    const body = JSON.stringify({ type: "message.created", data: { object: { id: "dup", grant_id: "g1" } } });
    const headers = { "content-type": "application/json", "x-nylas-signature": sign(body) };
    await app.inject({ method: "POST", url: "/webhooks/nylas", headers, payload: body });
    await app.inject({ method: "POST", url: "/webhooks/nylas", headers, payload: body });
    await flush();
    expect(countMessages()).toBe(1);
  });

  it("reports a fresh insert vs a duplicate via upsertMessage's return", () => {
    const m: EmailMessage = {
      id: "x1", grantId: "g1", threadId: null, from: "A", fromEmail: "a@x.com",
      subject: "s", snippet: "", receivedAt: 1, unread: true,
    };
    expect(upsertMessage(db, m)).toBe(true); // first delivery -> inserted
    expect(upsertMessage(db, m)).toBe(false); // duplicate delivery -> not inserted
    expect(countMessages()).toBe(1);
  });
});
