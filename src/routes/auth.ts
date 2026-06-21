import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import type { MailProvider } from "../mail/provider.js";
import { getGrant, saveGrant } from "../store/grants.js";

interface AuthDeps {
  db: DB;
  mail: MailProvider;
  /** Public callback URL registered with Nylas, e.g. https://host/oauth/callback */
  redirectUri: string;
}

interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

/**
 * Hosted-OAuth routes:
 *   GET /auth            -> redirect the user to Nylas hosted auth
 *   GET /oauth/callback  -> exchange the code for a grant and persist it
 *
 * Unhappy paths handled: user denies consent (`error`), missing code, and a
 * failed token exchange (e.g. expired/invalid code) — none of which crash.
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { db, mail, redirectUri } = deps;

  app.get("/auth", async (_req, reply) => {
    return reply.redirect(mail.authUrl(redirectUri));
  });

  app.get("/oauth/callback", async (req, reply) => {
    const q = req.query as CallbackQuery;

    if (q.error) {
      app.log.warn({ error: q.error }, "oauth consent not granted");
      return reply
        .code(400)
        .type("text/html")
        .send(`<h2>Authorization cancelled</h2><p>${escapeHtml(q.error)}</p>`);
    }
    if (!q.code) {
      return reply.code(400).type("text/html").send("<h2>Missing authorization code</h2>");
    }

    try {
      const { grantId, email } = await mail.exchangeCode(q.code, redirectUri);
      // Default the digest destination to the connected mailbox; changeable later.
      const existing = getGrant(db, grantId);
      saveGrant(db, {
        grantId,
        email,
        destinationEmail: existing?.destinationEmail ?? email,
        createdAt: existing?.createdAt ?? Date.now(),
      });
      app.log.info({ grantId }, "mailbox connected"); // never log tokens/bodies
      return reply
        .type("text/html")
        .send(
          `<h2>Mailbox connected ✅</h2><p>${escapeHtml(email)}</p>` +
            `<p>You can close this tab.</p>`,
        );
    } catch (err) {
      app.log.error({ err }, "code exchange failed");
      return reply
        .code(502)
        .type("text/html")
        .send("<h2>Could not connect mailbox</h2><p>The code was invalid or expired. Please try again.</p>");
    }
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
