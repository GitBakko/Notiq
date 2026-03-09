import prisma from '../../plugins/prisma';
import logger from '../../utils/logger';
import { NotFoundError, BadRequestError } from '../../utils/errors';
import { broadcast } from '../kanbanSSE';
import { logCardActivity, cardWithAssigneeSelect, transformCard } from './helpers';
import { notifyBoardUsers, notifyBoardUsersTiered } from './notifications';

// ─── Card CRUD ──────────────────────────────────────────────

export async function createCard(
  columnId: string,
  title: string,
  description?: string,
  actorId?: string,
  id?: string
) {
  const column = await prisma.kanbanColumn.findUnique({
    where: { id: columnId },
    select: { boardId: true, title: true },
  });
  if (!column) throw new NotFoundError('errors.kanban.columnNotFound');

  const maxPos = await prisma.kanbanCard.aggregate({
    where: { columnId },
    _max: { position: true },
  });
  const position = (maxPos._max.position ?? -1) + 1;

  const card = await prisma.kanbanCard.create({
    data: { ...(id ? { id } : {}), columnId, title, description, position },
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

  return transformCard(card);
}

export async function updateCard(
  cardId: string,
  data: {
    title?: string;
    description?: string | null;
    assigneeId?: string | null;
    dueDate?: string | null;
    priority?: string | null;
    noteId?: string | null;
  },
  actorId: string
) {
  // Get current card to detect assignee changes
  const currentCard = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: { assigneeId: true, title: true, dueDate: true, column: { select: { boardId: true } } },
  });
  if (!currentCard) throw new NotFoundError('errors.kanban.cardNotFound');

  const updateData: Record<string, unknown> = {};
  if (data.title !== undefined) updateData.title = data.title;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.assigneeId !== undefined) updateData.assigneeId = data.assigneeId;
  if (data.noteId !== undefined) updateData.noteId = data.noteId;
  if (data.priority !== undefined) updateData.priority = data.priority;
  if (data.dueDate !== undefined) {
    updateData.dueDate = data.dueDate ? new Date(data.dueDate) : null;
  }

  const rawCard = await prisma.kanbanCard.update({
    where: { id: cardId },
    data: updateData,
    select: cardWithAssigneeSelect,
  });
  const card = transformCard(rawCard);

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
      await import('../kanbanReminder.service');

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
  actorId?: string,
  skipNotification: boolean = false
) {
  const card = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: {
      title: true,
      columnId: true,
      position: true,
      taskItemId: true,
      column: { select: { boardId: true, title: true, isCompleted: true } },
    },
  });
  if (!card) throw new NotFoundError('errors.kanban.cardNotFound');

  const targetColumn = await prisma.kanbanColumn.findUnique({
    where: { id: toColumnId },
    select: { boardId: true, title: true, position: true, isCompleted: true },
  });
  if (!targetColumn) throw new NotFoundError('errors.kanban.columnNotFound');

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

    // Sync linked TaskItem checked status based on isCompleted columns
    if (card.taskItemId) {
      const movedIntoCompleted = targetColumn.isCompleted && !card.column.isCompleted;
      const movedOutOfCompleted = !targetColumn.isCompleted && card.column.isCompleted;

      if (movedIntoCompleted) {
        await prisma.taskItem.update({
          where: { id: card.taskItemId },
          data: { isChecked: true, checkedByUserId: actorId },
        });
      } else if (movedOutOfCompleted) {
        await prisma.taskItem.update({
          where: { id: card.taskItemId },
          data: { isChecked: false, checkedByUserId: null },
        });
      }
    }

    // Notify all board participants about cross-column move (tiered)
    if (!skipNotification) {
      const actor = await prisma.user.findUnique({
        where: { id: actorId },
        select: { name: true, email: true },
      });
      const actorName = actor?.name || actor?.email || 'Someone';

      await notifyBoardUsersTiered(
        actorId,
        boardId,
        'KANBAN_CARD_MOVED',
        'Card Moved',
        `${actorName} moved "${card.title}" from "${card.column.title}" to "${targetColumn.title}"`,
        {
          boardId,
          cardId,
          cardTitle: card.title,
          actorName,
          fromColumn: card.column.title,
          toColumn: targetColumn.title,
          localizationKey: 'notifications.kanbanCardMoved',
          localizationArgs: {
            actorName,
            cardTitle: card.title,
            fromColumn: card.column.title,
            toColumn: targetColumn.title,
          },
        },
        {
          type: 'KANBAN_CARD_MOVED',
          data: (_email, locale) => ({
            actorName,
            cardTitle: card.title,
            fromColumn: card.column.title,
            toColumn: targetColumn.title,
            boardId,
            locale,
          }),
        }
      );
    }

    // Auto-complete reminders when card moves to a completed column
    if (targetColumn.isCompleted) {
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
  if (!card) throw new NotFoundError('errors.kanban.cardNotFound');

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

// ─── Card Archiving ────────────────────────────────────────

const ARCHIVE_AFTER_DAYS = 7;

/**
 * Lazy archive: find cards in completed columns that haven't been updated
 * in ≥7 days and set archivedAt = now().
 */
export async function archiveCompletedCards(boardId: string): Promise<number> {
  const cutoffDate = new Date(Date.now() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000);

  // Find completed columns for this board
  const completedColumns = await prisma.kanbanColumn.findMany({
    where: { boardId, isCompleted: true },
    select: { id: true },
  });

  if (completedColumns.length === 0) return 0;

  const completedColumnIds = completedColumns.map((c) => c.id);

  const result = await prisma.kanbanCard.updateMany({
    where: {
      columnId: { in: completedColumnIds },
      archivedAt: null,
      updatedAt: { lte: cutoffDate },
    },
    data: { archivedAt: new Date() },
  });

  if (result.count > 0) {
    logger.info({ boardId, count: result.count }, 'Lazy-archived completed cards');
  }

  return result.count;
}

/**
 * Get archived cards for a board.
 */
export async function getArchivedCards(boardId: string) {
  const cards = await prisma.kanbanCard.findMany({
    where: {
      column: { boardId },
      archivedAt: { not: null },
    },
    orderBy: { archivedAt: 'desc' },
    select: {
      ...cardWithAssigneeSelect,
      column: { select: { id: true, title: true } },
    },
  });

  return cards.map((card) => {
    const { _count, ...rest } = card;
    return { ...rest, commentCount: _count.comments };
  });
}

/**
 * Unarchive a card (set archivedAt = null).
 */
export async function unarchiveCard(cardId: string) {
  const card = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: { id: true, archivedAt: true, column: { select: { boardId: true } } },
  });
  if (!card) throw new NotFoundError('errors.kanban.cardNotFound');
  if (!card.archivedAt) throw new BadRequestError('errors.kanban.cardNotArchived');

  await prisma.kanbanCard.update({
    where: { id: cardId },
    data: { archivedAt: null },
  });

  broadcast(card.column.boardId, {
    type: 'card:unarchived',
    boardId: card.column.boardId,
    cardId,
  });

  return { success: true };
}

