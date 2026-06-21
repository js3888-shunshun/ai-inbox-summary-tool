import type { MailProvider } from "../mail/provider.js";

/**
 * Synthetic test emails used to exercise the webhook -> ingest -> digest pipeline
 * without hand-sending from another account. Sent via Nylas to the connected
 * mailbox's own address, so they land in the inbox and fire `message.created`.
 *
 * Shared by the CLI (`npm run seed:mail`) and the in-app Testing panel. Caveat: a
 * single grant can only send as its own address, so every test email has the same
 * From; the variety is in subject/body/tone, which is what the digest groups on.
 */
export interface TestTemplate {
  subject: string;
  body: string;
}

/** A spread of tones so the digest produces urgent / action / info sections. */
export const TEST_TEMPLATES: TestTemplate[] = [
  {
    subject: "Action required: invoice #4821 is overdue",
    body: "Our records show invoice #4821 for $1,250 is past due. Please arrange payment by end of day to avoid a late fee.",
  },
  {
    subject: "Re: Q3 budget review - can you send the numbers?",
    body: "Thanks for the call earlier. Could you send the updated Q3 figures before Friday so I can finalize the deck? Appreciate it.",
  },
  {
    subject: "Meeting request: 30 minutes this week?",
    body: "I'd love to grab 30 minutes this week to walk through the rollout plan. Do any afternoons work for you? Happy to send an invite.",
  },
  {
    subject: "Server alert: elevated error rate on api-prod",
    body: "Automated alert: api-prod has been returning 5xx errors above the 2% threshold for the last 15 minutes. On-call has been paged.",
  },
  {
    subject: "Your weekly product newsletter: 5 updates",
    body: "This week: a faster dashboard, two new integrations, an improved export flow, and a couple of bug fixes. No action needed, just FYI.",
  },
  {
    subject: "Receipt from Acme Store - $42.00",
    body: "Thanks for your purchase. Your order #A-2291 totaling $42.00 has shipped and should arrive in 3-5 business days.",
  },
];

/** Largest batch we allow in one call (keeps the UI request and CLI sane). */
export const MAX_TEST_EMAILS = 20;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Send `count` synthetic emails (cycling templates) to `to` via the given grant.
 * Returns the subjects sent. `spacingMs` gently throttles the CLI; the in-app
 * route passes 0 for snappiness.
 */
export async function sendTestEmails(
  mail: MailProvider,
  grantId: string,
  to: string,
  count: number,
  spacingMs = 0,
): Promise<string[]> {
  const n = Math.max(1, Math.min(Math.floor(count) || 1, MAX_TEST_EMAILS));
  const sent: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = TEST_TEMPLATES[i % TEST_TEMPLATES.length]!;
    const subject = n > TEST_TEMPLATES.length ? `${t.subject} [#${i + 1}]` : t.subject;
    await mail.sendEmail(grantId, { to, subject, body: t.body });
    sent.push(subject);
    if (spacingMs > 0 && i < n - 1) await sleep(spacingMs);
  }
  return sent;
}
