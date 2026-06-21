import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { NylasMailProvider } from "./mail/nylas-provider.js";
import { ClaudeSummarizer } from "./ai/claude-summarizer.js";
import { anthropicCompletion } from "./ai/anthropic.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDigestRoutes } from "./routes/digest.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { webhookPlugin } from "./routes/webhook.js";
import { startScheduler } from "./scheduler/scheduler.js";

/**
 * Composition root: load+validate config, open the DB, wire routes, listen.
 * Routes for OAuth (M1), webhook (M3) and cadence (M4) are mounted here as the
 * build progresses.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config.databasePath);

  const app = Fastify({
    logger: {
      level: "info",
      // Never log secrets or message bodies.
      redact: ["req.headers.authorization", "req.headers['x-nylas-signature']"],
    },
  });

  const mail = new NylasMailProvider(config.nylas);
  const summarizer = new ClaudeSummarizer(anthropicCompletion(config.llm));

  app.get("/health", async () => ({ ok: true }));

  registerAuthRoutes(app, {
    db,
    mail,
    redirectUri: `${config.publicBaseUrl}/oauth/callback`,
  });
  registerDigestRoutes(app, { db, mail, summarizer });
  registerSettingsRoutes(app, { db, mail, summarizer });
  app.register(webhookPlugin({ db, mail, webhookSecret: config.nylas.webhookSecret }));

  const stopScheduler = startScheduler({ db, mail, summarizer, log: app.log });

  const close = async (): Promise<void> => {
    stopScheduler();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`AI Inbox Summary listening — public base ${config.publicBaseUrl}`);
}

main().catch((err) => {
  console.error("Fatal startup error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
