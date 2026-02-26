import { Prisma } from '@prisma/client';
import prisma from '../plugins/prisma';
import { broadcast, getPresenceUsers } from './kanbanSSE';
import logger from '../utils/logger';

// ─── Board chat email debounce (max 1 per user/board every 30 min) ──
const BOARD_CHAT_EMAIL_DEBOUNCE_MS = 30 * 60 * 1000;
const boardChatEmailDebounce = new Map<string, number>();

// ─── Notification helper ────────────────────────────────────

async function notifyBoardUsers(
  actorId: string,
  boardId: string,
  type: 'KANBAN_CARD_ASSIGNED' | 'KANBAN_COMMENT_ADDED',
  title: string,
  message: string,
  data: Record<string, unknown>,
  specificUserId?: string
): Promise<void> {
  const { createNotification } = await import('./notification.service');

  if (specificUserId && specificUserId !== actorId) {
    await createNotification(specificUserId, type, title, message, data);
    return;
  }

  // Get all board participants (owner + ACCEPTED shares) excluding actor
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: {
      ownerId: true,
      shares: { where: { status: 'ACCEPTED' }, select: { userId: true } },
    },
  });
  if (!board) return;

  const recipientIds = new Set<string>();
  recipientIds.add(board.ownerId);
  for (const s of board.shares) recipientIds.add(s.userId);
  recipientIds.delete(actorId);

  for (const uid of recipientIds) {
    try {
      await createNotification(uid, type, title, message, data);
    } catch {
      // Silently continue — push failure should not block the operation
    }
  }
}

// Re-usable select for chat message author info
const chatAuthorSelect = {
  id: true,
  name: true,
  email: true,
  color: true,
  avatarUrl: true,
} as const;

// ─── Activity logging helper ──────────────────────────────

