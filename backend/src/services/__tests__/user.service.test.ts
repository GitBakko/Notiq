import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';
import { makeUser } from '../../__tests__/factories';
import { updateUser, uploadAvatar, getUser, changePassword } from '../user.service';
import { BadRequestError, NotFoundError } from '../../utils/errors';

// Mock bcrypt
vi.mock('bcrypt', () => ({
  default: {
    compare: vi.fn(),
    hash: vi.fn(),
  },
}));

// Mock fs and stream/promises for uploadAvatar
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(() => ({ on: vi.fn(), write: vi.fn(), end: vi.fn() })),
  },
}));

vi.mock('stream/promises', () => ({
  pipeline: vi.fn().mockResolvedValue(undefined),
}));

import bcrypt from 'bcrypt';

const prismaMock = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// updateUser
// ---------------------------------------------------------------------------
describe('updateUser', () => {
  it('updates basic profile fields', async () => {
    const user = makeUser();
    prismaMock.user.update.mockResolvedValue({ ...user, name: 'NewName' });

    const result = await updateUser(user.id, { name: 'NewName' });

    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: user.id },
      data: expect.objectContaining({ name: 'NewName' }),
    });
    expect(result.name).toBe('NewName');
  });

  it('updates multiple fields at once', async () => {
    const user = makeUser();
    const updates = {
      name: 'Jane',
      surname: 'Doe',
      gender: 'female',
      placeOfBirth: 'Rome',
      mobile: '+39123456789',
    };
    prismaMock.user.update.mockResolvedValue({ ...user, ...updates });

    await updateUser(user.id, updates);

    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: user.id },
      data: expect.objectContaining({
        name: 'Jane',
        surname: 'Doe',
        gender: 'female',
        placeOfBirth: 'Rome',
        mobile: '+39123456789',
      }),
    });
  });

  it('parses a valid dateOfBirth ISO string into a Date', async () => {
    const user = makeUser();
    prismaMock.user.update.mockResolvedValue(user);

    await updateUser(user.id, { dateOfBirth: '1990-05-15T00:00:00.000Z' });

    const call = prismaMock.user.update.mock.calls[0][0];
    expect(call.data.dateOfBirth).toBeInstanceOf(Date);
    expect(call.data.dateOfBirth.toISOString()).toBe('1990-05-15T00:00:00.000Z');
  });

  it('sets dateOfBirth to null when empty string is provided', async () => {
    const user = makeUser();
    prismaMock.user.update.mockResolvedValue(user);

    await updateUser(user.id, { dateOfBirth: '' });

    const call = prismaMock.user.update.mock.calls[0][0];
    expect(call.data.dateOfBirth).toBeNull();
  });

  it('leaves dateOfBirth undefined when not provided', async () => {
    const user = makeUser();
    prismaMock.user.update.mockResolvedValue(user);

    await updateUser(user.id, { name: 'Test' });

    const call = prismaMock.user.update.mock.calls[0][0];
    expect(call.data.dateOfBirth).toBeUndefined();
  });

  it('ignores invalid dateOfBirth strings (leaves undefined)', async () => {
    const user = makeUser();
    prismaMock.user.update.mockResolvedValue(user);

    await updateUser(user.id, { dateOfBirth: 'not-a-date' });

    const call = prismaMock.user.update.mock.calls[0][0];
    // Invalid date string => parsed Date is NaN => dob stays undefined
    expect(call.data.dateOfBirth).toBeUndefined();
  });

  it('spreads emailNotificationsEnabled when provided', async () => {
    const user = makeUser();
    prismaMock.user.update.mockResolvedValue(user);

    await updateUser(user.id, { emailNotificationsEnabled: false });

    const call = prismaMock.user.update.mock.calls[0][0];
    expect(call.data.emailNotificationsEnabled).toBe(false);
  });

  it('does not include emailNotificationsEnabled when not provided', async () => {
    const user = makeUser();
    prismaMock.user.update.mockResolvedValue(user);

    await updateUser(user.id, { name: 'Test' });

    const call = prismaMock.user.update.mock.calls[0][0];
    expect(call.data).not.toHaveProperty('emailNotificationsEnabled');
  });

  it('spreads locale when provided', async () => {
    const user = makeUser();
    prismaMock.user.update.mockResolvedValue(user);

    await updateUser(user.id, { locale: 'it' });

    const call = prismaMock.user.update.mock.calls[0][0];
    expect(call.data.locale).toBe('it');
  });

  it('does not include locale when not provided', async () => {
    const user = makeUser();
    prismaMock.user.update.mockResolvedValue(user);

    await updateUser(user.id, { name: 'Test' });

    const call = prismaMock.user.update.mock.calls[0][0];
    expect(call.data).not.toHaveProperty('locale');
  });

  it('updates avatarUrl when provided', async () => {
    const user = makeUser();
    prismaMock.user.update.mockResolvedValue(user);

    await updateUser(user.id, { avatarUrl: '/uploads/avatars/new.jpg' });

    const call = prismaMock.user.update.mock.calls[0][0];
    expect(call.data.avatarUrl).toBe('/uploads/avatars/new.jpg');
  });
});

