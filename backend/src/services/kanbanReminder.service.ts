import prisma from '../plugins/prisma';
import logger from '../utils/logger';

/**
 * Get all board participant user IDs (owner + ACCEPTED shares).
 */
async function getBoardParticipantIds(boardId: string): Promise<string[]> {
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: {
      ownerId: true,
      shares: { where: { status: 'ACCEPTED' }, select: { userId: true } },
    },
  });
  if (!board) return [];
  const ids = new Set<string>();
  ids.add(board.ownerId);
  for (const s of board.shares) ids.add(s.userId);
  return Array.from(ids);
}

/**
 * Create reminders for ALL board users when a card's dueDate is set.
 */
export async function createRemindersForCard(
  cardId: string,
  boardId: string,
  dueDate: Date
): Promise<void> {
  const userIds = await getBoardParticipantIds(boardId);
  if (userIds.length === 0) return;

  try {
    await prisma.kanbanReminder.createMany({
      data: userIds.map((userId) => ({
        cardId,
        userId,
        boardId,
        dueDate,
      })),
      skipDuplicates: true,
    });
  } catch (err) {
    logger.warn({ err, cardId, boardId }, 'Failed to create kanban reminders');
  }
}

/**
 * Update dueDate on all reminders for a card + reset isDone.
 */
export async function updateRemindersForCard(
  cardId: string,
  newDueDate: Date
): Promise<void> {
  try {
    await prisma.kanbanReminder.updateMany({
      where: { cardId },
      data: { dueDate: newDueDate, isDone: false },
    });
  } catch (err) {
    logger.warn({ err, cardId }, 'Failed to update kanban reminders');
  }
}

/**
 * Delete all reminders for a card (when dueDate is removed).
 */
export async function deleteRemindersForCard(cardId: string): Promise<void> {
  try {
    await prisma.kanbanReminder.deleteMany({ where: { cardId } });
  } catch (err) {
    logger.warn({ err, cardId }, 'Failed to delete kanban reminders');
  }
}

/**
 * Delete all reminders for a specific user on a specific board
 * (used when user is removed from board share).
 */
export async function deleteRemindersForUserOnBoard(
  userId: string,
  boardId: string
): Promise<void> {
  try {
    await prisma.kanbanReminder.deleteMany({ where: { userId, boardId } });
  } catch (err) {
    logger.warn({ err, userId, boardId }, 'Failed to delete user kanban reminders');
  }
}

/**
 * Create catch-up reminders for a new board participant.
 * Finds all cards with dueDate in the board and creates reminders.
 */
export async function createRemindersForNewBoardUser(
  userId: string,
  boardId: string
): Promise<void> {
  try {
    const cards = await prisma.kanbanCard.findMany({
      where: {
        column: { boardId },
        dueDate: { not: null },
      },
      select: { id: true, dueDate: true },
    });

    if (cards.length === 0) return;

    await prisma.kanbanReminder.createMany({
      data: cards.map((card) => ({
        cardId: card.id,
        userId,
        boardId,
        dueDate: card.dueDate!,
      })),
      skipDuplicates: true,
    });
  } catch (err) {
    logger.warn({ err, userId, boardId }, 'Failed to create catch-up reminders');
  }
}

/**
 * Get all kanban reminders for a user (for RemindersPage API).
 */
export async function getUserKanbanReminders(userId: string) {
  return prisma.kanbanReminder.findMany({
    where: { userId },
    select: {
      id: true,
      cardId: true,
      boardId: true,
      dueDate: true,
      isDone: true,
      card: {
        select: {
          title: true,
          column: {
            select: {
              title: true,
              board: { select: { title: true } },
            },
          },
        },
      },
    },
    orderBy: { dueDate: 'asc' },
  });
}

/**
 * Toggle isDone on a specific reminder (only if owned by userId).
 */
export async function toggleReminderDone(
  reminderId: string,
  userId: string,
  isDone: boolean
): Promise<void> {
  const reminder = await prisma.kanbanReminder.findUnique({
    where: { id: reminderId },
    select: { userId: true },
  });
  if (!reminder) throw new Error('Reminder not found');
  if (reminder.userId !== userId) throw new Error('Access denied');

  await prisma.kanbanReminder.update({
    where: { id: reminderId },
    data: { isDone },
  });
}
