import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

// Mock services BEFORE imports
vi.mock('../../services/settings.service', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  getBooleanSetting: vi.fn(),
}));

vi.mock('../../services/admin.service', () => ({
  getDashboardStats: vi.fn(),
  getUsers: vi.fn(),
  getAuditLogs: vi.fn(),
  updateUser: vi.fn(),
}));

import prisma from '../../plugins/prisma';
import * as settingsService from '../../services/settings.service';
import * as adminService from '../../services/admin.service';
import { AppError } from '../../utils/errors';
import adminRoutes from '../admin';

const mockPrisma = prisma as any;
const mockSettings = settingsService as any;
const mockAdmin = adminService as any;

const TEST_USER = { id: 'user-1', email: 'test@test.com', role: 'USER', tokenVersion: 0 };
const ADMIN_USER = { id: 'admin-1', email: 'admin@test.com', role: 'SUPERADMIN', tokenVersion: 0 };

let app: FastifyInstance;
let userToken: string;
let adminToken: string;

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

  app.register(adminRoutes, { prefix: '/api/admin' });
  await app.ready();
  userToken = app.jwt.sign(TEST_USER);
  adminToken = app.jwt.sign(ADMIN_USER);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

// Helper: configure prisma.user.findUnique to return user with given role
function mockUserRole(role: 'USER' | 'SUPERADMIN') {
  mockPrisma.user.findUnique.mockResolvedValue({ id: role === 'SUPERADMIN' ? ADMIN_USER.id : TEST_USER.id, role });
}

describe('POST /api/admin/settings', () => {
  it('updates a setting when called by SUPERADMIN', async () => {
    mockUserRole('SUPERADMIN');
    mockSettings.setSetting.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/settings',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { key: 'ai_enabled', value: 'true' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ message: 'Setting updated' });
    expect(mockSettings.setSetting).toHaveBeenCalledWith('ai_enabled', 'true');
  });

  it('returns 403 when called by regular USER', async () => {
    mockUserRole('USER');

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/settings',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { key: 'ai_enabled', value: 'true' },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).message).toBe('errors.common.forbidden');
  });

  it('returns 400 with invalid body (missing key)', async () => {
    mockUserRole('SUPERADMIN');

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/settings',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { value: 'true' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/settings',
      payload: { key: 'ai_enabled', value: 'true' },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/admin/stats', () => {
  it('returns dashboard stats for SUPERADMIN', async () => {
    mockUserRole('SUPERADMIN');
    const mockStats = { users: 10, notes: 100, notebooks: 5 };
    mockAdmin.getDashboardStats.mockResolvedValue(mockStats);

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockStats);
  });

  it('returns 403 for regular USER', async () => {
    mockUserRole('USER');

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: { authorization: `Bearer ${userToken}` },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('GET /api/admin/users', () => {
  it('returns paginated users for SUPERADMIN', async () => {
    mockUserRole('SUPERADMIN');
    const mockUsers = { users: [{ id: 'u1', email: 'a@b.com' }], total: 1 };
    mockAdmin.getUsers.mockResolvedValue(mockUsers);

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/users?page=1&limit=10',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockUsers);
    expect(mockAdmin.getUsers).toHaveBeenCalledWith(1, 10, undefined);
  });

  it('passes search param to service', async () => {
    mockUserRole('SUPERADMIN');
    mockAdmin.getUsers.mockResolvedValue({ users: [], total: 0 });

    await app.inject({
      method: 'GET',
      url: '/api/admin/users?search=test',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(mockAdmin.getUsers).toHaveBeenCalledWith(1, 10, 'test');
  });

  it('rejects limit > 100', async () => {
    mockUserRole('SUPERADMIN');

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/users?limit=200',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /api/admin/users/:id', () => {
  it('updates a user role', async () => {
    mockUserRole('SUPERADMIN');
    mockAdmin.updateUser.mockResolvedValue(undefined);
    const uuid = '550e8400-e29b-41d4-a716-446655440000';

    const res = await app.inject({
      method: 'PUT',
      url: `/api/admin/users/${uuid}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: 'SUPERADMIN' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ message: 'User updated' });
    expect(mockAdmin.updateUser).toHaveBeenCalledWith(uuid, { role: 'SUPERADMIN' });
  });

  it('rejects non-UUID id param', async () => {
    mockUserRole('SUPERADMIN');

    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/users/not-a-uuid',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: 'USER' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid role value', async () => {
    mockUserRole('SUPERADMIN');
    const uuid = '550e8400-e29b-41d4-a716-446655440000';

    const res = await app.inject({
      method: 'PUT',
      url: `/api/admin/users/${uuid}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: 'INVALID_ROLE' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/admin/audit-logs', () => {
  it('returns audit logs for SUPERADMIN', async () => {
    mockUserRole('SUPERADMIN');
    const mockLogs = { logs: [{ id: 'log-1', action: 'LOGIN' }], total: 1 };
    mockAdmin.getAuditLogs.mockResolvedValue(mockLogs);

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-logs',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockLogs);
    expect(mockAdmin.getAuditLogs).toHaveBeenCalledWith(1, 20);
  });

  it('returns 403 for regular USER', async () => {
    mockUserRole('USER');

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-logs',
      headers: { authorization: `Bearer ${userToken}` },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('GET /api/admin/ai-config', () => {
  it('returns AI configuration for SUPERADMIN', async () => {
    mockUserRole('SUPERADMIN');
    mockSettings.getSetting
      .mockResolvedValueOnce('true')      // ai_enabled
      .mockResolvedValueOnce('anthropic')  // ai_provider
      .mockResolvedValueOnce('sk-xxx')     // ai_api_key
      .mockResolvedValueOnce('claude-sonnet-4-20250514') // ai_model
      .mockResolvedValueOnce('4096')       // ai_max_tokens
      .mockResolvedValueOnce('0.7');       // ai_temperature

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/ai-config',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.enabled).toBe(true);
    expect(body.provider).toBe('anthropic');
    expect(body.apiKeySet).toBe(true);
    expect(body.model).toBe('claude-sonnet-4-20250514');
    expect(body.maxTokens).toBe(4096);
    expect(body.temperature).toBe(0.7);
  });

  it('returns apiKeySet false when no key is configured', async () => {
    mockUserRole('SUPERADMIN');
    mockSettings.getSetting
      .mockResolvedValueOnce('false')
      .mockResolvedValueOnce('anthropic')
      .mockResolvedValueOnce('')           // empty api key
      .mockResolvedValueOnce('claude-sonnet-4-20250514')
      .mockResolvedValueOnce('4096')
      .mockResolvedValueOnce('0.7');

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/ai-config',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.enabled).toBe(false);
    expect(body.apiKeySet).toBe(false);
  });

  it('returns 403 for regular USER', async () => {
    mockUserRole('USER');

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/ai-config',
      headers: { authorization: `Bearer ${userToken}` },
    });

    expect(res.statusCode).toBe(403);
  });
});
