import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { AppError } from '../../utils/errors';
import urlMetadataRoutes from '../url-metadata';

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

  app.register(urlMetadataRoutes, { prefix: '/api/url-metadata' });
  await app.ready();
  authToken = app.jwt.sign(TEST_USER);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function createMockReadableStream(content: string) {
  let consumed = false;
  return {
    getReader: () => ({
      read: async () => {
        if (consumed) return { done: true, value: undefined };
        consumed = true;
        return { done: false, value: new TextEncoder().encode(content) };
      },
      cancel: vi.fn(),
    }),
  };
}

describe('GET /api/url-metadata', () => {
  it('returns title and favicon from HTML page', async () => {
    const html = `
      <html><head>
        <title>Example Page</title>
        <link rel="icon" href="/favicon.png">
      </head><body></body></html>
    `;

    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      body: createMockReadableStream(html),
    } as any);

    const res = await app.inject({
      method: 'GET',
      url: '/api/url-metadata?url=https://example.com/page',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.title).toBe('Example Page');
    expect(body.faviconUrl).toBe('https://example.com/favicon.png');
  });

  it('returns fallback favicon.ico when no link tag present', async () => {
    const html = '<html><head><title>No Icon</title></head><body></body></html>';

    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html' }),
      body: createMockReadableStream(html),
    } as any);

    const res = await app.inject({
      method: 'GET',
      url: '/api/url-metadata?url=https://example.com',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.title).toBe('No Icon');
    expect(body.faviconUrl).toBe('https://example.com/favicon.ico');
  });

  it('returns 502 when fetch fails (non-ok response)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
    } as any);

    const res = await app.inject({
      method: 'GET',
      url: '/api/url-metadata?url=https://example.com',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.payload)).toEqual({ message: 'errors.urlMetadata.fetchFailed' });
  });

  it('returns 504 on timeout (AbortError)', async () => {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    vi.spyOn(global, 'fetch').mockRejectedValue(abortError);

    const res = await app.inject({
      method: 'GET',
      url: '/api/url-metadata?url=https://example.com',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(504);
    expect(JSON.parse(res.payload)).toEqual({ message: 'errors.urlMetadata.fetchTimeout' });
  });

  it('returns 400 with invalid URL', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/url-metadata?url=not-a-url',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/url-metadata?url=https://example.com',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/url-metadata/screenshot', () => {
  it('returns base64 screenshot', async () => {
    const imageBuffer = Buffer.from('fake-png-data');
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => imageBuffer.buffer.slice(imageBuffer.byteOffset, imageBuffer.byteOffset + imageBuffer.byteLength),
    } as any);

    const res = await app.inject({
      method: 'GET',
      url: '/api/url-metadata/screenshot?url=https://example.com',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.screenshotBase64).toMatch(/^data:image\/png;base64,/);
  });

  it('returns 502 when screenshot fetch fails', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
    } as any);

    const res = await app.inject({
      method: 'GET',
      url: '/api/url-metadata/screenshot?url=https://example.com',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.payload)).toEqual({ message: 'errors.urlMetadata.screenshotFailed' });
  });

  it('returns 504 on screenshot timeout', async () => {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    vi.spyOn(global, 'fetch').mockRejectedValue(abortError);

    const res = await app.inject({
      method: 'GET',
      url: '/api/url-metadata/screenshot?url=https://example.com',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(504);
    expect(JSON.parse(res.payload)).toEqual({ message: 'errors.urlMetadata.screenshotTimeout' });
  });
});
