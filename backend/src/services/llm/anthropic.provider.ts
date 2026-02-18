import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMMessage, LLMStreamCallbacks } from './types';

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async stream(
    messages: LLMMessage[],
    system: string,
    callbacks: LLMStreamCallbacks,
    options?: { maxTokens?: number; temperature?: number; model?: string }
  ): Promise<void> {
    const model = options?.model || 'claude-sonnet-4-20250514';
    const maxTokens = options?.maxTokens || 4096;
    const temperature = options?.temperature ?? 0.7;

    try {
      const stream = this.client.messages.stream({
        model,
        max_tokens: maxTokens,
        temperature,
        system,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      });

      let fullText = '';

      stream.on('text', (text) => {
        fullText += text;
        callbacks.onToken(text);
      });

      const finalMessage = await stream.finalMessage();
      // Ensure we have the full text from the response
      if (!fullText && finalMessage.content[0]?.type === 'text') {
        fullText = finalMessage.content[0].text;
      }

      callbacks.onDone(fullText);
    } catch (error: any) {
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