async function logCardActivity(
  cardId: string,
  userId: string,
  action: 'CREATED' | 'MOVED' | 'UPDATED' | 'ASSIGNED' | 'UNASSIGNED' | 'DUE_DATE_SET' | 'DUE_DATE_REMOVED' | 'NOTE_LINKED' | 'NOTE_UNLINKED' | 'DELETED',
  extra?: { fromColumnTitle?: string; toColumnTitle?: string; metadata?: Record<string, unknown> }
): Promise<void> {
  try {
    await prisma.kanbanCardActivity.create({
      data: {
        cardId,
        userId,
        action,
        fromColumnTitle: extra?.fromColumnTitle ?? null,
        toColumnTitle: extra?.toColumnTitle ?? null,
        metadata: extra?.metadata ? (extra.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
    });
  } catch (err) {
    logger.warn({ err, cardId, action }, 'Failed to log card activity');
  }
}

// Re-usable select for card with assignee info
const cardWithAssigneeSelect = {
  id: true,
  title: true,
  description: true,
  position: true,
  columnId: true,
  assigneeId: true,
  dueDate: true,
  noteId: true,
  noteLinkedById: true,
  createdAt: true,
  updatedAt: true,
  assignee: { select: { id: true, name: true, email: true, color: true } },
  note: { select: { id: true, title: true, userId: true } },
  _count: { select: { comments: true } },
} as const;

// ─── Board CRUD ─────────────────────────────────────────────

export async function listBoards(userId: string) {
  const [owned, shared] = await Promise.all([
    prisma.kanbanBoard.findMany({
      where: { ownerId: userId },
      select: {
        id: true,
        title: true,
        description: true,
        coverImage: true,
        avatarUrl: true,
        ownerId: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { columns: true } },
        columns: {
          select: { _count: { select: { cards: true } } },
        },
      },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.sharedKanbanBoard.findMany({
      where: { userId, status: 'ACCEPTED' },
      select: {
        permission: true,
        board: {
          select: {
            id: true,
            title: true,
            description: true,
            coverImage: true,
            avatarUrl: true,
            ownerId: true,
            createdAt: true,
            updatedAt: true,
            owner: { select: { id: true, name: true, email: true } },
            _count: { select: { columns: true } },
            columns: {
              select: { _count: { select: { cards: true } } },
            },
          },
        },
      },
    }),
  ]);

  const ownedBoards = owned.map((b) => ({
    id: b.id,
    title: b.title,
    description: b.description,
    coverImage: b.coverImage,
    avatarUrl: b.avatarUrl,
    ownerId: b.ownerId,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    columnCount: b._count.columns,
    cardCount: b.columns.reduce((sum, col) => sum + col._count.cards, 0),
    ownership: 'owned' as const,
  }));

  const sharedBoards = shared.map((s) => ({
    id: s.board.id,
    title: s.board.title,
    description: s.board.description,
    coverImage: s.board.coverImage,
    avatarUrl: s.board.avatarUrl,
    ownerId: s.board.ownerId,
    owner: s.board.owner,
    createdAt: s.board.createdAt,
    updatedAt: s.board.updatedAt,
    columnCount: s.board._count.columns,
    cardCount: s.board.columns.reduce((sum, col) => sum + col._count.cards, 0),
    ownership: 'shared' as const,
    permission: s.permission,
  }));

  return [...ownedBoards, ...sharedBoards];
}

export async function createBoard(
  userId: string,
  title: string,
  description?: string
) {
  return prisma.$transaction(async (tx) => {
    const board = await tx.kanbanBoard.create({
      data: {
        title,
        description,
        ownerId: userId,
        columns: {
          create: [
            { title: 'TODO', position: 0 },
            { title: 'IN_PROGRESS', position: 1 },
            { title: 'DONE', position: 2 },
          ],
        },
      },
      include: {
        columns: { orderBy: { position: 'asc' } },
      },
    });
    return board;
  });
}

export async function getBoard(boardId: string, requestingUserId?: string) {
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    include: {
      columns: {
        orderBy: { position: 'asc' },
        include: {
          cards: {
            orderBy: { position: 'asc' },
            select: cardWithAssigneeSelect,
          },
        },
      },
      shares: {
        include: {
          user: { select: { id: true, name: true, email: true, color: true } },
        },
      },
      owner: { select: { id: true, name: true, email: true, color: true } },
      note: { select: { id: true, title: true, userId: true } },
    },
  });
  if (!board) throw new Error('Board not found');

  // Filter note visibility: only show linked note data if requesting user has access
  if (requestingUserId) {
    // Collect all noteIds from cards AND the board itself
    const noteIds = board.columns
      .flatMap((col) => col.cards)
      .map((c) => c.noteId)
      .filter((id): id is string => !!id);

    if (board.noteId) noteIds.push(board.noteId);

    if (noteIds.length > 0) {
      const uniqueNoteIds = [...new Set(noteIds)];

      // Get notes the user can see (owned or shared-ACCEPTED)
      const accessibleShares = await prisma.sharedNote.findMany({
        where: { noteId: { in: uniqueNoteIds }, userId: requestingUserId, status: 'ACCEPTED' },
        select: { noteId: true },
      });
      const accessibleNoteIds = new Set(accessibleShares.map((s) => s.noteId));

      // Also add notes owned by the requesting user
      const ownedNotes = await prisma.note.findMany({
        where: { id: { in: uniqueNoteIds }, userId: requestingUserId },
        select: { id: true },
      });
      for (const n of ownedNotes) accessibleNoteIds.add(n.id);

      // Null out note data for cards the user can't access
      for (const col of board.columns) {
        for (const card of col.cards) {
          if (card.noteId && !accessibleNoteIds.has(card.noteId)) {
            (card as Record<string, unknown>).note = null;
          }
        }
      }

      // Null out board-level note if user can't access it
      if (board.noteId && !accessibleNoteIds.has(board.noteId)) {
        (board as Record<string, unknown>).note = null;
      }
    }
  }

  return board;
}

export async function updateBoard(
  boardId: string,
  data: { title?: string; description?: string | null }
) {
  return prisma.kanbanBoard.update({
    where: { id: boardId },
    data,
  });
}

export async function deleteBoard(boardId: string) {
  return prisma.kanbanBoard.delete({ where: { id: boardId } });
}

// ─── Column CRUD ────────────────────────────────────────────

export async function createColumn(boardId: string, title: string) {
  const maxPos = await prisma.kanbanColumn.aggregate({
    where: { boardId },
    _max: { position: true },
  });
  const position = (maxPos._max.position ?? -1) + 1;

  const column = await prisma.kanbanColumn.create({
    data: { boardId, title, position },
  });

  broadcast(boardId, { type: 'column:created', boardId, column });
  return column;
}

export async function updateColumn(columnId: string, title: string) {
  const column = await prisma.kanbanColumn.update({
    where: { id: columnId },
    data: { title },
  });

  broadcast(column.boardId, {
    type: 'column:updated',
    boardId: column.boardId,
    column,
  });
  return column;
}

export async function reorderColumns(
  boardId: string,
  items: { id: string; position: number }[]
) {
  await prisma.$transaction(
    items.map((item) =>
      prisma.kanbanColumn.update({
        where: { id: item.id },
        data: { position: item.position },
      })
    )
  );

  broadcast(boardId, { type: 'columns:reordered', boardId, columns: items });
}

export async function deleteColumn(columnId: string) {
  const column = await prisma.kanbanColumn.findUnique({
    where: { id: columnId },
    select: { boardId: true, _count: { select: { cards: true } } },
  });
  if (!column) throw new Error('Column not found');
  if (column._count.cards > 0) throw new Error('Column has cards');

  await prisma.kanbanColumn.delete({ where: { id: columnId } });

  broadcast(column.boardId, {
    type: 'column:deleted',
    boardId: column.boardId,
    columnId,
  });
}

// ─── Card CRUD ──────────────────────────────────────────────

export async function createCard(
  columnId: string,
  title: string,
  description?: string,
  actorId?: string
) {
  const column = await prisma.kanbanColumn.findUnique({
    where: { id: columnId },
    select: { boardId: true, title: true },
  });
  if (!column) throw new Error('Column not found');

  const maxPos = await prisma.kanbanCard.aggregate({
    where: { columnId },
    _max: { position: true },
  });
  const position = (maxPos._max.position ?? -1) + 1;

  const card = await prisma.kanbanCard.create({
    data: { columnId, title, description, position },
    select: cardWithAssigneeSelect,
  });

  broadcast(column.boardId, {
    type: 'card:created',
    boardId: column.boardId,
    card,
  });

  if (actorId) {
    await logCardActivity(card.id, actorId, 'CREATED', { toColumnTitle: column.title });
  }

  return card;
}

export async function updateCard(
  cardId: string,
  data: {
    title?: string;
    description?: string | null;
    assigneeId?: string | null;
    dueDate?: string | null;
    noteId?: string | null;
  },
  actorId: string
) {
  // Get current card to detect assignee changes
  const currentCard = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: { assigneeId: true, title: true, dueDate: true, column: { select: { boardId: true } } },
  });
  if (!currentCard) throw new Error('Card not found');

  const updateData: Record<string, unknown> = {};
  if (data.title !== undefined) updateData.title = data.title;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.assigneeId !== undefined) updateData.assigneeId = data.assigneeId;
  if (data.noteId !== undefined) updateData.noteId = data.noteId;
  if (data.dueDate !== undefined) {
    updateData.dueDate = data.dueDate ? new Date(data.dueDate) : null;
  }

  const card = await prisma.kanbanCard.update({
    where: { id: cardId },
    data: updateData,
    select: cardWithAssigneeSelect,
  });

  const boardId = currentCard.column.boardId;

  broadcast(boardId, { type: 'card:updated', boardId, card });

  // Log activity for specific field changes
  if (data.assigneeId !== undefined) {
    if (data.assigneeId !== null && data.assigneeId !== currentCard.assigneeId) {
      const assignee = await prisma.user.findUnique({ where: { id: data.assigneeId }, select: { name: true, email: true } });
      await logCardActivity(cardId, actorId, 'ASSIGNED', {
        metadata: { assigneeName: assignee?.name || assignee?.email },
      });
    } else if (data.assigneeId === null && currentCard.assigneeId) {
      await logCardActivity(cardId, actorId, 'UNASSIGNED');
    }
  }
  if (data.dueDate !== undefined) {
    if (data.dueDate !== null) {
      await logCardActivity(cardId, actorId, 'DUE_DATE_SET', {
        metadata: { dueDate: data.dueDate },
      });
    } else if (currentCard.dueDate) {
      await logCardActivity(cardId, actorId, 'DUE_DATE_REMOVED');
    }
  }

  // Manage kanban reminders based on dueDate changes
  if (data.dueDate !== undefined) {
    const { createRemindersForCard, updateRemindersForCard, deleteRemindersForCard } =
      await import('./kanbanReminder.service');

    if (data.dueDate !== null && !currentCard.dueDate) {
      // dueDate SET for the first time: create reminders for all board users
      await createRemindersForCard(cardId, boardId, new Date(data.dueDate));
    } else if (data.dueDate !== null && currentCard.dueDate) {
      // dueDate CHANGED: update all existing reminders
      await updateRemindersForCard(cardId, new Date(data.dueDate));
    } else if (data.dueDate === null && currentCard.dueDate) {
      // dueDate REMOVED: delete all reminders for this card
      await deleteRemindersForCard(cardId);
    }
  }

  if (data.title !== undefined && data.title !== currentCard.title) {
    await logCardActivity(cardId, actorId, 'UPDATED', {
      metadata: { field: 'title', oldValue: currentCard.title, newValue: data.title },
    });
  }
  if (data.description !== undefined) {
    await logCardActivity(cardId, actorId, 'UPDATED', {
      metadata: { field: 'description' },
    });
  }

  // Notify new assignee if assignee changed to a non-null value
  if (
    data.assigneeId !== undefined &&
    data.assigneeId !== null &&
    data.assigneeId !== currentCard.assigneeId
  ) {
    const actor = await prisma.user.findUnique({
      where: { id: actorId },
      select: { name: true, email: true },
    });
    const board = await prisma.kanbanBoard.findUnique({
      where: { id: boardId },
      select: { title: true },
    });
    const assignerName = actor?.name || actor?.email || 'Someone';
    const cardTitle = data.title ?? currentCard.title;
    const boardTitle = board?.title || '';

    await notifyBoardUsers(
      actorId,
      boardId,
      'KANBAN_CARD_ASSIGNED',
      'Card Assigned',
      `${assignerName} assigned you to "${cardTitle}"`,
      {
        boardId,
        boardTitle,
        cardTitle,
        assignerName,
        localizationKey: 'notifications.kanbanCardAssigned',
        localizationArgs: { assignerName, cardTitle, boardTitle },
      },
      data.assigneeId
    );
  }

  return card;
}

