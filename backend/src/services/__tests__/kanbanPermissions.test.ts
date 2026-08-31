import { describe, it, expect, beforeEach, vi } from 'vitest';
import prisma from '../../plugins/prisma';
import {
  assertBoardAccess,
  getColumnWithAccess,
  getCardWithAccess,
  assertBelongsToBoard,
} from '../kanbanPermissions';
import {
  makeUser,
  makeKanbanBoard,
  makeKanbanColumn,
  makeKanbanCard,
  makeSharedKanbanBoard,
} from '../../__tests__/factories';
import { NotFoundError, ForbiddenError } from '../../utils/errors';

const prismaMock = prisma as any;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const owner = makeUser();
const reader = makeUser();
const writer = makeUser();
const stranger = makeUser();

const board = makeKanbanBoard({ ownerId: owner.id });
const column = makeKanbanColumn({ boardId: board.id });
const card = makeKanbanCard({ columnId: column.id });

const readShare = makeSharedKanbanBoard({
  boardId: board.id,
  userId: reader.id,
  permission: 'READ',
  status: 'ACCEPTED',
});

const writeShare = makeSharedKanbanBoard({
  boardId: board.id,
  userId: writer.id,
  permission: 'WRITE',
  status: 'ACCEPTED',
});

// ---------------------------------------------------------------------------
// Reset all mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// assertBoardAccess
// ===========================================================================

describe('assertBoardAccess', () => {
  it('allows owner with READ permission', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ ownerId: owner.id });

    const result = await assertBoardAccess(board.id, owner.id, 'READ');
    expect(result).toEqual({ isOwner: true });
    expect(prismaMock.sharedKanbanBoard.findUnique).not.toHaveBeenCalled();
  });

  it('allows owner with WRITE permission', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ ownerId: owner.id });

    const result = await assertBoardAccess(board.id, owner.id, 'WRITE');
    expect(result).toEqual({ isOwner: true });
    expect(prismaMock.sharedKanbanBoard.findUnique).not.toHaveBeenCalled();
  });

  it('allows direct share with READ permission', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ ownerId: owner.id });
    prismaMock.sharedKanbanBoard.findUnique.mockResolvedValue({
      permission: readShare.permission,
      status: readShare.status,
    });

    const result = await assertBoardAccess(board.id, reader.id, 'READ');
    expect(result).toEqual({ isOwner: false });
  });

  it('allows direct share with WRITE permission', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ ownerId: owner.id });
    prismaMock.sharedKanbanBoard.findUnique.mockResolvedValue({
      permission: writeShare.permission,
      status: writeShare.status,
    });

    const result = await assertBoardAccess(board.id, writer.id, 'WRITE');
    expect(result).toEqual({ isOwner: false });
  });

  it('allows WRITE-shared user to READ', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ ownerId: owner.id });
    prismaMock.sharedKanbanBoard.findUnique.mockResolvedValue({
      permission: 'WRITE',
      status: 'ACCEPTED',
    });

    const result = await assertBoardAccess(board.id, writer.id, 'READ');
    expect(result).toEqual({ isOwner: false });
  });

  it('throws ForbiddenError for WRITE when user has READ-only share', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ ownerId: owner.id });
    prismaMock.sharedKanbanBoard.findUnique.mockResolvedValue({
      permission: 'READ',
      status: 'ACCEPTED',
    });

    const promise = assertBoardAccess(board.id, reader.id, 'WRITE');
    await expect(promise).rejects.toThrow(ForbiddenError);
    await expect(promise).rejects.toThrow('errors.common.writeAccessRequired');
  });

  it('throws NotFoundError when board does not exist', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue(null);

    const promise = assertBoardAccess('nonexistent-id', owner.id, 'READ');
    await expect(promise).rejects.toThrow(NotFoundError);
    await expect(promise).rejects.toThrow('errors.kanban.boardNotFound');
  });

  it('throws ForbiddenError when user has no access at all', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ ownerId: owner.id });
    prismaMock.sharedKanbanBoard.findUnique.mockResolvedValue(null);

    const promise = assertBoardAccess(board.id, stranger.id, 'READ');
    await expect(promise).rejects.toThrow(ForbiddenError);
    await expect(promise).rejects.toThrow('errors.common.accessDenied');
  });

  it('throws ForbiddenError when share exists but status is PENDING', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ ownerId: owner.id });
    prismaMock.sharedKanbanBoard.findUnique.mockResolvedValue({
      permission: 'READ',
      status: 'PENDING',
    });

    const promise = assertBoardAccess(board.id, reader.id, 'READ');
    await expect(promise).rejects.toThrow(ForbiddenError);
    await expect(promise).rejects.toThrow('errors.common.accessDenied');
  });

  it('throws ForbiddenError when share exists but status is DECLINED', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ ownerId: owner.id });
    prismaMock.sharedKanbanBoard.findUnique.mockResolvedValue({
      permission: 'WRITE',
      status: 'DECLINED',
    });

    const promise = assertBoardAccess(board.id, writer.id, 'WRITE');
    await expect(promise).rejects.toThrow(ForbiddenError);
    await expect(promise).rejects.toThrow('errors.common.accessDenied');
  });
});

