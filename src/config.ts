import "dotenv/config";
import { z } from "zod";

/**
 * Single source of truth for configuration. All secrets and tunables are read
 * from the environment here and validated once at startup, so the rest of the
 * app can depend on a typed, already-validated `config` object.
 *
 * Never hard-code secrets elsewhere; never log this object.
 */
const EnvSchema = z.object({
  PUBLIC_BASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_PATH: z.string().default("./data/app.db"),

  NYLAS_API_KEY: z.string().min(1),
  NYLAS_API_URI: z.string().url().default("https://api.us.nylas.com"),
  NYLAS_CLIENT_ID: z.string().min(1),
  NYLAS_WEBHOOK_SECRET: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().default("claude-haiku-4-5-20251001"),
});

export type Config = Readonly<{
  publicBaseUrl: string;
  port: number;
  host: string;
  databasePath: string;
  nylas: {
    apiKey: string;
    apiUri: string;
    clientId: string;
    webhookSecret: string;
  };
  llm: {
    anthropicApiKey: string;
    model: string;
  };
}>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  return {
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/$/, ""),
    port: e.PORT,
    host: e.HOST,
    databasePath: e.DATABASE_PATH,
    nylas: {
      apiKey: e.NYLAS_API_KEY,
      apiUri: e.NYLAS_API_URI,
      clientId: e.NYLAS_CLIENT_ID,
      webhookSecret: e.NYLAS_WEBHOOK_SECRET,
    },
    llm: {
      anthropicApiKey: e.ANTHROPIC_API_KEY,
      model: e.LLM_MODEL,
    },
  };
}
