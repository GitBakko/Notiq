import prisma from '../plugins/prisma';
import * as notificationService from './notification.service';
import * as emailService from './email.service';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { MultipartFile } from '@fastify/multipart';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const GROUP_AVATAR_DIR = path.join(process.cwd(), 'uploads', 'groups');

// ---- GROUP CRUD ----

export const createGroup = async (
  ownerId: string,
  data: { name: string; description?: string }
) => {
  return prisma.group.create({
    data: { name: data.name, description: data.description, ownerId },
    include: {
      members: { include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } } },
      pendingInvites: { select: { id: true, email: true, createdAt: true } },
    },
  });
};

export const getMyGroups = async (userId: string) => {
  const [owned, memberOf] = await Promise.all([
    prisma.group.findMany({
      where: { ownerId: userId },
      include: {
        members: { include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } } },
        pendingInvites: { select: { id: true, email: true, createdAt: true } },
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.group.findMany({
      where: {
        members: { some: { userId } },
        ownerId: { not: userId },
      },
      include: {
        owner: { select: { id: true, email: true, name: true } },
        members: { include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } } },
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  return { owned, memberOf };
};

export const getGroup = async (groupId: string, requesterId: string) => {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: {
      owner: { select: { id: true, email: true, name: true } },
      members: { include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } } },
      pendingInvites: { select: { id: true, email: true, createdAt: true } },
    },
  });
  if (!group) throw new Error('Group not found');
  const isMember = group.members.some((m) => m.userId === requesterId);
  if (group.ownerId !== requesterId && !isMember) throw new Error('Access denied');
  return group;
};

export const updateGroup = async (
  groupId: string,
  ownerId: string,
  data: { name?: string; description?: string }
) => {
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group || group.ownerId !== ownerId) throw new Error('Not found or access denied');
  return prisma.group.update({
    where: { id: groupId },
    data: { name: data.name, description: data.description },
    include: {
      members: { include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } } },
      pendingInvites: { select: { id: true, email: true, createdAt: true } },
    },
  });
};

export const deleteGroup = async (groupId: string, ownerId: string) => {
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group || group.ownerId !== ownerId) throw new Error('Not found or access denied');
  // Clean up avatar file if exists
  if (group.avatarUrl) {
    const oldFile = path.join(process.cwd(), group.avatarUrl.replace(/^\//, ''));
    if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
  }
  await prisma.group.delete({ where: { id: groupId } });
};

// ---- GROUP AVATAR ----

const AVATAR_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export const uploadGroupAvatar = async (
  groupId: string,
  ownerId: string,
  file: MultipartFile
) => {
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group || group.ownerId !== ownerId) throw new Error('Not found or access denied');

  if (!AVATAR_MIME_TYPES.has(file.mimetype)) throw new Error('Only image files allowed');

  if (!fs.existsSync(GROUP_AVATAR_DIR)) fs.mkdirSync(GROUP_AVATAR_DIR, { recursive: true });

  const filename = `${groupId}-${Date.now()}${path.extname(file.filename)}`;
  const filepath = path.join(GROUP_AVATAR_DIR, filename);
  await pipeline(file.file, fs.createWriteStream(filepath));

  // Remove old avatar file
  if (group.avatarUrl) {
    const oldFile = path.join(process.cwd(), group.avatarUrl.replace(/^\//, ''));
    if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
  }

  const avatarUrl = `/uploads/groups/${filename}`;
  return prisma.group.update({
    where: { id: groupId },
    data: { avatarUrl },
    include: {
      members: { include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } } },
      pendingInvites: { select: { id: true, email: true, createdAt: true } },
    },
  });
};

// ---- MEMBER MANAGEMENT ----

export const addMember = async (groupId: string, ownerId: string, email: string) => {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: { owner: { select: { id: true, name: true, email: true, locale: true } } },
  });
  if (!group || group.ownerId !== ownerId) throw new Error('Not found or access denied');

  const ownerName = group.owner.name || group.owner.email;
  const ownerLocale = group.owner.locale || 'en';

  if (group.owner.email === email) throw new Error('Cannot add yourself to a group');

  const targetUser = await prisma.user.findUnique({ where: { email } });

  if (targetUser) {
    const existing = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: targetUser.id } },
    });
    if (existing) throw new Error('User is already a member');

    await prisma.groupMember.create({ data: { groupId, userId: targetUser.id } });

    await notificationService.createNotification(
      targetUser.id,
      'GROUP_INVITE',
      'Added to Group',
      `${ownerName} added you to the group "${group.name}"`,
      {
        groupId,
        groupName: group.name,
        ownerName,
        localizationKey: 'notifications.groupInvite',
        localizationArgs: { ownerName, groupName: group.name },
      }
    );

    await emailService.sendNotificationEmail(targetUser.email, 'GROUP_MEMBER_ADDED', {
      groupName: group.name,
      ownerName,
      locale: targetUser.locale || ownerLocale,
    });

    return { type: 'registered' as const, userId: targetUser.id };
  } else {
    // Unregistered user: create pending invite
    await prisma.pendingGroupInvite.upsert({
      where: { groupId_email: { groupId, email } },
      update: { invitedBy: ownerId },
      create: { groupId, email, invitedBy: ownerId },
    });

    await emailService.sendNotificationEmail(email, 'GROUP_INVITE_REGISTER', {
      groupName: group.name,
      ownerName,
      registerUrl: `${FRONTEND_URL}/register`,
      locale: ownerLocale,
    });

    return { type: 'pending' as const, email };
  }
};

