import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import prisma from '../../plugins/prisma';
import {
  registerUser,
  loginUser,
  verifyEmail,
  requestPasswordReset,
  resetPassword,
  resendVerificationForInvite,
} from '../auth.service';

// --- Mocks ---

vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('hashed-password'),
    compare: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('../email.service', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  sendNotificationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../invite.service', () => ({
  validateInvite: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../settings.service', () => ({
  getBooleanSetting: vi.fn().mockResolvedValue(true),
  getSetting: vi.fn().mockResolvedValue('true'),
  setSetting: vi.fn(),
}));

vi.mock('../group.service', () => ({
  hasPendingGroupInvite: vi.fn().mockResolvedValue(false),
  processPendingGroupInvites: vi.fn().mockResolvedValue(undefined),
}));

// Import mocked modules so we can configure them per-test
import bcrypt from 'bcrypt';
import { sendEmail, sendNotificationEmail } from '../email.service';
import * as inviteService from '../invite.service';
import * as settingsService from '../settings.service';
import * as groupService from '../group.service';

const prismaMock = prisma as any;

// --- Fixtures ---

const MOCK_USER_ID = 'user-id-123';
const MOCK_EMAIL = 'test@example.com';
const MOCK_PASSWORD = 'SecureP@ss1';
const MOCK_NAME = 'Test User';

function makeMockUser(overrides: Record<string, any> = {}) {
  return {
    id: MOCK_USER_ID,
    email: MOCK_EMAIL,
    password: 'hashed-password',
    name: MOCK_NAME,
    role: 'USER',
    isVerified: true,
    locale: 'en',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    invitesAvailable: 2,
    color: '#3182CE',
    resetToken: null,
    resetTokenExpiry: null,
    verificationToken: null,
    verificationTokenExpires: null,
    tokenVersion: 0,
    invitationCode: null,
    lastActiveAt: null,
    ...overrides,
  };
}

function makeSafeUser(overrides: Record<string, any> = {}) {
  const full = makeMockUser(overrides);
  const {
    password: _,
    resetToken: _rt,
    resetTokenExpiry: _rte,
    verificationToken: _vt,
    verificationTokenExpires: _vte,
    ...safe
  } = full;
  return safe;
}

