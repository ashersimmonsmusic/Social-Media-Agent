import { z } from "zod";

const boolFromString = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_ALLOWED_CHAT_ID: z.string().min(1, "TELEGRAM_ALLOWED_CHAT_ID is required"),
  TELEGRAM_USE_WEBHOOK: boolFromString,
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  PUBLIC_BASE_URL: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  AI_MODEL_STRATEGY: z.string().default("claude-opus-4-5-20251101"),
  AI_MODEL_FAST: z.string().default("claude-haiku-4-5-20251001"),

  ADMIN_API_KEY: z.string().min(1, "ADMIN_API_KEY is required"),

  STORAGE_DRIVER: z.enum(["local"]).default("local"),
  STORAGE_LOCAL_PATH: z.string().default("./uploads"),

  DRY_RUN: boolFromString,
  AI_MONTHLY_BUDGET_USD: z.coerce.number().default(50),
});

export type Env = z.infer<typeof envSchema> & { DRY_RUN: boolean; TELEGRAM_USE_WEBHOOK: boolean };

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const data = parsed.data as Env;
  // DRY_RUN defaults to true (safe default) unless explicitly set to a falsy string.
  if (process.env.DRY_RUN === undefined) {
    data.DRY_RUN = true;
  }
  return data;
}

export const env = loadEnv();
