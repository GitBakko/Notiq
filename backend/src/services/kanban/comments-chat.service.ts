import prisma from '../../plugins/prisma';
import { NotFoundError, ForbiddenError } from '../../utils/errors';
import { broadcast } from '../kanbanSSE';
import { notifyBoardUsersTiered, boardChatEmailDebounce, BOARD_CHAT_EMAIL_DEBOUNCE_MS } from './notifications';
import { assertBoardAccess } from '../kanbanPermissions';

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
  // [BACKUP] 2026-09-29 — 5.4: orderBy createdAt 'asc' made page 1 the OLDEST comments:
  // past the limit (50 by default) the newest never appeared. Fetch newest-first and hand
  // them back oldest-first, as the UI renders them (same as chat.service getMessages).
  const rows = await prisma.kanbanComment.findMany({
    where: { cardId },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit,
    include: {
      author: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
    },
  });
  return rows.reverse();
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
      // board.title is needed by the notifications.kanbanCommentAdded template
      column: { select: { boardId: true, board: { select: { title: true } } } },
    },
  });
  if (!card) throw new NotFoundError('errors.kanban.cardNotFound');

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

  // Not awaited (5.5): notifications and emails must not hold the request.
  void notifyBoardUsersTiered(
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
      // Key names MUST match the {{placeholders}} in notifications.kanbanCommentAdded
      // (backend/src/utils/notificationI18n.ts + locales): authorName, cardTitle, boardTitle.
      localizationArgs: {
        authorName: commenterName,
        cardTitle: card.title,
        boardTitle: card.column.board.title,
      },
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
      // board.title is needed by the notifications.kanbanCommentDeleted template
      card: {
        select: {
          id: true,
          title: true,
          column: { select: { boardId: true, board: { select: { title: true } } } },
        },
      },
      author: { select: { name: true, email: true } },
    },
  });
  if (!comment) throw new NotFoundError('errors.kanban.commentNotFound');

  const boardId = comment.card.column.boardId;

  // The DELETE /comments/:id route carries no board id, so it cannot check
  // access itself: a revoked or demoted user must not still be able to delete
  // (and notify the whole board about) their old comments.
  await assertBoardAccess(boardId, userId, 'WRITE');

  if (comment.authorId !== userId) throw new ForbiddenError('errors.kanban.notYourComment');

  await prisma.kanbanComment.delete({ where: { id: commentId } });

  // Broadcast deletion for real-time UI update
  broadcast(boardId, {
    type: 'comment:deleted',
    boardId,
    cardId: comment.card.id,
    commentId,
  });

  // Notify all board participants (tiered)
  const deleterName = comment.author.name || comment.author.email;

  // Not awaited (5.5): notifications and emails must not hold the request.
  void notifyBoardUsersTiered(
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
      // Key names MUST match the {{placeholders}} in notifications.kanbanCommentDeleted:
      // authorName, cardTitle, boardTitle.
      localizationArgs: {
        authorName: deleterName,
        cardTitle: comment.card.title,
        boardTitle: comment.card.column.board.title,
      },
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
  // [BACKUP] 2026-09-29 — 5.4: orderBy createdAt 'asc' made page 1 the OLDEST messages:
  // past the limit (50 by default) the newest never appeared. Fetch newest-first and hand
  // them back oldest-first, as the UI renders them (same as chat.service getMessages).
  const rows = await prisma.kanbanBoardChat.findMany({
    where: { boardId },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit,
    include: {
      author: { select: chatAuthorSelect },
    },
  });
  return rows.reverse();
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

  // Tiered notifications (same pattern as note chat), via the shared helper (5.5): one
  // recipient query, emails not awaited, and the call itself not awaited either.
  // [BACKUP] 2026-09-29 — this was a private copy of the notifyBoardUsersTiered loop with a
  // findUnique per recipient and an awaited sendNotificationEmail per offline recipient.
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: { title: true },
  });
  if (!board) return message;

  const authorName = message.author.name || message.author.email;
  void notifyBoardUsersTiered(
    authorId,
    boardId,
    'KANBAN_COMMENT_ADDED',
    'Board Chat',
    `${authorName}: ${content.substring(0, 100)}`,
    {
      boardId,
      boardTitle: board.title,
      authorName,
      localizationKey: 'notifications.kanbanBoardChat',
      // notifications.kanbanBoardChat interpolates {{senderName}}, not {{authorName}}.
      localizationArgs: { senderName: authorName, boardTitle: board.title },
    },
    {
      type: 'CHAT_MESSAGE',
      data: (_email, locale) => ({ noteId: boardId, noteTitle: board.title, senderName: authorName, messageContent: content, locale }),
    },
    BOARD_CHAT_EMAIL_DEBOUNCE_MS,
    { map: boardChatEmailDebounce, key: (uid) => `kanban:${uid}:${boardId}` },
  );

  return message;
}