// --- Helpers ---

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// --- Tests ---

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// registerUser
// ============================================================
describe('registerUser', () => {
  const registrationData = {
    email: MOCK_EMAIL,
    password: MOCK_PASSWORD,
    name: MOCK_NAME,
    invitationCode: 'ABC123',
  };

  const createdUser = {
    id: MOCK_USER_ID,
    email: MOCK_EMAIL,
    name: MOCK_NAME,
    role: 'USER',
    locale: 'en',
    createdAt: new Date('2026-01-01'),
    invitesAvailable: 0,
    color: '#3182CE',
  };

  beforeEach(() => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue(createdUser);
    prismaMock.invitation.update.mockResolvedValue({
      creatorId: 'creator-id',
      creator: { role: 'USER', invitesAvailable: 3 },
    });
    prismaMock.user.update.mockResolvedValue({});
    prismaMock.auditLog.create.mockResolvedValue({});
    vi.mocked(settingsService.getBooleanSetting).mockResolvedValue(true);
    vi.mocked(inviteService.validateInvite).mockResolvedValue(undefined);
  });

  it('should register a new user with a valid invitation code', async () => {
    const result = await registerUser(registrationData);

    expect(result).toEqual(createdUser);
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { email: MOCK_EMAIL },
    });
    expect(inviteService.validateInvite).toHaveBeenCalledWith('ABC123');
    expect(bcrypt.hash).toHaveBeenCalledWith(MOCK_PASSWORD, 10);
    expect(prismaMock.user.create).toHaveBeenCalledTimes(1);
    expect(sendNotificationEmail).toHaveBeenCalledWith(
      MOCK_EMAIL,
      'VERIFY_EMAIL',
      expect.objectContaining({ locale: 'en' }),
    );
    // Invite should be marked as used
    expect(prismaMock.invitation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { code: 'ABC123' },
        data: expect.objectContaining({ status: 'USED', usedById: MOCK_USER_ID }),
      }),
    );
    // Audit logs: INVITE_USED + REGISTRATION_PENDING
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(2);
  });

  it('should throw if user already exists', async () => {
    prismaMock.user.findUnique.mockResolvedValue(makeMockUser());

    await expect(registerUser(registrationData)).rejects.toThrow('auth.errors.userExists');
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it('should throw if invitation system is enabled and no code is provided and no pending group invite', async () => {
    vi.mocked(settingsService.getBooleanSetting).mockResolvedValue(true);
    vi.mocked(groupService.hasPendingGroupInvite).mockResolvedValue(false);

    await expect(
      registerUser({ email: MOCK_EMAIL, password: MOCK_PASSWORD }),
    ).rejects.toThrow('auth.errors.invitationRequired');
  });

  it('should allow registration without invite code if user has a pending group invite', async () => {
    vi.mocked(settingsService.getBooleanSetting).mockResolvedValue(true);
    vi.mocked(groupService.hasPendingGroupInvite).mockResolvedValue(true);

    const result = await registerUser({ email: MOCK_EMAIL, password: MOCK_PASSWORD });

    expect(result).toEqual(createdUser);
    expect(inviteService.validateInvite).not.toHaveBeenCalled();
    // No invitation.update since no invitationCode was provided
    expect(prismaMock.invitation.update).not.toHaveBeenCalled();
  });

  it('should skip invitation validation when invitation system is disabled', async () => {
    vi.mocked(settingsService.getBooleanSetting).mockResolvedValue(false);

    const result = await registerUser({
      email: MOCK_EMAIL,
      password: MOCK_PASSWORD,
    });

    expect(result).toEqual(createdUser);
    expect(inviteService.validateInvite).not.toHaveBeenCalled();
    expect(prismaMock.invitation.update).not.toHaveBeenCalled();
    // Audit log should record invitationCode as 'DISABLED'
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: 'REGISTRATION_PENDING',
          details: expect.objectContaining({ invitationCode: 'DISABLED' }),
        }),
      }),
    );
  });

  it('should not decrement invites for SUPERADMIN creators', async () => {
    prismaMock.invitation.update.mockResolvedValue({
      creatorId: 'admin-id',
      creator: { role: 'SUPERADMIN', invitesAvailable: 10 },
    });

    await registerUser(registrationData);

    // user.update should only be called for invite creator's invites decrement,
    // which should NOT happen for SUPERADMIN
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('should decrement invites for regular user creators', async () => {
    prismaMock.invitation.update.mockResolvedValue({
      creatorId: 'creator-id',
      creator: { role: 'USER', invitesAvailable: 3 },
    });

    await registerUser(registrationData);

    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'creator-id' },
      data: { invitesAvailable: 2 },
    });
  });

  it('should not decrement invites below zero for regular user creators', async () => {
    prismaMock.invitation.update.mockResolvedValue({
      creatorId: 'creator-id',
      creator: { role: 'USER', invitesAvailable: 0 },
    });

    await registerUser(registrationData);

    // Should not call user.update since invitesAvailable is already 0
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('should propagate error when validateInvite throws', async () => {
    vi.mocked(inviteService.validateInvite).mockRejectedValue(
      new Error('Invalid invitation code'),
    );

    await expect(registerUser(registrationData)).rejects.toThrow('Invalid invitation code');
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it('should store hashed verification token, not the raw one', async () => {
    await registerUser(registrationData);

    const createCall = prismaMock.user.create.mock.calls[0][0];
    const storedToken = createCall.data.verificationToken;
    // The stored token should be a SHA-256 hex string (64 chars), not the raw randomBytes hex (64 chars)
    expect(storedToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should set verificationTokenExpires to 24 hours from now', async () => {
    const before = Date.now();
    await registerUser(registrationData);
    const after = Date.now();

    const createCall = prismaMock.user.create.mock.calls[0][0];
    const expiresAt = createCall.data.verificationTokenExpires.getTime();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    expect(expiresAt).toBeGreaterThanOrEqual(before + twentyFourHours);
    expect(expiresAt).toBeLessThanOrEqual(after + twentyFourHours);
  });

  it('should assign a color from the USER_COLORS palette', async () => {
    await registerUser(registrationData);

    const createCall = prismaMock.user.create.mock.calls[0][0];
    const assignedColor: string = createCall.data.color;
    expect(assignedColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});

// ============================================================
// loginUser
// ============================================================
describe('loginUser', () => {
  const verifiedUser = makeMockUser({ isVerified: true });

  beforeEach(() => {
    prismaMock.user.findUnique.mockResolvedValue(verifiedUser);
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
    prismaMock.auditLog.create.mockResolvedValue({});
  });

  it('should return safe user object on successful login', async () => {
    const result = await loginUser(MOCK_EMAIL, MOCK_PASSWORD);

    expect(result).not.toHaveProperty('password');
    expect(result).not.toHaveProperty('resetToken');
    expect(result).not.toHaveProperty('resetTokenExpiry');
    expect(result).not.toHaveProperty('verificationToken');
    expect(result).not.toHaveProperty('verificationTokenExpires');
    expect(result).toHaveProperty('id', MOCK_USER_ID);
    expect(result).toHaveProperty('email', MOCK_EMAIL);
  });

  it('should create LOGIN_SUCCESS audit log on successful login', async () => {
    await loginUser(MOCK_EMAIL, MOCK_PASSWORD);

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: MOCK_USER_ID,
          event: 'LOGIN_SUCCESS',
        }),
      }),
    );
  });

  it('should throw "Invalid credentials" when user is not found', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(loginUser(MOCK_EMAIL, MOCK_PASSWORD)).rejects.toThrow('Invalid credentials');
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  it('should throw "Invalid credentials" when password is wrong', async () => {
    vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

    await expect(loginUser(MOCK_EMAIL, MOCK_PASSWORD)).rejects.toThrow('Invalid credentials');
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: 'LOGIN_FAILURE',
          details: expect.objectContaining({ reason: 'Invalid Password' }),
        }),
      }),
    );
  });

  it('should throw "auth.errors.unverified" when user is not verified', async () => {
    prismaMock.user.findUnique.mockResolvedValue(
      makeMockUser({ isVerified: false }),
    );

    await expect(loginUser(MOCK_EMAIL, MOCK_PASSWORD)).rejects.toThrow('auth.errors.unverified');
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: 'LOGIN_FAILURE',
          details: expect.objectContaining({ reason: 'Unverified' }),
        }),
      }),
    );
  });

  it('should not log LOGIN_FAILURE audit when user does not exist', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(loginUser(MOCK_EMAIL, MOCK_PASSWORD)).rejects.toThrow();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });
});