// ===========================================================================
// getColumnWithAccess
// ===========================================================================

describe('getColumnWithAccess', () => {
  it('returns boardId and isOwner for accessible column', async () => {
    prismaMock.kanbanColumn.findUnique.mockResolvedValue({
      boardId: board.id,
    });
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ ownerId: owner.id });

    const result = await getColumnWithAccess(column.id, owner.id, 'WRITE');
    expect(result).toEqual({ boardId: board.id, isOwner: true });
  });

  it('returns isOwner false for shared user accessing column', async () => {
    prismaMock.kanbanColumn.findUnique.mockResolvedValue({
      boardId: board.id,
    });
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ ownerId: owner.id });
    prismaMock.sharedKanbanBoard.findUnique.mockResolvedValue({
      permission: 'READ',
      status: 'ACCEPTED',
    });

    const result = await getColumnWithAccess(column.id, reader.id, 'READ');
    expect(result).toEqual({ boardId: board.id, isOwner: false });
  });

  it('throws NotFoundError for missing column', async () => {
    prismaMock.kanbanColumn.findUnique.mockResolvedValue(null);

    const promise = getColumnWithAccess('nonexistent-col', owner.id, 'READ');
    await expect(promise).rejects.toThrow(NotFoundError);
    await expect(promise).rejects.toThrow('errors.kanban.columnNotFound');
  });
});

// ===========================================================================
// getCardWithAccess
// ===========================================================================

describe('getCardWithAccess', () => {
  it('returns boardId, columnId and isOwner for accessible card', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      columnId: column.id,
      column: { boardId: board.id },
    });
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ ownerId: owner.id });

    const result = await getCardWithAccess(card.id, owner.id, 'WRITE');
    expect(result).toEqual({
      boardId: board.id,
      columnId: column.id,
      isOwner: true,
    });
  });

  it('returns isOwner false for shared user accessing card', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      columnId: column.id,
      column: { boardId: board.id },
    });
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ ownerId: owner.id });
    prismaMock.sharedKanbanBoard.findUnique.mockResolvedValue({
      permission: 'WRITE',
      status: 'ACCEPTED',
    });

    const result = await getCardWithAccess(card.id, writer.id, 'WRITE');
    expect(result).toEqual({
      boardId: board.id,
      columnId: column.id,
      isOwner: false,
    });
  });

  it('throws NotFoundError for missing card', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue(null);

    const promise = getCardWithAccess('nonexistent-card', owner.id, 'READ');
    await expect(promise).rejects.toThrow(NotFoundError);
    await expect(promise).rejects.toThrow('errors.kanban.cardNotFound');
  });
});

// ===========================================================================
// assertBelongsToBoard
// ===========================================================================

