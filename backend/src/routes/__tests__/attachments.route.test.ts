import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

// Mock services BEFORE imports
vi.mock('../../services/attachment.service', () => ({
  saveAttachment: vi.fn(),
  getAttachments: vi.fn(),
  deleteAttachment: vi.fn(),
  getAttachmentHistory: vi.fn(),
  getAttachmentPath: vi.fn(),
}));

vi.mock('../../services/note.service', () => ({
  checkNoteAccess: vi.fn(),
}));

vi.mock('../../plugins/prisma', () => ({
  default: {
    attachment: {
      findUnique: vi.fn(),
    },
  },
}));

// Mock fs for download route
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(),
      createReadStream: vi.fn(),
    },
    existsSync: vi.fn(),
    createReadStream: vi.fn(),
  };
});

import * as attachmentService from '../../services/attachment.service';
import * as noteService from '../../services/note.service';
import prisma from '../../plugins/prisma';
import fs from 'fs';
import { AppError, NotFoundError, ForbiddenError } from '../../utils/errors';
import { attachmentRoutes } from '../attachments';

const mockAttachmentService = attachmentService as any;
const mockNoteService = noteService as any;
const mockPrisma = prisma as any;
const mockFs = fs as any;

const TEST_USER = { id: 'user-1', email: 'test@test.com', role: 'USER', tokenVersion: 0 };

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

  app.register(attachmentRoutes, { prefix: '/api/attachments' });
  await app.ready();
  authToken = app.jwt.sign(TEST_USER);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/attachments/:noteId', () => {
  it('returns attachments for a note', async () => {
    const mockAttachments = [
      { id: 'att-1', filename: 'file.png', mimeType: 'image/png', size: 1024 },
    ];
    mockNoteService.checkNoteAccess.mockResolvedValue('OWNER');
    mockAttachmentService.getAttachments.mockResolvedValue(mockAttachments);

    const res = await app.inject({
      method: 'GET',
      url: '/api/attachments/note-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockAttachments);
    expect(mockNoteService.checkNoteAccess).toHaveBeenCalledWith('user-1', 'note-1');
  });

  it('returns 403 when user has no access', async () => {
    mockNoteService.checkNoteAccess.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/api/attachments/note-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/attachments/note-1',
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/attachments/:noteId/history', () => {
  it('returns version history for a filename', async () => {
    const mockHistory = [
      { id: 'att-2', filename: 'doc.pdf', version: 2 },
      { id: 'att-1', filename: 'doc.pdf', version: 1 },
    ];
    mockNoteService.checkNoteAccess.mockResolvedValue('READ');
    mockAttachmentService.getAttachmentHistory.mockResolvedValue(mockHistory);

    const res = await app.inject({
      method: 'GET',
      url: '/api/attachments/note-1/history?filename=doc.pdf',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockHistory);
    expect(mockAttachmentService.getAttachmentHistory).toHaveBeenCalledWith('note-1', 'doc.pdf');
  });

  it('returns 400 when filename query param is missing', async () => {
    mockNoteService.checkNoteAccess.mockResolvedValue('OWNER');

    const res = await app.inject({
      method: 'GET',
      url: '/api/attachments/note-1/history',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/attachments/:id', () => {
  it('deletes an attachment with OWNER access', async () => {
    const mockAttachment = { id: 'att-1', noteId: 'note-1', filename: 'file.png' };
    mockPrisma.attachment.findUnique.mockResolvedValue(mockAttachment);
    mockNoteService.checkNoteAccess.mockResolvedValue('OWNER');
    mockAttachmentService.deleteAttachment.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/attachments/att-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ message: 'Attachment deleted' });
    expect(mockAttachmentService.deleteAttachment).toHaveBeenCalledWith('att-1');
  });

  it('returns 404 when attachment not found', async () => {
    mockPrisma.attachment.findUnique.mockResolvedValue(null);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/attachments/att-999',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 403 when user has READ-only access', async () => {
    const mockAttachment = { id: 'att-1', noteId: 'note-1', filename: 'file.png' };
    mockPrisma.attachment.findUnique.mockResolvedValue(mockAttachment);
    mockNoteService.checkNoteAccess.mockResolvedValue('READ');

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/attachments/att-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).message).toBe('errors.common.readOnlyAccess');
  });
});
