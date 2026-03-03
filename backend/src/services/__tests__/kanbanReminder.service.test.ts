import { vi, describe, it, expect, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';
import {
  createRemindersForCard,
  updateRemindersForCard,
  deleteRemindersForCard,
  deleteRemindersForUserOnBoard,
  createRemindersForNewBoardUser,
  getUserKanbanReminders,
  toggleReminderDone,
} from '../kanbanReminder.service';
import { NotFoundError, ForbiddenError } from '../../utils/errors';
import {
  makeUser,
  makeKanbanBoard,
  makeKanbanCard,
  makeKanbanColumn,
  makeKanbanReminder,
} from '../../__tests__/factories';

const prismaMock = prisma as any;

const OWNER = makeUser();
const SHARED_USER = makeUser();
const BOARD = makeKanbanBoard({ ownerId: OWNER.id });
const COLUMN = makeKanbanColumn({ boardId: BOARD.id });
const DUE_DATE = new Date('2026-04-01T12:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// createRemindersForCard
// ---------------------------------------------------------------------------

describe('createRemindersForCard', () => {
  it('should create reminders for all board participants', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      ownerId: OWNER.id,
      shares: [{ userId: SHARED_USER.id }],
    });
    prismaMock.kanbanReminder.createMany.mockResolvedValue({ count: 2 });

    const card = makeKanbanCard({ columnId: COLUMN.id });
    await createRemindersForCard(card.id, BOARD.id, DUE_DATE);

    expect(prismaMock.kanbanBoard.findUnique).toHaveBeenCalledWith({
      where: { id: BOARD.id },
      select: {
        ownerId: true,
        shares: { where: { status: 'ACCEPTED' }, select: { userId: true } },
      },
    });

    expect(prismaMock.kanbanReminder.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ cardId: card.id, userId: OWNER.id, boardId: BOARD.id, dueDate: DUE_DATE }),
        expect.objectContaining({ cardId: card.id, userId: SHARED_USER.id, boardId: BOARD.id, dueDate: DUE_DATE }),
      ]),
      skipDuplicates: true,
    });
  });

  it('should set the correct dueDate on created reminders', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      ownerId: OWNER.id,
      shares: [],
    });
    prismaMock.kanbanReminder.createMany.mockResolvedValue({ count: 1 });

    const card = makeKanbanCard({ columnId: COLUMN.id });
    await createRemindersForCard(card.id, BOARD.id, DUE_DATE);

    const callData = prismaMock.kanbanReminder.createMany.mock.calls[0][0].data;
    expect(callData).toHaveLength(1);
    expect(callData[0].dueDate).toEqual(DUE_DATE);
  });

  it('should not create reminders when board has no participants', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue(null);

    const card = makeKanbanCard({ columnId: COLUMN.id });
    await createRemindersForCard(card.id, BOARD.id, DUE_DATE);

    expect(prismaMock.kanbanReminder.createMany).not.toHaveBeenCalled();
  });

  it('should deduplicate owner appearing in shares', async () => {
    // Owner also appears as a shared user — should only get one reminder
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      ownerId: OWNER.id,
      shares: [{ userId: OWNER.id }],
    });
    prismaMock.kanbanReminder.createMany.mockResolvedValue({ count: 1 });

    const card = makeKanbanCard({ columnId: COLUMN.id });
    await createRemindersForCard(card.id, BOARD.id, DUE_DATE);

    const callData = prismaMock.kanbanReminder.createMany.mock.calls[0][0].data;
    // Set deduplication means only one entry for OWNER
    expect(callData).toHaveLength(1);
    expect(callData[0].userId).toBe(OWNER.id);
  });
});

// ---------------------------------------------------------------------------
// updateRemindersForCard
// ---------------------------------------------------------------------------

describe('updateRemindersForCard', () => {
  it('should update dueDate and reset isDone for all reminders of a card', async () => {
    const newDueDate = new Date('2026-05-01T12:00:00Z');
    prismaMock.kanbanReminder.updateMany.mockResolvedValue({ count: 3 });

    const card = makeKanbanCard({ columnId: COLUMN.id });
    await updateRemindersForCard(card.id, newDueDate);

    expect(prismaMock.kanbanReminder.updateMany).toHaveBeenCalledWith({
      where: { cardId: card.id },
      data: { dueDate: newDueDate, isDone: false },
    });
  });
});

// ---------------------------------------------------------------------------
// deleteRemindersForCard
// ---------------------------------------------------------------------------

describe('deleteRemindersForCard', () => {
  it('should delete all reminders for a card', async () => {
    prismaMock.kanbanReminder.deleteMany.mockResolvedValue({ count: 2 });

    const card = makeKanbanCard({ columnId: COLUMN.id });
    await deleteRemindersForCard(card.id);

    expect(prismaMock.kanbanReminder.deleteMany).toHaveBeenCalledWith({
      where: { cardId: card.id },
    });
  });
});

// ---------------------------------------------------------------------------
// deleteRemindersForUserOnBoard
// ---------------------------------------------------------------------------

describe('deleteRemindersForUserOnBoard', () => {
  it('should delete all reminders for a specific user on a board', async () => {
    prismaMock.kanbanReminder.deleteMany.mockResolvedValue({ count: 5 });

    await deleteRemindersForUserOnBoard(SHARED_USER.id, BOARD.id);

    expect(prismaMock.kanbanReminder.deleteMany).toHaveBeenCalledWith({
      where: { userId: SHARED_USER.id, boardId: BOARD.id },
    });
  });
});

