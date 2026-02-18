import prisma from '../plugins/prisma';
import { getLLMProvider } from './llm/provider.factory';
import { getSetting, getBooleanSetting } from './settings.service';
import type { LLMMessage, LLMStreamCallbacks } from './llm/types';

// --- System prompts per operation ---
const SYSTEM_PROMPTS: Record<string, string> = {
  ask: `You are a helpful assistant. The user has a note with the following content. Answer their question based on the note content. If the answer is not in the note, say so and provide general knowledge.`,
  summarize: `Summarize the following note content concisely. Focus on the key points and main ideas. Write in the same language as the note.`,
  continue: `Continue writing the following text. Maintain the same tone, style, and language. Do not repeat what is already written. Produce a natural continuation.`,
  improve: `Improve the following text. Make it clearer, more professional, and better structured. Preserve the original meaning and language. Return only the improved text without explanations.`,
  tags: `Suggest 3-7 relevant tags for the following note. Return ONLY a JSON array of strings, no other text. Example: ["tag1", "tag2", "tag3"]`,
  translate: `Translate the following text. Return only the translation without explanations.`,
};

export type AiOperation = 'ask' | 'summarize' | 'continue' | 'improve' | 'tags' | 'translate';

export const isAiEnabled = async (): Promise<boolean> => {
  const enabled = await getBooleanSetting('ai_enabled', false);
  if (!enabled) return false;
  const apiKey = await getSetting('ai_api_key', '');
  return apiKey.length > 0;
};

export const streamAiResponse = async (
  userId: string,
  noteId: string,
  userMessage: string,
  operation: AiOperation,
  callbacks: LLMStreamCallbacks,
  targetLanguage?: string
) => {
  const provider = await getLLMProvider();
  const model = await getSetting('ai_model', 'claude-sonnet-4-20250514');
  const maxTokens = parseInt(await getSetting('ai_max_tokens', '4096'), 10);
  const temperature = parseFloat(await getSetting('ai_temperature', '0.7'));

  // Get note content for context
  const note = await prisma.note.findUnique({
    where: { id: noteId },
    select: { title: true, searchText: true, content: true, isEncrypted: true },
  });

  if (!note) throw new Error('Note not found');
  if (note.isEncrypted) throw new Error('AI cannot process encrypted notes');

  // Use searchText (plain text) for context, truncate to 50k chars
  const noteContext = (note.searchText || '').substring(0, 50000);

  // Build system prompt
  let system = SYSTEM_PROMPTS[operation] || SYSTEM_PROMPTS.ask;
  if (operation === 'translate' && targetLanguage) {
    system = `Translate the following text to ${targetLanguage}. Return only the translation without explanations.`;
  }
  system += `\n\nNote title: "${note.title}"\nNote content:\n${noteContext}`;

  // Load conversation history (last 20 messages)
  const history = await prisma.aiConversation.findMany({
    where: { noteId, userId },
    orderBy: { createdAt: 'asc' },
    take: 20,
    select: { role: true, content: true },
  });

  const messages: LLMMessage[] = [
    ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
    { role: 'user' as const, content: userMessage },
  ];

  // Save user message
  await prisma.aiConversation.create({
    data: { noteId, userId, role: 'user', content: userMessage, operation },
  });

  // Wrap callbacks to save assistant response
  const wrappedCallbacks: LLMStreamCallbacks = {
    onToken: callbacks.onToken,
    onDone: async (fullText: string) => {
      await prisma.aiConversation.create({
        data: { noteId, userId, role: 'assistant', content: fullText, operation },
      });
      callbacks.onDone(fullText);
    },
    onError: callbacks.onError,
  };

  await provider.stream(messages, system, wrappedCallbacks, {
    model,
    maxTokens,
    temperature,
  });
};

export const getConversationHistory = async (userId: string, noteId: string) => {
  return prisma.aiConversation.findMany({
    where: { noteId, userId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, role: true, content: true, operation: true, createdAt: true },
  });
};

export const clearConversation = async (userId: string, noteId: string) => {
  return prisma.aiConversation.deleteMany({
    where: { noteId, userId },
  });
};
