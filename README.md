# AI Inbox Summary (Nylas)

Connects a mailbox through **Nylas**, ingests incoming mail with a **webhook**, and
emails an **AI-written digest** of the inbox on a schedule you choose, so you can
read one summary instead of the whole firehose.

It runs as a single long-lived **Fastify** (TypeScript/Node) service backed by
**SQLite**, with the summary step handled by **Claude**. [`ROADMAP.md`](./ROADMAP.md)
has the milestone-by-milestone build log and the decisions behind it.

---

## Architecture

One process does everything. Both the webhook receiver and the scheduler need a
long-running server, so a browser-only client would not be enough on its own.

```
                       ┌──────────── Fastify (single Node process) ────────────┐
 Browser ── /auth ───▶ │ OAuth routes ──▶ exchange code ──▶ grant               │
 Nylas ─ message.created ▶ /webhooks/nylas (HMAC verify · 200 fast · async)     │
                       │        │ refetch full message                          │
                       │        ▼                                               │
                       │   SQLite: grants · messages · schedules · sent_windows │
                       │        ▲                                               │
 Scheduler (60s poll) ─┼─ due window? ─▶ unsummarized mail ─▶ AI seam ─▶ send ──┘
                       └───────────────────────────────────────────────────────┘
 Adapters behind interfaces:  MailProvider (Nylas)   Summarizer (Claude)   (both fakeable)
```

**Key modules**
- `src/mail/`: the `MailProvider` interface plus `NylasMailProvider`, the only file that imports the Nylas SDK.
- `src/ai/`: the testable AI seam. `prompt.ts` (assemble), an injected `CompletionFn` (call), `parse.ts` (parse and validate), `claude-summarizer.ts`, `anthropic.ts`.
- `src/scheduler/`: `cadence.ts` (pure window math) and `scheduler.ts` (the poller and the exactly-once send).
- `src/store/`: thin SQLite data access for `grants`, `messages`, `schedules`, `sent-windows`, and `users`.
- `src/auth/`: the signed login-session cookie.
- `src/routes/`: `account` (register/login), `auth`, `webhook`, `settings` (home UI plus `/schedule` and `/send-now`), `digest` (preview).

---

## Prerequisites

- Node.js 20 or newer
- A free **Nylas** application (API key, OAuth client, and a connected mailbox)
- An **Anthropic (Claude)** API key

## Setup & run

```bash
npm install
cp .env.example .env        # fill in real values (see below)
npm run build && npm start  # or: npm run dev
curl localhost:3000/health  # -> {"ok":true}
npm test                    # unit tests (no live mailbox or real LLM needed)
```

### Configuration (all from env, nothing hard-coded)

| Var | Purpose |
|-----|---------|
| `PUBLIC_BASE_URL` | Public HTTPS base of this service; used to build the OAuth callback and webhook URLs |
| `PORT` / `HOST` | Listen address (default `3000` / `0.0.0.0`) |
| `DATABASE_PATH` | SQLite file path (default `./data/app.db`) |
| `NYLAS_API_KEY` | Nylas API key (`nyk_...`), also used as the OAuth client secret |
| `NYLAS_API_URI` | Nylas region base (default `https://api.us.nylas.com`) |
| `NYLAS_CLIENT_ID` | Nylas application / OAuth client id |
| `NYLAS_WEBHOOK_SECRET` | Webhook signing secret (written by `npm run register:webhook`) |
| `ANTHROPIC_API_KEY` | Claude API key (`sk-ant-...`) |
| `LLM_MODEL` | Claude model (default `claude-haiku-4-5-20251001`) |

Config is validated once at startup with zod, so missing or invalid values fail fast.
There is no cookie secret to set: the login-session signing key is generated on first
run and stored in the database.

---

## Set up a Nylas app from scratch

1. Sign up at **https://dashboard-v3.nylas.com** (choose the **US** region to match `api.us.nylas.com`).
2. In your application, copy the **Client ID** (application id), then under **API Keys → Generate new key** create an API key (`nyk_...`, shown once).
3. **Connect a test mailbox** under **Grants → Add Account**. A personal Gmail works well; org accounts often block third-party OAuth.
4. **Register the OAuth callback**: add `https://<PUBLIC_BASE_URL>/oauth/callback` to the application's hosted-auth callback URIs. Nylas requires HTTPS for any non-localhost callback.
5. Put `NYLAS_CLIENT_ID`, `NYLAS_API_KEY`, and `ANTHROPIC_API_KEY` into `.env`.
6. Start the app, then register the webhook. The app must be publicly reachable so Nylas can complete the challenge handshake:
   ```bash
   npm run register:webhook   # creates the message.created webhook, writes NYLAS_WEBHOOK_SECRET to .env
   ```
   Restart the app to load the secret.

