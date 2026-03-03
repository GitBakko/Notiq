import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock kanbanSSE before imports
vi.mock('../../kanbanSSE', () => ({
  broadcast: vi.fn(),
}));

import prisma from '../../../plugins/prisma';
import { createColumn, updateColumn, reorderColumns, deleteColumn } from '../column.service';
import { makeKanbanColumn, makeKanbanBoard } from '../../../__tests__/factories';
import { NotFoundError, BadRequestError } from '../../../utils/errors';

// Cast for type-safe mock access
const prismaMock = prisma as any;

// The setup.ts mock already has kanbanColumn but lacks `aggregate` and `updateMany`.
// Augment here so every method we need is present.
prismaMock.kanbanColumn.aggregate = prismaMock.kanbanColumn.aggregate ?? vi.fn();
prismaMock.kanbanColumn.updateMany = prismaMock.kanbanColumn.updateMany ?? vi.fn();

beforeEach(() => {
  vi.clearAllMocks();

  // Re-attach mocks after clearAllMocks
  prismaMock.kanbanColumn.findUnique = vi.fn();
  prismaMock.kanbanColumn.findFirst = vi.fn();
  prismaMock.kanbanColumn.findMany = vi.fn();
  prismaMock.kanbanColumn.create = vi.fn();
  prismaMock.kanbanColumn.update = vi.fn();
  prismaMock.kanbanColumn.updateMany = vi.fn();
  prismaMock.kanbanColumn.delete = vi.fn();
  prismaMock.kanbanColumn.count = vi.fn();
  prismaMock.kanbanColumn.aggregate = vi.fn();

  // Ensure $transaction resolves its array of promises
  prismaMock.$transaction = vi.fn((fn: any) => {
    if (typeof fn === 'function') return fn(prismaMock);
    return Promise.all(fn);
  });
});

// ─── createColumn ──────────────────────────────────────────────

describe('createColumn', () => {
  it('creates a column with auto-incremented position when board has existing columns', async () => {
    const board = makeKanbanBoard();
    const expectedColumn = makeKanbanColumn({ boardId: board.id, position: 3 });

    prismaMock.kanbanColumn.aggregate.mockResolvedValue({ _max: { position: 2 } });
    prismaMock.kanbanColumn.create.mockResolvedValue(expectedColumn);

    const result = await createColumn(board.id, 'Done');

    expect(prismaMock.kanbanColumn.aggregate).toHaveBeenCalledWith({
      where: { boardId: board.id },
      _max: { position: true },
    });
    expect(prismaMock.kanbanColumn.create).toHaveBeenCalledWith({
      data: { boardId: board.id, title: 'Done', position: 3 },
    });
    expect(result).toEqual(expectedColumn);
  });

  it('sets position to 0 when board has no columns', async () => {
    const board = makeKanbanBoard();
    const expectedColumn = makeKanbanColumn({ boardId: board.id, position: 0 });

    prismaMock.kanbanColumn.aggregate.mockResolvedValue({ _max: { position: null } });
    prismaMock.kanbanColumn.create.mockResolvedValue(expectedColumn);

    const result = await createColumn(board.id, 'To Do');

    expect(prismaMock.kanbanColumn.create).toHaveBeenCalledWith({
      data: { boardId: board.id, title: 'To Do', position: 0 },
    });
    expect(result).toEqual(expectedColumn);
  });
});

// ─── updateColumn ──────────────────────────────────────────────

