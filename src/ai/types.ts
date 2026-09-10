/**
 * A task category, not a model name. AIService maps each to a model tier
 * (brief §48) so callers never hard-code a specific model.
 */
export type TaskType = "STRATEGY" | "CAPTION" | "CLASSIFY" | "CHAT" | "VISION" | "TRANSCRIBE";

export interface GenerateOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface GenerateResult {
  text: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Every AI backend (Claude, and later OpenAI or others) implements this.
 * AIService is the only thing callers talk to — no module imports a
 * provider directly (brief §48).
 */
export interface AIProvider {
  readonly name: string;
  generate(model: string, prompt: string, options?: GenerateOptions): Promise<GenerateResult>;
}