// ---------------------------------------------------------------------------
// createRemindersForNewBoardUser
// ---------------------------------------------------------------------------

describe('createRemindersForNewBoardUser', () => {
  it('should create reminders for all cards with due dates', async () => {
    const card1 = makeKanbanCard({ columnId: COLUMN.id, dueDate: DUE_DATE });
    const card2 = makeKanbanCard({ columnId: COLUMN.id, dueDate: new Date('2026-06-01T00:00:00Z') });

    prismaMock.kanbanCard.findMany.mockResolvedValue([
      { id: card1.id, dueDate: card1.dueDate },
      { id: card2.id, dueDate: card2.dueDate },
    ]);
    prismaMock.kanbanReminder.createMany.mockResolvedValue({ count: 2 });

    await createRemindersForNewBoardUser(SHARED_USER.id, BOARD.id);

    expect(prismaMock.kanbanCard.findMany).toHaveBeenCalledWith({
      where: {
        column: { boardId: BOARD.id },
        dueDate: { not: null },
      },
      select: { id: true, dueDate: true },
    });

    expect(prismaMock.kanbanReminder.createMany).toHaveBeenCalledWith({
      data: [
        { cardId: card1.id, userId: SHARED_USER.id, boardId: BOARD.id, dueDate: card1.dueDate },
        { cardId: card2.id, userId: SHARED_USER.id, boardId: BOARD.id, dueDate: card2.dueDate },
      ],
      skipDuplicates: true,
    });
  });

  it('should not create reminders when no cards have due dates', async () => {
    prismaMock.kanbanCard.findMany.mockResolvedValue([]);

    await createRemindersForNewBoardUser(SHARED_USER.id, BOARD.id);

    expect(prismaMock.kanbanReminder.createMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getUserKanbanReminders
// ---------------------------------------------------------------------------

describe('getUserKanbanReminders', () => {
  it('should return reminders with card, column, and board info', async () => {
    const reminder = makeKanbanReminder({ userId: OWNER.id, boardId: BOARD.id });
    const expected = [
      {
        id: reminder.id,
        cardId: reminder.cardId,
        boardId: reminder.boardId,
        dueDate: reminder.dueDate,
        isDone: false,
        card: {
          title: 'Deploy feature',
          column: {
            title: 'In Progress',
            board: { title: BOARD.title, avatarUrl: null },
          },
        },
      },
    ];
    prismaMock.kanbanReminder.findMany.mockResolvedValue(expected);

    const result = await getUserKanbanReminders(OWNER.id);

    expect(prismaMock.kanbanReminder.findMany).toHaveBeenCalledWith({
      where: { userId: OWNER.id },
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
                board: { select: { title: true, avatarUrl: true } },
              },
            },
          },
        },
      },
      orderBy: { dueDate: 'asc' },
    });
    expect(result).toEqual(expected);
  });

  it('should only return the requesting user\'s own reminders', async () => {
    prismaMock.kanbanReminder.findMany.mockResolvedValue([]);

    await getUserKanbanReminders(SHARED_USER.id);

    expect(prismaMock.kanbanReminder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: SHARED_USER.id },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// toggleReminderDone
// ---------------------------------------------------------------------------

describe('toggleReminderDone', () => {
  it('should mark a reminder as done', async () => {
    const reminder = makeKanbanReminder({ userId: OWNER.id });
    prismaMock.kanbanReminder.findUnique.mockResolvedValue({ userId: OWNER.id });
    prismaMock.kanbanReminder.update.mockResolvedValue({ ...reminder, isDone: true });

    await toggleReminderDone(reminder.id, OWNER.id, true);

    expect(prismaMock.kanbanReminder.findUnique).toHaveBeenCalledWith({
      where: { id: reminder.id },
      select: { userId: true },
    });
    expect(prismaMock.kanbanReminder.update).toHaveBeenCalledWith({
      where: { id: reminder.id },
      data: { isDone: true },
    });
  });

  it('should mark a reminder as not done', async () => {
    const reminder = makeKanbanReminder({ userId: OWNER.id, isDone: true });
    prismaMock.kanbanReminder.findUnique.mockResolvedValue({ userId: OWNER.id });
    prismaMock.kanbanReminder.update.mockResolvedValue({ ...reminder, isDone: false });

    await toggleReminderDone(reminder.id, OWNER.id, false);

    expect(prismaMock.kanbanReminder.update).toHaveBeenCalledWith({
      where: { id: reminder.id },
      data: { isDone: false },
    });
  });

  it('should throw NotFoundError for a missing reminder', async () => {
    prismaMock.kanbanReminder.findUnique.mockResolvedValue(null);

    await expect(toggleReminderDone('nonexistent-id', OWNER.id, true))
      .rejects.toThrow(NotFoundError);
  });

  it('should throw ForbiddenError when toggling another user\'s reminder', async () => {
    const reminder = makeKanbanReminder({ userId: OWNER.id });
    prismaMock.kanbanReminder.findUnique.mockResolvedValue({ userId: OWNER.id });

    await expect(toggleReminderDone(reminder.id, SHARED_USER.id, true))
      .rejects.toThrow(ForbiddenError);
  });
});
