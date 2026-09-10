import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import type {
  AiAttachment,
  AIProvider,
  ConversationTurn,
  ConverseOptions,
  ConverseResult,
  GenerateOptions,
  GenerateResult,
} from "./types.js";

const DEFAULT_MAX_ITERATIONS = 8;

/**
 * Adaptive thinking only exists on Claude 4.6-and-newer models, but the model
 * is set by env var and can be changed without a redeploy. Rather than keep a
 * version list here that goes stale, try it once per model and remember when
 * the API rejects it, so an older model degrades instead of failing outright.
 */
const adaptiveThinkingRejectedBy = new Set<string>();

function isAdaptiveThinkingUnsupported(error: unknown): boolean {
  const err = error as { status?: number; message?: string } | null;
  return err?.status === 400 && /thinking/i.test(err.message ?? "");
}

export class ClaudeProvider implements AIProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  /** Sends a request with adaptive thinking, retrying without it if the model can't do it. */
  private async createWithOptionalThinking(
    params: Omit<Anthropic.MessageCreateParamsNonStreaming, "thinking">,
  ): Promise<Anthropic.Message> {
    if (adaptiveThinkingRejectedBy.has(params.model)) {
      return this.client.messages.create(params);
    }

    try {
      return await this.client.messages.create({ ...params, thinking: { type: "adaptive" } });
    } catch (error) {
      if (!isAdaptiveThinkingUnsupported(error)) throw error;
      adaptiveThinkingRejectedBy.add(params.model);
      logger.warn("ai.adaptive_thinking_unsupported", { model: params.model });
      return this.client.messages.create(params);
    }
  }

  async generate(model: string, prompt: string, options?: GenerateOptions): Promise<GenerateResult> {
    // Attachments go before the prompt text: the model reads the file, then the
    // instruction about what to do with it.
    const content: Anthropic.ContentBlockParam[] = [
      ...(options?.attachments ?? []).map(attachmentToBlock),
      { type: "text", text: prompt },
    ];

    const response = await this.client.messages.create({
      model,
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature,
      system: options?.system,
      messages: [{ role: "user", content }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    return {
      text,
      provider: this.name,
      model,
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
  }

  /**
   * A manual agentic loop rather than the SDK's tool runner: the conversation
   * is persisted between Telegram messages, so it's worth keeping the message
   * list explicit and under our control. Tool results are all returned in a
   * single user message per iteration, which is what keeps parallel tool calls
   * working.
   */
  async converse(model: string, history: ConversationTurn[], options: ConverseOptions): Promise<ConverseResult> {
    const messages: Anthropic.MessageParam[] = history.map((turn) => ({ role: turn.role, content: turn.content }));

    const tools: Anthropic.Tool[] = options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));

    // Tools and system render ahead of the conversation and are identical on
    // every message, so a single breakpoint on the last system block caches
    // both — the largest fixed cost in each request.
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: options.system, cache_control: { type: "ephemeral" } },
    ];

    const toolsCalled: string[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const response = await this.createWithOptionalThinking({
        model,
        max_tokens: 16000,
        system,
        tools,
        messages: withHistoryCacheBreakpoint(messages),
      });

      promptTokens += response.usage.input_tokens;
      completionTokens += response.usage.output_tokens;
      cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
      cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;

      if (response.stop_reason !== "tool_use") {
        return {
          text: textOf(response.content),
          provider: this.name,
          model,
          promptTokens,
          completionTokens,
          cacheReadTokens,
          cacheWriteTokens,
          toolsCalled,
        };
      }

      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        toolsCalled.push(toolUse.name);
        try {
          const result = await options.executeTool(toolUse.name, toolUse.input);
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
        } catch (error) {
          // Report the failure to the model rather than dropping the result,
          // so it can tell Asher what didn't work instead of stalling.
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Tool failed: ${String(error)}`,
            is_error: true,
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
    }

    return {
      text: "I got stuck working through that — could you narrow it down for me?",
      provider: this.name,
      model,
      promptTokens,
      completionTokens,
      cacheReadTokens,
      cacheWriteTokens,
      toolsCalled,
    };
  }
}

/**
 * Marks the end of the conversation so far as a cache breakpoint. Each pass of
 * the tool loop re-sends every earlier message, so without this the whole
 * history and every tool result is re-billed at full price on each pass.
 *
 * The marker is applied to a copy rather than to `messages` itself: markers
 * left in place would accumulate across iterations and blow the four
 * breakpoints an request is allowed.
 */
function withHistoryCacheBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (!last) return messages;

  const blocks: Anthropic.ContentBlockParam[] =
    typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
  const tail = blocks[blocks.length - 1];
  if (!tail) return messages;

  blocks[blocks.length - 1] = { ...tail, cache_control: { type: "ephemeral" } } as Anthropic.ContentBlockParam;
  const copy = [...messages];
  copy[copy.length - 1] = { ...last, content: blocks };
  return copy;
}

function attachmentToBlock(attachment: AiAttachment): Anthropic.ContentBlockParam {
  const data = attachment.data.toString("base64");
  if (attachment.kind === "pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data },
      ...(attachment.filename ? { title: attachment.filename } : {}),
    };
  }
  return {
    type: "image",
    source: { type: "base64", media_type: attachment.mediaType as Anthropic.Base64ImageSource["media_type"], data },
  };
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}
