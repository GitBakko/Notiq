import prisma from '../plugins/prisma';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import logger from '../utils/logger';

const EDIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

const userSelect = {
  id: true,
  name: true,
  email: true,
  avatarUrl: true,
  color: true,
} as const;

const messageInclude = {
  sender: { select: userSelect },
  replyTo: {
    include: {
      sender: { select: { id: true, name: true } },
    },
  },
  reactions: {
    include: {
      user: { select: userSelect },
    },
  },
  files: true,
} as const;

async function assertParticipant(conversationId: string, userId: string) {
  const p = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  if (!p) throw new ForbiddenError('errors.chat.notParticipant');
  return p;
}

export async function getOrCreateDirectConversation(userId1: string, userId2: string) {
  // Find existing DIRECT conversation where BOTH users are participants
  const existing = await prisma.conversation.findFirst({
    where: {
      type: 'DIRECT',
      AND: [
        { participants: { some: { userId: userId1 } } },
        { participants: { some: { userId: userId2 } } },
      ],
    },
    include: {
      participants: {
        include: { user: { select: userSelect } },
      },
    },
  });

  if (existing) return existing;

  // Create new direct conversation
  const conversation = await prisma.conversation.create({
    data: {
      type: 'DIRECT',
      participants: {
        create: [
          { userId: userId1 },
          { userId: userId2 },
        ],
      },
    },
    include: {
      participants: {
        include: { user: { select: userSelect } },
      },
    },
  });

  logger.info({ userId1, userId2, conversationId: conversation.id }, 'Direct conversation created');
  return conversation;
}

export async function createGroupConversation(
  creatorId: string,
  title: string,
  participantIds: string[],
) {
  // Ensure creator is in the list
  const uniqueIds = [...new Set([creatorId, ...participantIds])];

  if (uniqueIds.length < 2) {
    throw new BadRequestError('errors.chat.groupNeedsParticipants');
  }

  const conversation = await prisma.conversation.create({
    data: {
      type: 'GROUP',
      title,
      participants: {
        create: uniqueIds.map((userId) => ({ userId })),
      },
    },
    include: {
      participants: {
        include: { user: { select: userSelect } },
      },
    },
  });

  logger.info(
    { creatorId, conversationId: conversation.id, participantCount: uniqueIds.length },
    'Group conversation created',
  );
  return conversation;
}

