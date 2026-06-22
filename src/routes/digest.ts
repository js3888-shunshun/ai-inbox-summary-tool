import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import type { MailProvider } from "../mail/provider.js";
import type { Summarizer } from "../ai/summarizer.js";
import type { Session } from "../auth/session.js";
import { listGrantsByOwner, getOwnedGrant } from "../store/grants.js";
import { excludeOwnDigests, filterByCategoryPolicy } from "../domain/digest.js";
import { renderDigestHtml } from "../email/render.js";

interface DigestDeps {
  db: DB;
  mail: MailProvider;
  summarizer: Summarizer;
  session: Session;
}

interface DigestQuery {
  grantId?: string;
  limit?: string;
}

/**
 * On-demand digest generation, used to exercise the read + AI seam before the
 * scheduler exists (M4) and to drive the demo. Reads recent inbox messages and
 * returns the generated digest. Does not send email — that is M4.
 */
export function registerDigestRoutes(app: FastifyInstance, deps: DigestDeps): void {
  const { db, mail, summarizer, session } = deps;

  app.get("/debug/digest", async (req, reply) => {
    const q = req.query as DigestQuery;
    const ownerId = session.currentOrIssue(req, reply);
    // Preview only a mailbox this visitor owns; default to their first connected one.
    const grant = q.grantId
      ? getOwnedGrant(db, q.grantId, ownerId)
      : listGrantsByOwner(db, ownerId)[0];
    if (!grant) {
      return reply.code(404).type("text/html").send("<h2>No connected mailbox. Visit /auth first.</h2>");
    }

    const limit = Math.min(Math.max(Number(q.limit ?? 30) || 30, 1), 100);
    const primaryOnly = grant.primaryOnly;
    const fetchN = primaryOnly ? 100 : Math.min(limit * 2 + 20, 100);
    const messages = filterByCategoryPolicy(
      excludeOwnDigests(await mail.listMessages(grant.grantId, { limit: fetchN })),
      primaryOnly,
    ).slice(0, limit);
    const digest = await summarizer.summarize(messages);

    return reply
      .type("text/html")
      .send(`<!doctype html><meta charset="utf-8"><body style="background:#f5f6f8;margin:0;padding:24px 0">${renderDigestHtml(digest)}</body>`);
  });
}
