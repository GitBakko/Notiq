import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import fastifyMultipart from '@fastify/multipart';

// chatWebSocket creates a WebSocketServer at import: must be mocked
vi.mock('../../chatWebSocket', () => ({
  broadcastToConversation: vi.fn(),
  notifyNewDirectMessage: vi.fn(),
}));

vi.mock('../../services/chat-direct.service', () => ({
  getConversations: vi.fn(),
  getOrCreateDirectConversation: vi.fn(),
  createGroupConversation: vi.fn(),
  getMessages: vi.fn(),
  searchMessages: vi.fn(),
  getUnreadCount: vi.fn(),
  sendMessage: vi.fn(),
  messageInclude: {},
}));

vi.mock('../../services/chat-file.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/chat-file.service')>();
  return { ...actual, uploadChatFile: vi.fn() };
});

vi.mock('../../plugins/prisma', () => ({
  default: {
    conversationParticipant: { findUnique: vi.fn() },
    directMessage: { findUnique: vi.fn() },
    systemSetting: { findUnique: vi.fn() },
  },
}));

import { broadcastToConversation, notifyNewDirectMessage } from '../../chatWebSocket';
import * as chatService from '../../services/chat-direct.service';
import * as fileService from '../../services/chat-file.service';
import prisma from '../../plugins/prisma';
import { AppError } from '../../utils/errors';
import chatDirectRoutes from '../chat-direct';

const mockBroadcast = broadcastToConversation as any;
const mockNotify = notifyNewDirectMessage as any;
const mockChat = chatService as any;
const mockFiles = fileService as any;
const mockPrisma = prisma as any;

const TEST_USER = { id: 'user-1', email: 'test@test.com', role: 'USER', tokenVersion: 0 };
const CONV_ID = '550e8400-e29b-41d4-a716-446655440000';

let app: FastifyInstance;
let authToken: string;

beforeAll(async () => {
  app = Fastify();
  app.register(jwt, { secret: 'test-secret' });
  app.register(fastifyMultipart);
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
    reply.status(500).send({ message: error.message });
  });
  app.register(chatDirectRoutes, { prefix: '/api/chat-direct' });
  await app.ready();
  authToken = app.jwt.sign(TEST_USER);
});

afterAll(async () => {
  await app.close();
});

const MESSAGE = { id: 'msg-1', content: 'hello.txt', sender: { name: 'Test' } };
const FULL_MESSAGE = { ...MESSAGE, files: [{ id: 'f1', url: '/uploads/chat/x.txt' }] };
const FILE_RESULT = { url: '/uploads/chat/x.txt', thumbnailUrl: null, filename: 'hello.txt', mimeType: 'text/plain', size: 2 };

beforeEach(() => {
  vi.resetAllMocks();
  mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ id: 'p1' });
  mockPrisma.systemSetting.findUnique.mockResolvedValue(null);
  mockChat.sendMessage.mockResolvedValue(MESSAGE);
  mockFiles.uploadChatFile.mockResolvedValue(FILE_RESULT);
  mockPrisma.directMessage.findUnique.mockResolvedValue(FULL_MESSAGE);
});

function upload(filename: string) {
  const boundary = '----TestBoundary' + Date.now();
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--${boundary}--\r\n`,
  );
  return app.inject({
    method: 'POST',
    url: `/api/chat-direct/conversations/${CONV_ID}/files`,
    headers: { authorization: `Bearer ${authToken}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
}

describe('POST /api/chat-direct/conversations/:id/files', () => {
  it('broadcasts message:new (excluding sender) and notifies', async () => {
    const res = await upload('hello.txt');
    expect(res.statusCode).toBe(200);
    expect(mockBroadcast).toHaveBeenCalledWith(CONV_ID, { type: 'message:new', message: FULL_MESSAGE }, TEST_USER.id);
    expect(mockNotify).toHaveBeenCalledWith(CONV_ID, TEST_USER.id, MESSAGE, 'hello.txt');
  });

  it('still returns 200 with files populated when the broadcast rejects', async () => {
    mockBroadcast.mockRejectedValue(new Error('ws down'));
    const res = await upload('hello.txt');
    expect(res.statusCode).toBe(200);
    expect(res.json().message.files).toHaveLength(1);
    expect(mockNotify).toHaveBeenCalledWith(CONV_ID, TEST_USER.id, MESSAGE, 'hello.txt');
  });

  it('never returns message: null when the re-read finds nothing, and skips broadcast', async () => {
    mockPrisma.directMessage.findUnique.mockResolvedValue(null);
    const res = await upload('hello.txt');
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toMatchObject({
      id: 'msg-1',
      files: [{ url: FILE_RESULT.url, thumbnailUrl: null, filename: 'hello.txt', mimeType: 'text/plain', size: 2 }],
    });
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('rejects a blocked extension with 400 before any message is created', async () => {
    const res = await upload('virus.exe');
    expect(res.statusCode).toBe(400);
    expect(mockChat.sendMessage).not.toHaveBeenCalled();
    expect(mockFiles.uploadChatFile).not.toHaveBeenCalled();
  });
});
