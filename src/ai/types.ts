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
  /** Uncached input tokens only — cache reads/writes are billed at different rates. */
  promptTokens: number;
  completionTokens: number;
  /** Input tokens served from the prompt cache, billed at 0.1x. */
  cacheReadTokens: number;
  /** Input tokens written into the prompt cache, billed at 1.25x. */
  cacheWriteTokens: number;
}

/** A tool the agent may call during a conversation, described provider-neutrally. */
export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>;
}

/** Runs a tool call and returns its result as text for the model to read. */
export type ToolExecutor = (name: string, input: unknown) => Promise<string>;

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ConverseOptions {
  system: string;
  tools: AgentTool[];
  executeTool: ToolExecutor;
  maxIterations?: number;
}

export interface ConverseResult extends GenerateResult {
  /** Names of tools called while producing this reply, in order, for auditing. */
  toolsCalled: string[];
}

/**
 * Every AI backend (Claude, and later OpenAI or others) implements this.
 * AIService is the only thing callers talk to — no module imports a
 * provider directly (brief §48).
 */
export interface AIProvider {
  readonly name: string;
  generate(model: string, prompt: string, options?: GenerateOptions): Promise<GenerateResult>;
  /** Runs a tool-using conversation to completion and returns the final reply. */
  converse(model: string, history: ConversationTurn[], options: ConverseOptions): Promise<ConverseResult>;
}
