
import prisma from '../plugins/prisma';
import crypto from 'crypto';
import { NotFoundError, BadRequestError, ConflictError } from '../utils/errors';

const generateSecureCode = (): string => {
  return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
};

export const generateInvite = async (userId: string) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('errors.user.notFound');

  // SuperAdmin has infinite invites, but we still generate codes.
  // Regular users need invitesAvailable > 0.
  if (user.role !== 'SUPERADMIN' && user.invitesAvailable <= 0) {
    throw new BadRequestError('errors.invites.noInvitesAvailable');
  }

  let code = '';
  for (let i = 0; i < 5; i++) {
    code = generateSecureCode();
    const existing = await prisma.invitation.findUnique({ where: { code } });
    if (!existing) break;
  }

  const invite = await prisma.invitation.create({
    data: {
      code,
      creatorId: userId,
      status: 'PENDING',
    },
  });

  return invite;
};

export const validateInvite = async (code: string) => {
  const invite = await prisma.invitation.findUnique({
    where: { code },
    include: { creator: true },
  });

  if (!invite) {
    throw new BadRequestError('errors.invites.invalidCode');
  }

  if (invite.status !== 'PENDING') {
    throw new ConflictError('errors.invites.codeAlreadyUsed');
  }

  return invite;
};


export const getUserInvites = async (userId: string) => {
  const invites = await prisma.invitation.findMany({
    where: { creatorId: userId },
    orderBy: { createdAt: 'desc' },
    include: { usedBy: { select: { id: true, email: true, name: true, isVerified: true } } },
  });
  return invites;
};

export const sendInviteEmail = async (code: string, userId: string, email: string, name: string, locale: string) => {
  const invite = await prisma.invitation.findUnique({ where: { code } });
  if (!invite || invite.creatorId !== userId) throw new NotFoundError('errors.invites.notFound');
  if (invite.status !== 'PENDING') throw new ConflictError('errors.invites.alreadyUsed');

  const sender = await prisma.user.findUnique({ where: { id: userId } });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const emailService = require('./email.service');
  await emailService.sendNotificationEmail(email, 'REGISTRATION_INVITATION', {
    sharerName: sender?.name || 'A user',
    code: invite.code,
    locale
  });
};

export const createInvitationRequest = async (email: string, ip?: string) => {
  // Check if pending exists
  const existing = await prisma.invitationRequest.findFirst({
    where: { email, status: 'PENDING' }
  });
  if (existing) return; // Silent return

  await prisma.invitationRequest.create({
    data: {
      email,
      ipAddress: ip,
      status: 'PENDING'
    }
  });
};

export const getInvitationRequests = async () => {
  return prisma.invitationRequest.findMany({
    orderBy: { createdAt: 'desc' },
    where: { status: 'PENDING' } // Only show pending by default for now
  });
};

export const approveInvitationRequest = async (requestId: string, adminId: string) => {
  const req = await prisma.invitationRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new NotFoundError('errors.invites.requestNotFound');

  // Generate Invite Code (Force logic reuse or duplicate?)
  // Reusing logic via new call? simpler to duplicate for slightly different context (admin gen)

  let code = '';
  for (let i = 0; i < 5; i++) {
    code = generateSecureCode();
    const existing = await prisma.invitation.findUnique({ where: { code } });
    if (!existing) break;
  }

  // Create Invite linked to Admin
  await prisma.invitation.create({
    data: {
      code,
      creatorId: adminId,
      status: 'PENDING'
    }
  });

  // Update Request
  await prisma.invitationRequest.update({
    where: { id: requestId },
    data: { status: 'APPROVED' }
  });

  // Resolve locale: check if requester already exists as user, otherwise default to 'en'
  const existingUser = await prisma.user.findUnique({ where: { email: req.email }, select: { locale: true } });
  const locale = existingUser?.locale || 'en';

  // Send Email
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const emailService = require('./email.service');
  await emailService.sendNotificationEmail(req.email, 'INVITE_APPROVED', {
    code,
    locale,
  });
};

export const rejectInvitationRequest = async (requestId: string) => {
  const req = await prisma.invitationRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new NotFoundError('errors.invites.requestNotFound');

  await prisma.invitationRequest.update({
    where: { id: requestId },
    data: { status: 'REJECTED' }
  });

  // Resolve locale: check if requester already exists as user, otherwise default to 'en'
  const existingUser = await prisma.user.findUnique({ where: { email: req.email }, select: { locale: true } });
  const locale = existingUser?.locale || 'en';

  // Send Email
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const emailService = require('./email.service');
  await emailService.sendNotificationEmail(req.email, 'INVITE_REJECTED', {
    locale,
  });
};
