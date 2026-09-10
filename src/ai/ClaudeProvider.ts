import Anthropic from "@anthropic-ai/sdk";
import type {
  AIProvider,
  ConversationTurn,
  ConverseOptions,
  ConverseResult,
  GenerateOptions,
  GenerateResult,
} from "./types.js";

const DEFAULT_MAX_ITERATIONS = 8;

export class ClaudeProvider implements AIProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async generate(model: string, prompt: string, options?: GenerateOptions): Promise<GenerateResult> {
    const response = await this.client.messages.create({
      model,
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature,
      system: options?.system,
      messages: [{ role: "user", content: prompt }],
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

    const toolsCalled: string[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const response = await this.client.messages.create({
        model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: options.system,
        tools,
        messages,
      });

      promptTokens += response.usage.input_tokens;
      completionTokens += response.usage.output_tokens;

      if (response.stop_reason !== "tool_use") {
        return {
          text: textOf(response.content),
          provider: this.name,
          model,
          promptTokens,
          completionTokens,
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
      toolsCalled,
    };
  }
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}
