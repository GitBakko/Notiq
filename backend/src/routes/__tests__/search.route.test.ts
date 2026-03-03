import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

// Mock search service
vi.mock('../../services/search.service', () => ({
  searchNotes: vi.fn(),
}));

import { searchNotes } from '../../services/search.service';
import { AppError } from '../../utils/errors';
import searchRoutes from '../search';

const mockSearchNotes = searchNotes as any;

const TEST_USER = { id: 'user-1', email: 'test@test.com', role: 'USER', tokenVersion: 0 };
const NOTEBOOK_UUID = '550e8400-e29b-41d4-a716-446655440000';

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

  app.register(searchRoutes, { prefix: '/api/search' });
  await app.ready();
  authToken = app.jwt.sign(TEST_USER);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/search', () => {
  it('returns search results with valid query', async () => {
    const mockResults = { notes: [{ id: 'note-1', title: 'Meeting notes' }], total: 1 };
    mockSearchNotes.mockResolvedValue(mockResults);

    const res = await app.inject({
      method: 'GET',
      url: '/api/search?q=meeting',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockResults);
    expect(mockSearchNotes).toHaveBeenCalledWith('user-1', 'meeting', 1, 20, undefined);
  });

  it('passes page, limit, and notebookId correctly', async () => {
    mockSearchNotes.mockResolvedValue({ notes: [], total: 0 });

    const res = await app.inject({
      method: 'GET',
      url: `/api/search?q=test&page=3&limit=10&notebookId=${NOTEBOOK_UUID}`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(mockSearchNotes).toHaveBeenCalledWith('user-1', 'test', 3, 10, NOTEBOOK_UUID);
  });

  it('clamps limit to max 50', async () => {
    mockSearchNotes.mockResolvedValue({ notes: [], total: 0 });

    const res = await app.inject({
      method: 'GET',
      url: '/api/search?q=test&limit=999',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(mockSearchNotes).toHaveBeenCalledWith('user-1', 'test', 1, 50, undefined);
  });

  it('defaults page to 1 and limit to 20', async () => {
    mockSearchNotes.mockResolvedValue({ notes: [], total: 0 });

    const res = await app.inject({
      method: 'GET',
      url: '/api/search?q=hello',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(mockSearchNotes).toHaveBeenCalledWith('user-1', 'hello', 1, 20, undefined);
  });

  it('returns 400 with missing query', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/search',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 with query shorter than 2 characters', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/search?q=a',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/search?q=test',
    });
    expect(res.statusCode).toBe(401);
  });

  it('trims whitespace from query', async () => {
    mockSearchNotes.mockResolvedValue({ notes: [], total: 0 });

    const res = await app.inject({
      method: 'GET',
      url: '/api/search?q=%20%20hello%20%20',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(mockSearchNotes).toHaveBeenCalledWith('user-1', 'hello', 1, 20, undefined);
  });
});