describe('assertBelongsToBoard', () => {
  const otherBoard = makeKanbanBoard({ ownerId: stranger.id });

  it('resolves without querying anything when no ids are given', async () => {
    await expect(assertBelongsToBoard(board.id, {})).resolves.toBeUndefined();

    expect(prismaMock.kanbanColumn.count).not.toHaveBeenCalled();
    expect(prismaMock.kanbanCard.count).not.toHaveBeenCalled();
    expect(prismaMock.kanbanBoard.findUnique).not.toHaveBeenCalled();
  });

  it('resolves when every column belongs to the board', async () => {
    const colA = makeKanbanColumn({ boardId: board.id });
    const colB = makeKanbanColumn({ boardId: board.id });
    prismaMock.kanbanColumn.count.mockResolvedValue(2);

    await expect(
      assertBelongsToBoard(board.id, { columnIds: [colA.id, colB.id] })
    ).resolves.toBeUndefined();

    expect(prismaMock.kanbanColumn.count).toHaveBeenCalledWith({
      where: { boardId: board.id, id: { in: [colA.id, colB.id] } },
    });
  });

  it('throws ForbiddenError when a column belongs to another board', async () => {
    const mine = makeKanbanColumn({ boardId: board.id });
    const foreign = makeKanbanColumn({ boardId: otherBoard.id });
    prismaMock.kanbanColumn.count.mockResolvedValue(1);

    const promise = assertBelongsToBoard(board.id, { columnIds: [mine.id, foreign.id] });
    await expect(promise).rejects.toThrow(ForbiddenError);
    await expect(promise).rejects.toThrow('errors.common.accessDenied');
  });

  it('de-duplicates column ids before comparing the count', async () => {
    const colA = makeKanbanColumn({ boardId: board.id });
    prismaMock.kanbanColumn.count.mockResolvedValue(1);

    await expect(
      assertBelongsToBoard(board.id, { columnIds: [colA.id, colA.id, colA.id] })
    ).resolves.toBeUndefined();

    expect(prismaMock.kanbanColumn.count).toHaveBeenCalledWith({
      where: { boardId: board.id, id: { in: [colA.id] } },
    });
  });

  it('resolves when every card belongs to the board', async () => {
    const cardA = makeKanbanCard({ columnId: column.id });
    prismaMock.kanbanCard.count.mockResolvedValue(1);

    await expect(
      assertBelongsToBoard(board.id, { cardIds: [cardA.id] })
    ).resolves.toBeUndefined();

    expect(prismaMock.kanbanCard.count).toHaveBeenCalledWith({
      where: { column: { boardId: board.id }, id: { in: [cardA.id] } },
    });
  });

  it('throws ForbiddenError when a card belongs to another board', async () => {
    const foreign = makeKanbanCard();
    prismaMock.kanbanCard.count.mockResolvedValue(0);

    const promise = assertBelongsToBoard(board.id, { cardIds: [foreign.id] });
    await expect(promise).rejects.toThrow(ForbiddenError);
    await expect(promise).rejects.toThrow('errors.common.accessDenied');
  });

  it('resolves when the user is the board owner', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      ownerId: owner.id,
      shares: [],
    });

    await expect(
      assertBelongsToBoard(board.id, { userIds: [owner.id] })
    ).resolves.toBeUndefined();
  });

  it('resolves when the user has an ACCEPTED share', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      ownerId: owner.id,
      shares: [{ userId: writer.id }],
    });

    await expect(
      assertBelongsToBoard(board.id, { userIds: [writer.id] })
    ).resolves.toBeUndefined();

    expect(prismaMock.kanbanBoard.findUnique).toHaveBeenCalledWith({
      where: { id: board.id },
      select: {
        ownerId: true,
        shares: { where: { status: 'ACCEPTED' }, select: { userId: true } },
      },
    });
  });

  it('throws ForbiddenError for a user who is not a board participant', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      ownerId: owner.id,
      shares: [{ userId: writer.id }],
    });

    const promise = assertBelongsToBoard(board.id, { userIds: [stranger.id] });
    await expect(promise).rejects.toThrow(ForbiddenError);
    await expect(promise).rejects.toThrow('errors.common.accessDenied');
  });

  it('throws NotFoundError when the board does not exist', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue(null);

    const promise = assertBelongsToBoard('nonexistent-board', { userIds: [owner.id] });
    await expect(promise).rejects.toThrow(NotFoundError);
    await expect(promise).rejects.toThrow('errors.kanban.boardNotFound');
  });
});
