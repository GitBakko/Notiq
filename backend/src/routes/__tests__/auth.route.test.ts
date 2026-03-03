import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwtPlugin from '@fastify/jwt';
import { ConflictError, UnauthorizedError } from '../../utils/errors';

// Mock services
vi.mock('../../services/auth.service', () => ({
  registerUser: vi.fn(),
  loginUser: vi.fn(),
  verifyEmail: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
}));

vi.mock('../../services/settings.service', () => ({
  getBooleanSetting: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../plugins/prisma', () => ({
  default: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

import { registerUser, loginUser, verifyEmail, requestPasswordReset, resetPassword } from '../../services/auth.service';
import authRoutes from '../auth';

const mockRegister = registerUser as any;
const mockLogin = loginUser as any;
const mockVerify = verifyEmail as any;
const mockRequestReset = requestPasswordReset as any;
const mockResetPw = resetPassword as any;

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  app.register(jwtPlugin, { secret: 'test-secret' });

  app.decorate('authenticate', async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ message: 'Unauthorized' });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error.name === 'ZodError') {
      return reply.status(400).send({ message: 'Validation error' });
    }
    const statusCode = (error as any).statusCode || 500;
    reply.status(statusCode).send({ message: error.message });
  });

  app.register(authRoutes, { prefix: '/api/auth' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/auth/register', () => {
  it('registers a user successfully', async () => {
    mockRegister.mockResolvedValue({ id: 'user-1', email: 'test@test.com' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'test@test.com', password: 'password123' },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.userId).toBe('user-1');
    expect(body.message).toContain('Registration successful');
  });

  it('returns 400 for invalid email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'not-email', password: 'password123' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for short password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'test@test.com', password: '12' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 409 when user already exists', async () => {
    mockRegister.mockRejectedValue(new ConflictError('auth.errors.userExists'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'existing@test.com', password: 'password123' },
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).message).toBe('auth.errors.userExists');
  });
});

describe('POST /api/auth/login', () => {
  it('logs in successfully and returns token', async () => {
    mockLogin.mockResolvedValue({
      id: 'user-1', email: 'test@test.com', role: 'USER', tokenVersion: 0,
      name: 'Test', surname: null, invitesAvailable: 3, avatarUrl: null, color: '#319795', createdAt: new Date(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'test@test.com', password: 'password123' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.token).toBeDefined();
    expect(body.user.id).toBe('user-1');
    expect(body.user.email).toBe('test@test.com');
  });

  it('returns 401 for invalid credentials', async () => {
    mockLogin.mockRejectedValue(new UnauthorizedError('auth.errors.invalidCredentials'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'test@test.com', password: 'wrongpassword' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 400 for missing password (Zod validation error)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'test@test.com', password: '' },
    });

    // Empty password fails Zod validation (min(1)), error handler returns 400
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/auth/verify-email', () => {
  it('verifies email successfully', async () => {
    mockVerify.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/verify-email',
      payload: { token: 'valid-token-123' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).message).toBe('Email verified successfully');
  });

  it('returns 401 for invalid token', async () => {
    mockVerify.mockRejectedValue(new UnauthorizedError('auth.errors.invalidOrExpiredToken'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/verify-email',
      payload: { token: 'bad-token' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 400 for empty token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/verify-email',
      payload: { token: '' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/auth/forgot-password', () => {
  it('always returns success (prevents email enumeration)', async () => {
    mockRequestReset.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      payload: { email: 'test@test.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).message).toContain('If the email exists');
  });

  it('returns success even for non-existent email', async () => {
    mockRequestReset.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      payload: { email: 'nonexistent@test.com' },
    });

    expect(res.statusCode).toBe(200);
  });
});

describe('POST /api/auth/reset-password', () => {
  it('resets password successfully', async () => {
    mockResetPw.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token: 'reset-token', newPassword: 'newpass123' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).message).toBe('Password reset successfully');
  });

  it('returns 401 for invalid token', async () => {
    mockResetPw.mockRejectedValue(new UnauthorizedError('auth.errors.invalidOrExpiredToken'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token: 'bad-token', newPassword: 'newpass123' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 400 for short password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token: 'token', newPassword: '12' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/auth/config', () => {
  it('returns invitation system config', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/config',
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ invitationSystemEnabled: true });
  });
});
