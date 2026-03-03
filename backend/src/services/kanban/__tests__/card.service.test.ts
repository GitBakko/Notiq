import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock sibling services BEFORE imports ────────────────────

vi.mock('../helpers', () => ({
  logCardActivity: vi.fn().mockResolvedValue(undefined),
  cardWithAssigneeSelect: {
    id: true,
    title: true,
    description: true,
    position: true,
    columnId: true,
    assigneeId: true,
    dueDate: true,
    priority: true,
    noteId: true,
    noteLinkedById: true,
    archivedAt: true,
    taskItemId: true,
    createdAt: true,
    updatedAt: true,
    assignee: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
    note: { select: { id: true, title: true, userId: true } },
    _count: { select: { comments: true } },
  },
  transformCard: vi.fn((card: any) => {
    const { _count, ...rest } = card;
    return { ...rest, commentCount: _count?.comments ?? 0 };
  }),
}));

vi.mock('../notifications', () => ({
  notifyBoardUsers: vi.fn().mockResolvedValue(undefined),
  notifyBoardUsersTiered: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../kanbanSSE', () => ({
  broadcast: vi.fn(),
}));

vi.mock('../../kanbanReminder.service', () => ({
  createRemindersForCard: vi.fn().mockResolvedValue(undefined),
  updateRemindersForCard: vi.fn().mockResolvedValue(undefined),
  deleteRemindersForCard: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue({ id: 'notif-1' }),
}));

// ─── Imports ──────────────────────────────────────────────────

import prisma from '../../../plugins/prisma';
import {
  createCard,
  updateCard,
  moveCard,
  deleteCard,
  getCardActivities,
  archiveCompletedCards,
  getArchivedCards,
  unarchiveCard,
} from '../card.service';
import { logCardActivity, transformCard } from '../helpers';
import { broadcast } from '../../kanbanSSE';
import { notifyBoardUsers, notifyBoardUsersTiered } from '../notifications';
import {
  makeUser,
  makeKanbanBoard,
  makeKanbanColumn,
  makeKanbanCard,
  makeKanbanCardActivity,
} from '../../../__tests__/factories';
import { NotFoundError, BadRequestError } from '../../../utils/errors';

// ─── Typed prisma mock ────────────────────────────────────────

const prismaMock = prisma as any;

// Augment kanbanCard mock with aggregate (not present in global setup.ts)
if (!prismaMock.kanbanCard.aggregate) {
  prismaMock.kanbanCard.aggregate = vi.fn();
}

// ─── Reset ────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Re-create aggregate after clearAllMocks wipes it
  prismaMock.kanbanCard.aggregate = vi.fn();
});

// ═══════════════════════════════════════════════════════════════
//  createCard
// ═══════════════════════════════════════════════════════════════