// ============================================================
// verifyEmail
// ============================================================
describe('verifyEmail', () => {
  const RAW_TOKEN = 'raw-verification-token';
  const TOKEN_HASH = hashToken(RAW_TOKEN);

  const unverifiedUser = makeMockUser({
    isVerified: false,
    verificationToken: TOKEN_HASH,
    verificationTokenExpires: new Date(Date.now() + 3600000),
  });

  const verifiedUser = {
    id: MOCK_USER_ID,
    email: MOCK_EMAIL,
    name: MOCK_NAME,
    role: 'USER',
    locale: 'en',
    isVerified: true,
    createdAt: new Date('2026-01-01'),
    invitesAvailable: 2,
    color: '#3182CE',
  };

  beforeEach(() => {
    prismaMock.user.findFirst.mockResolvedValue(unverifiedUser);
    prismaMock.user.update.mockResolvedValue(verifiedUser);
    prismaMock.auditLog.create.mockResolvedValue({});
    vi.mocked(groupService.processPendingGroupInvites).mockResolvedValue(undefined);
  });

  it('should verify user and return updated user object', async () => {
    const result = await verifyEmail(RAW_TOKEN);

    expect(result).toEqual(verifiedUser);
    expect(prismaMock.user.findFirst).toHaveBeenCalledWith({
      where: {
        verificationToken: TOKEN_HASH,
        verificationTokenExpires: { gt: expect.any(Date) },
      },
    });
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: MOCK_USER_ID },
      data: {
        isVerified: true,
        verificationToken: null,
        verificationTokenExpires: null,
        invitesAvailable: 2,
      },
      select: expect.objectContaining({ isVerified: true }),
    });
  });

  it('should create REGISTRATION_COMPLETED audit log', async () => {
    await verifyEmail(RAW_TOKEN);

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: MOCK_USER_ID,
          event: 'REGISTRATION_COMPLETED',
          details: { email: MOCK_EMAIL },
        }),
      }),
    );
  });

  it('should process pending group invites after verification', async () => {
    await verifyEmail(RAW_TOKEN);

    expect(groupService.processPendingGroupInvites).toHaveBeenCalledWith(
      MOCK_USER_ID,
      MOCK_EMAIL,
    );
  });

  it('should throw when token is invalid (no matching user)', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null);

    await expect(verifyEmail('bad-token')).rejects.toThrow('Invalid or expired token');
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('should throw when token is expired (findFirst returns null)', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null);

    await expect(verifyEmail(RAW_TOKEN)).rejects.toThrow('Invalid or expired token');
  });

  it('should hash the raw token with SHA-256 before querying', async () => {
    await verifyEmail(RAW_TOKEN);

    const expectedHash = hashToken(RAW_TOKEN);
    expect(prismaMock.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          verificationToken: expectedHash,
        }),
      }),
    );
  });
});

