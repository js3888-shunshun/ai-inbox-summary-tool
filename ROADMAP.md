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

- [x] README: install, env config, run, **how the webhook is exposed (HTTPS on the VM)**,
      **Nylas app setup from scratch**, end-to-end flow, design tradeoffs, "what I'd do with more time".
- [x] No `any` (strict tsconfig, `typecheck` clean); logger redacts auth + signature headers; bodies/tokens never logged.
- [x] Deployed on the VM via **systemd** (`ai-inbox` + `caddy`, auto-start on boot, auto-restart on crash); webhook reachable over public HTTPS.
- [ ] Short demo video: connect mailbox → incoming email picked up via webhook → summary arrives at destination. _(to record)_
- [x] Clean, incremental git history (commit per milestone + fixes).

## M6 — Product polish 🔨 IN PROGRESS

**Goal:** take the working prototype to something that *looks and feels* like a
product. Each item is discussed with the user before building.

- [ ] **6.1 Connect flow** 🔨 — open hosted-auth in a **new tab** (script
      `window.open`, so the callback can talk back to the opener); on success the
      callback page **refreshes the opener and closes itself**, so you land back on
      `/` with the new mailbox already listed (graceful fallback message if the
      browser blocks auto-close). Document the provider scope: any Nylas-enabled
      provider works (Google / Microsoft / IMAP / …), gated by the owner's OAuth
      consent — not Google-only, and a mailbox can't be connected without consent.
- [x] **6.2 Digest email redesign** ✅ — structured, color-coded HTML: the AI seam
      now returns `headline + sections[{title, tone, items[{from, summary}]}]` with
      tone in {urgent, action, info}, validated by zod (tone defaults to info,
      missing sender to empty, empty sections rejected). A shared inline-styled
      renderer (`src/email/render.ts`) drives both the scheduled email and the
      `/debug` preview so they match. Subject prefix de-emoji'd to `Inbox digest:`
      (legacy prefix still recognized for self-loop filtering). _(First pass; can
      iterate further from a user-supplied template.)_
- [x] **6.3 Web UI redesign** ✅ — card layout, proper buttons, **cadence as a
      number + unit dropdown** (`Every N minutes/hours`) plus a `Daily at` time
      picker, and a full IANA **timezone dropdown**. Same `POST /schedule` API
      underneath. Plain copy: no arrows / em-dashes / emoji / check glyphs.
- [x] **6.4 Test-mail generator** ✅ _(optional)_ — `npm run seed:mail` sends a
      batch of varied, realistic synthetic emails (spanning urgent / action / info
      tones) to the connected mailbox via Nylas, so the webhook→ingest→digest
      pipeline can be exercised without hand-sending from another account. Caveat as
      discussed: a single grant can only send as its own address, so the From is
      always the connected mailbox; the variety is in subject/body/tone.
- [ ] **6.5 Multi-tenant (the real product gap)** — today `/` is a single shared,
      unauthenticated dashboard: anyone who reaches the URL sees and can edit *all*
      connected mailboxes. To be a broadly deployable product it needs (a) real
      user accounts / login on *our* app, (b) per-user data isolation so each
      person sees only their own grants, and (c) the Nylas app + Google OAuth moved
      from sandbox to **production / verified** (so arbitrary users can consent
      without allowlisting or "unverified app" warnings). Connecting always remains
      gated by the mailbox owner's OAuth consent — that part is already correct.
      _(Scoped out of the take-home; documented as the main "more time" item.)_

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