describe('createCard', () => {
  const board = makeKanbanBoard();
  const column = makeKanbanColumn({ boardId: board.id });

  it('creates card in column with correct position (empty column)', async () => {
    prismaMock.kanbanColumn.findUnique.mockResolvedValue({
      boardId: board.id,
      title: column.title,
    });
    prismaMock.kanbanCard.aggregate.mockResolvedValue({ _max: { position: null } });

    const rawCard = {
      id: 'card-1',
      title: 'New Card',
      description: null,
      position: 0,
      columnId: column.id,
      assigneeId: null,
      dueDate: null,
      priority: null,
      noteId: null,
      noteLinkedById: null,
      archivedAt: null,
      taskItemId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      assignee: null,
      note: null,
      _count: { comments: 0 },
    };
    prismaMock.kanbanCard.create.mockResolvedValue(rawCard);

    const result = await createCard(column.id, 'New Card');

    expect(prismaMock.kanbanCard.create).toHaveBeenCalledWith({
      data: { columnId: column.id, title: 'New Card', description: undefined, position: 0 },
      select: expect.any(Object),
    });
    expect(result).toHaveProperty('commentCount', 0);
    expect(result).not.toHaveProperty('_count');
  });

  it('creates card at correct position when column already has cards', async () => {
    prismaMock.kanbanColumn.findUnique.mockResolvedValue({
      boardId: board.id,
      title: column.title,
    });
    prismaMock.kanbanCard.aggregate.mockResolvedValue({ _max: { position: 3 } });

    const rawCard = {
      id: 'card-2',
      title: 'Another Card',
      description: null,
      position: 4,
      columnId: column.id,
      assigneeId: null,
      dueDate: null,
      priority: null,
      noteId: null,
      noteLinkedById: null,
      archivedAt: null,
      taskItemId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      assignee: null,
      note: null,
      _count: { comments: 0 },
    };
    prismaMock.kanbanCard.create.mockResolvedValue(rawCard);

    await createCard(column.id, 'Another Card');

    expect(prismaMock.kanbanCard.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ position: 4 }),
      })
    );
  });

  it('throws NotFoundError when column does not exist', async () => {
    prismaMock.kanbanColumn.findUnique.mockResolvedValue(null);

    await expect(createCard('nonexistent', 'Card')).rejects.toThrow(NotFoundError);
  });

  it('logs CREATED activity when actorId is provided', async () => {
    const actor = makeUser();
    prismaMock.kanbanColumn.findUnique.mockResolvedValue({
      boardId: board.id,
      title: column.title,
    });
    prismaMock.kanbanCard.aggregate.mockResolvedValue({ _max: { position: null } });

    const rawCard = {
      id: 'card-3',
      title: 'Card with actor',
      position: 0,
      columnId: column.id,
      assigneeId: null,
      dueDate: null,
      priority: null,
      noteId: null,
      noteLinkedById: null,
      archivedAt: null,
      taskItemId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      assignee: null,
      note: null,
      _count: { comments: 0 },
    };
    prismaMock.kanbanCard.create.mockResolvedValue(rawCard);

    await createCard(column.id, 'Card with actor', undefined, actor.id);

    expect(logCardActivity).toHaveBeenCalledWith('card-3', actor.id, 'CREATED', {
      toColumnTitle: column.title,
    });
  });

  it('broadcasts card:created event', async () => {
    prismaMock.kanbanColumn.findUnique.mockResolvedValue({
      boardId: board.id,
      title: column.title,
    });
    prismaMock.kanbanCard.aggregate.mockResolvedValue({ _max: { position: null } });

    const rawCard = {
      id: 'card-4',
      title: 'Broadcast Card',
      position: 0,
      columnId: column.id,
      assigneeId: null,
      dueDate: null,
      priority: null,
      noteId: null,
      noteLinkedById: null,
      archivedAt: null,
      taskItemId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      assignee: null,
      note: null,
      _count: { comments: 0 },
    };
    prismaMock.kanbanCard.create.mockResolvedValue(rawCard);

    await createCard(column.id, 'Broadcast Card');

    expect(broadcast).toHaveBeenCalledWith(board.id, {
      type: 'card:created',
      boardId: board.id,
      card: rawCard,
    });
  });
});

// ═══════════════════════════════════════════════════════════════
//  updateCard
// ═══════════════════════════════════════════════════════════════