// ============================================================
// requestPasswordReset
// ============================================================
describe('requestPasswordReset', () => {
  beforeEach(() => {
    prismaMock.user.findUnique.mockResolvedValue(makeMockUser());
    prismaMock.user.update.mockResolvedValue({});
  });

  it('should return true and send reset email when user exists', async () => {
    const result = await requestPasswordReset(MOCK_EMAIL);

    expect(result).toBe(true);
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MOCK_USER_ID },
        data: expect.objectContaining({
          resetToken: expect.any(String),
          resetTokenExpiry: expect.any(Date),
        }),
      }),
    );
    expect(sendEmail).toHaveBeenCalledWith(
      MOCK_EMAIL,
      'Reset your Notiq password',
      expect.stringContaining('reset'),
    );
  });

  it('should store hashed reset token, not the raw one', async () => {
    await requestPasswordReset(MOCK_EMAIL);

    const updateCall = prismaMock.user.update.mock.calls[0][0];
    const storedToken: string = updateCall.data.resetToken;
    // SHA-256 hex is 64 characters
    expect(storedToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should set resetTokenExpiry to ~1 hour from now', async () => {
    const before = Date.now();
    await requestPasswordReset(MOCK_EMAIL);
    const after = Date.now();

    const updateCall = prismaMock.user.update.mock.calls[0][0];
    const expiry = updateCall.data.resetTokenExpiry.getTime();
    const oneHour = 3600000;

    expect(expiry).toBeGreaterThanOrEqual(before + oneHour);
    expect(expiry).toBeLessThanOrEqual(after + oneHour);
  });

  it('should return true silently when user does not exist (no information leak)', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    const result = await requestPasswordReset('nonexistent@example.com');

    expect(result).toBe(true);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('should include FRONTEND_URL in the reset link', async () => {
    await requestPasswordReset(MOCK_EMAIL);

    const emailCall = vi.mocked(sendEmail).mock.calls[0];
    const emailBody = emailCall[2];
    expect(emailBody).toContain('http://localhost:5173');
  });
});

