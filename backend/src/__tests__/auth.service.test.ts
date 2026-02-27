import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before imports
vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('hashed-password'),
    compare: vi.fn(),
  },
}));

vi.mock('../services/email.service', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  sendNotificationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/invite.service', () => ({
  validateInvite: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/settings.service', () => ({
  getBooleanSetting: vi.fn().mockResolvedValue(true),
}));

vi.mock('../services/group.service', () => ({
  hasPendingGroupInvite: vi.fn().mockResolvedValue(false),
  processPendingGroupInvites: vi.fn().mockResolvedValue(undefined),
}));

import prisma from '../plugins/prisma';
import bcrypt from 'bcrypt';
import { registerUser, loginUser, verifyEmail, requestPasswordReset, resetPassword } from '../services/auth.service';
import * as settingsService from '../services/settings.service';
import * as inviteService from '../services/invite.service';
import * as groupService from '../services/group.service';

const prismaMock = vi.mocked(prisma, true);
const bcryptMock = vi.mocked(bcrypt, true);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('auth.service — registerUser', () => {
  const validData = {
    email: 'test@example.com',
    password: 'SecureP@ss1',
    name: 'Test User',
    invitationCode: 'ABC123',
  };

  const createdUser = {
    id: 'user-1',
    email: 'test@example.com',
    name: 'Test User',
    role: 'USER',
    locale: 'en',
    createdAt: new Date(),
    invitesAvailable: 0,
    color: '#3182CE',
  };

  it('should register a new user successfully with invitation code', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null); // no existing user
    prismaMock.user.create.mockResolvedValueOnce(createdUser as any);
    prismaMock.invitation.update.mockResolvedValueOnce({
      creatorId: 'creator-1',
      creator: { role: 'USER', invitesAvailable: 3 },
    } as any);
    prismaMock.auditLog.create.mockResolvedValue({} as any);
    prismaMock.user.update.mockResolvedValueOnce({} as any);

    const result = await registerUser(validData);

    expect(result).toEqual(createdUser);
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({ where: { email: validData.email } });
    expect(prismaMock.user.create).toHaveBeenCalled();
    expect(inviteService.validateInvite).toHaveBeenCalledWith('ABC123');
  });

  it('should throw if user already exists', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce({ id: 'existing' } as any);

    await expect(registerUser(validData)).rejects.toThrow('auth.errors.userExists');
  });

  it('should throw if invitation system is enabled and no code provided and no pending group invite', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null);
    vi.mocked(settingsService.getBooleanSetting).mockResolvedValueOnce(true);
    vi.mocked(groupService.hasPendingGroupInvite).mockResolvedValueOnce(false);

    const dataNoCode = { email: 'test@example.com', password: 'pass123' };
    await expect(registerUser(dataNoCode)).rejects.toThrow('auth.errors.invitationRequired');
  });

  it('should allow registration without invite code if pending group invite exists', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null);
    vi.mocked(settingsService.getBooleanSetting).mockResolvedValueOnce(true);
    vi.mocked(groupService.hasPendingGroupInvite).mockResolvedValueOnce(true);
    prismaMock.user.create.mockResolvedValueOnce(createdUser as any);
    prismaMock.auditLog.create.mockResolvedValue({} as any);

    const dataNoCode = { email: 'test@example.com', password: 'pass123' };
    const result = await registerUser(dataNoCode);

    expect(result).toEqual(createdUser);
    expect(inviteService.validateInvite).not.toHaveBeenCalled();
  });
});

