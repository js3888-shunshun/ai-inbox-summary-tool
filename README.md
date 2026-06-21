# AI Inbox Summary (Nylas)

Connects a mailbox via **Nylas**, ingests incoming mail through a **webhook**, and
emails an **AI-written digest** of the inbox on a **user-configurable cadence** —
so you can skip the firehose and read one good summary.

Built on a single long-running **Fastify** (TypeScript/Node) service backed by
**SQLite**, with the LLM step provided by **Claude**. See [`ROADMAP.md`](./ROADMAP.md)
for the milestone-by-milestone build log.

---

## Architecture

One process does everything (the webhook receiver and the scheduler both need a
long-running server, so a browser-only client wouldn't be enough):

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
 Adapters behind interfaces:  MailProvider (Nylas)   Summarizer (Claude)   — both fakeable.
```

**Key modules**
- `src/mail/` — `MailProvider` interface + `NylasMailProvider` (the only file that imports the Nylas SDK).
- `src/ai/` — the testable AI seam: `prompt.ts` (assemble) · `CompletionFn` (call, injected) · `parse.ts` (parse/validate) · `claude-summarizer.ts` · `anthropic.ts`.
- `src/scheduler/` — `cadence.ts` (pure window math) + `scheduler.ts` (poller, exactly-once send).
- `src/store/` — thin SQLite data access (`grants`, `messages`, `schedules`, `sent-windows`).
- `src/routes/` — `auth`, `webhook`, `settings` (home UI + `/schedule` + `/send-now`), `digest` (preview).

---

## Prerequisites

- Node.js ≥ 20
- A free **Nylas** application (API key + OAuth client + a connected mailbox)
- An **Anthropic (Claude)** API key

## Setup & run

```bash
npm install
cp .env.example .env        # fill in real values (see below)
npm run build && npm start  # or: npm run dev
curl localhost:3000/health  # -> {"ok":true}
npm test                    # unit tests (no live mailbox / no real LLM needed)
```

### Configuration (all from env — nothing hard-coded)

| Var | Purpose |
|-----|---------|
| `PUBLIC_BASE_URL` | Public HTTPS base of this service; used to build the OAuth callback + webhook URLs |
| `PORT` / `HOST` | Listen address (default `3000` / `0.0.0.0`) |
| `DATABASE_PATH` | SQLite file path (default `./data/app.db`) |
| `NYLAS_API_KEY` | Nylas API key (`nyk_...`) — also used as the OAuth client secret |
| `NYLAS_API_URI` | Nylas region base (default `https://api.us.nylas.com`) |
| `NYLAS_CLIENT_ID` | Nylas application / OAuth client id |
| `NYLAS_WEBHOOK_SECRET` | Webhook signing secret (written by `npm run register:webhook`) |
| `ANTHROPIC_API_KEY` | Claude API key (`sk-ant-...`) |
| `LLM_MODEL` | Claude model (default `claude-haiku-4-5-20251001`) |

Config is validated once at startup with zod; missing/invalid values fail fast.

---

## Set up a Nylas app from scratch

1. Sign up at **https://dashboard-v3.nylas.com** (choose the **US** region to match `api.us.nylas.com`).
2. In your application: copy the **Client ID** (application id) and, under **API Keys → Generate new key**, create an API key (`nyk_...`, shown once).
3. **Connect a test mailbox**: **Grants → Add Account** (a personal Gmail works well; org accounts often block third-party OAuth).
4. **Register the OAuth callback**: add `https://<PUBLIC_BASE_URL>/oauth/callback` to the application's hosted-auth callback URIs. _Nylas requires HTTPS for any non-localhost callback._
5. Put `NYLAS_CLIENT_ID`, `NYLAS_API_KEY`, and `ANTHROPIC_API_KEY` into `.env`.
6. Start the app, then register the webhook (app must be publicly reachable so Nylas can complete the challenge handshake):
   ```bash
   npm run register:webhook   # creates the message.created webhook, writes NYLAS_WEBHOOK_SECRET to .env
   ```
   Restart the app to load the secret.

## Exposing the webhook over HTTPS (on the VM)

Nylas rejects non-localhost `http` callbacks, so the service needs TLS. This is a
**real cert on the VM**, not a dev tunnel:

- A public hostname via **sslip.io** (`<dashed-ip>.sslip.io` resolves to the VM IP).
- **Caddy** terminates TLS with an auto-provisioned **Let's Encrypt** cert and reverse-proxies `:443 → localhost:3000`. Minimal `Caddyfile`:
  ```
  135-148-170-25.sslip.io {
      reverse_proxy localhost:3000
  }
  ```
  (Caddy was granted `cap_net_bind_service` so it binds 80/443 without root.)

`PUBLIC_BASE_URL` is then `https://135-148-170-25.sslip.io`, and the registered
callback/webhook URLs hang off it.

---

## End-to-end flow

1. **Connect** — open `/`, click *Connect a mailbox* → Nylas hosted OAuth → `/oauth/callback` exchanges the code and persists the `grantId`. **Connect as many mailboxes as you like**; each is an independent grant with its own settings (the auth flow forces the account chooser so additional accounts can be added).
2. **Configure** — on `/`, per mailbox set a **cadence** (`hourly`, `every:5m`, `every:2h`, `daily:09:00`), a **timezone**, and the **destination** address (may differ from the mailbox). Each mailbox can be **paused/resumed** or **disconnected** (which revokes the grant on Nylas and drops its local data).
3. **Ingest** — when mail arrives, Nylas calls `/webhooks/nylas`; the handler verifies the HMAC, returns `200` immediately, then refetches the full message and stores it (deduped).
4. **Summarize & send** — each scheduler tick, a due window claims its idempotency key, summarizes the mail collected since the last digest, and emails it via Nylas to the destination.
5. **Preview / trigger** — `/debug/digest` previews a digest; the *Send digest now* button triggers one immediately.

---

## Design decisions & tradeoffs

**Scheduling: DB-backed poller + idempotency ledger.** A 60s poll over enabled
schedules, with cadence math kept pure in `cadence.ts`. The three required
invariants:
- *Survives restart* — cadence and the `sent_windows` ledger live in SQLite, not memory.
- *Per-grant* — schedules are keyed by `grantId`; the tick iterates each enabled one.
- *Exactly once* — each window has a deterministic key (`cadence@ISO-boundary`).
  `claimWindow` does `INSERT OR IGNORE` on the `sent_windows` primary key, so only
  one caller can win — across a restart, a double run, or multiple instances. The
  claim happens **before** sending; on send failure the claim is released so a
  later tick retries. (Chosen over BullMQ/Redis: SQLite already gives durability +
  atomic claims, with far less to run on a bare VM.)

**Collecting & de-duplicating incoming mail.** The webhook stores messages keyed
on the Nylas message id (PK), so duplicate and out-of-order deliveries are
no-ops. Payloads can be truncated, so the handler **always refetches the full
message** rather than trusting the webhook body. A `summarized` flag marks what a
digest has already covered, so the next window only includes new mail (no
refetching the whole mailbox).

**Self-reference.** When the digest's destination is the connected mailbox
itself, each digest email lands back in the inbox. Digests are tagged with a known
subject prefix and filtered out of ingestion and summarization, so the app never
summarizes its own output ("meta-digests"). Manual *Send digest now* summarizes a
snapshot of the recent inbox (matching the preview); the scheduled digest covers
only mail accumulated since the last one.

**The AI seam is a clean, testable boundary.** Three explicit steps — assemble
(`buildSummaryPrompt`), call (an injected `CompletionFn`), parse
(`parseDigest`, which validates the model's JSON with zod). The model is asked
for strict JSON so parsing is deterministic. Because the call is injected, the
summarizer is unit-tested with a fake completion — **no API key or live mailbox
needed** — and Claude can be swapped for any provider by supplying a different
`CompletionFn`.

**Provider-agnostic core.** Everything depends on the `MailProvider` and
`Summarizer` interfaces; the Nylas and Anthropic SDKs are each confined to one
adapter file, so they can be faked or swapped.

**Security.** Secrets come only from env. The webhook HMAC is verified with a
constant-time compare before any payload is trusted. Logs redact the auth and
signature headers and never include message bodies or tokens.

**CommonJS build.** The project targets CommonJS: the Nylas v8 SDK's dual-package
typings resolve cleanly via its `require` condition, and better-sqlite3 is
CJS-native — avoiding ESM dual-package friction for zero benefit on a Node service.

## What I'd do with more time

- **Delivery guarantees:** an outbox table + retry/backoff with a provider-side
  idempotency key, so a failed send is retried without any chance of a duplicate.
- **Richer digests:** HTML email templating; per-sender importance learned over time; thread-aware grouping.
- **Multi-user:** multiple mailboxes are already supported per-grant (connect/pause/disconnect from the UI); what's missing is real user accounts/auth so different people see only their own mailboxes.
- **Ops:** structured metrics, webhook replay protection via event-id dedup, and a dead-letter log for failed ingests.
- **Tests:** type-check the test files in CI; add an integration test against a Nylas sandbox.

## Deliberately left out

- A job queue (BullMQ/Redis) — SQLite proves the three scheduling invariants without extra infrastructure.
- Sending a digest when there's no new mail (empty windows are consumed silently to avoid noise).
- OAuth token refresh handling beyond what Nylas grants provide.

## Project layout

```
src/
  config.ts            env loading + validation (zod)
  server.ts            composition root: wires routes + starts scheduler
  domain/types.ts      provider-agnostic domain types
  mail/                MailProvider interface + Nylas adapter
  ai/                  prompt / parse / summarizer / anthropic (the AI seam)
  scheduler/           cadence (pure) + scheduler (poller, exactly-once)
  store/               SQLite data access
  routes/              auth · webhook · settings · digest
scripts/register-webhook.ts   one-off: create the Nylas message.created webhook
test/                  vitest unit tests (ai · webhook · scheduler)
```

## Tests

`npm test` runs 18 unit tests covering the AI seam (prompt/parse/fake-completion),
the webhook (challenge handshake, HMAC accept/reject, idempotent ingest), and the
scheduler (cadence math + exactly-once-per-window). None require a live mailbox or
a real LLM.