describe('updateCard', () => {
  const actor = makeUser();
  const board = makeKanbanBoard({ ownerId: actor.id });
  const column = makeKanbanColumn({ boardId: board.id });

  const currentCard = {
    assigneeId: null,
    title: 'Old Title',
    dueDate: null,
    column: { boardId: board.id },
  };

  function makeRawCardResult(overrides: Record<string, unknown> = {}) {
    return {
      id: 'card-u1',
      title: 'Old Title',
      description: null,
      position: 0,
      columnId: column.id,
      assigneeId: null,
      dueDate: null,
      priority: null,
      noteId: null,
      noteLinkedById: null,
      archivedAt: null,
      taskItemId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      assignee: null,
      note: null,
      _count: { comments: 2 },
      ...overrides,
    };
  }

  beforeEach(() => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue(currentCard);
  });

  it('updates title and description', async () => {
    const rawCard = makeRawCardResult({ title: 'New Title', description: 'Desc' });
    prismaMock.kanbanCard.update.mockResolvedValue(rawCard);

    const result = await updateCard('card-u1', { title: 'New Title', description: 'Desc' }, actor.id);

    expect(prismaMock.kanbanCard.update).toHaveBeenCalledWith({
      where: { id: 'card-u1' },
      data: { title: 'New Title', description: 'Desc' },
      select: expect.any(Object),
    });
    expect(result).toHaveProperty('commentCount', 2);
    expect(result.title).toBe('New Title');
  });

  it('throws NotFoundError when card does not exist', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue(null);

    await expect(updateCard('missing', { title: 'X' }, actor.id)).rejects.toThrow(NotFoundError);
  });

  it('assigns user and logs ASSIGNED activity', async () => {
    const assignee = makeUser();
    const rawCard = makeRawCardResult({ assigneeId: assignee.id });
    prismaMock.kanbanCard.update.mockResolvedValue(rawCard);
    prismaMock.user.findUnique.mockResolvedValue({ name: assignee.name, email: assignee.email });
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ title: board.title });

    await updateCard('card-u1', { assigneeId: assignee.id }, actor.id);

    expect(logCardActivity).toHaveBeenCalledWith('card-u1', actor.id, 'ASSIGNED', {
      metadata: { assigneeName: assignee.name },
    });
  });

  it('unassigns user and logs UNASSIGNED activity', async () => {
    const previousAssignee = makeUser();
    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      ...currentCard,
      assigneeId: previousAssignee.id,
    });
    const rawCard = makeRawCardResult({ assigneeId: null });
    prismaMock.kanbanCard.update.mockResolvedValue(rawCard);

    await updateCard('card-u1', { assigneeId: null }, actor.id);

    expect(logCardActivity).toHaveBeenCalledWith('card-u1', actor.id, 'UNASSIGNED');
  });

  it('sets due date and logs DUE_DATE_SET activity', async () => {
    const dueDate = '2026-04-01T00:00:00.000Z';
    const rawCard = makeRawCardResult({ dueDate: new Date(dueDate) });
    prismaMock.kanbanCard.update.mockResolvedValue(rawCard);

    await updateCard('card-u1', { dueDate }, actor.id);

    expect(prismaMock.kanbanCard.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dueDate: new Date(dueDate) }),
      })
    );
    expect(logCardActivity).toHaveBeenCalledWith('card-u1', actor.id, 'DUE_DATE_SET', {
      metadata: { dueDate },
    });
  });

  it('removes due date and logs DUE_DATE_REMOVED activity', async () => {
    const existingDueDate = new Date('2026-03-15');
    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      ...currentCard,
      dueDate: existingDueDate,
    });
    const rawCard = makeRawCardResult({ dueDate: null });
    prismaMock.kanbanCard.update.mockResolvedValue(rawCard);

    await updateCard('card-u1', { dueDate: null }, actor.id);

    expect(prismaMock.kanbanCard.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dueDate: null }),
      })
    );
    expect(logCardActivity).toHaveBeenCalledWith('card-u1', actor.id, 'DUE_DATE_REMOVED');
  });

  it('notifies new assignee when assignee changes', async () => {
    const assignee = makeUser();
    const rawCard = makeRawCardResult({ assigneeId: assignee.id });
    prismaMock.kanbanCard.update.mockResolvedValue(rawCard);
    prismaMock.user.findUnique.mockResolvedValue({ name: actor.name, email: actor.email });
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ title: board.title });

    await updateCard('card-u1', { assigneeId: assignee.id }, actor.id);

    expect(notifyBoardUsers).toHaveBeenCalledWith(
      actor.id,
      board.id,
      'KANBAN_CARD_ASSIGNED',
      'Card Assigned',
      expect.stringContaining('assigned you to'),
      expect.objectContaining({
        boardId: board.id,
        localizationKey: 'notifications.kanbanCardAssigned',
      }),
      assignee.id
    );
  });

  it('broadcasts card:updated event', async () => {
    const rawCard = makeRawCardResult({ title: 'Updated' });
    prismaMock.kanbanCard.update.mockResolvedValue(rawCard);

    await updateCard('card-u1', { title: 'Updated' }, actor.id);

    expect(broadcast).toHaveBeenCalledWith(board.id, expect.objectContaining({
      type: 'card:updated',
      boardId: board.id,
    }));
  });
});

