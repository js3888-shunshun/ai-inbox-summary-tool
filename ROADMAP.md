# Roadmap — AI Inbox Summary (Nylas)

A reference document for planning and self-checking. Each phase ends with a
**milestone** that has concrete, verifiable acceptance criteria. Tick them off
before moving on. Mirrors the task list (M0–M6).

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

- [x] **6.1 Connect flow** ✅ — hosted-auth opens in a **new tab** (script
      `window.open`, so the callback can talk back to the opener); on success the
      callback page **refreshes the opener and closes itself**, so you land back on
      `/` with the new mailbox already listed (graceful fallback message if the
      browser blocks auto-close). README documents the provider scope: any
      Nylas-enabled provider works (Google / Microsoft / IMAP / …), gated by the
      owner's OAuth consent — not Google-only, and a mailbox can't be connected
      without consent.
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
- [x] **6.5 Multi-tenant — username/password accounts + per-user isolation** ✅ —
      `/` was a single shared, unauthenticated dashboard (anyone reaching the URL saw
      and could edit *all* connected mailboxes). Now:
  - **Accounts**: `users` table; passwords hashed with scrypt (`node:crypto`, no new
    dep) as `salt:key`, never stored in plaintext; usernames unique + lowercased.
    Self-serve `/register`, `/login`, `/logout` (plain HTML forms, work without JS).
  - **Sessions**: HMAC-signed, HttpOnly, SameSite=Lax (survives the Nylas redirect),
    Secure over HTTPS, carrying the authenticated user id. Signing key is generated
    once and persisted in a `meta` table — no new env var.
  - **Isolation**: `grants.owner_id` references a user; every page and mutation
    requires login (dashboard + `/debug/digest` redirect to `/login` when signed
    out, API routes reject grants the user doesn't own via `getOwnedGrant`).
    `listGrantsByOwner` scopes the dashboard. One user cannot see or act on
    another's mailbox even by guessing a grantId.
  - **Connect → bind**: connecting a mailbox binds the grant to the logged-in
    account; reconnecting rebinds it to the connecting account (passing that
    account's OAuth is itself proof of control), which also adopts legacy
    pre-accounts grants (`owner_id` was NULL).
  - _Still future for true public launch_: the Nylas app + Google OAuth moved from
    sandbox to **production / verified** so arbitrary users can consent without
    allowlisting / "unverified app" warnings; plus the usual account hardening
    (email verification, password reset, rate limiting). See cut lines.
- [x] **6.6 Send-now & digest-quality refinements** ✅ — a cluster of fixes from
      real-inbox testing:
  - **Selectable count** on each card (`last 10/20/30/50`) wired to `POST /send-now`
    (clamped 1–100). No "Save" needed — it's read at click time.
  - **"last N" means N real emails**: fetch a buffer past `N`, drop own-digests +
    filtered categories, then trim to `N` (so filtered mail doesn't shrink the count).
  - **Message count shown** in the digest **subject** (`Inbox digest (N messages): …`)
    and body (`Covering N messages`), for both manual and scheduled digests.
  - **Promotional rollup**: low-value promo/newsletter mail is collapsed into one
    info line (`N promotional emails, no action needed`) instead of listed/dropped.
  - **No false "unread"**: removed the `[UNREAD]` signal from the prompt and forbade
    the model from mentioning read/unread or putting an unread count in the headline
    (Nylas's unread flag can disagree with the client; we summarize read+unread alike).
  - **Gmail category filtering**: always exclude `CATEGORY_PROMOTIONS` / `_SOCIAL`;
    a **per-mailbox "Primary only" toggle** (`POST /primary-only`, `grants.primary_only`)
    also excludes `_UPDATES` / `_FORUMS`. Applied across send-now, scheduled, preview.

---

## Digest selection logic & key decisions (reference)

How a message ends up in a digest, and the answers to the questions that came up
most during testing. (Both paths only ever read the **live Gmail inbox** as the
source of truth — see "deleted mail" below.)

### How messages are selected

- **Manual `Send digest now` / `/debug/digest` preview** — a *snapshot* of the most
  recent inbox mail: fetch a page from Nylas (buffer beyond the chosen `N`, capped
  at the Nylas max of 100; full 100 when Primary-only is on), drop the app's own
  digests, apply the mailbox's category policy, then take the first `N`.
  **`last N` is a ceiling, not a quota** — if only 3 messages pass the filters, the
  digest covers 3.
- **Scheduled digest** — *event-based*: summarizes mail the webhook **accumulated
  since the last digest** that is **still in the live inbox**, then marks it
  summarized (watermark) so it never repeats. Exactly-once per window via the
  `sent_windows` claim. Because it's event-based, it reliably catches an email when
  it *arrives*, regardless of how much noise comes later (unlike the "recent N" snapshot).

### What is excluded, and why

- **The app's own digests** — filtered by subject prefix (`Inbox digest`, legacy
  `📥 Inbox digest` still recognized), so the app never summarizes its own output.
- **Spam / Trash / Sent / archived** — only `in:["INBOX"]` is read; non-inbox mail is
  also skipped at ingestion.
- **Deleted / moved-out mail** — the scheduled path intersects accumulated mail with
  the live inbox, so anything removed after arrival is dropped (and still consumed so
  it can't resurface).
- **Gmail Promotions / Social** — always excluded. **Updates / Forums** additionally
  excluded when a mailbox's **Primary-only** toggle is on.

### Decisions & FAQs (the things we went back and forth on)

- **Who can you connect?** Not just Google — any provider enabled in the Nylas app
  (Google / Microsoft / IMAP / …). Connecting *always* requires the mailbox owner to
  sign in and consent; you can't connect someone's mailbox without them. Multiple
  mailboxes are supported (one grant each, independent settings).
- **Read vs unread** — we summarize **both**; unread status is not a selection axis
  and is no longer surfaced (it was inaccurate).
- **Why Primary-only sometimes shows very few** — it's a ceiling, and on a busy inbox
  most mail is Updates (e.g. job alerts) + the app's own digests; only a handful are
  real Primary. Nylas returns max 100 per page, so Primary mail older than ~100
  messages back isn't reached (pagination would be needed to go deeper — not built).
- **Focused / Other (Outlook) vs Gmail tabs** — "Focused/Other" is a *client-side*
  feature of the Outlook app; it does **not** exist on the Gmail server and is
  invisible to Nylas. For a Google mailbox the closest server-side proxy is the
  Gmail **Primary** tab → the Primary-only toggle.
- **"Make Outlook-deleted mail not be summarized"** — _investigated and abandoned._
  Deleting in the Outlook client did **not** propagate to the Gmail inbox at all
  (inspection: 0 of 100 inbox messages carried any Trash/Deleted label; emptying
  Outlook's Deleted Items changed nothing on the Gmail side). There is no server-side
  signal to distinguish them, so the app can't. The app already excludes anything
  **actually** removed from the Gmail inbox; the reliable fix is to delete in **Gmail
  web** (or fix the Outlook account's delete-sync), which is outside the app.
- **Self-digest pile-up** — when the destination equals the connected mailbox, every
  digest lands back in that inbox. They're filtered from summarization, but they do
  clutter the inbox and consume the recent-N window; recommend sending digests to a
  **different** address.

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

- **Public launch of multi-tenant**: accounts + per-user isolation are done (M6.5);
  what remains for arbitrary public users is the Nylas/Google app moved to
  production/verified, plus account hardening (email verification, password reset,
  login rate limiting).
- Job queue (BullMQ/Redis) — SQLite poller is enough to prove the three scheduling invariants.
- Deep pagination past the Nylas 100-message page (to reach older Primary mail).
- Retry/backoff on send failures (outbox); observability/metrics; webhook replay dedup.

_Done since the original cut list:_ rich structured HTML email (M6.2), product-grade
web UI with dropdowns (M6.3), per-mailbox pause/disconnect and Primary-only filtering.