export async function moveCard(
  cardId: string,
  toColumnId: string,
  newPosition: number,
  actorId?: string
) {
  const card = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: { columnId: true, position: true, column: { select: { boardId: true, title: true } } },
  });
  if (!card) throw new Error('Card not found');

  const targetColumn = await prisma.kanbanColumn.findUnique({
    where: { id: toColumnId },
    select: { boardId: true, title: true, position: true },
  });
  if (!targetColumn) throw new Error('Column not found');

  const boardId = card.column.boardId;

  await prisma.$transaction(async (tx) => {
    // Shift cards in target column to make room
    await tx.kanbanCard.updateMany({
      where: { columnId: toColumnId, position: { gte: newPosition } },
      data: { position: { increment: 1 } },
    });

    // Move the card
    await tx.kanbanCard.update({
      where: { id: cardId },
      data: { columnId: toColumnId, position: newPosition },
    });

    // If moving within the same column, close the gap at the old position
    if (card.columnId === toColumnId) {
      await tx.kanbanCard.updateMany({
        where: {
          columnId: card.columnId,
          position: { gt: card.position },
          id: { not: cardId },
        },
        data: { position: { decrement: 1 } },
      });
    } else {
      // Close gap in source column
      await tx.kanbanCard.updateMany({
        where: { columnId: card.columnId, position: { gt: card.position } },
        data: { position: { decrement: 1 } },
      });
    }
  });

  broadcast(boardId, {
    type: 'card:moved',
    boardId,
    cardId,
    toColumnId,
    position: newPosition,
  });

  // Cross-column move: log activity + auto-assign card to the mover
  if (actorId && card.columnId !== toColumnId) {
    await prisma.kanbanCard.update({
      where: { id: cardId },
      data: { assigneeId: actorId },
    });

    await logCardActivity(cardId, actorId, 'MOVED', {
      fromColumnTitle: card.column.title,
      toColumnTitle: targetColumn.title,
    });

    // Auto-complete reminders when card moves to the last column (done)
    const maxPositionCol = await prisma.kanbanColumn.findFirst({
      where: { boardId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    if (maxPositionCol && targetColumn.position === maxPositionCol.position) {
      await prisma.kanbanReminder.updateMany({
        where: { cardId, isDone: false },
        data: { isDone: true },
      });
    }
  }
}

export async function deleteCard(cardId: string, actorId?: string) {
  const card = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: { columnId: true, position: true, title: true, column: { select: { boardId: true, title: true } } },
  });
  if (!card) throw new Error('Card not found');

  const boardId = card.column.boardId;

  // Log activity before deletion (activity will cascade-delete with card)
  // Instead, we don't log DELETED since the card (and its activities) are removed.
  // If we want to keep history after deletion, we'd need a board-level log.
  // For now, activities are tied to the card lifecycle.

  await prisma.$transaction(async (tx) => {
    await tx.kanbanCard.delete({ where: { id: cardId } });

    // Reposition remaining cards in the column
    await tx.kanbanCard.updateMany({
      where: { columnId: card.columnId, position: { gt: card.position } },
      data: { position: { decrement: 1 } },
    });
  });

  broadcast(boardId, { type: 'card:deleted', boardId, cardId });
}