export async function getConversations(userId: string) {
  const participations = await prisma.conversationParticipant.findMany({
    where: { userId },
    include: {
      conversation: {
        include: {
          participants: {
            include: { user: { select: userSelect } },
          },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: {
              sender: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
    orderBy: { conversation: { updatedAt: 'desc' } },
  });

  const result = await Promise.all(
    participations.map(async (p) => {
      const unreadCount = await prisma.directMessage.count({
        where: {
          conversationId: p.conversationId,
          createdAt: { gt: p.lastReadAt },
          senderId: { not: userId },
          isDeleted: false,
        },
      });

      return {
        ...p.conversation,
        lastMessage: p.conversation.messages[0] || null,
        unreadCount,
      };
    }),
  );

  return result;
}

export async function getMessages(
  conversationId: string,
  userId: string,
  options: { page?: number; limit?: number; before?: string } = {},
) {
  await assertParticipant(conversationId, userId);

  const limit = Math.min(options.limit || 50, 100);

  // Cursor-based pagination if `before` is provided
  if (options.before) {
    const messages = await prisma.directMessage.findMany({
      where: {
        conversationId,
        createdAt: {
          lt: (
            await prisma.directMessage.findUnique({
              where: { id: options.before },
              select: { createdAt: true },
            })
          )?.createdAt,
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: messageInclude,
    });

    return messages.reverse();
  }

  // Offset-based pagination
  const page = Math.max(options.page || 1, 1);
  const skip = (page - 1) * limit;

  const messages = await prisma.directMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    skip,
    take: limit,
    include: messageInclude,
  });

  return messages.reverse();
}

export async function sendMessage(
  conversationId: string,
  senderId: string,
  data: { content: string; replyToId?: string },
) {
  await assertParticipant(conversationId, senderId);

  if (data.replyToId) {
    const replyTarget = await prisma.directMessage.findUnique({
      where: { id: data.replyToId },
      select: { conversationId: true },
    });
    if (!replyTarget || replyTarget.conversationId !== conversationId) {
      throw new NotFoundError('errors.chat.replyTargetNotFound');
    }
  }

  const message = await prisma.directMessage.create({
    data: {
      conversationId,
      senderId,
      content: data.content,
      replyToId: data.replyToId,
    },
    include: messageInclude,
  });

  // Touch conversation updatedAt
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });

  return message;
}

export async function editMessage(messageId: string, senderId: string, content: string) {
  const message = await prisma.directMessage.findUnique({
    where: { id: messageId },
  });

  if (!message) throw new NotFoundError('errors.chat.messageNotFound');
  if (message.senderId !== senderId) throw new ForbiddenError('errors.chat.notMessageOwner');
  if (message.isDeleted) throw new BadRequestError('errors.chat.messageDeleted');

  if (Date.now() - message.createdAt.getTime() > EDIT_WINDOW_MS) {
    throw new BadRequestError('errors.chat.editWindowExpired');
  }

  const updated = await prisma.directMessage.update({
    where: { id: messageId },
    data: { content, editedAt: new Date() },
    include: messageInclude,
  });

  return updated;
}

export async function deleteMessage(messageId: string, senderId: string) {
  const message = await prisma.directMessage.findUnique({
    where: { id: messageId },
  });

  if (!message) throw new NotFoundError('errors.chat.messageNotFound');
  if (message.senderId !== senderId) throw new ForbiddenError('errors.chat.notMessageOwner');
  if (message.isDeleted) throw new BadRequestError('errors.chat.messageAlreadyDeleted');

  // Only allow deleting the user's last non-deleted message in this conversation
  const lastMessage = await prisma.directMessage.findFirst({
    where: {
      conversationId: message.conversationId,
      senderId,
      isDeleted: false,
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!lastMessage || lastMessage.id !== messageId) {
    throw new BadRequestError('errors.chat.canOnlyDeleteLastMessage');
  }

  await prisma.directMessage.update({
    where: { id: messageId },
    data: { isDeleted: true, content: '' },
  });

  return messageId;
}

export async function searchMessages(
  conversationId: string,
  userId: string,
  query: string,
) {
  await assertParticipant(conversationId, userId);

  const messages = await prisma.directMessage.findMany({
    where: {
      conversationId,
      content: { contains: query, mode: 'insensitive' },
      isDeleted: false,
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      sender: { select: userSelect },
    },
  });

  return messages;
}

export async function updateReadReceipt(conversationId: string, userId: string) {
  const updated = await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: { lastReadAt: new Date() },
  });

  return updated;
}

export async function getUnreadCount(userId: string) {
  const participations = await prisma.conversationParticipant.findMany({
    where: { userId },
    select: { conversationId: true, lastReadAt: true },
  });

  if (participations.length === 0) return 0;

  const counts = await Promise.all(
    participations.map((p) =>
      prisma.directMessage.count({
        where: {
          conversationId: p.conversationId,
          createdAt: { gt: p.lastReadAt },
          senderId: { not: userId },
          isDeleted: false,
        },
      }),
    ),
  );

  return counts.reduce((sum, c) => sum + c, 0);
}

export async function setReaction(messageId: string, userId: string, emoji: string) {
  const message = await prisma.directMessage.findUnique({
    where: { id: messageId },
    select: { conversationId: true },
  });

  if (!message) throw new NotFoundError('errors.chat.messageNotFound');
  await assertParticipant(message.conversationId, userId);

  // Upsert: one reaction per user per message, new emoji replaces old
  await prisma.messageReaction.upsert({
    where: { messageId_userId: { messageId, userId } },
    create: { messageId, userId, emoji },
    update: { emoji },
  });

  const reactions = await prisma.messageReaction.findMany({
    where: { messageId },
    include: { user: { select: userSelect } },
  });

  return reactions;
}

export async function removeReaction(messageId: string, userId: string) {
  await prisma.messageReaction.deleteMany({
    where: { messageId, userId },
  });

  const reactions = await prisma.messageReaction.findMany({
    where: { messageId },
    include: { user: { select: userSelect } },
  });

  return reactions;
}
