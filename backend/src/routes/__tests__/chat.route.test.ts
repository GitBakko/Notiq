import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

// Mock chat and note services
vi.mock('../../services/chat.service', () => ({
  createMessage: vi.fn(),
  getMessages: vi.fn(),
}));

vi.mock('../../services/note.service', () => ({
  checkNoteAccess: vi.fn(),
}));

import * as chatService from '../../services/chat.service';
import { checkNoteAccess } from '../../services/note.service';
import { AppError } from '../../utils/errors';
import chatRoutes from '../chat';

const mockChatService = chatService as any;
const mockCheckNoteAccess = checkNoteAccess as any;

const TEST_USER = { id: 'user-1', email: 'test@test.com', role: 'USER', tokenVersion: 0 };
const NOTE_UUID = '550e8400-e29b-41d4-a716-446655440000';

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

  app.register(chatRoutes, { prefix: '/api/chat' });
  await app.ready();
  authToken = app.jwt.sign(TEST_USER);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/chat', () => {
  it('creates a message with valid data', async () => {
    const mockMessage = { id: 'msg-1', content: 'Hello', noteId: NOTE_UUID, userId: 'user-1' };
    mockCheckNoteAccess.mockResolvedValue({ permission: 'WRITE' });
    mockChatService.createMessage.mockResolvedValue(mockMessage);

    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { noteId: NOTE_UUID, content: 'Hello' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockMessage);
    expect(mockChatService.createMessage).toHaveBeenCalledWith('user-1', NOTE_UUID, 'Hello');
  });

  it('returns 403 when user has no note access', async () => {
    mockCheckNoteAccess.mockResolvedValue(null);

    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { noteId: NOTE_UUID, content: 'Hello' },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).message).toBe('errors.common.forbidden');
  });

  it('returns 400 with non-UUID noteId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { noteId: 'not-a-uuid', content: 'Hello' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 with empty content', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { noteId: NOTE_UUID, content: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { noteId: NOTE_UUID, content: 'Hello' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/chat/:noteId', () => {
  it('returns messages for a note', async () => {
    const mockMessages = [
      { id: 'msg-1', content: 'Hi', userId: 'user-1' },
      { id: 'msg-2', content: 'Hey', userId: 'user-2' },
    ];
    mockCheckNoteAccess.mockResolvedValue({ permission: 'READ' });
    mockChatService.getMessages.mockResolvedValue(mockMessages);

    const res = await app.inject({
      method: 'GET',
      url: `/api/chat/${NOTE_UUID}`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockMessages);
    expect(mockChatService.getMessages).toHaveBeenCalledWith(NOTE_UUID);
  });

  it('returns 403 when user has no note access', async () => {
    mockCheckNoteAccess.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: `/api/chat/${NOTE_UUID}`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).message).toBe('errors.common.forbidden');
  });
});
