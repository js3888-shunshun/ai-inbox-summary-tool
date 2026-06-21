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
      return reply.type("text/html").send(connectedPage(email));
    } catch (err) {
      app.log.error({ err }, "code exchange failed");
      return reply
        .code(502)
        .type("text/html")
        .send("<h2>Could not connect mailbox</h2><p>The code was invalid or expired. Please try again.</p>");
    }
  });
}

/**
 * Success page shown after a grant is created. When opened in the script-opened
 * connect tab, it refreshes the dashboard (opener) and closes itself; if the
 * browser blocks auto-close (or the page was opened directly), it falls back to
 * a clear message with a link back to the dashboard.
 */
function connectedPage(email: string): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mailbox connected</title>
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f5f6f8;
    color:#1f2329;display:grid;place-items:center;min-height:100vh;margin:0}
  .box{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:32px 36px;
    box-shadow:0 1px 3px rgba(16,24,40,.1);text-align:center;max-width:380px}
  h2{margin:0 0 8px;font-size:19px}
  p{margin:6px 0;color:#6b7280;font-size:14px}
  .email{color:#1f2329;font-weight:600}
  a{color:#1557b0;text-decoration:none;font-weight:500}
</style></head>
<body>
  <div class="box">
    <h2>Mailbox connected</h2>
    <p class="email">${escapeHtml(email)}</p>
    <p id="hint">Returning to the dashboard</p>
  </div>
  <script>
    (function () {
      var opener = window.opener;
      if (opener && !opener.closed) {
        try { opener.location.reload(); } catch (e) {}
        window.close();
      }
      setTimeout(function () {
        var h = document.getElementById("hint");
        if (h) h.innerHTML = 'You can close this tab. <a href="/">Open the dashboard</a>';
      }, 800);
    })();
  </script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
