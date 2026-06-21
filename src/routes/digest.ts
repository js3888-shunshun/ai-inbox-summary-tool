import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import type { MailProvider } from "../mail/provider.js";
import type { Summarizer } from "../ai/summarizer.js";
import { listGrants } from "../store/grants.js";

interface DigestDeps {
  db: DB;
  mail: MailProvider;
  summarizer: Summarizer;
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
  const { db, mail, summarizer } = deps;

  app.get("/debug/digest", async (req, reply) => {
    const q = req.query as DigestQuery;
    const grantId = q.grantId ?? listGrants(db)[0]?.grantId;
    if (!grantId) {
      return reply.code(404).type("text/html").send("<h2>No connected mailbox. Visit /auth first.</h2>");
    }

    const limit = Math.min(Math.max(Number(q.limit ?? 30) || 30, 1), 100);
    const messages = await mail.listMessages(grantId, { limit });
    const digest = await summarizer.summarize(messages);

    return reply
      .type("text/html")
      .send(
        `<!doctype html><meta charset="utf-8">` +
          `<h1>${escapeHtml(digest.headline)}</h1>` +
          `<p><em>Covering ${digest.messageCount} message(s).</em></p>` +
          `<pre style="white-space:pre-wrap;font-family:system-ui">${escapeHtml(digest.body)}</pre>`,
      );
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
