/**
 * Dev helper: send a batch of synthetic test emails to a connected mailbox, so
 * the full webhook -> ingest -> digest pipeline can be exercised without manually
 * sending from another account.
 *
 * The messages are sent via Nylas to the grant's own address, so they land in the
 * inbox and fire `message.created`. Caveat: a single grant can only send *as* its
 * own address, so every test email has the same From; for varied senders you would
 * need a second mailbox. The variety here is in subject/body/tone, which is what
 * the digest groups on.
 *
 * Run from the project root:
 *   npx tsx scripts/seed-test-mail.ts                 # one of each template
 *   npx tsx scripts/seed-test-mail.ts --count 10      # cycle to 10 messages
 *   npx tsx scripts/seed-test-mail.ts --grant <id>    # target a specific grant
 */
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { listGrants, getGrant } from "../src/store/grants.js";
import { NylasMailProvider } from "../src/mail/nylas-provider.js";

interface Template {
  subject: string;
  body: string;
}

/** A spread of tones so the digest produces urgent / action / info sections. */
const TEMPLATES: Template[] = [
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

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config.databasePath);
  const mail = new NylasMailProvider(config.nylas);

  const grantId = arg("grant") ?? listGrants(db)[0]?.grantId;
  if (!grantId) {
    console.error("No connected mailbox. Connect one at /auth first.");
    process.exit(1);
  }
  const grant = getGrant(db, grantId);
  if (!grant) {
    console.error(`Unknown grant: ${grantId}`);
    process.exit(1);
  }

  const count = Math.max(1, Number(arg("count")) || TEMPLATES.length);
  const to = grant.email;
  console.log(`Sending ${count} test email(s) to ${to} (grant ${grantId})`);

  for (let i = 0; i < count; i++) {
    const t = TEMPLATES[i % TEMPLATES.length]!;
    const subject = count > TEMPLATES.length ? `${t.subject} [#${i + 1}]` : t.subject;
    await mail.sendEmail(grantId, { to, subject, body: t.body });
    console.log(`  sent: ${subject}`);
    if (i < count - 1) await sleep(400); // gentle spacing to avoid rate limits
  }

  console.log("Done. Watch the app logs for webhook ingestion, then preview /debug/digest.");
}

main().catch((err) => {
  console.error("Failed to seed test mail:", err instanceof Error ? err.message : err);
  process.exit(1);
});
