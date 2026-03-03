import prisma from '../../plugins/prisma';
import { NotFoundError, ForbiddenError } from '../../utils/errors';
import { broadcast, getPresenceUsers } from '../kanbanSSE';
import { notifyBoardUsersTiered, boardChatEmailDebounce, BOARD_CHAT_EMAIL_DEBOUNCE_MS } from './notifications';

// Re-usable select for chat message author info
const chatAuthorSelect = {
  id: true,
  name: true,
  email: true,
  color: true,
  avatarUrl: true,
} as const;

// ─── Comments ───────────────────────────────────────────────

export async function getComments(
  cardId: string,
  page: number,
  limit: number
) {
  return prisma.kanbanComment.findMany({
    where: { cardId },
    orderBy: { createdAt: 'asc' },
    skip: (page - 1) * limit,
    take: limit,
    include: {
      author: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
    },
  });
}

export async function createComment(
  cardId: string,
  authorId: string,
  content: string
) {
  const card = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: {
      title: true,
      assigneeId: true,
      column: { select: { boardId: true } },
    },
  });
  if (!card) throw new NotFoundError('Card not found');

  const comment = await prisma.kanbanComment.create({
    data: { cardId, authorId, content },
    include: {
      author: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
    },
  });

  const boardId = card.column.boardId;

  broadcast(boardId, {
    type: 'comment:added',
    boardId,
    cardId,
    comment,
  });

  // Notify ALL board participants (tiered: SSE → in-app → email)
  const commenterName = comment.author.name || comment.author.email;

  await notifyBoardUsersTiered(
    authorId,
    boardId,
    'KANBAN_COMMENT_ADDED',
    'New Comment',
    `${commenterName} commented on "${card.title}"`,
    {
      boardId,
      cardId,
      cardTitle: card.title,
      commenterName,
      localizationKey: 'notifications.kanbanCommentAdded',
      localizationArgs: { commenterName, cardTitle: card.title },
    },
    {
      type: 'KANBAN_COMMENT',
      data: (_email, locale) => ({
        authorName: commenterName,
        cardTitle: card.title,
        commentContent: content.substring(0, 200),
        boardId,
        locale,
      }),
    }
  );

  return comment;
}

export async function deleteComment(commentId: string, userId: string) {
  const comment = await prisma.kanbanComment.findUnique({
    where: { id: commentId },
    select: {
      authorId: true,
      content: true,
      card: { select: { id: true, title: true, column: { select: { boardId: true } } } },
      author: { select: { name: true, email: true } },
    },
  });
  if (!comment) throw new NotFoundError('Comment not found');
  if (comment.authorId !== userId) throw new ForbiddenError('Not your comment');

  await prisma.kanbanComment.delete({ where: { id: commentId } });

  // Broadcast deletion for real-time UI update
  const boardId = comment.card.column.boardId;
  broadcast(boardId, {
    type: 'comment:deleted',
    boardId,
    cardId: comment.card.id,
    commentId,
  });

  // Notify all board participants (tiered)
  const deleterName = comment.author.name || comment.author.email;

  await notifyBoardUsersTiered(
    userId,
    boardId,
    'KANBAN_COMMENT_DELETED',
    'Comment Deleted',
    `${deleterName} deleted a comment on "${comment.card.title}"`,
    {
      boardId,
      cardId: comment.card.id,
      cardTitle: comment.card.title,
      deleterName,
      localizationKey: 'notifications.kanbanCommentDeleted',
      localizationArgs: { deleterName, cardTitle: comment.card.title },
    },
    {
      type: 'KANBAN_COMMENT_DELETED',
      data: (_email, locale) => ({
        authorName: deleterName,
        cardTitle: comment.card.title,
        boardId,
        locale,
      }),
    }
  );
}

// ─── Board Chat ────────────────────────────────────────────────

export async function getBoardChat(
  boardId: string,
  page: number,
  limit: number
) {
  return prisma.kanbanBoardChat.findMany({
    where: { boardId },
    orderBy: { createdAt: 'asc' },
    skip: (page - 1) * limit,
    take: limit,
    include: {
      author: { select: chatAuthorSelect },
    },
  });
}

export async function createBoardChatMessage(
  boardId: string,
  authorId: string,
  content: string
) {
  const message = await prisma.kanbanBoardChat.create({
    data: { boardId, authorId, content },
    include: {
      author: { select: chatAuthorSelect },
    },
  });

  broadcast(boardId, {
    type: 'chat:message',
    boardId,
    message,
  });

  // Tiered notifications (same pattern as note chat):
  // 1. User on board (SSE) → skip (frontend handles sound/badge)
  // 2. User online in app → DB notification only
  // 3. User offline → DB notification + email (with debounce)
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: {
      title: true,
      ownerId: true,
      shares: { where: { status: 'ACCEPTED' }, select: { userId: true } },
    },
  });
  if (!board) return message;

  const recipientIds = new Set<string>();
  recipientIds.add(board.ownerId);
  for (const s of board.shares) recipientIds.add(s.userId);
  recipientIds.delete(authorId);

  // Users currently connected to this board via SSE — frontend handles their notifications
  const activeOnBoard = new Set(getPresenceUsers(boardId).map((u) => u.id));

  const authorName = message.author.name || message.author.email;

  for (const uid of recipientIds) {
    // Tier 1 & 2: User is on the board page → skip backend notification
    if (activeOnBoard.has(uid)) continue;

    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const recipient = await prisma.user.findUnique({
        where: { id: uid },
        select: { lastActiveAt: true, email: true, locale: true, emailNotificationsEnabled: true },
      });
      if (!recipient) continue;

      const isOnlineInApp = recipient.lastActiveAt && recipient.lastActiveAt > fiveMinutesAgo;

      // Always create DB notification (Tier 2 & 3)
      const { createNotification } = await import('../notification.service');
      await createNotification(
        uid,
        'KANBAN_COMMENT_ADDED',
        'Board Chat',
        `${authorName}: ${content.substring(0, 100)}`,
        {
          boardId,
          boardTitle: board.title,
          authorName,
          localizationKey: 'notifications.kanbanBoardChat',
          localizationArgs: { authorName, boardTitle: board.title },
        }
      );

      // Tier 3: Offline → also send email (debounced, respecting email preferences)
      if (!isOnlineInApp && recipient.emailNotificationsEnabled) {
        const debounceKey = `kanban:${uid}:${boardId}`;
        const lastSent = boardChatEmailDebounce.get(debounceKey) || 0;
        if (Date.now() - lastSent >= BOARD_CHAT_EMAIL_DEBOUNCE_MS) {
          try {
            const emailService = await import('../email.service');
            await emailService.sendNotificationEmail(
              recipient.email,
              'CHAT_MESSAGE',
              { noteId: boardId, noteTitle: board.title, senderName: authorName, messageContent: content, locale: recipient.locale }
            );
            boardChatEmailDebounce.set(debounceKey, Date.now());
          } catch {
            // Email send failure is non-critical
          }
        }
      }
    } catch {
      // Silently continue
    }
  }

  return message;
}
