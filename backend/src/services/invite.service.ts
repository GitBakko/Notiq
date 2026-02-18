
import prisma from '../plugins/prisma';
import crypto from 'crypto';

const generateSecureCode = (): string => {
  return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
};

export const generateInvite = async (userId: string) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');

  // SuperAdmin has infinite invites, but we still generate codes.
  // Regular users need invitesAvailable > 0.
  if (user.role !== 'SUPERADMIN' && user.invitesAvailable <= 0) {
    throw new Error('No invites available');
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
    throw new Error('Invalid invitation code');
  }

  if (invite.status !== 'PENDING') {
    throw new Error('Invitation code already used');
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
  if (!invite || invite.creatorId !== userId) throw new Error('Invalid invite');
  if (invite.status !== 'PENDING') throw new Error('Invite already used');

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
  if (!req) throw new Error('Request not found');

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

  // Send Email
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const emailService = require('./email.service');
  await emailService.sendNotificationEmail(req.email, 'INVITE_APPROVED', {
    code,
    locale: 'it' // Default or guess? No locale in request. Check if we can infer or default to IT given user language.
    // TODO: Add locale to Request model? For now default IT as per user preference likely.
  });
};

export const rejectInvitationRequest = async (requestId: string) => {
  const req = await prisma.invitationRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new Error('Request not found');

  await prisma.invitationRequest.update({
    where: { id: requestId },
    data: { status: 'REJECTED' }
  });

  // Send Email
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const emailService = require('./email.service');
  await emailService.sendNotificationEmail(req.email, 'INVITE_REJECTED', {
    locale: 'it'
  });
};
