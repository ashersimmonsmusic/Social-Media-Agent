import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { logger } from "../lib/logger.js";
import { ClaudeProvider } from "./ClaudeProvider.js";
import type { AIProvider, GenerateOptions, GenerateResult, TaskType } from "./types.js";

// Approximate USD per 1M tokens (input, output). Rough figures for cost
// *tracking*, not billing — good enough for the budget-awareness groundwork
// in brief §49. Update as pricing changes; Phase 2 can source this from a
// config file if it needs to be more precise.
const PRICING_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "claude-opus-4-5-20251101": { input: 15, output: 75 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};
const DEFAULT_PRICING = { input: 3, output: 15 };

// Standing instruction applied to every generation so the agent never
// fabricates biography, achievements, relationships, or credits that
// weren't supplied in the prompt (brief §41/§65). Callers can extend this
// via `options.system`, but this line is always present.
const GROUNDING_INSTRUCTION =
  "You are an assistant for independent artist Asher Simmons. Only use facts explicitly " +
  "provided to you in this conversation or prompt. If you do not have information needed " +
  "to answer accurately (biography, achievements, press, relationships, credits, dates, " +
  "streams, etc.), say plainly that you don't have that information — never invent or guess it.";

const MODEL_FOR_TASK: Record<TaskType, string> = {
  STRATEGY: env.AI_MODEL_STRATEGY,
  CHAT: env.AI_MODEL_STRATEGY,
  CAPTION: env.AI_MODEL_FAST,
  CLASSIFY: env.AI_MODEL_FAST,
  VISION: env.AI_MODEL_FAST,
  TRANSCRIBE: env.AI_MODEL_FAST,
};

export class AIService {
  constructor(private readonly provider: AIProvider) {}

  async generate(taskType: TaskType, prompt: string, options?: GenerateOptions): Promise<GenerateResult> {
    if (taskType === "VISION" || taskType === "TRANSCRIBE") {
      // Interface exists now so Phase 2 can wire real image/audio input
      // against a stable contract; no vision/audio call is implemented yet.
      throw new Error(`${taskType} is not implemented in Phase 1 — interface reserved for a later phase.`);
    }

    const model = MODEL_FOR_TASK[taskType];
    const system = options?.system ? `${GROUNDING_INSTRUCTION}\n\n${options.system}` : GROUNDING_INSTRUCTION;

    const result = await this.provider.generate(model, prompt, { ...options, system });
    await this.logUsage(taskType, result);
    return result;
  }

  private async logUsage(taskType: TaskType, result: GenerateResult) {
    const pricing = PRICING_PER_MILLION_TOKENS[result.model] ?? DEFAULT_PRICING;
    const estimatedCostUsd =
      (result.promptTokens / 1_000_000) * pricing.input + (result.completionTokens / 1_000_000) * pricing.output;

    await prisma.aIUsageLog.create({
      data: {
        provider: result.provider,
        model: result.model,
        taskType,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        estimatedCostUsd,
      },
    });

    logger.info("ai.usage", { taskType, model: result.model, estimatedCostUsd: estimatedCostUsd.toFixed(4) });
  }
}

export async function getMonthToDateAiSpend(): Promise<number> {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const rows = await prisma.aIUsageLog.findMany({
    where: { createdAt: { gte: startOfMonth } },
    select: { estimatedCostUsd: true },
  });
  return rows.reduce((sum, row) => sum + row.estimatedCostUsd, 0);
}

export const aiService = new AIService(new ClaudeProvider(env.ANTHROPIC_API_KEY));
