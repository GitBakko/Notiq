export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMStreamCallbacks {
  onToken: (token: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: Error) => void;
}

export interface LLMProvider {
  stream(
    messages: LLMMessage[],
    system: string,
    callbacks: LLMStreamCallbacks,
    options?: { maxTokens?: number; temperature?: number; model?: string }
  ): Promise<void>;
}