// ═══════════════════════════════════════════════════════════════
//  moveCard
// ═══════════════════════════════════════════════════════════════

describe('moveCard', () => {
  const actor = makeUser();
  const board = makeKanbanBoard({ ownerId: actor.id });
  const sourceColumn = makeKanbanColumn({ boardId: board.id, title: 'To Do', isCompleted: false });
  const targetColumn = makeKanbanColumn({ boardId: board.id, title: 'Done', isCompleted: false });
  const card = makeKanbanCard({ columnId: sourceColumn.id });

  it('moves card between columns and updates positions via transaction', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      title: card.title,
      columnId: sourceColumn.id,
      position: 0,
      taskItemId: null,
      column: { boardId: board.id, title: sourceColumn.title, isCompleted: false },
    });
    prismaMock.kanbanColumn.findUnique.mockResolvedValue({
      boardId: board.id,
      title: targetColumn.title,
      position: 0,
      isCompleted: false,
    });
    // $transaction passes mock prisma as tx
    prismaMock.kanbanCard.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.kanbanCard.update.mockResolvedValue({});
    prismaMock.user.findUnique.mockResolvedValue({ name: actor.name, email: actor.email });

    await moveCard(card.id, targetColumn.id, 0, actor.id);

    // $transaction should have been called
    expect(prismaMock.$transaction).toHaveBeenCalled();
    // Broadcast card:moved event
    expect(broadcast).toHaveBeenCalledWith(board.id, {
      type: 'card:moved',
      boardId: board.id,
      cardId: card.id,
      toColumnId: targetColumn.id,
      position: 0,
    });
  });

  it('logs MOVED activity on cross-column move', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      title: card.title,
      columnId: sourceColumn.id,
      position: 0,
      taskItemId: null,
      column: { boardId: board.id, title: 'To Do', isCompleted: false },
    });
    prismaMock.kanbanColumn.findUnique.mockResolvedValue({
      boardId: board.id,
      title: 'Done',
      position: 1,
      isCompleted: false,
    });
    prismaMock.kanbanCard.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.kanbanCard.update.mockResolvedValue({});
    prismaMock.user.findUnique.mockResolvedValue({ name: actor.name, email: actor.email });

    await moveCard(card.id, targetColumn.id, 0, actor.id);

    expect(logCardActivity).toHaveBeenCalledWith(card.id, actor.id, 'MOVED', {
      fromColumnTitle: 'To Do',
      toColumnTitle: 'Done',
    });
  });

  it('throws NotFoundError when card does not exist', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue(null);

    await expect(moveCard('missing', targetColumn.id, 0)).rejects.toThrow(NotFoundError);
  });

  it('throws NotFoundError when target column does not exist', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      title: card.title,
      columnId: sourceColumn.id,
      position: 0,
      taskItemId: null,
      column: { boardId: board.id, title: sourceColumn.title, isCompleted: false },
    });
    prismaMock.kanbanColumn.findUnique.mockResolvedValue(null);

    await expect(moveCard(card.id, 'nonexistent', 0)).rejects.toThrow(NotFoundError);
  });

  it('auto-assigns card to mover on cross-column move', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      title: card.title,
      columnId: sourceColumn.id,
      position: 0,
      taskItemId: null,
      column: { boardId: board.id, title: 'To Do', isCompleted: false },
    });
    prismaMock.kanbanColumn.findUnique.mockResolvedValue({
      boardId: board.id,
      title: 'Done',
      position: 1,
      isCompleted: false,
    });
    prismaMock.kanbanCard.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.kanbanCard.update.mockResolvedValue({});
    prismaMock.user.findUnique.mockResolvedValue({ name: actor.name, email: actor.email });

    await moveCard(card.id, targetColumn.id, 0, actor.id);

    // The auto-assign call is after the transaction
    expect(prismaMock.kanbanCard.update).toHaveBeenCalledWith({
      where: { id: card.id },
      data: { assigneeId: actor.id },
    });
  });

  it('syncs linked TaskItem to checked when moved to completed column', async () => {
    const taskItemId = 'task-item-1';
    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      title: card.title,
      columnId: sourceColumn.id,
      position: 0,
      taskItemId,
      column: { boardId: board.id, title: 'To Do', isCompleted: false },
    });
    prismaMock.kanbanColumn.findUnique.mockResolvedValue({
      boardId: board.id,
      title: 'Done',
      position: 1,
      isCompleted: true,
    });
    prismaMock.kanbanCard.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.kanbanCard.update.mockResolvedValue({});
    prismaMock.taskItem.update.mockResolvedValue({});
    prismaMock.user.findUnique.mockResolvedValue({ name: actor.name, email: actor.email });
    prismaMock.kanbanReminder.updateMany.mockResolvedValue({ count: 0 });

    await moveCard(card.id, targetColumn.id, 0, actor.id);

    expect(prismaMock.taskItem.update).toHaveBeenCalledWith({
      where: { id: taskItemId },
      data: { isChecked: true, checkedByUserId: actor.id },
    });
  });

  it('notifies board users on cross-column move (tiered)', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      title: card.title,
      columnId: sourceColumn.id,
      position: 0,
      taskItemId: null,
      column: { boardId: board.id, title: 'To Do', isCompleted: false },
    });
    prismaMock.kanbanColumn.findUnique.mockResolvedValue({
      boardId: board.id,
      title: 'Done',
      position: 1,
      isCompleted: false,
    });
    prismaMock.kanbanCard.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.kanbanCard.update.mockResolvedValue({});
    prismaMock.user.findUnique.mockResolvedValue({ name: actor.name, email: actor.email });

    await moveCard(card.id, targetColumn.id, 0, actor.id);

    expect(notifyBoardUsersTiered).toHaveBeenCalledWith(
      actor.id,
      board.id,
      'KANBAN_CARD_MOVED',
      'Card Moved',
      expect.stringContaining('moved'),
      expect.objectContaining({
        boardId: board.id,
        cardId: card.id,
        localizationKey: 'notifications.kanbanCardMoved',
      }),
      expect.objectContaining({ type: 'KANBAN_CARD_MOVED' })
    );
  });
});

