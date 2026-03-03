import { describe, it, expect, beforeEach, vi } from 'vitest';
import prisma from '../../plugins/prisma';
import {
  assertBoardAccess,
  getColumnWithAccess,
  getCardWithAccess,
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

    await expect(
      assertBoardAccess(board.id, reader.id, 'WRITE')
    ).rejects.toThrow(ForbiddenError);
  });

  it('throws NotFoundError when board does not exist', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue(null);

    await expect(
      assertBoardAccess('nonexistent-id', owner.id, 'READ')
    ).rejects.toThrow(NotFoundError);
  });

  it('throws ForbiddenError when user has no access at all', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ ownerId: owner.id });
    prismaMock.sharedKanbanBoard.findUnique.mockResolvedValue(null);

    await expect(
      assertBoardAccess(board.id, stranger.id, 'READ')
    ).rejects.toThrow(ForbiddenError);
  });

  it('throws ForbiddenError when share exists but status is PENDING', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ ownerId: owner.id });
    prismaMock.sharedKanbanBoard.findUnique.mockResolvedValue({
      permission: 'READ',
      status: 'PENDING',
    });

    await expect(
      assertBoardAccess(board.id, reader.id, 'READ')
    ).rejects.toThrow(ForbiddenError);
  });

  it('throws ForbiddenError when share exists but status is DECLINED', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ ownerId: owner.id });
    prismaMock.sharedKanbanBoard.findUnique.mockResolvedValue({
      permission: 'WRITE',
      status: 'DECLINED',
    });

    await expect(
      assertBoardAccess(board.id, writer.id, 'WRITE')
    ).rejects.toThrow(ForbiddenError);
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

    await expect(
      getColumnWithAccess('nonexistent-col', owner.id, 'READ')
    ).rejects.toThrow(NotFoundError);
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

    await expect(
      getCardWithAccess('nonexistent-card', owner.id, 'READ')
    ).rejects.toThrow(NotFoundError);
  });
});
