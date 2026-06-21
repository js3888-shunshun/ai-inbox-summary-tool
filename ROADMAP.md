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

## M0 — Project bootstrap

**Goal:** a runnable, typed skeleton with config + storage in place.

- [ ] Fastify app boots; `GET /health` → `200 {"ok":true}`.
- [ ] `loadConfig()` validates env with zod; missing/invalid env fails fast with a clear message.
- [ ] SQLite schema created on boot: `grants`, `messages`, `schedules`, `sent_windows`.
- [ ] `tsconfig` strict; `npm run typecheck` clean; no `any`.
- [ ] `git init`, `.gitignore` excludes `.env` + `*.db`; first commit.

## M1 — Nylas hosted OAuth

**Goal:** connect a real mailbox and persist the grant.

- [ ] `GET /auth` redirects to Nylas hosted auth (`/v3/connect/auth`).
- [ ] `GET /oauth/callback` exchanges `code` → grant; persists `grantId` + email.
- [ ] Grant survives a process restart (read back from SQLite).
- [ ] Unhappy paths handled: denied consent, expired/invalid grant → friendly error, no crash.
- [ ] All Nylas calls sit behind a `MailProvider` interface (vendor type does not leak).

## M2 — Read inbox + AI summary seam

**Goal:** a clean, testable summarization seam producing a *useful* digest.

- [ ] Read recent messages via `GET /v3/grants/{id}/messages` with deliberate
      pagination (bounded pull; do **not** refetch the whole mailbox).
- [ ] Map provider payload → `EmailMessage` (sender, subject, date, snippet, unread).
- [ ] AI seam is three explicit boundaries: **assemble input → call model → parse output**.
- [ ] `summarize(messages): Digest` is unit-tested with a **fake** Summarizer (no live mailbox, no real LLM needed).
- [ ] Real Claude run yields a genuinely useful digest: who matters, asks awaiting
      a reply, deadlines — not a list of subjects.

## M3 — Webhook ingestion (`message.created`)

**Goal:** reliably accumulate incoming mail since the last summary.

- [ ] Webhook registered and pointed at `PUBLIC_BASE_URL/webhooks/nylas`.
- [ ] Challenge/verification handshake completed (echo `challenge`).
- [ ] `x-nylas-signature` HMAC verified **before** trusting payload; bad signature → 401. (tested both ways)
- [ ] Returns `200` fast; heavy work (refetch/store) happens outside the request.
- [ ] Tolerates webhook realities: **duplicate** deliveries (idempotent upsert),
      **out-of-order** events, **truncated** payloads (refetch full message when needed).

## M4 — Configurable cadence + scheduled send

**Goal:** durable, per-grant, exactly-once scheduled digests.

- [ ] User sets cadence (e.g. `hourly`, `every:3h`, `daily:09:00`) → persisted; **changing it needs no code change**.
- [ ] DB-backed scheduler fires a due window → builds digest → `POST .../messages/send` to the destination address.
- [ ] **Survives restart:** schedule + next-due state live in SQLite, not memory.
- [ ] **Per-grant:** different grants can be on different cadences.
- [ ] **Exactly once:** a `sent_windows` idempotency key guarantees one email per
      window even across restart, double-run, or multiple instances.

## M5 — Polish + deliverables

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
