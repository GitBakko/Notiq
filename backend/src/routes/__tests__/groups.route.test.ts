import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

// Mock group service
vi.mock('../../services/group.service', () => ({
  createGroup: vi.fn(),
  getMyGroups: vi.fn(),
  getGroupsForSharing: vi.fn(),
  getGroup: vi.fn(),
  updateGroup: vi.fn(),
  deleteGroup: vi.fn(),
  addMember: vi.fn(),
  removeMember: vi.fn(),
  uploadGroupAvatar: vi.fn(),
  removePendingInvite: vi.fn(),
}));

import * as groupService from '../../services/group.service';
import { AppError, NotFoundError, ForbiddenError } from '../../utils/errors';
import groupRoutes from '../groups';

const mockGroupService = groupService as any;

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

  app.register(groupRoutes, { prefix: '/api/groups' });
  await app.ready();
  authToken = app.jwt.sign(TEST_USER);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/groups', () => {
  it('creates a group with valid data', async () => {
    const mockGroup = { id: 'group-1', name: 'Dev Team', ownerId: 'user-1' };
    mockGroupService.createGroup.mockResolvedValue(mockGroup);

    const res = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'Dev Team' },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload)).toEqual(mockGroup);
    expect(mockGroupService.createGroup).toHaveBeenCalledWith('user-1', { name: 'Dev Team' });
  });

  it('returns 400 with empty name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/groups',
      payload: { name: 'Dev Team' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/groups', () => {
  it('returns groups list', async () => {
    const mockGroups = [{ id: 'group-1', name: 'Dev Team' }];
    mockGroupService.getMyGroups.mockResolvedValue(mockGroups);

    const res = await app.inject({
      method: 'GET',
      url: '/api/groups',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockGroups);
  });
});

describe('GET /api/groups/for-sharing', () => {
  it('returns groups for sharing', async () => {
    const mockGroups = [{ id: 'group-1', name: 'Team A', memberCount: 3 }];
    mockGroupService.getGroupsForSharing.mockResolvedValue(mockGroups);

    const res = await app.inject({
      method: 'GET',
      url: '/api/groups/for-sharing',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockGroups);
  });
});

describe('GET /api/groups/:id', () => {
  it('returns a group by id', async () => {
    const mockGroup = { id: 'group-1', name: 'Dev Team', members: [] };
    mockGroupService.getGroup.mockResolvedValue(mockGroup);

    const res = await app.inject({
      method: 'GET',
      url: '/api/groups/group-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockGroup);
  });

  it('returns 404 when group not found', async () => {
    mockGroupService.getGroup.mockRejectedValue(new NotFoundError('errors.groups.notFound'));

    const res = await app.inject({
      method: 'GET',
      url: '/api/groups/group-999',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('PUT /api/groups/:id', () => {
  it('updates a group', async () => {
    const updated = { id: 'group-1', name: 'New Name' };
    mockGroupService.updateGroup.mockResolvedValue(updated);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/groups/group-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'New Name' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(updated);
  });

  it('returns 403 when not owner', async () => {
    mockGroupService.updateGroup.mockRejectedValue(new ForbiddenError('errors.groups.notOwner'));

    const res = await app.inject({
      method: 'PUT',
      url: '/api/groups/group-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'New Name' },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('DELETE /api/groups/:id', () => {
  it('deletes a group', async () => {
    mockGroupService.deleteGroup.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/groups/group-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
  });
});

describe('POST /api/groups/:id/members', () => {
  it('adds a member by email', async () => {
    const mockMember = { id: 'member-1', userId: 'user-2', groupId: 'group-1' };
    mockGroupService.addMember.mockResolvedValue(mockMember);

    const res = await app.inject({
      method: 'POST',
      url: '/api/groups/group-1/members',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { email: 'member@test.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockMember);
  });

  it('returns 400 with invalid email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/groups/group-1/members',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/groups/:id/members/:userId', () => {
  it('removes a member', async () => {
    mockGroupService.removeMember.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/groups/group-1/members/user-2',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
  });
});

describe('DELETE /api/groups/:id/pending', () => {
  it('removes a pending invite', async () => {
    mockGroupService.removePendingInvite.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/groups/group-1/pending',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { email: 'pending@test.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
  });

  it('returns 400 with invalid email in body', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/groups/group-1/pending',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { email: 'not-valid' },
    });
    expect(res.statusCode).toBe(400);
  });
});
