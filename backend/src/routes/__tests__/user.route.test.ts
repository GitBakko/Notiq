import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import fastifyMultipart from '@fastify/multipart';

// Mock services BEFORE imports
vi.mock('../../services/user.service', () => ({
  getUser: vi.fn(),
  updateUser: vi.fn(),
  changePassword: vi.fn(),
  uploadAvatar: vi.fn(),
}));

import * as userService from '../../services/user.service';
import { AppError, BadRequestError, NotFoundError } from '../../utils/errors';
import userRoutes from '../user';

const mockUser = userService as any;

const TEST_USER = { id: 'user-1', email: 'test@test.com', role: 'USER', tokenVersion: 0 };

let app: FastifyInstance;
let authToken: string;

beforeAll(async () => {
  app = Fastify();
  app.register(jwt, { secret: 'test-secret' });
  app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024 } });

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

  app.register(userRoutes, { prefix: '/api/user' });
  await app.ready();
  authToken = app.jwt.sign(TEST_USER);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

/** Build a minimal multipart/form-data payload with a single file field. */
function buildMultipartPayload(filename: string, content: Buffer, contentType = 'image/png') {
  const boundary = '----TestBoundary' + Date.now();
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;

  return {
    body: Buffer.concat([Buffer.from(header), content, Buffer.from(footer)]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('GET /api/user/me', () => {
  it('returns the current user profile', async () => {
    const mockProfile = { id: 'user-1', email: 'test@test.com', name: 'Test', avatarUrl: null };
    mockUser.getUser.mockResolvedValue(mockProfile);

    const res = await app.inject({
      method: 'GET',
      url: '/api/user/me',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockProfile);
    expect(mockUser.getUser).toHaveBeenCalledWith(TEST_USER.id);
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/user/me',
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('PUT /api/user/me', () => {
  it('updates user profile with valid data', async () => {
    const updatedProfile = { id: 'user-1', email: 'test@test.com', name: 'Updated' };
    mockUser.updateUser.mockResolvedValue(updatedProfile);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/user/me',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'Updated', surname: 'User', locale: 'it' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(updatedProfile);
    expect(mockUser.updateUser).toHaveBeenCalledWith(TEST_USER.id, {
      name: 'Updated',
      surname: 'User',
      locale: 'it',
    });
  });

  it('rejects invalid locale value', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/user/me',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { locale: 'fr' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('allows partial updates (empty body)', async () => {
    mockUser.updateUser.mockResolvedValue({ id: 'user-1' });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/user/me',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(mockUser.updateUser).toHaveBeenCalledWith(TEST_USER.id, {});
  });

  it('accepts emailNotificationsEnabled boolean', async () => {
    mockUser.updateUser.mockResolvedValue({ id: 'user-1', emailNotificationsEnabled: false });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/user/me',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { emailNotificationsEnabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUser.updateUser).toHaveBeenCalledWith(TEST_USER.id, { emailNotificationsEnabled: false });
  });
});

describe('POST /api/user/change-password', () => {
  it('changes password with valid data', async () => {
    mockUser.changePassword.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/api/user/change-password',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { oldPassword: 'OldPass123', newPassword: 'NewPass456' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ message: 'Password updated successfully' });
    expect(mockUser.changePassword).toHaveBeenCalledWith(TEST_USER.id, 'OldPass123', 'NewPass456');
  });

  it('returns 400 when new password is too short', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/user/change-password',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { oldPassword: 'OldPass123', newPassword: '12345' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when old password is empty', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/user/change-password',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { oldPassword: '', newPassword: 'NewPass456' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('propagates BadRequestError for invalid old password', async () => {
    mockUser.changePassword.mockRejectedValue(new BadRequestError('errors.user.invalidOldPassword'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/user/change-password',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { oldPassword: 'WrongPass', newPassword: 'NewPass456' },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).message).toBe('errors.user.invalidOldPassword');
  });

  it('propagates NotFoundError for missing user', async () => {
    mockUser.changePassword.mockRejectedValue(new NotFoundError('errors.user.notFound'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/user/change-password',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { oldPassword: 'OldPass123', newPassword: 'NewPass456' },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/user/me/avatar', () => {
  it('uploads avatar with valid image', async () => {
    const updatedUser = { id: 'user-1', avatarUrl: '/uploads/avatars/user-1-123.png' };
    mockUser.uploadAvatar.mockResolvedValue(updatedUser);

    const { body, contentType } = buildMultipartPayload('photo.png', Buffer.from('fake-png-data'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/user/me/avatar',
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': contentType,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(updatedUser);
    expect(mockUser.uploadAvatar).toHaveBeenCalledWith(TEST_USER.id, expect.objectContaining({
      filename: 'photo.png',
    }));
  });

  it('propagates BadRequestError for non-image file', async () => {
    mockUser.uploadAvatar.mockRejectedValue(new BadRequestError('errors.user.onlyImagesForAvatar'));

    const { body, contentType } = buildMultipartPayload('doc.pdf', Buffer.from('fake-pdf'), 'application/pdf');

    const res = await app.inject({
      method: 'POST',
      url: '/api/user/me/avatar',
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': contentType,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).message).toBe('errors.user.onlyImagesForAvatar');
  });

  it('returns 401 without auth token', async () => {
    const { body, contentType } = buildMultipartPayload('photo.png', Buffer.from('fake'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/user/me/avatar',
      headers: { 'content-type': contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
  });
});