## Exposing the webhook over HTTPS (on the VM)

Nylas rejects non-localhost `http` callbacks, so the service needs TLS. This is a
real certificate on the VM, not a dev tunnel:

- A public hostname comes from **sslip.io** (`<dashed-ip>.sslip.io` resolves to the VM IP).
- **Caddy** terminates TLS with an auto-provisioned **Let's Encrypt** certificate and reverse-proxies `:443 → localhost:3000`. The whole `Caddyfile`:
  ```
  135-148-170-25.sslip.io {
      reverse_proxy localhost:3000
  }
  ```
  (Caddy was granted `cap_net_bind_service` so it binds 80/443 without root.)

`PUBLIC_BASE_URL` is then `https://135-148-170-25.sslip.io`, and the registered
callback and webhook URLs hang off it.

---

## Generate test mail (optional)

To exercise the pipeline without hand-sending from another account, use either the
**Testing panel** at the bottom of the home page (pick a mailbox and a count, then
click *Send test emails*) or the CLI:

```bash
npm run seed:mail               # one of each built-in template
npm run seed:mail -- --count 6  # cycle to N messages
```

Messages are sent through Nylas to the connected mailbox's own address, so they land
in the inbox and trigger the `message.created` webhook. A grant can only send *as*
its own address, so the From is always the connected mailbox. The variety is in the
subject, body, and tone (urgent, action, info), which is what the digest groups on.

## End-to-end flow

0. **Sign in.** Open `/`. If you are not logged in you are sent to `/login`. Register an account (`/register`, username and password) or sign in. Each account is isolated: you only see and control the mailboxes you connected, and the dashboard shows a *Sign out* control. Passwords are stored only as salted scrypt hashes.
1. **Connect.** From the dashboard, click *Connect a mailbox*. Hosted auth opens in a new tab. After you sign in and grant consent at your provider, the tab closes itself and the dashboard refreshes with the new mailbox. Any provider enabled for your Nylas app works (Google, Microsoft/Outlook, IMAP, and so on). Connecting always needs the mailbox owner's OAuth consent, so you cannot connect a mailbox without the owner signing in. You can connect as many mailboxes as you like; each is an independent grant with its own cadence, destination, and on/off switch, and a sensible default schedule is created so it starts active.
2. **Configure.** On `/`, per mailbox, set a cadence (`hourly`, `every:5m`, `every:2h`, `daily:09:00`), a timezone, and the destination address (which may differ from the mailbox). Each mailbox can be paused, resumed, or disconnected. Disconnecting revokes the grant on Nylas and drops its local data.
3. **Ingest.** When mail arrives, Nylas calls `/webhooks/nylas`. The handler verifies the HMAC, returns `200` right away, then refetches the full message and stores it (deduped).
4. **Summarize and send.** On each scheduler tick, a due window claims its idempotency key, summarizes the mail collected since the last digest, and emails it through Nylas to the destination.
5. **Preview or trigger.** `/debug/digest` previews a digest; the *Send digest now* button sends one immediately.

---

## Design decisions & tradeoffs

**Scheduling: a DB-backed poller plus an idempotency ledger.** A 60-second poll runs
over the enabled schedules, with the cadence math kept pure in `cadence.ts`. The three
required invariants:
- *Survives restart.* The cadence and the `sent_windows` ledger live in SQLite, not in memory.
- *Per-grant.* Schedules are keyed by `grantId`, and the tick iterates each enabled one.
- *Exactly once.* Each window has a deterministic key (`cadence@ISO-boundary`). `claimWindow` does an `INSERT OR IGNORE` on the `sent_windows` primary key, so only one caller can win, whether across a restart, a double run, or multiple instances. The claim happens before sending; on a send failure the claim is released so a later tick retries. I chose this over BullMQ/Redis because SQLite already gives durability and atomic claims with far less to run on a bare VM.