// ═══════════════════════════════════════════════════════════════
//  deleteCard
// ═══════════════════════════════════════════════════════════════

describe('deleteCard', () => {
  const board = makeKanbanBoard();
  const column = makeKanbanColumn({ boardId: board.id });

  it('deletes card and repositions remaining cards', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      columnId: column.id,
      position: 1,
      title: 'Card to delete',
      column: { boardId: board.id, title: column.title },
    });
    prismaMock.kanbanCard.delete.mockResolvedValue({});
    prismaMock.kanbanCard.updateMany.mockResolvedValue({ count: 2 });

    await deleteCard('card-del');

    expect(prismaMock.$transaction).toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(board.id, {
      type: 'card:deleted',
      boardId: board.id,
      cardId: 'card-del',
    });
  });

  it('throws NotFoundError when card does not exist', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue(null);

    await expect(deleteCard('missing')).rejects.toThrow(NotFoundError);
  });
});

// ═══════════════════════════════════════════════════════════════
//  getCardActivities
// ═══════════════════════════════════════════════════════════════

describe('getCardActivities', () => {
  it('returns paginated activities for a card', async () => {
    const activity1 = makeKanbanCardActivity({ cardId: 'card-a' });
    const activity2 = makeKanbanCardActivity({ cardId: 'card-a' });
    prismaMock.kanbanCardActivity.findMany.mockResolvedValue([
      { ...activity1, user: { id: 'u1', name: 'User', email: 'u@t.com', color: '#fff', avatarUrl: null } },
      { ...activity2, user: { id: 'u2', name: 'User2', email: 'u2@t.com', color: '#000', avatarUrl: null } },
    ]);

    const result = await getCardActivities('card-a', 1, 10);

    expect(prismaMock.kanbanCardActivity.findMany).toHaveBeenCalledWith({
      where: { cardId: 'card-a' },
      orderBy: { createdAt: 'desc' },
      skip: 0,
      take: 10,
      include: {
        user: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
      },
    });
    expect(result).toHaveLength(2);
  });

  it('respects page and limit parameters', async () => {
    prismaMock.kanbanCardActivity.findMany.mockResolvedValue([]);

    await getCardActivities('card-a', 3, 5);

    expect(prismaMock.kanbanCardActivity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 5 })
    );
  });
});