// ============================================================
// resetPassword
// ============================================================
describe('resetPassword', () => {
  const RAW_TOKEN = 'raw-reset-token';
  const TOKEN_HASH = hashToken(RAW_TOKEN);
  const NEW_PASSWORD = 'NewSecureP@ss2';

  const userWithResetToken = makeMockUser({
    resetToken: TOKEN_HASH,
    resetTokenExpiry: new Date(Date.now() + 3600000),
  });

  beforeEach(() => {
    prismaMock.user.findFirst.mockResolvedValue(userWithResetToken);
    prismaMock.user.update.mockResolvedValue({});
    vi.mocked(bcrypt.hash).mockResolvedValue('new-hashed-password' as never);
  });

  it('should reset password and clear reset tokens', async () => {
    const result = await resetPassword(RAW_TOKEN, NEW_PASSWORD);

    expect(result).toBe(true);
    expect(bcrypt.hash).toHaveBeenCalledWith(NEW_PASSWORD, 10);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: MOCK_USER_ID },
      data: {
        password: 'new-hashed-password',
        resetToken: null,
        resetTokenExpiry: null,
        tokenVersion: { increment: 1 },
      },
    });
  });

  it('should increment tokenVersion to invalidate existing JWTs', async () => {
    await resetPassword(RAW_TOKEN, NEW_PASSWORD);

    const updateCall = prismaMock.user.update.mock.calls[0][0];
    expect(updateCall.data.tokenVersion).toEqual({ increment: 1 });
  });

  it('should throw when reset token is invalid', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null);

    await expect(resetPassword('bad-token', NEW_PASSWORD)).rejects.toThrow(
      'Invalid or expired token',
    );
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('should throw when reset token is expired (findFirst returns null)', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null);

    await expect(resetPassword(RAW_TOKEN, NEW_PASSWORD)).rejects.toThrow(
      'Invalid or expired token',
    );
  });

  it('should hash the raw token with SHA-256 before querying', async () => {
    await resetPassword(RAW_TOKEN, NEW_PASSWORD);

    expect(prismaMock.user.findFirst).toHaveBeenCalledWith({
      where: {
        resetToken: TOKEN_HASH,
        resetTokenExpiry: { gt: expect.any(Date) },
      },
    });
  });
});