// ---------------------------------------------------------------------------
// uploadAvatar
// ---------------------------------------------------------------------------
describe('uploadAvatar', () => {
  function makeMockFile(overrides: Record<string, any> = {}): any {
    return {
      mimetype: 'image/png',
      filename: 'avatar.png',
      file: { pipe: vi.fn() },
      ...overrides,
    };
  }

  it('uploads a valid image and updates user avatarUrl', async () => {
    const user = makeUser();
    prismaMock.user.update.mockResolvedValue({ ...user, avatarUrl: '/uploads/avatars/test.png' });

    const file = makeMockFile({ mimetype: 'image/png', filename: 'photo.png' });
    const result = await uploadAvatar(user.id, file);

    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: user.id },
      data: { avatarUrl: expect.stringContaining('/uploads/avatars/') },
    });
    expect(result.avatarUrl).toBeDefined();
  });

  it('accepts image/jpeg', async () => {
    const user = makeUser();
    prismaMock.user.update.mockResolvedValue(user);

    const file = makeMockFile({ mimetype: 'image/jpeg', filename: 'photo.jpg' });
    await expect(uploadAvatar(user.id, file)).resolves.toBeDefined();
  });

  it('accepts image/gif', async () => {
    const user = makeUser();
    prismaMock.user.update.mockResolvedValue(user);

    const file = makeMockFile({ mimetype: 'image/gif', filename: 'anim.gif' });
    await expect(uploadAvatar(user.id, file)).resolves.toBeDefined();
  });

  it('accepts image/webp', async () => {
    const user = makeUser();
    prismaMock.user.update.mockResolvedValue(user);

    const file = makeMockFile({ mimetype: 'image/webp', filename: 'photo.webp' });
    await expect(uploadAvatar(user.id, file)).resolves.toBeDefined();
  });

  it('throws BadRequestError for non-image mime types', async () => {
    const file = makeMockFile({ mimetype: 'application/pdf', filename: 'doc.pdf' });

    await expect(uploadAvatar('user-1', file)).rejects.toThrow(BadRequestError);
    await expect(uploadAvatar('user-1', file)).rejects.toThrow('errors.user.onlyImagesForAvatar');
  });

  it('throws BadRequestError for text/plain', async () => {
    const file = makeMockFile({ mimetype: 'text/plain', filename: 'file.txt' });

    await expect(uploadAvatar('user-1', file)).rejects.toThrow(BadRequestError);
  });

  it('generates filename with userId and timestamp', async () => {
    const user = makeUser({ id: 'user-abc' });
    prismaMock.user.update.mockResolvedValue(user);

    const file = makeMockFile({ mimetype: 'image/png', filename: 'original.png' });
    await uploadAvatar('user-abc', file);

    const call = prismaMock.user.update.mock.calls[0][0];
    const avatarUrl: string = call.data.avatarUrl;
    expect(avatarUrl).toMatch(/^\/uploads\/avatars\/user-abc-\d+\.png$/);
  });

  it('preserves original file extension', async () => {
    const user = makeUser();
    prismaMock.user.update.mockResolvedValue(user);

    const file = makeMockFile({ mimetype: 'image/jpeg', filename: 'photo.jpg' });
    await uploadAvatar(user.id, file);

    const call = prismaMock.user.update.mock.calls[0][0];
    expect(call.data.avatarUrl).toMatch(/\.jpg$/);
  });
});