// ─── Card Activities ────────────────────────────────────────

export async function getCardActivities(cardId: string, page: number, limit: number) {
  return prisma.kanbanCardActivity.findMany({
    where: { cardId },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit,
    include: {
      user: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
    },
  });
}

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
      author: { select: { id: true, name: true, email: true, color: true } },
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
  if (!card) throw new Error('Card not found');

  const comment = await prisma.kanbanComment.create({
    data: { cardId, authorId, content },
    include: {
      author: { select: { id: true, name: true, email: true, color: true } },
    },
  });

  const boardId = card.column.boardId;

  broadcast(boardId, {
    type: 'comment:added',
    boardId,
    cardId,
    comment,
  });

  // Notify card assignee if different from the comment author
  if (card.assigneeId && card.assigneeId !== authorId) {
    const board = await prisma.kanbanBoard.findUnique({
      where: { id: boardId },
      select: { title: true },
    });
    const commenterName = comment.author.name || comment.author.email;
    const boardTitle = board?.title || '';

    await notifyBoardUsers(
      authorId,
      boardId,
      'KANBAN_COMMENT_ADDED',
      'New Comment',
      `${commenterName} commented on "${card.title}"`,
      {
        boardId,
        boardTitle,
        cardId,
        cardTitle: card.title,
        commenterName,
        localizationKey: 'notifications.kanbanCommentAdded',
        localizationArgs: { commenterName, cardTitle: card.title, boardTitle },
      },
      card.assigneeId
    );
  }

  return comment;
}

