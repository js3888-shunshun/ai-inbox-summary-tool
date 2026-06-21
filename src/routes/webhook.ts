import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyPluginCallback, FastifyRequest } from "fastify";
import type { DB } from "../db/index.js";
import type { MailProvider } from "../mail/provider.js";
import { isOwnDigest } from "../domain/digest.js";
import { upsertMessage } from "../store/messages.js";

interface WebhookDeps {
  db: DB;
  mail: MailProvider;
  webhookSecret: string;
}

/** Minimal shape we rely on from a Nylas `message.created` event. */
interface NylasWebhookPayload {
  type?: string;
  data?: {
    grant_id?: string;
    object?: { id?: string; grant_id?: string };
  };
}

/** Request augmented with the raw body captured for HMAC verification. */
type WithRaw = FastifyRequest & { rawBody?: Buffer };

function headerValue(h: string | string[] | undefined): string | undefined {
  return Array.isArray(h) ? h[0] : h;
}

/** Constant-time verification of the x-nylas-signature HMAC-SHA256 (hex). */
function verifySignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  let provided: Buffer;
  let expectedBuf: Buffer;
  try {
    provided = Buffer.from(signature, "hex");
    expectedBuf = Buffer.from(expected, "hex");
  } catch {
    return false;
  }
  return provided.length === expectedBuf.length && timingSafeEqual(provided, expectedBuf);
}

/**
 * Nylas `message.created` webhook, encapsulated so its raw-body parser does not
 * affect other routes. Handler contract:
 *   - GET  completes the challenge/verification handshake (echo `challenge`)
 *   - POST verifies the HMAC, acknowledges with 200 immediately, and does the
 *     heavy work (refetch full message + idempotent store) outside the request.
 * Duplicate/out-of-order deliveries are absorbed by the idempotent upsert;
 * truncated payloads are tolerated by always refetching the full message.
 */
export function webhookPlugin(deps: WebhookDeps): FastifyPluginCallback {
  const { db, mail, webhookSecret } = deps;

  return (fastify, _opts, done) => {
    // Keep the raw bytes so we can verify the signature, but still expose parsed JSON.
    fastify.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, onDone) => {
      (req as WithRaw).rawBody = body as Buffer;
      const buf = body as Buffer;
      if (buf.length === 0) return onDone(null, {});
      try {
        onDone(null, JSON.parse(buf.toString("utf8")));
      } catch {
        onDone(null, {}); // signature is verified on raw bytes regardless
      }
    });

    fastify.get("/webhooks/nylas", async (req, reply) => {
      const challenge = (req.query as { challenge?: string }).challenge;
      return reply.type("text/plain").send(challenge ?? "");
    });

    fastify.post("/webhooks/nylas", async (req, reply) => {
      const rawBody = (req as WithRaw).rawBody ?? Buffer.alloc(0);
      const signature = headerValue(req.headers["x-nylas-signature"]);
      if (!verifySignature(rawBody, signature, webhookSecret)) {
        fastify.log.warn("rejected webhook with invalid signature");
        return reply.code(401).send({ error: "invalid signature" });
      }

      // Acknowledge immediately; do the refetch + store off the request path.
      const payload = req.body as NylasWebhookPayload;
      setImmediate(() => {
        void ingest(payload).catch((err) => fastify.log.error({ err }, "webhook ingest failed"));
      });
      return reply.code(200).send({ ok: true });
    });

    async function ingest(payload: NylasWebhookPayload): Promise<void> {
      if (payload.type && payload.type !== "message.created") return;
      const messageId = payload.data?.object?.id;
      const grantId = payload.data?.object?.grant_id ?? payload.data?.grant_id;
      if (!messageId || !grantId) {
        fastify.log.warn("webhook payload missing message id or grant id");
        return;
      }
      // Always refetch the full message: handles truncated payloads uniformly.
      const full = await mail.getMessage(grantId, messageId);
      // Only accumulate inbox mail — skip spam, trash, sent, etc.
      if (full.folders && !full.folders.includes("INBOX")) {
        fastify.log.info({ messageId, folders: full.folders }, "skipped non-inbox message");
        return;
      }
      // Never ingest the app's own digest emails (avoids self-summarizing loops).
      if (isOwnDigest(full.subject)) {
        fastify.log.info({ messageId }, "skipped own digest email");
        return;
      }
      const inserted = upsertMessage(db, full);
      fastify.log.info({ messageId, inserted }, "webhook message ingested");
    }

    done();
  };
}
