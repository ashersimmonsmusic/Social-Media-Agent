import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider, GenerateOptions, GenerateResult } from "./types.js";

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
}
