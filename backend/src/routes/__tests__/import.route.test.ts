import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import fastifyMultipart from '@fastify/multipart';

// Mock services BEFORE imports
vi.mock('../../services/import.service', () => ({
  importFromEnex: vi.fn(),
}));

vi.mock('../../services/onenote-import.service', () => ({
  importFromOneNote: vi.fn(),
}));

import * as importService from '../../services/import.service';
import * as onenoteImportService from '../../services/onenote-import.service';
import { AppError } from '../../utils/errors';
import importRoutes from '../import';

const mockImportService = importService as any;
const mockOnenoteImportService = onenoteImportService as any;

const TEST_USER = { id: 'user-1', email: 'test@test.com', role: 'USER', tokenVersion: 0 };

let app: FastifyInstance;
let authToken: string;

beforeAll(async () => {
  app = Fastify();
  app.register(jwt, { secret: 'test-secret' });
  app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024 } });

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

  app.register(importRoutes, { prefix: '/api/import' });
  await app.ready();
  authToken = app.jwt.sign(TEST_USER);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

/** Build a minimal multipart/form-data payload with a single file field. */
function buildMultipartPayload(filename: string, content: Buffer, contentType = 'application/xml') {
  const boundary = '----TestBoundary' + Date.now();
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;

  return {
    body: Buffer.concat([Buffer.from(header), content, Buffer.from(footer)]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('POST /api/import/evernote', () => {
  it('imports an ENEX file successfully', async () => {
    const mockResult = { imported: 3, skipped: 0, errors: [] };
    mockImportService.importFromEnex.mockResolvedValue(mockResult);

    const { body, contentType } = buildMultipartPayload('notes.enex', Buffer.from('<en-export></en-export>'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/import/evernote',
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': contentType,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockResult);
    expect(mockImportService.importFromEnex).toHaveBeenCalledWith(
      expect.any(Buffer),
      'user-1',
      undefined,
      false,
    );
  });

  it('passes notebookId and isVault query params', async () => {
    const mockResult = { imported: 1, skipped: 0, errors: [] };
    mockImportService.importFromEnex.mockResolvedValue(mockResult);

    const nbId = '550e8400-e29b-41d4-a716-446655440000';
    const { body, contentType } = buildMultipartPayload('notes.enex', Buffer.from('<en-export></en-export>'));

    const res = await app.inject({
      method: 'POST',
      url: `/api/import/evernote?notebookId=${nbId}&isVault=true`,
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': contentType,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(mockImportService.importFromEnex).toHaveBeenCalledWith(
      expect.any(Buffer),
      'user-1',
      nbId,
      true,
    );
  });

  it('returns 401 without auth token', async () => {
    const { body, contentType } = buildMultipartPayload('notes.enex', Buffer.from('<en-export></en-export>'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/import/evernote',
      headers: { 'content-type': contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when import service throws', async () => {
    mockImportService.importFromEnex.mockRejectedValue(new Error('Invalid ENEX format'));

    const { body, contentType } = buildMultipartPayload('bad.enex', Buffer.from('not xml'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/import/evernote',
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': contentType,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).message).toBe('Invalid ENEX format');
  });
});

describe('POST /api/import/onenote', () => {
  it('imports a OneNote file successfully', async () => {
    const mockResult = { imported: 2, skipped: 1, errors: [] };
    mockOnenoteImportService.importFromOneNote.mockResolvedValue(mockResult);

    const { body, contentType } = buildMultipartPayload('notes.mht', Buffer.from('<html></html>'), 'message/rfc822');

    const res = await app.inject({
      method: 'POST',
      url: '/api/import/onenote',
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': contentType,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockResult);
    expect(mockOnenoteImportService.importFromOneNote).toHaveBeenCalledWith(
      expect.any(Buffer),
      'notes.mht',
      'user-1',
      undefined,
      false,
    );
  });

  it('returns 400 when OneNote import service throws', async () => {
    mockOnenoteImportService.importFromOneNote.mockRejectedValue(new Error('Unsupported format'));

    const { body, contentType } = buildMultipartPayload('bad.mht', Buffer.from('garbage'), 'message/rfc822');

    const res = await app.inject({
      method: 'POST',
      url: '/api/import/onenote',
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': contentType,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).message).toBe('Unsupported format');
  });
});