// ---------------------------------------------------------------------------
// getUser
// ---------------------------------------------------------------------------
describe('getUser', () => {
  it('returns user profile with selected fields', async () => {
    const user = makeUser();
    const profileData = {
      id: user.id,
      email: user.email,
      name: user.name,
      surname: user.surname,
      gender: user.gender,
      dateOfBirth: user.dateOfBirth,
      placeOfBirth: user.placeOfBirth,
      mobile: user.mobile,
      avatarUrl: user.avatarUrl,
      color: user.color,
      emailNotificationsEnabled: user.emailNotificationsEnabled,
      createdAt: user.createdAt,
    };
    prismaMock.user.findUnique.mockResolvedValue(profileData);

    const result = await getUser(user.id);

    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        name: true,
        surname: true,
        gender: true,
        dateOfBirth: true,
        placeOfBirth: true,
        mobile: true,
        avatarUrl: true,
        color: true,
        emailNotificationsEnabled: true,
        createdAt: true,
      },
    });
    expect(result).toEqual(profileData);
  });

  it('returns null when user does not exist', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    const result = await getUser('nonexistent-id');

    expect(result).toBeNull();
  });

  it('does not select sensitive fields like password or tokenVersion', async () => {
    prismaMock.user.findUnique.mockResolvedValue({});

    await getUser('user-1');

    const call = prismaMock.user.findUnique.mock.calls[0][0];
    expect(call.select.password).toBeUndefined();
    expect(call.select.tokenVersion).toBeUndefined();
    expect(call.select.resetToken).toBeUndefined();
    expect(call.select.verificationToken).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// changePassword
// ---------------------------------------------------------------------------
describe('changePassword', () => {
  it('changes password when old password is correct', async () => {
    const user = makeUser({ id: 'user-1', password: '$2b$10$oldhash' });
    prismaMock.user.findUnique.mockResolvedValue(user);
    (bcrypt.compare as any).mockResolvedValue(true);
    (bcrypt.hash as any).mockResolvedValue('$2b$10$newhash');
    prismaMock.user.update.mockResolvedValue({ id: user.id, email: user.email, name: user.name });

    const result = await changePassword('user-1', 'oldPassword123', 'newPassword456');

    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' } });
    expect(bcrypt.compare).toHaveBeenCalledWith('oldPassword123', user.password);
    expect(bcrypt.hash).toHaveBeenCalledWith('newPassword456', 10);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { password: '$2b$10$newhash', tokenVersion: { increment: 1 } },
      select: { id: true, email: true, name: true },
    });
    expect(result).toEqual({ id: user.id, email: user.email, name: user.name });
  });

  it('throws NotFoundError when user does not exist', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(changePassword('nonexistent', 'old', 'new'))
      .rejects.toThrow(NotFoundError);
    await expect(changePassword('nonexistent', 'old', 'new'))
      .rejects.toThrow('errors.user.notFound');
  });

  it('does not call bcrypt.compare when user is not found', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(changePassword('nonexistent', 'old', 'new')).rejects.toThrow();

    expect(bcrypt.compare).not.toHaveBeenCalled();
    expect(bcrypt.hash).not.toHaveBeenCalled();
  });

  it('throws BadRequestError when old password is incorrect', async () => {
    const user = makeUser({ id: 'user-1' });
    prismaMock.user.findUnique.mockResolvedValue(user);
    (bcrypt.compare as any).mockResolvedValue(false);

    await expect(changePassword('user-1', 'wrongPassword', 'newPassword'))
      .rejects.toThrow(BadRequestError);
    await expect(changePassword('user-1', 'wrongPassword', 'newPassword'))
      .rejects.toThrow('errors.user.invalidOldPassword');
  });

  it('does not call bcrypt.hash or update when old password is wrong', async () => {
    const user = makeUser({ id: 'user-1' });
    prismaMock.user.findUnique.mockResolvedValue(user);
    (bcrypt.compare as any).mockResolvedValue(false);

    await expect(changePassword('user-1', 'wrong', 'new')).rejects.toThrow();

    expect(bcrypt.hash).not.toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('increments tokenVersion to invalidate existing sessions', async () => {
    const user = makeUser({ id: 'user-1' });
    prismaMock.user.findUnique.mockResolvedValue(user);
    (bcrypt.compare as any).mockResolvedValue(true);
    (bcrypt.hash as any).mockResolvedValue('$2b$10$newhash');
    prismaMock.user.update.mockResolvedValue({ id: user.id, email: user.email, name: user.name });

    await changePassword('user-1', 'old', 'new');

    const call = prismaMock.user.update.mock.calls[0][0];
    expect(call.data.tokenVersion).toEqual({ increment: 1 });
  });

  it('returns only id, email, and name (no password or sensitive data)', async () => {
    const user = makeUser({ id: 'user-1' });
    prismaMock.user.findUnique.mockResolvedValue(user);
    (bcrypt.compare as any).mockResolvedValue(true);
    (bcrypt.hash as any).mockResolvedValue('$2b$10$newhash');
    prismaMock.user.update.mockResolvedValue({ id: 'user-1', email: 'test@test.com', name: 'Test' });

    await changePassword('user-1', 'old', 'new');

    const call = prismaMock.user.update.mock.calls[0][0];
    expect(call.select).toEqual({ id: true, email: true, name: true });
  });
});
