import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';

// Mock sibling services
vi.mock('../email.service', () => ({
  sendNotificationEmail: vi.fn().mockResolvedValue(undefined),
}));

import * as emailService from '../email.service';

import {
  generateInvite,
  validateInvite,
  getUserInvites,
  sendInviteEmail,
  createInvitationRequest,
  getInvitationRequests,
  approveInvitationRequest,
  rejectInvitationRequest,
} from '../invite.service';
import { makeUser, makeInvitation } from '../../__tests__/factories';
import { NotFoundError, BadRequestError, ConflictError } from '../../utils/errors';

const prismaMock = prisma as any;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const regularUser = makeUser({ id: 'user-1', email: 'user@test.com', name: 'Regular', invitesAvailable: 2, role: 'USER' });
const superadmin = makeUser({ id: 'admin-1', email: 'admin@test.com', name: 'Admin', invitesAvailable: 0, role: 'SUPERADMIN' });
const userNoInvites = makeUser({ id: 'user-2', email: 'noinvites@test.com', name: 'NoInvites', invitesAvailable: 0, role: 'USER' });

const pendingInvite = makeInvitation({ id: 'inv-1', code: 'ABC123', creatorId: regularUser.id, status: 'PENDING' });
const usedInvite = makeInvitation({ id: 'inv-2', code: 'DEF456', creatorId: regularUser.id, status: 'USED', usedById: 'someone', usedAt: new Date() });

// ---------------------------------------------------------------------------
// Reset all mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// generateInvite
// ---------------------------------------------------------------------------
describe('generateInvite', () => {
  it('generates an invite for a regular user with invites available', async () => {
    prismaMock.user.findUnique.mockResolvedValue(regularUser);
    prismaMock.invitation.findUnique.mockResolvedValue(null); // No code collision
    prismaMock.invitation.create.mockResolvedValue(pendingInvite);

    const result = await generateInvite(regularUser.id);

    expect(result).toEqual(pendingInvite);
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({ where: { id: regularUser.id } });
    expect(prismaMock.invitation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        creatorId: regularUser.id,
        status: 'PENDING',
      }),
    });
  });

  it('generates an invite for superadmin even with zero invites available', async () => {
    prismaMock.user.findUnique.mockResolvedValue(superadmin);
    prismaMock.invitation.findUnique.mockResolvedValue(null);
    prismaMock.invitation.create.mockResolvedValue(pendingInvite);

    const result = await generateInvite(superadmin.id);

    expect(result).toEqual(pendingInvite);
    expect(prismaMock.invitation.create).toHaveBeenCalled();
  });

  it('throws NotFoundError when user does not exist', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(generateInvite('nonexistent')).rejects.toThrow(NotFoundError);
    await expect(generateInvite('nonexistent')).rejects.toThrow('errors.user.notFound');
  });

  it('throws BadRequestError when regular user has no invites available', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userNoInvites);

    await expect(generateInvite(userNoInvites.id)).rejects.toThrow(BadRequestError);
    await expect(generateInvite(userNoInvites.id)).rejects.toThrow('errors.invites.noInvitesAvailable');
  });

  it('retries code generation on collision', async () => {
    prismaMock.user.findUnique.mockResolvedValue(regularUser);
    // First code collides, second does not
    prismaMock.invitation.findUnique
      .mockResolvedValueOnce({ id: 'existing' }) // collision
      .mockResolvedValueOnce(null);               // no collision
    prismaMock.invitation.create.mockResolvedValue(pendingInvite);

    const result = await generateInvite(regularUser.id);

    expect(result).toEqual(pendingInvite);
    expect(prismaMock.invitation.findUnique).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// validateInvite
// ---------------------------------------------------------------------------
describe('validateInvite', () => {
  it('returns invite with creator when code is valid and pending', async () => {
    const inviteWithCreator = { ...pendingInvite, creator: regularUser };
    prismaMock.invitation.findUnique.mockResolvedValue(inviteWithCreator);

    const result = await validateInvite('ABC123');

    expect(result).toEqual(inviteWithCreator);
    expect(prismaMock.invitation.findUnique).toHaveBeenCalledWith({
      where: { code: 'ABC123' },
      include: { creator: true },
    });
  });

  it('throws BadRequestError when code does not exist', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue(null);

    await expect(validateInvite('INVALID')).rejects.toThrow(BadRequestError);
    await expect(validateInvite('INVALID')).rejects.toThrow('errors.invites.invalidCode');
  });

  it('throws ConflictError when invite is already used', async () => {
    const usedWithCreator = { ...usedInvite, creator: regularUser };
    prismaMock.invitation.findUnique.mockResolvedValue(usedWithCreator);

    await expect(validateInvite('DEF456')).rejects.toThrow(ConflictError);
    await expect(validateInvite('DEF456')).rejects.toThrow('errors.invites.codeAlreadyUsed');
  });
});

// ---------------------------------------------------------------------------
// getUserInvites
// ---------------------------------------------------------------------------
describe('getUserInvites', () => {
  it('returns all invites created by the user', async () => {
    const invites = [
      { ...pendingInvite, usedBy: null },
      { ...usedInvite, usedBy: { id: 'someone', email: 's@test.com', name: 'Someone', isVerified: true } },
    ];
    prismaMock.invitation.findMany.mockResolvedValue(invites);

    const result = await getUserInvites(regularUser.id);

    expect(result).toEqual(invites);
    expect(prismaMock.invitation.findMany).toHaveBeenCalledWith({
      where: { creatorId: regularUser.id },
      orderBy: { createdAt: 'desc' },
      include: { usedBy: { select: { id: true, email: true, name: true, isVerified: true } } },
    });
  });

  it('returns empty array when user has no invites', async () => {
    prismaMock.invitation.findMany.mockResolvedValue([]);

    const result = await getUserInvites('no-invites-user');

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sendInviteEmail
// ---------------------------------------------------------------------------
describe('sendInviteEmail', () => {
  it('sends invitation email for a valid pending invite owned by the user', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue(pendingInvite);
    prismaMock.user.findUnique.mockResolvedValue(regularUser);

    await sendInviteEmail('ABC123', regularUser.id, 'recipient@test.com', 'Recipient', 'en');

    expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
      'recipient@test.com',
      'REGISTRATION_INVITATION',
      {
        sharerName: regularUser.name,
        code: pendingInvite.code,
        locale: 'en',
      },
    );
  });

  it('uses fallback name when sender has no name', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue(pendingInvite);
    prismaMock.user.findUnique.mockResolvedValue({ ...regularUser, name: null });

    await sendInviteEmail('ABC123', regularUser.id, 'recipient@test.com', 'Recipient', 'it');

    expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
      'recipient@test.com',
      'REGISTRATION_INVITATION',
      expect.objectContaining({ sharerName: 'A user' }),
    );
  });

  it('throws NotFoundError when invite does not exist', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue(null);

    await expect(sendInviteEmail('NOPE', regularUser.id, 'r@test.com', 'R', 'en')).rejects.toThrow(NotFoundError);
    await expect(sendInviteEmail('NOPE', regularUser.id, 'r@test.com', 'R', 'en')).rejects.toThrow('errors.invites.notFound');
  });

  it('throws NotFoundError when invite belongs to a different user', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue({ ...pendingInvite, creatorId: 'other-user' });

    await expect(sendInviteEmail('ABC123', regularUser.id, 'r@test.com', 'R', 'en')).rejects.toThrow(NotFoundError);
    await expect(sendInviteEmail('ABC123', regularUser.id, 'r@test.com', 'R', 'en')).rejects.toThrow('errors.invites.notFound');
  });

  it('throws ConflictError when invite is already used', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue(usedInvite);

    await expect(sendInviteEmail('DEF456', regularUser.id, 'r@test.com', 'R', 'en')).rejects.toThrow(ConflictError);
    await expect(sendInviteEmail('DEF456', regularUser.id, 'r@test.com', 'R', 'en')).rejects.toThrow('errors.invites.alreadyUsed');
  });
});

