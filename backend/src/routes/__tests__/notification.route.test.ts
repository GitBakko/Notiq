import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

// Mock services BEFORE imports
vi.mock('../../services/notification.service', () => ({
  getUserNotifications: vi.fn(),
  markNotificationAsRead: vi.fn(),
  markAllNotificationsAsRead: vi.fn(),
  deleteNotification: vi.fn(),
  deleteAllNotifications: vi.fn(),
}));

vi.mock('../../services/push.service', () => ({
  subscribeUser: vi.fn(),
}));

import * as notificationService from '../../services/notification.service';
import * as pushService from '../../services/push.service';
import { AppError } from '../../utils/errors';
import notificationRoutes from '../notification.routes';

const mockNotificationService = notificationService as any;
const mockPushService = pushService as any;

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

  app.register(notificationRoutes, { prefix: '/api/notifications' });
  await app.ready();
  authToken = app.jwt.sign(TEST_USER);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/notifications', () => {
  it('returns paginated notifications', async () => {
    const mockNotifications = [
      { id: 'notif-1', type: 'SHARE_NOTE', read: false },
      { id: 'notif-2', type: 'SYSTEM', read: true },
    ];
    mockNotificationService.getUserNotifications.mockResolvedValue(mockNotifications);

    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockNotifications);
    expect(mockNotificationService.getUserNotifications).toHaveBeenCalledWith(TEST_USER.id, 1, 50);
  });

  it('passes pagination params', async () => {
    mockNotificationService.getUserNotifications.mockResolvedValue([]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications?page=3&limit=10',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(mockNotificationService.getUserNotifications).toHaveBeenCalledWith(TEST_USER.id, 3, 10);
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects limit > 100', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications?limit=200',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /api/notifications/:id/read', () => {
  it('marks a notification as read', async () => {
    mockNotificationService.markNotificationAsRead.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/notifications/notif-1/read',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
    expect(mockNotificationService.markNotificationAsRead).toHaveBeenCalledWith('notif-1', TEST_USER.id);
  });
});

describe('PUT /api/notifications/read-all', () => {
  it('marks all notifications as read', async () => {
    mockNotificationService.markAllNotificationsAsRead.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/notifications/read-all',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
    expect(mockNotificationService.markAllNotificationsAsRead).toHaveBeenCalledWith(TEST_USER.id);
  });
});

describe('DELETE /api/notifications/all', () => {
  it('deletes all notifications', async () => {
    mockNotificationService.deleteAllNotifications.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/notifications/all',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
    expect(mockNotificationService.deleteAllNotifications).toHaveBeenCalledWith(TEST_USER.id);
  });
});

describe('DELETE /api/notifications/:id', () => {
  it('deletes a single notification', async () => {
    mockNotificationService.deleteNotification.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/notifications/notif-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
    expect(mockNotificationService.deleteNotification).toHaveBeenCalledWith('notif-1', TEST_USER.id);
  });
});

describe('POST /api/notifications/subscribe', () => {
  it('subscribes user for push notifications', async () => {
    mockPushService.subscribeUser.mockResolvedValue(undefined);

    const subscription = {
      endpoint: 'https://push.example.com/v1/sub123',
      keys: {
        p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfWpk',
        auth: 'tBHItJI5svbpC7',
      },
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/subscribe',
      headers: { authorization: `Bearer ${authToken}` },
      payload: subscription,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
    expect(mockPushService.subscribeUser).toHaveBeenCalledWith(TEST_USER.id, subscription);
  });

  it('returns 400 with invalid subscription payload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/subscribe',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { endpoint: 'not-a-url', keys: {} },
    });
    expect(res.statusCode).toBe(400);
  });
});