describe('auth.service — loginUser', () => {
  const mockUser = {
    id: 'user-1',
    email: 'test@example.com',
    name: 'Test User',
    password: 'hashed-password',
    role: 'USER',
    locale: 'en',
    isVerified: true,
    color: '#3182CE',
    createdAt: new Date(),
    updatedAt: new Date(),
    invitesAvailable: 2,
    avatarUrl: null,
    lastActiveAt: new Date(),
    tokenVersion: 0,
    invitationCode: null,
    resetToken: null,
    resetTokenExpiry: null,
    verificationToken: null,
    verificationTokenExpires: null,
  };

  it('should login successfully with valid credentials', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(mockUser as any);
    bcryptMock.compare.mockResolvedValueOnce(true as any);
    prismaMock.auditLog.create.mockResolvedValue({} as any);

    const result = await loginUser('test@example.com', 'correct-password');

    expect(result).toBeDefined();
    expect(result.id).toBe('user-1');
    expect(result).not.toHaveProperty('password');
    expect(result).not.toHaveProperty('resetToken');
    expect(result).not.toHaveProperty('verificationToken');
  });

  it('should throw if user not found', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null);

    await expect(loginUser('no@user.com', 'pass')).rejects.toThrow('Invalid credentials');
  });

  it('should throw if password is wrong', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(mockUser as any);
    bcryptMock.compare.mockResolvedValueOnce(false as any);
    prismaMock.auditLog.create.mockResolvedValue({} as any);

    await expect(loginUser('test@example.com', 'wrong-password')).rejects.toThrow('Invalid credentials');
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ event: 'LOGIN_FAILURE' }),
      })
    );
  });

  it('should throw if user is not verified', async () => {
    const unverifiedUser = { ...mockUser, isVerified: false };
    prismaMock.user.findUnique.mockResolvedValueOnce(unverifiedUser as any);
    bcryptMock.compare.mockResolvedValueOnce(true as any);
    prismaMock.auditLog.create.mockResolvedValue({} as any);

    await expect(loginUser('test@example.com', 'correct-password')).rejects.toThrow('auth.errors.unverified');
  });
});

describe('auth.service — verifyEmail', () => {
  it('should verify email with valid token', async () => {
    const mockUser = { id: 'user-1', email: 'test@example.com' };
    const verifiedUser = {
      id: 'user-1',
      email: 'test@example.com',
      name: 'Test',
      role: 'USER',
      locale: 'en',
      isVerified: true,
      createdAt: new Date(),
      invitesAvailable: 2,
      color: '#3182CE',
    };

    prismaMock.user.findFirst.mockResolvedValueOnce(mockUser as any);
    prismaMock.user.update.mockResolvedValueOnce(verifiedUser as any);
    prismaMock.auditLog.create.mockResolvedValue({} as any);

    const result = await verifyEmail('valid-token');

    expect(result).toEqual(verifiedUser);
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isVerified: true,
          verificationToken: null,
          invitesAvailable: 2,
        }),
      })
    );
    expect(groupService.processPendingGroupInvites).toHaveBeenCalledWith('user-1', 'test@example.com');
  });

  it('should throw if token is invalid or expired', async () => {
    prismaMock.user.findFirst.mockResolvedValueOnce(null);

    await expect(verifyEmail('invalid-token')).rejects.toThrow('Invalid or expired token');
  });
});

describe('auth.service — requestPasswordReset', () => {
  it('should return true even if user does not exist (no user enumeration)', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null);

    const result = await requestPasswordReset('no@user.com');
    expect(result).toBe(true);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('should generate reset token and send email if user exists', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce({ id: 'user-1', email: 'test@example.com' } as any);
    prismaMock.user.update.mockResolvedValueOnce({} as any);

    const result = await requestPasswordReset('test@example.com');

    expect(result).toBe(true);
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1' },
        data: expect.objectContaining({
          resetToken: expect.any(String),
          resetTokenExpiry: expect.any(Date),
        }),
      })
    );
  });
});

describe('auth.service — resetPassword', () => {
  it('should reset password with valid token', async () => {
    prismaMock.user.findFirst.mockResolvedValueOnce({ id: 'user-1' } as any);
    prismaMock.user.update.mockResolvedValueOnce({} as any);

    const result = await resetPassword('valid-token', 'NewSecureP@ss1');

    expect(result).toBe(true);
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1' },
        data: expect.objectContaining({
          password: 'hashed-password',
          resetToken: null,
          resetTokenExpiry: null,
          tokenVersion: { increment: 1 },
        }),
      })
    );
  });

  it('should throw if reset token is invalid or expired', async () => {
    prismaMock.user.findFirst.mockResolvedValueOnce(null);

    await expect(resetPassword('bad-token', 'newpass')).rejects.toThrow('Invalid or expired token');
  });
});
