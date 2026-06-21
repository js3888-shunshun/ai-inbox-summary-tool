# AI Inbox Summary (Nylas)

Connects a mailbox via Nylas, ingests incoming mail through a webhook, and emails
an AI-written digest of the inbox on a user-configurable cadence.

> Status: **work in progress** — see [`ROADMAP.md`](./ROADMAP.md) for phases and milestones.

## Architecture

A single long-running **Fastify** Node process that:
- serves the OAuth connect flow (`/auth`, `/oauth/callback`),
- receives Nylas `message.created` webhooks (`/webhooks/nylas`),
- runs a **DB-backed scheduler** that builds and sends digests,

backed by **SQLite** (grants, messages, schedules, exactly-once `sent_windows`).
The email provider (Nylas) and the LLM (Claude) each sit behind a small interface
(`MailProvider`, `Summarizer`) so they can be swapped or faked — unit logic runs
without a live mailbox or real model.

## Prerequisites

- Node.js ≥ 20
- A (free) Nylas application: API key, OAuth client, connected mailbox
- An LLM key (Anthropic / Claude by default)

## Setup

```bash
npm install
cp .env.example .env   # then fill in real values — see comments in .env.example
npm run dev            # or: npm run build && npm start
curl localhost:3000/health   # -> {"ok":true}
```

## Configuration

All config is read from the environment (`.env`); nothing is hard-coded. See
[`.env.example`](./.env.example) for the full list (Nylas keys, webhook secret,
LLM key/model, public base URL).

## How the webhook is exposed

_(filled in at M5 — public IP / HTTPS on the VM, the exact Nylas webhook URL.)_

## Nylas app setup from scratch

_(filled in at M5.)_

## End-to-end flow

connect mailbox → incoming mail collected via webhook → scheduled summary → email sent.

## Design decisions & tradeoffs

_(filled in at M5: scheduling durability & exactly-once, incoming-mail de-dup, the
testable AI seam, and what was deliberately left out.)_
