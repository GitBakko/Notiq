import { vi, describe, it, expect, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';
import { makeNote } from '../../__tests__/factories';
import { NotFoundError, BadRequestError } from '../../utils/errors';

// Mock settings.service
vi.mock('../settings.service', () => ({
  getSetting: vi.fn(),
  getBooleanSetting: vi.fn(),
}));

// Mock LLM provider factory
vi.mock('../llm/provider.factory', () => ({
  getLLMProvider: vi.fn(),
}));

import {
  isAiEnabled,
  streamAiResponse,
  getConversationHistory,
  clearConversation,
} from '../ai.service';
import { getSetting, getBooleanSetting } from '../settings.service';
import { getLLMProvider } from '../llm/provider.factory';

const prismaMock = prisma as any;
const getSettingMock = getSetting as ReturnType<typeof vi.fn>;
const getBooleanSettingMock = getBooleanSetting as ReturnType<typeof vi.fn>;
const getLLMProviderMock = getLLMProvider as ReturnType<typeof vi.fn>;

const USER_ID = 'user-1';
const NOTE_ID = 'note-1';

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// isAiEnabled
// ---------------------------------------------------------------------------

describe('isAiEnabled', () => {
  it('should return true when AI is enabled and API key is configured', async () => {
    getBooleanSettingMock.mockResolvedValue(true);
    getSettingMock.mockResolvedValue('sk-ant-test-key');

    const result = await isAiEnabled();

    expect(result).toBe(true);
    expect(getBooleanSettingMock).toHaveBeenCalledWith('ai_enabled', false);
    expect(getSettingMock).toHaveBeenCalledWith('ai_api_key', '');
  });

  it('should return false when AI is disabled', async () => {
    getBooleanSettingMock.mockResolvedValue(false);

    const result = await isAiEnabled();

    expect(result).toBe(false);
    expect(getBooleanSettingMock).toHaveBeenCalledWith('ai_enabled', false);
    // getSetting should not be called when ai_enabled is false
    expect(getSettingMock).not.toHaveBeenCalled();
  });

  it('should return false when AI is enabled but API key is empty', async () => {
    getBooleanSettingMock.mockResolvedValue(true);
    getSettingMock.mockResolvedValue('');

    const result = await isAiEnabled();

    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// streamAiResponse
// ---------------------------------------------------------------------------

describe('streamAiResponse', () => {
  const mockProvider = {
    stream: vi.fn(),
  };

  const mockCallbacks = {
    onToken: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  };

  function setupSettingsMocks() {
    getSettingMock
      .mockResolvedValueOnce('claude-sonnet-4-20250514') // ai_model
      .mockResolvedValueOnce('4096')                      // ai_max_tokens
      .mockResolvedValueOnce('0.7');                       // ai_temperature
  }

  beforeEach(() => {
    getLLMProviderMock.mockResolvedValue(mockProvider);
    mockProvider.stream.mockResolvedValue(undefined);
  });

  it('should call LLM provider with correct prompt for ask operation', async () => {
    setupSettingsMocks();

    const note = makeNote({
      id: NOTE_ID,
      title: 'My Note',
      searchText: 'Some note content here',
      isEncrypted: false,
    });
    prismaMock.note.findUnique.mockResolvedValue(note);
    prismaMock.aiConversation.findMany.mockResolvedValue([]);
    prismaMock.aiConversation.create.mockResolvedValue({});

    await streamAiResponse(USER_ID, NOTE_ID, 'What is this about?', 'ask', mockCallbacks);

    expect(getLLMProviderMock).toHaveBeenCalled();
    expect(prismaMock.note.findUnique).toHaveBeenCalledWith({
      where: { id: NOTE_ID },
      select: { title: true, searchText: true, content: true, isEncrypted: true },
    });

    // Verify provider.stream was called with correct structure
    expect(mockProvider.stream).toHaveBeenCalledWith(
      [{ role: 'user', content: 'What is this about?' }],
      expect.stringContaining('My Note'),
      expect.objectContaining({ onToken: expect.any(Function) }),
      { model: 'claude-sonnet-4-20250514', maxTokens: 4096, temperature: 0.7 },
    );

    // Verify user message was saved
    expect(prismaMock.aiConversation.create).toHaveBeenCalledWith({
      data: {
        noteId: NOTE_ID,
        userId: USER_ID,
        role: 'user',
        content: 'What is this about?',
        operation: 'ask',
      },
    });
  });

  it('should include target language in system prompt for translate operation', async () => {
    setupSettingsMocks();

    const note = makeNote({
      id: NOTE_ID,
      title: 'English Note',
      searchText: 'Hello world',
      isEncrypted: false,
    });
    prismaMock.note.findUnique.mockResolvedValue(note);
    prismaMock.aiConversation.findMany.mockResolvedValue([]);
    prismaMock.aiConversation.create.mockResolvedValue({});

    await streamAiResponse(
      USER_ID,
      NOTE_ID,
      'Translate this',
      'translate',
      mockCallbacks,
      'Italian',
    );

    // Verify system prompt contains target language
    const systemPrompt = mockProvider.stream.mock.calls[0][1];
    expect(systemPrompt).toContain('Translate the following text to Italian');
    expect(systemPrompt).toContain('English Note');
  });

  it('should throw NotFoundError when note does not exist', async () => {
    setupSettingsMocks();
    prismaMock.note.findUnique.mockResolvedValue(null);

    await expect(
      streamAiResponse(USER_ID, NOTE_ID, 'question', 'ask', mockCallbacks),
    ).rejects.toThrow(NotFoundError);

    await expect(
      streamAiResponse(USER_ID, NOTE_ID, 'question', 'ask', mockCallbacks),
    ).rejects.toThrow('errors.notes.notFound');
  });

  it('should throw BadRequestError when note is encrypted (vault)', async () => {
    setupSettingsMocks();

    const encryptedNote = makeNote({
      id: NOTE_ID,
      isEncrypted: true,
    });
    prismaMock.note.findUnique.mockResolvedValue(encryptedNote);

    await expect(
      streamAiResponse(USER_ID, NOTE_ID, 'question', 'ask', mockCallbacks),
    ).rejects.toThrow(BadRequestError);

    await expect(
      streamAiResponse(USER_ID, NOTE_ID, 'question', 'ask', mockCallbacks),
    ).rejects.toThrow('errors.ai.cannotProcessEncrypted');
  });

  it('should include conversation history from Prisma in messages', async () => {
    setupSettingsMocks();

    const note = makeNote({
      id: NOTE_ID,
      title: 'Note',
      searchText: 'Content',
      isEncrypted: false,
    });
    prismaMock.note.findUnique.mockResolvedValue(note);

    const history = [
      { role: 'user', content: 'Previous question' },
      { role: 'assistant', content: 'Previous answer' },
    ];
    prismaMock.aiConversation.findMany.mockResolvedValue(history);
    prismaMock.aiConversation.create.mockResolvedValue({});

    await streamAiResponse(USER_ID, NOTE_ID, 'Follow up?', 'ask', mockCallbacks);

    // History should be loaded with correct query
    expect(prismaMock.aiConversation.findMany).toHaveBeenCalledWith({
      where: { noteId: NOTE_ID, userId: USER_ID },
      orderBy: { createdAt: 'asc' },
      take: 20,
      select: { role: true, content: true },
    });

    // Messages sent to provider should include history + new message
    const messages = mockProvider.stream.mock.calls[0][0];
    expect(messages).toEqual([
      { role: 'user', content: 'Previous question' },
      { role: 'assistant', content: 'Previous answer' },
      { role: 'user', content: 'Follow up?' },
    ]);
  });

  it('should save assistant response via wrapped onDone callback', async () => {
    setupSettingsMocks();

    const note = makeNote({
      id: NOTE_ID,
      title: 'Note',
      searchText: 'Content',
      isEncrypted: false,
    });
    prismaMock.note.findUnique.mockResolvedValue(note);
    prismaMock.aiConversation.findMany.mockResolvedValue([]);
    prismaMock.aiConversation.create.mockResolvedValue({});

    // Capture the wrapped callbacks that get passed to provider.stream
    mockProvider.stream.mockImplementation(
      async (_msgs: any, _sys: any, callbacks: any, _opts: any) => {
        // Simulate streaming completion
        await callbacks.onDone('The AI response text');
      },
    );

    await streamAiResponse(USER_ID, NOTE_ID, 'question', 'summarize', mockCallbacks);

    // First create call = user message, second = assistant response
    expect(prismaMock.aiConversation.create).toHaveBeenCalledTimes(2);
    expect(prismaMock.aiConversation.create).toHaveBeenNthCalledWith(2, {
      data: {
        noteId: NOTE_ID,
        userId: USER_ID,
        role: 'assistant',
        content: 'The AI response text',
        operation: 'summarize',
      },
    });

    // Original onDone callback should also be called
    expect(mockCallbacks.onDone).toHaveBeenCalledWith('The AI response text');
  });
});

// ---------------------------------------------------------------------------
// getConversationHistory
// ---------------------------------------------------------------------------

describe('getConversationHistory', () => {
  it('should query Prisma for conversation history ordered by createdAt', async () => {
    const historyData = [
      { id: 'c1', role: 'user', content: 'Hello', operation: 'ask', createdAt: new Date() },
      { id: 'c2', role: 'assistant', content: 'Hi!', operation: 'ask', createdAt: new Date() },
    ];
    prismaMock.aiConversation.findMany.mockResolvedValue(historyData);

    const result = await getConversationHistory(USER_ID, NOTE_ID);

    expect(prismaMock.aiConversation.findMany).toHaveBeenCalledWith({
      where: { noteId: NOTE_ID, userId: USER_ID },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true, operation: true, createdAt: true },
    });
    expect(result).toEqual(historyData);
  });
});

// ---------------------------------------------------------------------------
// clearConversation
// ---------------------------------------------------------------------------

describe('clearConversation', () => {
  it('should delete all conversation messages for user and note', async () => {
    prismaMock.aiConversation.deleteMany.mockResolvedValue({ count: 5 });

    const result = await clearConversation(USER_ID, NOTE_ID);

    expect(prismaMock.aiConversation.deleteMany).toHaveBeenCalledWith({
      where: { noteId: NOTE_ID, userId: USER_ID },
    });
    expect(result).toEqual({ count: 5 });
  });
});
