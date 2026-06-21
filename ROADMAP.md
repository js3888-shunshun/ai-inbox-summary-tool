# Roadmap — AI Inbox Summary (Nylas)

A reference document for planning and self-checking. Each phase ends with a
**milestone** that has concrete, verifiable acceptance criteria. Tick them off
before moving on. Mirrors the task list (M0–M5).

> Target: ~4 focused hours. A clean, well-reasoned, smaller submission beats a
> sprawling one. Commit incrementally — the reviewers read the git history.

## Fixed constraints (do not change)

- **Platform:** Nylas API + TypeScript / Node.js. BYO LLM key.
- **Architecture:** a long-running service that can **receive HTTP** (OAuth
  callback + webhook) **and run scheduled work**. A browser-only client is not
  enough. → Chosen: **Fastify single Node process + SQLite + DB-backed scheduler**.
- **Secrets:** all from env/config, never hard-coded. Never log message bodies or tokens.

## Architecture at a glance

```
                 ┌──────────────────────── Fastify (single process) ───────────────────────┐
  Browser ──/auth──▶  OAuth routes ──▶ exchange code ─▶ grant ─┐                             │
  Nylas ──message.created──▶ /webhooks/nylas (HMAC verify, 200 fast) ─▶ ingest queue ─┐      │
                                                                │                      ▼      │
                                                          SQLite (grants, messages, schedules, sent_windows)
                                                                ▲                      │      │
  Scheduler (DB-backed poller) ── due window? ──▶ read messages ▶ AI seam ▶ send via Nylas ──┘
                 └──────────────────────────────────────────────────────────────────────────┘

  Adapters behind interfaces:  MailProvider (Nylas)   Summarizer (Claude)   — both fakeable in tests.
```

---

## M0 — Project bootstrap ✅ DONE

**Goal:** a runnable, typed skeleton with config + storage in place.

- [x] Fastify app boots; `GET /health` → `200 {"ok":true}`. _(verified on VM, public)_
- [x] `loadConfig()` validates env with zod; missing/invalid env fails fast with a clear message.
- [x] SQLite schema created on boot: `grants`, `messages`, `schedules`, `sent_windows`.
- [x] `tsconfig` strict; `npm run typecheck` clean; no `any`.
- [x] `git init`, `.gitignore` excludes `.env` + `*.db`; first commit.

## M1 — Nylas hosted OAuth ✅ DONE

**Goal:** connect a real mailbox and persist the grant.

- [x] `GET /auth` redirects to Nylas hosted auth (`/v3/connect/auth`).
- [x] `GET /oauth/callback` exchanges `code` → grant; persists `grantId` + email.
- [x] Grant survives a process restart (read back from SQLite). _(grant for jiayisun3888@gmail.com persisted)_
- [x] Unhappy paths handled: denied consent, expired/invalid grant → friendly error, no crash.
- [x] All Nylas calls sit behind a `MailProvider` interface (vendor type does not leak).
- [x] _(infra)_ HTTPS on the VM: Caddy + Let's Encrypt cert for `135-148-170-25.sslip.io` → reverse-proxy to `:3000` (Nylas rejects non-localhost http callbacks).

## M2 — Read inbox + AI summary seam ✅ DONE

**Goal:** a clean, testable summarization seam producing a *useful* digest.

- [x] Read recent messages via `GET /v3/grants/{id}/messages` with deliberate
      pagination (bounded `limit`, optional `receivedAfter`; INBOX only).
- [x] Map provider payload → `EmailMessage` (sender, subject, date, snippet, unread).
- [x] AI seam is three explicit boundaries: **assemble input → call model → parse output** (`prompt.ts` / injected `CompletionFn` / `parse.ts`).
- [x] `summarize(messages): Digest` is unit-tested with a **fake** completion (8 tests; no live mailbox, no real LLM needed).
- [x] Real Claude run yields a genuinely useful digest. _(verified live via `/debug/digest`: grouped urgent/asks/deadlines vs skippable marketing.)_

## M3 — Webhook ingestion (`message.created`) ✅ DONE

**Goal:** reliably accumulate incoming mail since the last summary.

- [x] Webhook registered and pointed at `PUBLIC_BASE_URL/webhooks/nylas` (via `npm run register:webhook`).
- [x] Challenge/verification handshake completed (echo `challenge`). _(passed during registration)_
- [x] `x-nylas-signature` HMAC verified **before** trusting payload; bad signature → 401. _(tested both ways)_
- [x] Returns `200` fast; heavy work (refetch/store) happens outside the request (`setImmediate`).
- [x] Tolerates webhook realities: **duplicate** deliveries (idempotent upsert),
      **out-of-order** events, **truncated** payloads (always refetch full message).
- [x] _(verified live)_ real test email → event → HMAC-verified → ingested into `messages`.

## M4 — Configurable cadence + scheduled send ✅ DONE

**Goal:** durable, per-grant, exactly-once scheduled digests.

- [x] User sets cadence (`hourly`, `every:5m`, `every:2h`, `daily:09:00`) via `POST /schedule` → persisted; **no code change**.
- [x] DB-backed scheduler (60s poll) fires a due window → builds digest → sends via Nylas to the destination address.
- [x] **Survives restart:** schedule + `sent_windows` live in SQLite. _(verified: restarted, both persisted.)_
- [x] **Per-grant:** schedules keyed by grant; the tick iterates each enabled schedule.
- [x] **Exactly once:** `claimWindow` (INSERT OR IGNORE on `sent_windows` PK) claims a window before sending; second run → `skipped`. _(unit-tested + live windowKey recorded.)_
- [x] _(verified live)_ set `every:2m` → scheduler auto-fired → `digest sent`, idempotency row written. Plus `POST /send-now` for manual digests.

## M5 — Polish + deliverables 🔨 IN PROGRESS

**Goal:** ship something defensible.

- [ ] README: install, env config, run, **how the webhook is exposed (HTTPS on the VM)**,
      **Nylas app setup from scratch**, end-to-end flow, design tradeoffs, "what I'd do with more time".
- [ ] No `any`; secrets/bodies/tokens never logged.
- [ ] Deployed on the VM; webhook reachable from the public internet.
- [ ] Short demo video: connect mailbox → incoming email picked up via webhook → summary arrives at destination.
- [ ] Clean, incremental git history.

---

## Time budget (≈4h)

| Phase | Est. | Running total |
|-------|------|---------------|
| M0 bootstrap        | 20m | 0:20 |
| M1 OAuth            | 45m | 1:05 |
| M2 read + AI seam   | 50m | 1:55 |
| M3 webhook          | 50m | 2:45 |
| M4 cadence + send   | 50m | 3:35 |
| M5 polish + deliver | 45m | 4:20 |

## Deliberate cut lines (state in README under "what I'd do with more time")

- Multi-user UI / account management beyond a single connect button.
- Job queue (BullMQ/Redis) — SQLite poller is enough to prove the three scheduling invariants.
- Rich HTML email templating; retry/backoff on send failures; observability/metrics.