// ============================================================
// resendVerificationForInvite
// ============================================================
describe('resendVerificationForInvite', () => {
  const INVITE_CODE = 'INV001';
  const REQUESTER_ID = 'requester-id';
  const TARGET_USER_ID = 'target-user-id';
  const TARGET_EMAIL = 'target@example.com';

  const unverifiedUsedBy = {
    id: TARGET_USER_ID,
    email: TARGET_EMAIL,
    isVerified: false,
    locale: 'it',
  };

  const inviteOwnedByRequester = {
    code: INVITE_CODE,
    creatorId: REQUESTER_ID,
    status: 'USED',
    usedBy: unverifiedUsedBy,
  };

  beforeEach(() => {
    prismaMock.invitation.findUnique.mockResolvedValue(inviteOwnedByRequester);
    prismaMock.user.findUnique.mockResolvedValue(null); // Not needed unless checking SUPERADMIN
    prismaMock.user.update.mockResolvedValue({});
    prismaMock.auditLog.create.mockResolvedValue({});
  });

  it('should resend verification email for unverified user on used invite', async () => {
    const result = await resendVerificationForInvite(INVITE_CODE, REQUESTER_ID);

    expect(result).toEqual({ message: 'Verification email sent' });
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TARGET_USER_ID },
        data: expect.objectContaining({
          verificationToken: expect.any(String),
          verificationTokenExpires: expect.any(Date),
        }),
      }),
    );
    expect(sendNotificationEmail).toHaveBeenCalledWith(
      TARGET_EMAIL,
      'VERIFY_EMAIL',
      expect.objectContaining({ locale: 'it' }),
    );
  });

  it('should create VERIFICATION_RESENT audit log', async () => {
    await resendVerificationForInvite(INVITE_CODE, REQUESTER_ID);

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: REQUESTER_ID,
          event: 'VERIFICATION_RESENT',
          details: { targetUser: TARGET_EMAIL, inviteCode: INVITE_CODE },
        }),
      }),
    );
  });

  it('should throw when invite is not found', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue(null);

    await expect(
      resendVerificationForInvite(INVITE_CODE, REQUESTER_ID),
    ).rejects.toThrow('Invite not found');
  });

  it('should throw when requester is not the invite creator and not SUPERADMIN', async () => {
    const inviteFromAnotherUser = {
      ...inviteOwnedByRequester,
      creatorId: 'someone-else',
    };
    prismaMock.invitation.findUnique.mockResolvedValue(inviteFromAnotherUser);
    prismaMock.user.findUnique.mockResolvedValue({ role: 'USER' });

    await expect(
      resendVerificationForInvite(INVITE_CODE, REQUESTER_ID),
    ).rejects.toThrow('Not authorized to manage this invite');
  });

  it('should allow SUPERADMIN to resend verification for any invite', async () => {
    const inviteFromAnotherUser = {
      ...inviteOwnedByRequester,
      creatorId: 'someone-else',
    };
    prismaMock.invitation.findUnique.mockResolvedValue(inviteFromAnotherUser);
    prismaMock.user.findUnique.mockResolvedValue({ role: 'SUPERADMIN' });

    const result = await resendVerificationForInvite(INVITE_CODE, REQUESTER_ID);

    expect(result).toEqual({ message: 'Verification email sent' });
  });

  it('should throw when invite has not been used yet', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue({
      ...inviteOwnedByRequester,
      status: 'PENDING',
      usedBy: null,
    });

    await expect(
      resendVerificationForInvite(INVITE_CODE, REQUESTER_ID),
    ).rejects.toThrow('Invite has not been used yet');
  });

  it('should throw when the invited user is already verified', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue({
      ...inviteOwnedByRequester,
      usedBy: { ...unverifiedUsedBy, isVerified: true },
    });

    await expect(
      resendVerificationForInvite(INVITE_CODE, REQUESTER_ID),
    ).rejects.toThrow('User is already verified');
  });

  it('should set verificationTokenExpires to 24 hours from now', async () => {
    const before = Date.now();
    await resendVerificationForInvite(INVITE_CODE, REQUESTER_ID);
    const after = Date.now();

    const updateCall = prismaMock.user.update.mock.calls[0][0];
    const expiresAt = updateCall.data.verificationTokenExpires.getTime();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    expect(expiresAt).toBeGreaterThanOrEqual(before + twentyFourHours);
    expect(expiresAt).toBeLessThanOrEqual(after + twentyFourHours);
  });

  it('should use the target user locale for the verification email', async () => {
    await resendVerificationForInvite(INVITE_CODE, REQUESTER_ID);

    expect(sendNotificationEmail).toHaveBeenCalledWith(
      TARGET_EMAIL,
      'VERIFY_EMAIL',
      expect.objectContaining({ locale: 'it' }),
    );
  });

  it('should default to "en" locale when user locale is null', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue({
      ...inviteOwnedByRequester,
      usedBy: { ...unverifiedUsedBy, locale: null },
    });

    await resendVerificationForInvite(INVITE_CODE, REQUESTER_ID);

    expect(sendNotificationEmail).toHaveBeenCalledWith(
      TARGET_EMAIL,
      'VERIFY_EMAIL',
      expect.objectContaining({ locale: 'en' }),
    );
  });
});