// ═══════════════════════════════════════════════════════════════
//  archiveCompletedCards
// ═══════════════════════════════════════════════════════════════

describe('archiveCompletedCards', () => {
  const board = makeKanbanBoard();

  it('archives cards in completed columns older than 7 days', async () => {
    prismaMock.kanbanColumn.findMany.mockResolvedValue([{ id: 'col-done' }]);
    prismaMock.kanbanCard.updateMany.mockResolvedValue({ count: 3 });

    const result = await archiveCompletedCards(board.id);

    expect(prismaMock.kanbanColumn.findMany).toHaveBeenCalledWith({
      where: { boardId: board.id, isCompleted: true },
      select: { id: true },
    });
    expect(prismaMock.kanbanCard.updateMany).toHaveBeenCalledWith({
      where: {
        columnId: { in: ['col-done'] },
        archivedAt: null,
        updatedAt: { lte: expect.any(Date) },
      },
      data: { archivedAt: expect.any(Date) },
    });
    expect(result).toBe(3);
  });

  it('returns 0 when no completed columns exist', async () => {
    prismaMock.kanbanColumn.findMany.mockResolvedValue([]);

    const result = await archiveCompletedCards(board.id);

    expect(result).toBe(0);
    expect(prismaMock.kanbanCard.updateMany).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
//  unarchiveCard
// ═══════════════════════════════════════════════════════════════

describe('unarchiveCard', () => {
  const board = makeKanbanBoard();

  it('unarchives an archived card', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      id: 'card-arch',
      archivedAt: new Date(),
      column: { boardId: board.id },
    });
    prismaMock.kanbanCard.update.mockResolvedValue({});

    const result = await unarchiveCard('card-arch');

    expect(prismaMock.kanbanCard.update).toHaveBeenCalledWith({
      where: { id: 'card-arch' },
      data: { archivedAt: null },
    });
    expect(broadcast).toHaveBeenCalledWith(board.id, {
      type: 'card:unarchived',
      boardId: board.id,
      cardId: 'card-arch',
    });
    expect(result).toEqual({ success: true });
  });

  it('throws NotFoundError when card does not exist', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue(null);

    await expect(unarchiveCard('missing')).rejects.toThrow(NotFoundError);
  });

  it('throws BadRequestError when card is not archived', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      id: 'card-not-arch',
      archivedAt: null,
      column: { boardId: board.id },
    });

    await expect(unarchiveCard('card-not-arch')).rejects.toThrow(BadRequestError);
  });
});
