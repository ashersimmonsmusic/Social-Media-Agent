import { z } from "zod";

const boolFromString = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

/**
 * Railway's variable editor has separate name and value boxes, but pasting a
 * whole `AI_MODEL_STRATEGY=claude-opus-5` line into the value box is an easy
 * slip — and it reaches the API as a model id with the variable name still
 * attached, which 404s with a confusing "model not found". Strip a
 * self-referential `KEY=` prefix and any wrapping quotes so the paste works.
 */
export function sanitizeModelId(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "")
    .trim();
  return cleaned || fallback;
}

const modelId = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((raw) => sanitizeModelId(raw, fallback));

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
  AI_MODEL_STRATEGY: modelId("claude-opus-5"),
  AI_MODEL_FAST: modelId("claude-haiku-4-5"),

  ADMIN_API_KEY: z.string().min(1, "ADMIN_API_KEY is required"),

  // Social publishing. Optional so the app still boots before any account is
  // connected; connecting one without SOCIAL_TOKEN_KEY fails with a clear error.
  SOCIAL_TOKEN_KEY: z.string().optional(),
  META_GRAPH_API_VERSION: z.string().default("v21.0"),

  // Website. Content goes into Sanity, which the Next.js site renders from;
  // anything needing real code goes to GitHub as an issue instead.
  SANITY_PROJECT_ID: z.string().optional(),
  SANITY_DATASET: z.string().default("production"),
  SANITY_API_VERSION: z.string().default("2021-06-07"),
  SANITY_WRITE_TOKEN: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  WEBSITE_REPO: z.string().default("ashersimmonsmusic/ashersimmonsmusic.com"),

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
