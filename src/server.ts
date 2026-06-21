import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";

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

  app.get("/health", async () => ({ ok: true }));

  // TODO(M1): app.register(authRoutes, { config, db })
  // TODO(M3): app.register(webhookRoutes, { config, db })
  // TODO(M4): start scheduler(config, db)

  const close = async (): Promise<void> => {
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