// ─── Bulk Archive (owner-only) ──────────────────────────────

/**
 * Preview which cards in completed columns are older than N days.
 * Returns card IDs + titles for frontend highlight.
 */
export async function previewBulkArchive(boardId: string, olderThanDays: number) {
  const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  const completedColumns = await prisma.kanbanColumn.findMany({
    where: { boardId, isCompleted: true },
    select: { id: true },
  });

  if (completedColumns.length === 0) return [];

  const cards = await prisma.kanbanCard.findMany({
    where: {
      columnId: { in: completedColumns.map((c) => c.id) },
      archivedAt: null,
      updatedAt: { lte: cutoffDate },
    },
    select: { id: true, title: true, updatedAt: true },
    orderBy: { updatedAt: 'asc' },
  });

  return cards;
}

/**
 * Archive cards by IDs (owner-only). Returns count of archived cards.
 */
export async function executeBulkArchive(boardId: string, cardIds: string[]) {
  if (cardIds.length === 0) return 0;

  // Only archive cards that belong to this board and are not already archived
  const result = await prisma.kanbanCard.updateMany({
    where: {
      id: { in: cardIds },
      column: { boardId },
      archivedAt: null,
    },
    data: { archivedAt: new Date() },
  });

  if (result.count > 0) {
    logger.info({ boardId, count: result.count }, 'Bulk-archived cards by owner');
  }

  return result.count;
}

// ─── Bulk Move Notify ───────────────────────────────────────

export async function bulkMoveNotify(
  boardId: string,
  moves: { cardId: string; fromColumnId: string; toColumnId: string }[],
  actorId: string,
) {
  if (moves.length === 0) return;

  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: { title: true, columns: { select: { id: true, title: true } } },
  });
  if (!board) return;

  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { name: true, email: true },
  });
  const actorName = actor?.name || actor?.email || 'Unknown';

  const columnMap = new Map(board.columns.map(c => [c.id, c.title]));

  // Group moves by fromColumn -> toColumn
  const groups = new Map<string, number>();
  for (const move of moves) {
    const from = columnMap.get(move.fromColumnId) || '?';
    const to = columnMap.get(move.toColumnId) || '?';
    const key = `${from} \u2192 ${to}`;
    groups.set(key, (groups.get(key) || 0) + 1);
  }

  const summary = Array.from(groups.entries())
    .map(([key, count]) => `${count} \u00d7 ${key}`)
    .join(', ');

  const totalCount = moves.length;

  await notifyBoardUsersTiered(
    actorId,
    boardId,
    'KANBAN_CARD_MOVED',
    'Cards Moved',
    `${actorName} moved ${totalCount} cards on ${board.title}: ${summary}`,
    {
      boardId,
      actorName,
      count: totalCount,
      summary,
      boardTitle: board.title,
      localizationKey: 'notifications.kanbanBulkMove',
      localizationArgs: {
        actorName,
        count: String(totalCount),
        boardTitle: board.title,
        summary,
      },
    },
    {
      type: 'KANBAN_CARD_MOVED',
      data: (_email: string, locale: string) => ({
        actorName,
        count: String(totalCount),
        summary,
        boardTitle: board.title,
        locale,
      }),
    }
  );
}