**Collecting and de-duplicating incoming mail.** The webhook stores messages keyed on
the Nylas message id (primary key), so duplicate and out-of-order deliveries are
no-ops. Payloads can be truncated, so the handler always refetches the full message
rather than trusting the webhook body. Only INBOX mail is accumulated; spam, trash,
and sent mail are skipped at ingestion. A `summarized` flag marks what a digest has
already covered, so the next window only includes new mail and never refetches the
whole mailbox. At digest time the accumulated set is validated against the live
inbox, so mail that was deleted or moved after it arrived is left out. The digest
reflects what is actually in the inbox now, not just what once arrived.

**Self-reference.** When the digest's destination is the connected mailbox itself,
each digest email lands back in the inbox. Digests carry a known subject prefix and
are filtered out of both ingestion and summarization, so the app never summarizes its
own output. Manual *Send digest now* summarizes a snapshot of the recent inbox (the
same view as the preview); the scheduled digest covers only mail accumulated since the
last one.

**The AI seam is a clean, testable boundary.** It has three explicit steps: assemble
(`buildSummaryPrompt`), call (an injected `CompletionFn`), and parse (`parseDigest`,
which validates the model's JSON with zod). The model is asked for strict JSON so
parsing is deterministic. Because the call is injected, the summarizer is unit-tested
with a fake completion, so no API key or live mailbox is needed, and Claude can be
swapped for any provider by supplying a different `CompletionFn`.

**Provider-agnostic core.** Everything depends on the `MailProvider` and `Summarizer`
interfaces. The Nylas and Anthropic SDKs are each confined to one adapter file, so they
can be faked or swapped.

**Accounts and per-user isolation.** The app is multi-tenant. A visitor registers with
a username and password and signs in; after that they only see the mailboxes their own
account connected. Passwords are hashed with scrypt and stored as `salt:key`, never in
plaintext. The login state is an HMAC-signed, HttpOnly cookie set to SameSite=Lax so it
survives the redirect back from Nylas. The signing key is generated once and kept in a
small `meta` table, so there is no extra environment variable to manage. Every page and
every mutation is scoped to the signed-in user, so one account cannot read or change
another account's mailbox even if it guesses the grant id.

**Security.** Secrets come only from env. The webhook HMAC is checked with a
constant-time compare before any payload is trusted. Logs redact the auth and signature
headers and never include message bodies or tokens.

**CommonJS build.** The project targets CommonJS. The Nylas v8 SDK's dual-package
typings resolve cleanly through its `require` condition, and better-sqlite3 is
CJS-native, which avoids ESM dual-package friction for no benefit on a Node service.

## What I'd do with more time

- **Delivery guarantees:** an outbox table with retry and backoff and a provider-side idempotency key, so a failed send is retried without any chance of a duplicate.
- **Richer digests:** HTML email templating, per-sender importance learned over time, and thread-aware grouping.
- **Public multi-tenant launch:** accounts and per-user isolation are already done. What remains is moving the Nylas/Google app from sandbox to production/verified, plus the usual account hardening (email verification, password reset, login rate limiting).
- **Ops:** structured metrics, webhook replay protection via event-id dedup, and a dead-letter log for failed ingests.
- **Tests:** type-check the test files in CI, and add an integration test against a Nylas sandbox.

## Deliberately left out

- A job queue (BullMQ/Redis). SQLite proves the three scheduling invariants without the extra infrastructure.
- Sending a digest when there is no new mail. Empty windows are consumed silently to avoid noise.
- OAuth token refresh handling beyond what Nylas grants provide.

## Project layout

```
src/
  config.ts            env loading + validation (zod)
  server.ts            composition root: wires routes, starts the scheduler
  domain/types.ts      provider-agnostic domain types
  auth/session.ts      signed login-session cookie
  mail/                MailProvider interface + Nylas adapter
  ai/                  prompt / parse / summarizer / anthropic (the AI seam)
  scheduler/           cadence (pure) + scheduler (poller, exactly-once)
  store/               SQLite data access (grants, messages, schedules, sent-windows, users)
  routes/              account · auth · webhook · settings · digest
scripts/register-webhook.ts   one-off: create the Nylas message.created webhook
scripts/seed-test-mail.ts     dev: send synthetic test emails into the pipeline
test/                  vitest unit tests
```

## Tests

`npm test` runs 40 unit tests, and none of them need a live mailbox or a real LLM. They
cover the AI seam (prompt building, parsing, a fake completion), the webhook (challenge
handshake, HMAC accept and reject, idempotent ingest including fresh-vs-duplicate
detection), the scheduler (cadence math and exactly-once-per-window), digest selection
and category filtering, and accounts (scrypt password hashing, session signing and
verification, and per-user grant isolation).
