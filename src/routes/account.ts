import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import type { Session } from "../auth/session.js";
import { authenticate, createUser, currentUser, UsernameTakenError } from "../store/users.js";

interface AccountDeps {
  db: DB;
  session: Session;
}

interface Credentials {
  username?: string;
  password?: string;
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const MIN_PASSWORD = 8;

/**
 * Self-serve accounts: register, log in, log out. Forms post as
 * application/x-www-form-urlencoded so they work without client JS (Enter to
 * submit, browser password managers, etc.).
 */
export function registerAccountRoutes(app: FastifyInstance, deps: AccountDeps): void {
  const { db, session } = deps;

  // Parse classic form posts. Harmless alongside the JSON parser used elsewhere.
  if (!app.hasContentTypeParser("application/x-www-form-urlencoded")) {
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );
  }

  app.get("/login", async (req, reply) => {
    if (currentUser(db, session, req)) return reply.redirect("/");
    return reply.type("text/html").send(authPage("login"));
  });

  app.get("/register", async (req, reply) => {
    if (currentUser(db, session, req)) return reply.redirect("/");
    return reply.type("text/html").send(authPage("register"));
  });

  app.post("/login", async (req, reply) => {
    const { username, password } = req.body as Credentials;
    const userId = username && password ? authenticate(db, username, password) : undefined;
    if (!userId) {
      return reply.code(401).type("text/html").send(authPage("login", "Incorrect username or password."));
    }
    session.login(reply, userId);
    return reply.redirect("/");
  });

  app.post("/register", async (req, reply) => {
    const username = (req.body as Credentials).username?.trim() ?? "";
    const password = (req.body as Credentials).password ?? "";
    if (!USERNAME_RE.test(username)) {
      return reply.code(400).type("text/html")
        .send(authPage("register", "Username must be 3-32 chars: letters, numbers, . _ - only."));
    }
    if (password.length < MIN_PASSWORD) {
      return reply.code(400).type("text/html")
        .send(authPage("register", `Password must be at least ${MIN_PASSWORD} characters.`));
    }
    try {
      const user = createUser(db, username, password);
      session.login(reply, user.id);
      return reply.redirect("/");
    } catch (err) {
      if (err instanceof UsernameTakenError) {
        return reply.code(409).type("text/html").send(authPage("register", "That username is already taken."));
      }
      app.log.error({ err }, "registration failed");
      return reply.code(500).type("text/html").send(authPage("register", "Something went wrong. Please try again."));
    }
  });

  app.post("/logout", async (_req, reply) => {
    session.logout(reply);
    return reply.redirect("/login");
  });
}

/** Render the shared login/register card. `mode` picks copy + action; `error` is optional. */
function authPage(mode: "login" | "register", error?: string): string {
  const isLogin = mode === "login";
  const title = isLogin ? "Sign in" : "Create your account";
  const action = isLogin ? "/login" : "/register";
  const cta = isLogin ? "Sign in" : "Create account";
  const alt = isLogin
    ? `New here? <a href="/register">Create an account</a>`
    : `Already have an account? <a href="/login">Sign in</a>`;
  const hint = isLogin ? "" : `<p class="hint">At least 8 characters. Choose something only you know.</p>`;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — AI Inbox Summary</title>
<style>${AUTH_STYLE}</style>
</head><body>
<div class="card">
  <h1>AI Inbox Summary</h1>
  <h2>${title}</h2>
  ${error ? `<div class="err">${esc(error)}</div>` : ""}
  <form method="post" action="${action}" autocomplete="on">
    <label>Username
      <input name="username" autocomplete="username" autofocus required
        minlength="3" maxlength="32" placeholder="your-name">
    </label>
    <label>Password
      <input name="password" type="password"
        autocomplete="${isLogin ? "current-password" : "new-password"}" required
        minlength="${isLogin ? 1 : MIN_PASSWORD}" placeholder="••••••••">
    </label>
    ${hint}
    <button type="submit">${cta}</button>
  </form>
  <p class="alt">${alt}</p>
</div>
</body></html>`;
}

const AUTH_STYLE = `
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f6f8;color:#1f2329;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5;padding:24px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 1px 3px rgba(16,24,40,.1);
  padding:32px 32px 28px;width:100%;max-width:380px}
h1{font-size:15px;letter-spacing:.04em;text-transform:uppercase;color:#6b7280;margin:0 0 18px}
h2{font-size:21px;margin:0 0 18px}
form{display:flex;flex-direction:column;gap:14px}
label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:600;color:#374151}
input{font:inherit;font-size:15px;color:#1f2329;border:1px solid #e5e7eb;border-radius:9px;padding:10px 12px}
input:focus{outline:none;border-color:#1a73e8;box-shadow:0 0 0 3px rgba(26,115,232,.15)}
button{font:inherit;font-size:15px;font-weight:600;margin-top:4px;cursor:pointer;border:none;
  background:#1a73e8;color:#fff;padding:11px;border-radius:9px}
button:hover{background:#1557b0}
.hint{font-size:12px;color:#6b7280;margin:-4px 0 0}
.err{background:#fdecec;color:#dc2626;font-size:13px;border-radius:9px;padding:10px 12px;margin-bottom:16px}
.alt{font-size:13px;color:#6b7280;text-align:center;margin:18px 0 0}
a{color:#1557b0;text-decoration:none;font-weight:500}
a:hover{text-decoration:underline}
`;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