export async function deleteComment(commentId: string, userId: string) {
  const comment = await prisma.kanbanComment.findUnique({
    where: { id: commentId },
    select: { authorId: true },
  });
  if (!comment) throw new Error('Comment not found');
  if (comment.authorId !== userId) throw new Error('Not your comment');

  await prisma.kanbanComment.delete({ where: { id: commentId } });
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
        select: { lastActiveAt: true, email: true, locale: true },
      });
      if (!recipient) continue;

      const isOnlineInApp = recipient.lastActiveAt && recipient.lastActiveAt > fiveMinutesAgo;

      // Tier 3: Online in app but not on board → DB notification
      if (isOnlineInApp) {
        const { createNotification } = await import('./notification.service');
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
      } else {
        // Tier 4: Offline → DB notification + email (debounced)
        const { createNotification } = await import('./notification.service');
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

        // Email with debounce (max 1 per user/board every 30 min)
        const debounceKey = `kanban:${uid}:${boardId}`;
        const lastSent = boardChatEmailDebounce.get(debounceKey) || 0;
        if (Date.now() - lastSent >= BOARD_CHAT_EMAIL_DEBOUNCE_MS) {
          try {
            const emailService = await import('./email.service');
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

// ─── Create Board from Task List ────────────────────────────

export async function createBoardFromTaskList(userId: string, taskListId: string) {
  // Fetch the task list with items
  const taskList = await prisma.taskList.findUnique({
    where: { id: taskListId },
    include: {
      items: { orderBy: { position: 'asc' } },
    },
  });

  if (!taskList) throw new Error('TaskList not found');

  // Only the owner can convert
  if (taskList.userId !== userId) {
    // Check if user has shared access
    const shared = await prisma.sharedTaskList.findUnique({
      where: { taskListId_userId: { taskListId, userId } },
      select: { status: true, permission: true },
    });
    if (!shared || shared.status !== 'ACCEPTED' || shared.permission !== 'WRITE') {
      throw new Error('Access denied');
    }
  }

  return prisma.$transaction(async (tx) => {
    // Create board with two columns
    const board = await tx.kanbanBoard.create({
      data: {
        title: taskList.title,
        ownerId: userId,
        columns: {
          create: [
            { title: 'Da fare', position: 0 },
            { title: 'Completato', position: 1 },
          ],
        },
      },
      include: {
        columns: { orderBy: { position: 'asc' } },
      },
    });

    const todoColumnId = board.columns[0].id;
    const doneColumnId = board.columns[1].id;

    // Separate items by checked status
    const uncheckedItems = taskList.items.filter((i) => !i.isChecked);
    const checkedItems = taskList.items.filter((i) => i.isChecked);

    // Create cards for unchecked items → "Da fare" column
    for (let i = 0; i < uncheckedItems.length; i++) {
      const item = uncheckedItems[i];
      await tx.kanbanCard.create({
        data: {
          columnId: todoColumnId,
          title: item.text,
          position: i,
          dueDate: item.dueDate,
        },
      });
    }

    // Create cards for checked items → "Completato" column
    // Assign the card to whoever checked the task item
    for (let i = 0; i < checkedItems.length; i++) {
      const item = checkedItems[i];
      await tx.kanbanCard.create({
        data: {
          columnId: doneColumnId,
          title: item.text,
          position: i,
          dueDate: item.dueDate,
          assigneeId: item.checkedByUserId,
        },
      });
    }

    return board;
  });
}

// ─── Note Linking ──────────────────────────────────────────

/**
 * Check which board participants have/don't have access to the given note.
 */
export async function checkNoteSharingForBoard(
  noteId: string,
  boardId: string,
  requestingUserId: string
) {
  // Get note owner
  const note = await prisma.note.findUnique({
    where: { id: noteId },
    select: { id: true, title: true, userId: true },
  });
  if (!note) throw new Error('Note not found');

  // Get board owner + accepted shares
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: {
      ownerId: true,
      owner: { select: { id: true, name: true, email: true } },
      shares: {
        where: { status: 'ACCEPTED' },
        select: { user: { select: { id: true, name: true, email: true } } },
      },
    },
  });
  if (!board) throw new Error('Board not found');

  // All board participants (owner + accepted shares)
  const boardParticipants = [
    board.owner,
    ...board.shares.map((s) => s.user),
  ];

  // Get existing note shares (ACCEPTED)
  const noteShares = await prisma.sharedNote.findMany({
    where: { noteId, status: 'ACCEPTED' },
    select: { userId: true },
  });
  const noteAccessUserIds = new Set([note.userId, ...noteShares.map((s) => s.userId)]);

  const usersWithAccess = boardParticipants.filter((u) => noteAccessUserIds.has(u.id));
  const usersWithoutAccess = boardParticipants.filter(
    (u) => !noteAccessUserIds.has(u.id) && u.id !== requestingUserId
  );

  return {
    noteTitle: note.title,
    noteOwnerId: note.userId,
    alreadyFullyShared: usersWithoutAccess.length === 0,
    usersWithAccess,
    usersWithoutAccess,
  };
}

/**
 * Link a note to a card. Optionally auto-share with specified users.
 */
export async function linkNoteToCard(
  cardId: string,
  noteId: string,
  actorId: string,
  shareWithUserIds?: string[]
) {
  const card = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: { noteId: true, column: { select: { boardId: true, board: { select: { title: true } } } } },
  });
  if (!card) throw new Error('Card not found');
  if (card.noteId) throw new Error('Card already has a linked note');

  const note = await prisma.note.findUnique({
    where: { id: noteId },
    select: { id: true, title: true, userId: true },
  });
  if (!note) throw new Error('Note not found');

  // Only the note owner can link their note
  if (note.userId !== actorId) throw new Error('Only the note owner can link this note');

  await prisma.kanbanCard.update({
    where: { id: cardId },
    data: { noteId, noteLinkedById: actorId },
  });

  const boardId = card.column.boardId;

  // Auto-share with selected users
  if (shareWithUserIds && shareWithUserIds.length > 0) {
    const { autoShareNoteForBoard } = await import('./sharing.service');
    await autoShareNoteForBoard(
      actorId,
      noteId,
      shareWithUserIds,
      'READ',
      card.column.board.title
    );
  }

  // Log activity
  await logCardActivity(cardId, actorId, 'NOTE_LINKED', {
    metadata: { noteId, noteTitle: note.title },
  });

  // Broadcast update
  const updatedCard = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: cardWithAssigneeSelect,
  });
  if (updatedCard) {
    broadcast(boardId, { type: 'card:updated', boardId, card: updatedCard });
  }

  return updatedCard;
}