export const removeMember = async (groupId: string, ownerId: string, targetUserId: string) => {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: { owner: { select: { id: true, name: true, email: true } } },
  });
  if (!group || group.ownerId !== ownerId) throw new Error('Not found or access denied');
  if (targetUserId === ownerId) throw new Error('Cannot remove yourself as owner');

  const member = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: targetUserId } },
    include: { user: { select: { email: true, name: true, locale: true } } },
  });
  if (!member) throw new Error('Member not found');

  await prisma.groupMember.delete({
    where: { groupId_userId: { groupId, userId: targetUserId } },
  });

  const ownerName = group.owner.name || group.owner.email;

  await notificationService.createNotification(
    targetUserId,
    'GROUP_REMOVE',
    'Removed from Group',
    `${ownerName} removed you from the group "${group.name}"`,
    {
      groupId,
      groupName: group.name,
      ownerName,
      localizationKey: 'notifications.groupRemove',
      localizationArgs: { ownerName, groupName: group.name },
    }
  );

  await emailService.sendNotificationEmail(member.user.email, 'GROUP_MEMBER_REMOVED', {
    groupName: group.name,
    ownerName,
    locale: member.user.locale || 'en',
  });
};

export const removePendingInvite = async (groupId: string, ownerId: string, email: string) => {
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group || group.ownerId !== ownerId) throw new Error('Not found or access denied');
  await prisma.pendingGroupInvite.deleteMany({ where: { groupId, email } });
};

// ---- POST-REGISTRATION HOOK ----

export const processPendingGroupInvites = async (userId: string, email: string) => {
  const pending = await prisma.pendingGroupInvite.findMany({
    where: { email },
    include: {
      group: {
        include: { owner: { select: { id: true, name: true, email: true, locale: true } } },
      },
    },
  });

  if (pending.length === 0) return;

  for (const invite of pending) {
    const group = invite.group;
    const ownerName = group.owner.name || group.owner.email;

    const existing = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId } },
    });
    if (existing) {
      await prisma.pendingGroupInvite.delete({ where: { id: invite.id } });
      continue;
    }

    await prisma.groupMember.create({ data: { groupId: group.id, userId } });

    await notificationService.createNotification(
      userId,
      'GROUP_INVITE',
      'Added to Group',
      `${ownerName} added you to the group "${group.name}"`,
      {
        groupId: group.id,
        groupName: group.name,
        ownerName,
        localizationKey: 'notifications.groupInvite',
        localizationArgs: { ownerName, groupName: group.name },
      }
    );

    await notificationService.createNotification(
      group.owner.id,
      'SYSTEM',
      'Group Member Joined',
      `${email} has registered and joined your group "${group.name}"`,
      {
        groupId: group.id,
        groupName: group.name,
        memberEmail: email,
        localizationKey: 'notifications.groupMemberJoined',
        localizationArgs: { memberEmail: email, groupName: group.name },
      }
    );

    await emailService.sendNotificationEmail(group.owner.email, 'GROUP_MEMBER_JOINED', {
      groupName: group.name,
      memberEmail: email,
      locale: group.owner.locale || 'en',
    });

    await prisma.pendingGroupInvite.delete({ where: { id: invite.id } });
  }
};

// ---- QUERY FOR SHARING MODAL ----

export const getGroupsForSharing = async (userId: string) => {
  return prisma.group.findMany({
    where: {
      OR: [
        { ownerId: userId },
        { members: { some: { userId } } },
      ],
    },
    include: {
      members: { include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } } },
      _count: { select: { members: true } },
    },
    orderBy: { name: 'asc' },
  });
};

// ---- CHECK IF EMAIL HAS PENDING GROUP INVITE ----

export const hasPendingGroupInvite = async (email: string): Promise<boolean> => {
  const count = await prisma.pendingGroupInvite.count({ where: { email } });
  return count > 0;
};
