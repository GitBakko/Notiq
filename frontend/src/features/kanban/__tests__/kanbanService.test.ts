import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks (Dexie db + authStore + api), mirroring syncService.test.ts
// ---------------------------------------------------------------------------

const { mockDb, mockAuthStore } = vi.hoisted(() => {
  const createTable = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Vitest mock table
    const table: Record<string, any> = {
      get: vi.fn().mockResolvedValue(null),
      add: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(1),
    };
    return table;
  };

  const mockDb = {
    kanbanBoards: createTable(),
    kanbanColumns: createTable(),
    kanbanCards: createTable(),
    syncQueue: createTable(),
    // db.transaction('rw', ...tables, async () => {...}) — callback is the last arg
    transaction: vi.fn(async (...args: unknown[]) => {
      const fn = args[args.length - 1];
      if (typeof fn === 'function') return (fn as () => unknown)();
    }),
  };

  const mockAuthStore = { getState: vi.fn(() => ({ user: { id: 'user-1' } })) };

  return { mockDb, mockAuthStore };
});

vi.mock('../../../lib/db', () => ({ db: mockDb }));
vi.mock('../../../lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('../../../store/authStore', () => ({ useAuthStore: mockAuthStore }));

import { deleteCard } from '../kanbanService';

describe('kanbanService.deleteCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.kanbanCards.get.mockResolvedValue(null);
    mockDb.kanbanBoards.get.mockResolvedValue(null);
  });

  it('enqueues a server DELETE even when the card is not in the local Dexie cache', async () => {
    // The board detail view renders cards from the server query, which can be
    // out of sync with Dexie (hydration is best-effort). A displayed card may
    // not exist locally — delete must still issue the server DELETE.
    mockDb.kanbanCards.get.mockResolvedValue(undefined);

    await deleteCard('card-x');

    expect(mockDb.syncQueue.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'DELETE',
        entity: 'KANBAN_CARD',
        entityId: 'card-x',
      }),
    );
  });

  it('deletes locally, decrements board count, and enqueues DELETE when the card IS in Dexie', async () => {
    mockDb.kanbanCards.get.mockResolvedValue({ id: 'card-x', columnId: 'col-1', boardId: 'board-1' });
    mockDb.kanbanBoards.get.mockResolvedValue({ id: 'board-1', cardCount: 3 });

    await deleteCard('card-x');

    expect(mockDb.kanbanCards.delete).toHaveBeenCalledWith('card-x');
    expect(mockDb.kanbanBoards.update).toHaveBeenCalledWith('board-1', { cardCount: 2 });
    expect(mockDb.syncQueue.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'DELETE',
        entity: 'KANBAN_CARD',
        entityId: 'card-x',
        data: { columnId: 'col-1' },
      }),
    );
  });
});