/**
 * Unlink a note from a card. Only the user who linked it can unlink.
 */
export async function unlinkNoteFromCard(cardId: string, actorId: string) {
  const card = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: {
      noteId: true,
      noteLinkedById: true,
      note: { select: { title: true } },
      column: { select: { boardId: true } },
    },
  });
  if (!card) throw new Error('Card not found');
  if (!card.noteId) throw new Error('Card has no linked note');
  if (card.noteLinkedById !== actorId) throw new Error('Only the user who linked the note can unlink it');

  const noteTitle = card.note?.title || '';

  await prisma.kanbanCard.update({
    where: { id: cardId },
    data: { noteId: null, noteLinkedById: null },
  });

  const boardId = card.column.boardId;

  await logCardActivity(cardId, actorId, 'NOTE_UNLINKED', {
    metadata: { noteTitle },
  });

  const updatedCard = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: cardWithAssigneeSelect,
  });
  if (updatedCard) {
    broadcast(boardId, { type: 'card:updated', boardId, card: updatedCard });
  }

  return updatedCard;
}

/**
 * Link a note to a board. Optionally auto-share with specified users.
 */
export async function linkNoteToBoard(
  boardId: string,
  noteId: string,
  actorId: string,
  shareWithUserIds?: string[]
) {
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: { noteId: true, title: true },
  });
  if (!board) throw new Error('Board not found');
  if (board.noteId) throw new Error('Board already has a linked note');

  const note = await prisma.note.findUnique({
    where: { id: noteId },
    select: { id: true, title: true, userId: true },
  });
  if (!note) throw new Error('Note not found');

  // Only the note owner can link their note
  if (note.userId !== actorId) throw new Error('Only the note owner can link this note');

  const updatedBoard = await prisma.kanbanBoard.update({
    where: { id: boardId },
    data: { noteId, noteLinkedById: actorId },
    select: {
      noteId: true,
      noteLinkedById: true,
      note: { select: { id: true, title: true, userId: true } },
    },
  });

  // Auto-share with selected users
  if (shareWithUserIds && shareWithUserIds.length > 0) {
    const { autoShareNoteForBoard } = await import('./sharing.service');
    await autoShareNoteForBoard(actorId, noteId, shareWithUserIds, 'READ', board.title);
  }

  broadcast(boardId, { type: 'board:updated', boardId });

  return updatedBoard;
}

