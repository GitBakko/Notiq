import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

vi.mock('../../services/note.service', () => ({
  createNote: vi.fn().mockResolvedValue({ id: 'n1' }),
  updateNote: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../utils/ydoc', () => ({ contentToYNodes: vi.fn() }));

import { AppError } from '../../utils/errors';
import noteRoutes from '../notes';

const NB = '550e8400-e29b-41d4-a716-446655440000';
const MAX = 2 * 1024 * 1024;
let app: FastifyInstance;
let auth: Record<string, string>;

beforeAll(async () => {
  // Default Fastify bodyLimit (1 MiB), like app.ts: only the route-level override can accept 2 MiB.
  app = Fastify();
  app.register(jwt, { secret: 'test-secret' });
  app.decorate('authenticate', async (request: any, reply: any) => {
    try { await request.jwtVerify(); } catch { return reply.code(401).send({ message: 'Unauthorized' }); }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.statusCode).send({ message: error.message });
    if (error.name === 'ZodError') return reply.status(400).send({ message: 'Validation error' });
    reply.status((error as any).statusCode ?? 500).send({ message: error.message });
  });
  app.register(noteRoutes, { prefix: '/api/notes' });
  await app.ready();
  auth = { authorization: `Bearer ${app.jwt.sign({ id: 'u1', email: 'a@b.c', role: 'USER' })}` };
});

afterAll(async () => { await app.close(); });

describe('notes routes body limit', () => {
  it('PUT accepts content of 2 MiB plus title/tags beyond 2 MiB total', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/notes/n1', headers: auth,
      payload: { content: 'a'.repeat(MAX), title: 't'.repeat(1000), tags: [] },
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST accepts content of 2 MiB plus other fields', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/notes', headers: auth,
      payload: { notebookId: NB, title: 't'.repeat(1000), content: 'a'.repeat(MAX) },
    });
    expect(res.statusCode).toBe(200);
  });

  it('content of 2 MiB + 1 -> 400 on PUT and POST', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/notes/n1', headers: auth, payload: { content: 'a'.repeat(MAX + 1) } });
    const post = await app.inject({ method: 'POST', url: '/api/notes', headers: auth, payload: { notebookId: NB, content: 'a'.repeat(MAX + 1) } });
    expect(put.statusCode).toBe(400);
    expect(post.statusCode).toBe(400);
  });
});
