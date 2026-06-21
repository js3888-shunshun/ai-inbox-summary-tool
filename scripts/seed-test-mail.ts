/**
 * Dev helper: send a batch of synthetic test emails to a connected mailbox, so
 * the full webhook -> ingest -> digest pipeline can be exercised without manually
 * sending from another account. The same templates/logic also power the in-app
 * Testing panel (see src/email/test-mail.ts).
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
import { sendTestEmails, TEST_TEMPLATES } from "../src/email/test-mail.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

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

  const count = Number(arg("count")) || TEST_TEMPLATES.length;
  console.log(`Sending ${count} test email(s) to ${grant.email} (grant ${grantId})`);

  const sent = await sendTestEmails(mail, grantId, grant.email, count, 400);
  for (const subject of sent) console.log(`  sent: ${subject}`);

  console.log("Done. Watch the app logs for webhook ingestion, then preview /debug/digest.");
}

main().catch((err) => {
  console.error("Failed to seed test mail:", err instanceof Error ? err.message : err);
  process.exit(1);
});