describe('updateColumn', () => {
  it('updates the column title', async () => {
    const column = makeKanbanColumn({ title: 'Old Title' });
    const updated = { ...column, title: 'New Title' };

    prismaMock.kanbanColumn.update.mockResolvedValue(updated);

    const result = await updateColumn(column.id, { title: 'New Title' });

    expect(prismaMock.kanbanColumn.update).toHaveBeenCalledWith({
      where: { id: column.id },
      data: { title: 'New Title' },
    });
    expect(result.title).toBe('New Title');
  });

  it('sets isCompleted and unsets other completed columns in the same board', async () => {
    const board = makeKanbanBoard();
    const column = makeKanbanColumn({ boardId: board.id, isCompleted: false });
    const updated = { ...column, isCompleted: true };

    prismaMock.kanbanColumn.findUnique.mockResolvedValue({ boardId: board.id });
    prismaMock.kanbanColumn.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.kanbanColumn.update.mockResolvedValue(updated);

    const result = await updateColumn(column.id, { isCompleted: true });

    // Should first unset any other completed column
    expect(prismaMock.kanbanColumn.findUnique).toHaveBeenCalledWith({
      where: { id: column.id },
      select: { boardId: true },
    });
    expect(prismaMock.kanbanColumn.updateMany).toHaveBeenCalledWith({
      where: { boardId: board.id, isCompleted: true, id: { not: column.id } },
      data: { isCompleted: false },
    });
    expect(result.isCompleted).toBe(true);
  });

  it('does not unset other columns when isCompleted is not being set to true', async () => {
    const column = makeKanbanColumn();
    const updated = { ...column, title: 'Renamed' };

    prismaMock.kanbanColumn.update.mockResolvedValue(updated);

    await updateColumn(column.id, { title: 'Renamed' });

    expect(prismaMock.kanbanColumn.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.kanbanColumn.updateMany).not.toHaveBeenCalled();
  });
});

// ─── reorderColumns ────────────────────────────────────────────

describe('reorderColumns', () => {
  it('reorders columns by updating their positions in a transaction', async () => {
    const board = makeKanbanBoard();
    const col1 = makeKanbanColumn({ boardId: board.id, position: 0 });
    const col2 = makeKanbanColumn({ boardId: board.id, position: 1 });

    const reorderItems = [
      { id: col1.id, position: 1 },
      { id: col2.id, position: 0 },
    ];

    // Each update inside $transaction returns the updated column
    prismaMock.kanbanColumn.update
      .mockResolvedValueOnce({ ...col1, position: 1 })
      .mockResolvedValueOnce({ ...col2, position: 0 });

    await reorderColumns(board.id, reorderItems);

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    // The $transaction receives an array of promises (one update per item)
    expect(prismaMock.kanbanColumn.update).toHaveBeenCalledTimes(2);
    expect(prismaMock.kanbanColumn.update).toHaveBeenCalledWith({
      where: { id: col1.id },
      data: { position: 1 },
    });
    expect(prismaMock.kanbanColumn.update).toHaveBeenCalledWith({
      where: { id: col2.id },
      data: { position: 0 },
    });
  });
});

// ─── deleteColumn ──────────────────────────────────────────────

describe('deleteColumn', () => {
  it('deletes an empty column', async () => {
    const board = makeKanbanBoard();
    const column = makeKanbanColumn({ boardId: board.id });

    prismaMock.kanbanColumn.findUnique.mockResolvedValue({
      boardId: board.id,
      _count: { cards: 0 },
    });
    prismaMock.kanbanColumn.delete.mockResolvedValue(column);

    await deleteColumn(column.id);

    expect(prismaMock.kanbanColumn.findUnique).toHaveBeenCalledWith({
      where: { id: column.id },
      select: { boardId: true, _count: { select: { cards: true } } },
    });
    expect(prismaMock.kanbanColumn.delete).toHaveBeenCalledWith({
      where: { id: column.id },
    });
  });

  it('throws BadRequestError when column has cards', async () => {
    const column = makeKanbanColumn();

    prismaMock.kanbanColumn.findUnique.mockResolvedValue({
      boardId: column.boardId,
      _count: { cards: 3 },
    });

    await expect(deleteColumn(column.id)).rejects.toThrow(BadRequestError);
    await expect(deleteColumn(column.id)).rejects.toThrow('errors.kanban.columnHasCards');
    expect(prismaMock.kanbanColumn.delete).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when column does not exist', async () => {
    prismaMock.kanbanColumn.findUnique.mockResolvedValue(null);

    await expect(deleteColumn('nonexistent-id')).rejects.toThrow(NotFoundError);
    await expect(deleteColumn('nonexistent-id')).rejects.toThrow('errors.kanban.columnNotFound');
    expect(prismaMock.kanbanColumn.delete).not.toHaveBeenCalled();
  });
});
