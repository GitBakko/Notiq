import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

// Mock services BEFORE imports
vi.mock('../../services/invite.service', () => ({
  generateInvite: vi.fn(),
  getUserInvites: vi.fn(),
  sendInviteEmail: vi.fn(),
  createInvitationRequest: vi.fn(),
  getInvitationRequests: vi.fn(),
  approveInvitationRequest: vi.fn(),
  rejectInvitationRequest: vi.fn(),
}));

vi.mock('../../services/auth.service', () => ({
  resendVerificationForInvite: vi.fn(),
}));

import * as inviteService from '../../services/invite.service';
import * as authService from '../../services/auth.service';
import { AppError, BadRequestError, NotFoundError } from '../../utils/errors';
import inviteRoutes, { adminInviteRoutes, publicInviteRoutes } from '../invite';

const mockInvite = inviteService as any;
const mockAuth = authService as any;

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

  // Register all three route groups with their production prefixes
  app.register(inviteRoutes, { prefix: '/api/invites' });
  app.register(adminInviteRoutes, { prefix: '/api/admin' });
  app.register(publicInviteRoutes, { prefix: '/api/auth' });
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

// --- Authenticated invite routes (prefix: /api/invites) ---

describe('GET /api/invites', () => {
  it('returns user invites', async () => {
    const mockInvites = [{ id: 'inv-1', code: 'ABC123', status: 'PENDING' }];
    mockInvite.getUserInvites.mockResolvedValue(mockInvites);

    const res = await app.inject({
      method: 'GET',
      url: '/api/invites',
      headers: { authorization: `Bearer ${userToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockInvites);
    expect(mockInvite.getUserInvites).toHaveBeenCalledWith(TEST_USER.id);
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/invites',
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/invites', () => {
  it('generates a new invite', async () => {
    const mockResult = { id: 'inv-1', code: 'NEW-CODE' };
    mockInvite.generateInvite.mockResolvedValue(mockResult);

    const res = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: { authorization: `Bearer ${userToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockResult);
    expect(mockInvite.generateInvite).toHaveBeenCalledWith(TEST_USER.id);
  });
});

describe('POST /api/invites/:code/email', () => {
  it('sends invite email with valid data', async () => {
    mockInvite.sendInviteEmail.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/api/invites/ABC123/email',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { email: 'friend@example.com', name: 'Friend', locale: 'it' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
    expect(mockInvite.sendInviteEmail).toHaveBeenCalledWith('ABC123', TEST_USER.id, 'friend@example.com', 'Friend', 'it');
  });

  it('defaults locale to en when not provided', async () => {
    mockInvite.sendInviteEmail.mockResolvedValue(undefined);

    await app.inject({
      method: 'POST',
      url: '/api/invites/ABC123/email',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { email: 'friend@example.com', name: 'Friend' },
    });

    expect(mockInvite.sendInviteEmail).toHaveBeenCalledWith('ABC123', TEST_USER.id, 'friend@example.com', 'Friend', 'en');
  });

  it('returns 400 with invalid email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/invites/ABC123/email',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { email: 'not-an-email', name: 'Friend' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 with empty name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/invites/ABC123/email',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { email: 'friend@example.com', name: '' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('propagates service error', async () => {
    mockInvite.sendInviteEmail.mockRejectedValue(new NotFoundError('errors.invites.notFound'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/invites/ABC123/email',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { email: 'friend@example.com', name: 'Friend' },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/invites/:code/resend', () => {
  it('resends verification email for invite', async () => {
    mockAuth.resendVerificationForInvite.mockResolvedValue({ success: true });

    const res = await app.inject({
      method: 'POST',
      url: '/api/invites/ABC123/resend',
      headers: { authorization: `Bearer ${userToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
  });

  it('propagates service error on resend', async () => {
    mockAuth.resendVerificationForInvite.mockRejectedValue(new BadRequestError('errors.invites.alreadyUsed'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/invites/ABC123/resend',
      headers: { authorization: `Bearer ${userToken}` },
    });

    expect(res.statusCode).toBe(400);
  });
});

// --- Public invite routes (prefix: /api/auth) ---

describe('POST /api/auth/request (public)', () => {
  it('creates invitation request and returns success', async () => {
    mockInvite.createInvitationRequest.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/request',
      payload: { email: 'newuser@example.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
    expect(mockInvite.createInvitationRequest).toHaveBeenCalledWith('newuser@example.com', expect.any(String));
  });

  it('silently succeeds when honeypot is filled (bot trap)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/request',
      payload: { email: 'bot@spam.com', honeypot: 'i-am-a-bot' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
    expect(mockInvite.createInvitationRequest).not.toHaveBeenCalled();
  });

  it('returns success even when service throws (no email leak)', async () => {
    mockInvite.createInvitationRequest.mockRejectedValue(new Error('duplicate'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/request',
      payload: { email: 'existing@example.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
  });

  it('returns 400 with invalid email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/request',
      payload: { email: 'not-valid' },
    });

    expect(res.statusCode).toBe(400);
  });
});

// --- Admin invite routes (prefix: /api/admin) ---

describe('GET /api/admin/requests', () => {
  it('returns invitation requests for SUPERADMIN', async () => {
    const mockRequests = [{ id: 'req-1', email: 'pending@example.com', status: 'PENDING' }];
    mockInvite.getInvitationRequests.mockResolvedValue(mockRequests);

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/requests',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockRequests);
  });

  it('returns 403 for regular USER', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/requests',
      headers: { authorization: `Bearer ${userToken}` },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('POST /api/admin/requests/:id/approve', () => {
  it('approves an invitation request', async () => {
    mockInvite.approveInvitationRequest.mockResolvedValue(undefined);
    const uuid = '550e8400-e29b-41d4-a716-446655440000';

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/requests/${uuid}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
    expect(mockInvite.approveInvitationRequest).toHaveBeenCalledWith(uuid, ADMIN_USER.id);
  });

  it('returns 403 for regular USER', async () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/requests/${uuid}/approve`,
      headers: { authorization: `Bearer ${userToken}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('rejects non-UUID id param', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/requests/not-a-uuid/approve',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/admin/requests/:id/reject', () => {
  it('rejects an invitation request', async () => {
    mockInvite.rejectInvitationRequest.mockResolvedValue(undefined);
    const uuid = '550e8400-e29b-41d4-a716-446655440000';

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/requests/${uuid}/reject`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
    expect(mockInvite.rejectInvitationRequest).toHaveBeenCalledWith(uuid);
  });

  it('returns 403 for regular USER', async () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/requests/${uuid}/reject`,
      headers: { authorization: `Bearer ${userToken}` },
    });

    expect(res.statusCode).toBe(403);
  });
});