// ---------------------------------------------------------------------------
// createInvitationRequest
// ---------------------------------------------------------------------------
describe('createInvitationRequest', () => {
  it('creates a new invitation request', async () => {
    prismaMock.invitationRequest.findFirst.mockResolvedValue(null);
    prismaMock.invitationRequest.create.mockResolvedValue({
      id: 'req-1',
      email: 'new@test.com',
      ipAddress: '127.0.0.1',
      status: 'PENDING',
      createdAt: new Date(),
    });

    await createInvitationRequest('new@test.com', '127.0.0.1');

    expect(prismaMock.invitationRequest.create).toHaveBeenCalledWith({
      data: {
        email: 'new@test.com',
        ipAddress: '127.0.0.1',
        status: 'PENDING',
      },
    });
  });

  it('creates request without IP address', async () => {
    prismaMock.invitationRequest.findFirst.mockResolvedValue(null);
    prismaMock.invitationRequest.create.mockResolvedValue({});

    await createInvitationRequest('new@test.com');

    expect(prismaMock.invitationRequest.create).toHaveBeenCalledWith({
      data: {
        email: 'new@test.com',
        ipAddress: undefined,
        status: 'PENDING',
      },
    });
  });

  it('silently returns without creating when a pending request already exists', async () => {
    prismaMock.invitationRequest.findFirst.mockResolvedValue({
      id: 'existing-req',
      email: 'new@test.com',
      status: 'PENDING',
    });

    await createInvitationRequest('new@test.com', '127.0.0.1');

    expect(prismaMock.invitationRequest.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getInvitationRequests
// ---------------------------------------------------------------------------
describe('getInvitationRequests', () => {
  it('returns pending invitation requests ordered by creation date', async () => {
    const requests = [
      { id: 'req-2', email: 'b@test.com', status: 'PENDING', createdAt: new Date() },
      { id: 'req-1', email: 'a@test.com', status: 'PENDING', createdAt: new Date() },
    ];
    prismaMock.invitationRequest.findMany.mockResolvedValue(requests);

    const result = await getInvitationRequests();

    expect(result).toEqual(requests);
    expect(prismaMock.invitationRequest.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
      where: { status: 'PENDING' },
    });
  });

  it('returns empty array when no pending requests exist', async () => {
    prismaMock.invitationRequest.findMany.mockResolvedValue([]);

    const result = await getInvitationRequests();

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// approveInvitationRequest
// ---------------------------------------------------------------------------
describe('approveInvitationRequest', () => {
  const request = {
    id: 'req-1',
    email: 'requester@test.com',
    ipAddress: '127.0.0.1',
    status: 'PENDING',
    createdAt: new Date(),
  };

  it('approves request, generates invite code, and sends email', async () => {
    prismaMock.invitationRequest.findUnique.mockResolvedValue(request);
    prismaMock.invitation.findUnique.mockResolvedValue(null); // No code collision
    prismaMock.invitation.create.mockResolvedValue(pendingInvite);
    prismaMock.invitationRequest.update.mockResolvedValue({ ...request, status: 'APPROVED' });
    prismaMock.user.findUnique.mockResolvedValue(null); // Requester not yet a user

    await approveInvitationRequest('req-1', superadmin.id);

    expect(prismaMock.invitation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        creatorId: superadmin.id,
        status: 'PENDING',
      }),
    });
    expect(prismaMock.invitationRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: { status: 'APPROVED' },
    });
    expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
      request.email,
      'INVITE_APPROVED',
      expect.objectContaining({ locale: 'en' }),
    );
  });

  it('uses existing user locale when requester is already a user', async () => {
    prismaMock.invitationRequest.findUnique.mockResolvedValue(request);
    prismaMock.invitation.findUnique.mockResolvedValue(null);
    prismaMock.invitation.create.mockResolvedValue(pendingInvite);
    prismaMock.invitationRequest.update.mockResolvedValue({ ...request, status: 'APPROVED' });
    prismaMock.user.findUnique.mockResolvedValue({ locale: 'it' });

    await approveInvitationRequest('req-1', superadmin.id);

    expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
      request.email,
      'INVITE_APPROVED',
      expect.objectContaining({ locale: 'it' }),
    );
  });

  it('retries code generation on collision', async () => {
    prismaMock.invitationRequest.findUnique.mockResolvedValue(request);
    prismaMock.invitation.findUnique
      .mockResolvedValueOnce({ id: 'collision' })
      .mockResolvedValueOnce(null);
    prismaMock.invitation.create.mockResolvedValue(pendingInvite);
    prismaMock.invitationRequest.update.mockResolvedValue({ ...request, status: 'APPROVED' });
    prismaMock.user.findUnique.mockResolvedValue(null);

    await approveInvitationRequest('req-1', superadmin.id);

    expect(prismaMock.invitation.findUnique).toHaveBeenCalledTimes(2);
    expect(prismaMock.invitation.create).toHaveBeenCalled();
  });

  it('throws NotFoundError when request does not exist', async () => {
    prismaMock.invitationRequest.findUnique.mockResolvedValue(null);

    await expect(approveInvitationRequest('nonexistent', superadmin.id)).rejects.toThrow(NotFoundError);
    await expect(approveInvitationRequest('nonexistent', superadmin.id)).rejects.toThrow('errors.invites.requestNotFound');
  });
});

// ---------------------------------------------------------------------------
// rejectInvitationRequest
// ---------------------------------------------------------------------------
describe('rejectInvitationRequest', () => {
  const request = {
    id: 'req-1',
    email: 'requester@test.com',
    ipAddress: '127.0.0.1',
    status: 'PENDING',
    createdAt: new Date(),
  };

  it('rejects request and sends rejection email', async () => {
    prismaMock.invitationRequest.findUnique.mockResolvedValue(request);
    prismaMock.invitationRequest.update.mockResolvedValue({ ...request, status: 'REJECTED' });
    prismaMock.user.findUnique.mockResolvedValue(null); // Requester not a user

    await rejectInvitationRequest('req-1');

    expect(prismaMock.invitationRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: { status: 'REJECTED' },
    });
    expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
      request.email,
      'INVITE_REJECTED',
      { locale: 'en' },
    );
  });

  it('uses existing user locale when requester is already a user', async () => {
    prismaMock.invitationRequest.findUnique.mockResolvedValue(request);
    prismaMock.invitationRequest.update.mockResolvedValue({ ...request, status: 'REJECTED' });
    prismaMock.user.findUnique.mockResolvedValue({ locale: 'it' });

    await rejectInvitationRequest('req-1');

    expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
      request.email,
      'INVITE_REJECTED',
      { locale: 'it' },
    );
  });

  it('throws NotFoundError when request does not exist', async () => {
    prismaMock.invitationRequest.findUnique.mockResolvedValue(null);

    await expect(rejectInvitationRequest('nonexistent')).rejects.toThrow(NotFoundError);
    await expect(rejectInvitationRequest('nonexistent')).rejects.toThrow('errors.invites.requestNotFound');
  });
});
