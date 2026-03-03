import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

// Mock service BEFORE imports
vi.mock('../../services/tasklist.service', () => ({
  getTaskLists: vi.fn(),
  getTaskList: vi.fn(),
  createTaskList: vi.fn(),
  updateTaskList: vi.fn(),
  deleteTaskList: vi.fn(),
  addTaskItem: vi.fn(),
  updateTaskItem: vi.fn(),
  deleteTaskItem: vi.fn(),
  reorderTaskItems: vi.fn(),
}));

import * as taskListService from '../../services/tasklist.service';
import { AppError, NotFoundError, ForbiddenError } from '../../utils/errors';
import taskListRoutes from '../tasklists';

const mockService = taskListService as any;

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

  app.register(taskListRoutes, { prefix: '/api/tasklists' });
  await app.ready();
  authToken = app.jwt.sign(TEST_USER);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Task List CRUD ──────────────────────────────────────────────

describe('GET /api/tasklists', () => {
  it('returns all task lists for the user', async () => {
    const mockLists = [{ id: 'tl-1', title: 'Shopping', items: [] }];
    mockService.getTaskLists.mockResolvedValue(mockLists);

    const res = await app.inject({
      method: 'GET',
      url: '/api/tasklists',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockLists);
    expect(mockService.getTaskLists).toHaveBeenCalledWith('user-1');
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/tasklists',
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/tasklists/:id', () => {
  it('returns a single task list', async () => {
    const mockList = { id: 'tl-1', title: 'Shopping', items: [] };
    mockService.getTaskList.mockResolvedValue(mockList);

    const res = await app.inject({
      method: 'GET',
      url: '/api/tasklists/tl-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockList);
    expect(mockService.getTaskList).toHaveBeenCalledWith('user-1', 'tl-1');
  });

  it('returns 404 when task list not found', async () => {
    mockService.getTaskList.mockRejectedValue(new NotFoundError('errors.tasks.listNotFound'));

    const res = await app.inject({
      method: 'GET',
      url: '/api/tasklists/tl-999',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/tasklists', () => {
  it('creates a task list', async () => {
    const mockList = { id: 'tl-new', title: 'Groceries', items: [] };
    mockService.createTaskList.mockResolvedValue(mockList);

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasklists',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { title: 'Groceries' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockList);
    expect(mockService.createTaskList).toHaveBeenCalledWith('user-1', 'Groceries', undefined);
  });

  it('returns 400 with empty title', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasklists',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { title: '' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /api/tasklists/:id', () => {
  it('updates a task list title', async () => {
    const mockUpdated = { id: 'tl-1', title: 'Updated', items: [] };
    mockService.updateTaskList.mockResolvedValue(mockUpdated);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasklists/tl-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { title: 'Updated' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockUpdated);
    expect(mockService.updateTaskList).toHaveBeenCalledWith('user-1', 'tl-1', { title: 'Updated' });
  });

  it('returns 403 when user lacks write access', async () => {
    mockService.updateTaskList.mockRejectedValue(new ForbiddenError('errors.common.accessDenied'));

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasklists/tl-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { title: 'Nope' },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('DELETE /api/tasklists/:id', () => {
  it('soft-deletes a task list', async () => {
    mockService.deleteTaskList.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/tasklists/tl-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
    expect(mockService.deleteTaskList).toHaveBeenCalledWith('user-1', 'tl-1');
  });

  it('returns 403 when non-owner tries to delete', async () => {
    mockService.deleteTaskList.mockRejectedValue(new ForbiddenError('errors.common.accessDenied'));

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/tasklists/tl-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(403);
  });
});

// ── Task Item CRUD ──────────────────────────────────────────────

describe('POST /api/tasklists/:id/items', () => {
  it('adds a task item', async () => {
    const mockItem = { id: 'ti-1', text: 'Buy milk', priority: 'MEDIUM', position: 0 };
    mockService.addTaskItem.mockResolvedValue(mockItem);

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasklists/tl-1/items',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { text: 'Buy milk' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockItem);
    expect(mockService.addTaskItem).toHaveBeenCalledWith('user-1', 'tl-1', {
      text: 'Buy milk',
      priority: 'MEDIUM',
    });
  });

  it('returns 400 with empty text', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasklists/tl-1/items',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { text: '' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('accepts optional priority and dueDate', async () => {
    const mockItem = { id: 'ti-2', text: 'Urgent task', priority: 'HIGH', dueDate: '2026-04-01' };
    mockService.addTaskItem.mockResolvedValue(mockItem);

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasklists/tl-1/items',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { text: 'Urgent task', priority: 'HIGH', dueDate: '2026-04-01' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockService.addTaskItem).toHaveBeenCalledWith('user-1', 'tl-1', {
      text: 'Urgent task',
      priority: 'HIGH',
      dueDate: '2026-04-01',
    });
  });
});

describe('PUT /api/tasklists/:id/items/:itemId', () => {
  it('updates a task item', async () => {
    const mockItem = { id: 'ti-1', text: 'Buy milk', isChecked: true };
    mockService.updateTaskItem.mockResolvedValue(mockItem);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasklists/tl-1/items/ti-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { isChecked: true },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockItem);
    expect(mockService.updateTaskItem).toHaveBeenCalledWith('user-1', 'tl-1', 'ti-1', { isChecked: true });
  });

  it('returns 404 when item not found', async () => {
    mockService.updateTaskItem.mockRejectedValue(new NotFoundError('errors.tasks.itemNotFound'));

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasklists/tl-1/items/ti-999',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { text: 'Does not exist' },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/tasklists/:id/items/:itemId', () => {
  it('deletes a task item', async () => {
    mockService.deleteTaskItem.mockResolvedValue({ success: true });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/tasklists/tl-1/items/ti-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(mockService.deleteTaskItem).toHaveBeenCalledWith('user-1', 'tl-1', 'ti-1');
  });
});

describe('PUT /api/tasklists/:id/items/reorder', () => {
  it('reorders task items', async () => {
    mockService.reorderTaskItems.mockResolvedValue({ success: true });

    const items = [
      { id: '550e8400-e29b-41d4-a716-446655440000', position: 0 },
      { id: '550e8400-e29b-41d4-a716-446655440001', position: 1 },
    ];

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasklists/tl-1/items/reorder',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { items },
    });

    expect(res.statusCode).toBe(200);
    expect(mockService.reorderTaskItems).toHaveBeenCalledWith('user-1', 'tl-1', items);
  });

  it('returns 400 with invalid reorder payload', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasklists/tl-1/items/reorder',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { items: [{ id: 'not-a-uuid', position: 'bad' }] },
    });

    expect(res.statusCode).toBe(400);
  });
});
