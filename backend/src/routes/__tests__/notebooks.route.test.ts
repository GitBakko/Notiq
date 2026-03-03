import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

// Mock notebook service
vi.mock('../../services/notebook.service', () => ({
  createNotebook: vi.fn(),
  getNotebooks: vi.fn(),
  getNotebook: vi.fn(),
  updateNotebook: vi.fn(),
  deleteNotebook: vi.fn(),
}));

import * as notebookService from '../../services/notebook.service';
import { AppError, NotFoundError } from '../../utils/errors';
import notebookRoutes from '../notebooks';

const mockNotebookService = notebookService as any;

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

  app.register(notebookRoutes, { prefix: '/api/notebooks' });
  await app.ready();
  authToken = app.jwt.sign(TEST_USER);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/notebooks', () => {
  it('creates a notebook with valid data', async () => {
    const mockNotebook = { id: 'nb-1', name: 'My Notebook', userId: 'user-1' };
    mockNotebookService.createNotebook.mockResolvedValue(mockNotebook);

    const res = await app.inject({
      method: 'POST',
      url: '/api/notebooks',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'My Notebook' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockNotebook);
    expect(mockNotebookService.createNotebook).toHaveBeenCalledWith('user-1', 'My Notebook', undefined);
  });

  it('creates a notebook with optional client-generated id', async () => {
    const clientId = '550e8400-e29b-41d4-a716-446655440000';
    const mockNotebook = { id: clientId, name: 'Synced', userId: 'user-1' };
    mockNotebookService.createNotebook.mockResolvedValue(mockNotebook);

    const res = await app.inject({
      method: 'POST',
      url: '/api/notebooks',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'Synced', id: clientId },
    });

    expect(res.statusCode).toBe(200);
    expect(mockNotebookService.createNotebook).toHaveBeenCalledWith('user-1', 'Synced', clientId);
  });

  it('returns 400 with empty name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/notebooks',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 with non-UUID id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/notebooks',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'Test', id: 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/notebooks',
      payload: { name: 'Test' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/notebooks', () => {
  it('returns notebooks list', async () => {
    const mockNotebooks = [{ id: 'nb-1', name: 'Work' }, { id: 'nb-2', name: 'Personal' }];
    mockNotebookService.getNotebooks.mockResolvedValue(mockNotebooks);

    const res = await app.inject({
      method: 'GET',
      url: '/api/notebooks',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockNotebooks);
  });
});

describe('GET /api/notebooks/:id', () => {
  it('returns a notebook by id', async () => {
    const mockNotebook = { id: 'nb-1', name: 'Work', notes: [] };
    mockNotebookService.getNotebook.mockResolvedValue(mockNotebook);

    const res = await app.inject({
      method: 'GET',
      url: '/api/notebooks/nb-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockNotebook);
  });

  it('returns 404 when notebook not found', async () => {
    mockNotebookService.getNotebook.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/api/notebooks/nb-999',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('PUT /api/notebooks/:id', () => {
  it('updates a notebook', async () => {
    mockNotebookService.updateNotebook.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/notebooks/nb-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'Updated Name' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ message: 'Notebook updated' });
  });

  it('returns 404 when notebook not found', async () => {
    mockNotebookService.updateNotebook.mockRejectedValue(new NotFoundError('errors.notebooks.notFound'));

    const res = await app.inject({
      method: 'PUT',
      url: '/api/notebooks/nb-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'X' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 400 with empty name', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/notebooks/nb-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/notebooks/:id', () => {
  it('deletes a notebook', async () => {
    mockNotebookService.deleteNotebook.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/notebooks/nb-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ message: 'Notebook deleted' });
  });

  it('returns 404 when notebook not found', async () => {
    mockNotebookService.deleteNotebook.mockRejectedValue(new NotFoundError('errors.notebooks.notFound'));

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/notebooks/nb-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
