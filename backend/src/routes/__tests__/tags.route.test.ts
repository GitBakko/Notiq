import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

// Mock tag service
vi.mock('../../services/tag.service', () => ({
  createTag: vi.fn(),
  getTags: vi.fn(),
  updateTag: vi.fn(),
  deleteTag: vi.fn(),
  addTagToNote: vi.fn(),
  removeTagFromNote: vi.fn(),
}));

import * as tagService from '../../services/tag.service';
import { AppError, NotFoundError } from '../../utils/errors';
import tagRoutes from '../tags';

const mockTagService = tagService as any;

const TEST_USER = { id: 'user-1', email: 'test@test.com', role: 'USER', tokenVersion: 0 };
const UUID = '550e8400-e29b-41d4-a716-446655440000';
const UUID2 = '660e8400-e29b-41d4-a716-446655440001';

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

  app.register(tagRoutes, { prefix: '/api/tags' });
  await app.ready();
  authToken = app.jwt.sign(TEST_USER);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/tags', () => {
  it('creates a tag with valid data', async () => {
    const mockTag = { id: 'tag-1', name: 'Important', userId: 'user-1' };
    mockTagService.createTag.mockResolvedValue(mockTag);

    const res = await app.inject({
      method: 'POST',
      url: '/api/tags',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'Important' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockTag);
    expect(mockTagService.createTag).toHaveBeenCalledWith('user-1', 'Important', undefined, undefined);
  });

  it('creates a vault tag with client-generated id', async () => {
    const mockTag = { id: UUID, name: 'Secret', isVault: true };
    mockTagService.createTag.mockResolvedValue(mockTag);

    const res = await app.inject({
      method: 'POST',
      url: '/api/tags',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'Secret', isVault: true, id: UUID },
    });

    expect(res.statusCode).toBe(200);
    expect(mockTagService.createTag).toHaveBeenCalledWith('user-1', 'Secret', true, UUID);
  });

  it('returns 400 with empty name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tags',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 on duplicate tag (Prisma P2002)', async () => {
    const prismaError = Object.assign(new Error('Unique constraint'), { code: 'P2002' });
    mockTagService.createTag.mockRejectedValue(prismaError);

    const res = await app.inject({
      method: 'POST',
      url: '/api/tags',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'Duplicate' },
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).message).toBe('errors.tags.alreadyExists');
  });
});

describe('GET /api/tags', () => {
  it('returns all tags', async () => {
    const mockTags = [{ id: 'tag-1', name: 'Work' }, { id: 'tag-2', name: 'Personal' }];
    mockTagService.getTags.mockResolvedValue(mockTags);

    const res = await app.inject({
      method: 'GET',
      url: '/api/tags',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockTags);
    expect(mockTagService.getTags).toHaveBeenCalledWith('user-1', undefined);
  });

  it('filters vault tags with isVault=true', async () => {
    mockTagService.getTags.mockResolvedValue([]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/tags?isVault=true',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(mockTagService.getTags).toHaveBeenCalledWith('user-1', true);
  });

  it('filters non-vault tags with isVault=false', async () => {
    mockTagService.getTags.mockResolvedValue([]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/tags?isVault=false',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(mockTagService.getTags).toHaveBeenCalledWith('user-1', false);
  });
});

describe('PUT /api/tags/:id', () => {
  it('updates a tag', async () => {
    mockTagService.updateTag.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tags/tag-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'Updated' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ message: 'Tag updated' });
  });

  it('returns 404 when tag not found', async () => {
    mockTagService.updateTag.mockRejectedValue(new NotFoundError('errors.tags.notFound'));

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tags/tag-999',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'X' },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/tags/:id', () => {
  it('deletes a tag', async () => {
    mockTagService.deleteTag.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/tags/tag-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ message: 'Tag deleted' });
  });
});

describe('POST /api/tags/note', () => {
  it('adds a tag to a note', async () => {
    mockTagService.addTagToNote.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/api/tags/note',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { noteId: UUID, tagId: UUID2 },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ message: 'Tag added to note' });
  });

  it('returns 400 with non-UUID noteId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tags/note',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { noteId: 'bad-id', tagId: UUID2 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/tags/note', () => {
  it('removes a tag from a note', async () => {
    mockTagService.removeTagFromNote.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/tags/note',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { noteId: UUID, tagId: UUID2 },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ message: 'Tag removed from note' });
  });

  it('returns 400 with non-UUID tagId', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/tags/note',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { noteId: UUID, tagId: 'bad-id' },
    });
    expect(res.statusCode).toBe(400);
  });
});
