import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

// Mock prisma plugin BEFORE imports
vi.mock('../../plugins/prisma', () => ({
  default: {
    $queryRaw: vi.fn(),
  },
}));

import prisma from '../../plugins/prisma';
import { AppError } from '../../utils/errors';
import healthRoutes from '../health';

const mockPrisma = prisma as any;

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ message: error.message });
    }
    reply.status(500).send({ message: error.message });
  });

  app.register(healthRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /health', () => {
  it('returns 200 with status ok when DB is up', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('ok');
    expect(body.db).toBe('up');
    expect(body.timestamp).toBeDefined();
  });

  it('returns 503 when DB is down', async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error('Connection refused'));

    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('error');
    expect(body.db).toBe('down');
    expect(body.timestamp).toBeDefined();
  });

  it('does not require authentication', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    // No auth header — health check should be public
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
  });
});
