/**
 * One-off admin script: register (or report) the Nylas `message.created`
 * webhook for this app, pointed at PUBLIC_BASE_URL/webhooks/nylas.
 *
 * Nylas performs the challenge handshake against the URL during creation, so
 * the app must be running and publicly reachable first. The signing secret is
 * returned only once on create — this script writes it straight into `.env`
 * (NYLAS_WEBHOOK_SECRET) and never prints it.
 *
 * Run from the project root:  npx tsx scripts/register-webhook.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import Nylas, { WebhookTriggers } from "nylas";
import { loadConfig } from "../src/config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const nylas = new Nylas({ apiKey: config.nylas.apiKey, apiUri: config.nylas.apiUri });
  const webhookUrl = `${config.publicBaseUrl}/webhooks/nylas`;

  const res = await nylas.webhooks.create({
    requestBody: {
      triggerTypes: [WebhookTriggers.MessageCreated],
      webhookUrl,
      description: "AI Inbox Summary — message.created",
    },
  });

  const secret = res.data.webhookSecret;
  patchEnvSecret(secret);

  console.log(`Webhook created: id=${res.data.id} url=${webhookUrl}`);
  console.log("NYLAS_WEBHOOK_SECRET written to .env (restart the app to load it).");
}

/** Replace (or append) NYLAS_WEBHOOK_SECRET in ./.env without printing it. */
function patchEnvSecret(secret: string): void {
  const path = "./.env";
  const line = `NYLAS_WEBHOOK_SECRET=${secret}`;
  let env = "";
  try {
    env = readFileSync(path, "utf8");
  } catch {
    /* .env may not exist yet */
  }
  const next = /^NYLAS_WEBHOOK_SECRET=.*$/m.test(env)
    ? env.replace(/^NYLAS_WEBHOOK_SECRET=.*$/m, line)
    : `${env.replace(/\n?$/, "\n")}${line}\n`;
  writeFileSync(path, next);
}

main().catch((err) => {
  console.error("Failed to register webhook:", err instanceof Error ? err.message : err);
  process.exit(1);
});