/**
 * Unlink a note from a board. Only the user who linked it can unlink.
 */
export async function unlinkNoteFromBoard(boardId: string, actorId: string) {
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: { noteId: true, noteLinkedById: true },
  });
  if (!board) throw new Error('Board not found');
  if (!board.noteId) throw new Error('Board has no linked note');
  if (board.noteLinkedById !== actorId) throw new Error('Only the user who linked the note can unlink it');

  await prisma.kanbanBoard.update({
    where: { id: boardId },
    data: { noteId: null, noteLinkedById: null },
  });

  broadcast(boardId, { type: 'board:updated', boardId });

  return { success: true };
}

/**
 * Search notes that belong to the user (owned) for the note picker.
 */
export async function searchUserNotes(
  userId: string,
  query: string,
  limit: number = 20
) {
  const where: Prisma.NoteWhereInput = {
    userId,
    isVault: false, // Don't allow linking vault notes
  };

  if (query.trim()) {
    where.OR = [
      { title: { contains: query, mode: 'insensitive' } },
      { searchText: { contains: query, mode: 'insensitive' } },
    ];
  }

  return prisma.note.findMany({
    where,
    select: {
      id: true,
      title: true,
      notebookId: true,
      notebook: { select: { id: true, name: true } },
      updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
}

/**
 * Get kanban boards linked to the given note (via cards or directly),
 * accessible to the requesting user.
 */
export async function getLinkedBoardsForNote(noteId: string, userId: string) {
  const boardSelect = {
    id: true,
    title: true,
    avatarUrl: true,
    ownerId: true,
    shares: {
      where: { userId, status: 'ACCEPTED' as const },
      select: { id: true },
    },
  };

  // Find cards and boards that reference this note in parallel
  const [cards, directBoards] = await Promise.all([
    prisma.kanbanCard.findMany({
      where: { noteId },
      select: {
        id: true,
        title: true,
        column: { select: { board: { select: boardSelect } } },
      },
    }),
    prisma.kanbanBoard.findMany({
      where: { noteId },
      select: boardSelect,
    }),
  ]);

  type LinkedBoardEntry = {
    boardId: string;
    boardTitle: string;
    boardAvatarUrl: string | null;
    linkedAs: 'board' | 'card';
    cardIds: string[];
    cardTitles: string[];
  };

  const results = new Map<string, LinkedBoardEntry>();

  // Process card-level links (grouped by board)
  for (const card of cards) {
    const board = card.column.board;
    const hasAccess = board.ownerId === userId || board.shares.length > 0;
    if (!hasAccess) continue;

    const existing = results.get(board.id);
    if (existing && existing.linkedAs === 'card') {
      existing.cardIds.push(card.id);
      existing.cardTitles.push(card.title);
    } else if (!results.has(board.id)) {
      results.set(board.id, {
        boardId: board.id,
        boardTitle: board.title,
        boardAvatarUrl: board.avatarUrl,
        linkedAs: 'card',
        cardIds: [card.id],
        cardTitles: [card.title],
      });
    }
  }

  // Process board-level links
  for (const board of directBoards) {
    const hasAccess = board.ownerId === userId || board.shares.length > 0;
    if (!hasAccess) continue;

    // If already in results from a card link, add a separate board entry
    const key = `board:${board.id}`;
    results.set(key, {
      boardId: board.id,
      boardTitle: board.title,
      boardAvatarUrl: board.avatarUrl,
      linkedAs: 'board',
      cardIds: [],
      cardTitles: [],
    });
  }

  return Array.from(results.values());
}
