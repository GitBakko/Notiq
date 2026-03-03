import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

// Mock services BEFORE imports
vi.mock('../../services/ai.service', () => ({
  streamAiResponse: vi.fn(),
  getConversationHistory: vi.fn(),
  clearConversation: vi.fn(),
  isAiEnabled: vi.fn(),
}));

vi.mock('../../services/note.service', () => ({
  checkNoteAccess: vi.fn(),
}));

import * as aiService from '../../services/ai.service';
import * as noteService from '../../services/note.service';
import { AppError } from '../../utils/errors';
import aiRoutes from '../ai';

const mockAiService = aiService as any;
const mockNoteService = noteService as any;

const TEST_USER = { id: 'user-1', email: 'test@test.com', role: 'USER', tokenVersion: 0 };
const VALID_NOTE_ID = '550e8400-e29b-41d4-a716-446655440000';

let app: FastifyInstance;
let authToken: string;

beforeAll(async () => {
  app = Fastify();
  app.register(jwt, { secret: 'test-secret' });

  app.decorate('authenticate', async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ message: 'Unauthorized' });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ message: error.message });
    }
    if (error.name === 'ZodError') {
      return reply.status(400).send({ message: 'Validation error', issues: (error as any).issues || (error as any).errors });
    }
    reply.status(500).send({ message: error.message });
  });

  app.register(aiRoutes, { prefix: '/api/ai' });
  await app.ready();
  authToken = app.jwt.sign(TEST_USER);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/ai/status', () => {
  it('returns enabled status', async () => {
    mockAiService.isAiEnabled.mockResolvedValue(true);

    const res = await app.inject({
      method: 'GET',
      url: '/api/ai/status',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ enabled: true });
  });

  it('returns disabled status', async () => {
    mockAiService.isAiEnabled.mockResolvedValue(false);

    const res = await app.inject({
      method: 'GET',
      url: '/api/ai/status',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ enabled: false });
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/ai/status',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/ai/chat', () => {
  it('returns 400 with invalid payload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { noteId: 'not-a-uuid', message: '', operation: 'invalid' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 when user has no note access', async () => {
    mockNoteService.checkNoteAccess.mockResolvedValue(null);

    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { noteId: VALID_NOTE_ID, message: 'Hello', operation: 'ask' },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload)).toEqual({ message: 'errors.notes.notFoundOrDenied' });
  });

  it('returns 503 when AI is not enabled', async () => {
    mockNoteService.checkNoteAccess.mockResolvedValue('OWNER');
    mockAiService.isAiEnabled.mockResolvedValue(false);

    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { noteId: VALID_NOTE_ID, message: 'Hello', operation: 'ask' },
    });

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.payload)).toEqual({ message: 'errors.ai.notEnabled' });
  });
});

describe('GET /api/ai/history/:noteId', () => {
  it('returns conversation history', async () => {
    const mockHistory = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    mockAiService.getConversationHistory.mockResolvedValue(mockHistory);

    const res = await app.inject({
      method: 'GET',
      url: `/api/ai/history/${VALID_NOTE_ID}`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockHistory);
    expect(mockAiService.getConversationHistory).toHaveBeenCalledWith(TEST_USER.id, VALID_NOTE_ID);
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/ai/history/${VALID_NOTE_ID}`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('DELETE /api/ai/history/:noteId', () => {
  it('clears conversation history', async () => {
    mockAiService.clearConversation.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/ai/history/${VALID_NOTE_ID}`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
    expect(mockAiService.clearConversation).toHaveBeenCalledWith(TEST_USER.id, VALID_NOTE_ID);
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/ai/history/${VALID_NOTE_ID}`,
    });
    expect(res.statusCode).toBe(401);
  });
});
