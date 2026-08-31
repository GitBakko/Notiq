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
      bulkAdd: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(1),
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          toArray: vi.fn().mockResolvedValue([]),
          sortBy: vi.fn().mockResolvedValue([]),
          delete: vi.fn().mockResolvedValue(0),
        })),
      })),
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

import { deleteCard, createCard, moveCard, splitTextForCard, CARD_TITLE_MAX, CARD_DESCRIPTION_MAX } from '../kanbanService';

describe('splitTextForCard', () => {
  it('keeps a short single-line text as the title, with no description', () => {
    expect(splitTextForCard('Buy milk')).toEqual({ title: 'Buy milk', description: undefined });
  });

  it('moves the full text into the description when the text is multiline', () => {
    const text = 'Ship release\nremember to tag it';
    expect(splitTextForCard(text)).toEqual({ title: 'Ship release', description: text });
  });

  it('truncates an over-long title to the backend cap and keeps the full text as description', () => {
    const long = 'x'.repeat(600);
    const result = splitTextForCard(long);

    // Backend rejects title > 500 (Zod max(500)) — must fit, ellipsis included.
    expect(result.title.length).toBe(CARD_TITLE_MAX);
    expect(result.title.endsWith('…')).toBe(true);
    expect(result.description).toBe(long);
  });

  it('caps the description at the backend maximum', () => {
    const huge = 'y'.repeat(CARD_DESCRIPTION_MAX + 2000);
    expect(splitTextForCard(huge).description).toHaveLength(CARD_DESCRIPTION_MAX);
  });
});

describe('kanbanService.createCard length guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.kanbanColumns.get.mockResolvedValue({ id: 'col-1', boardId: 'board-1' });
    mockDb.kanbanBoards.get.mockResolvedValue({ id: 'board-1', cardCount: 0 });
  });

  it('truncates title and description to the caps the backend enforces', async () => {
    await createCard('col-1', { title: 'a'.repeat(900), description: 'b'.repeat(9000) });

    const queued = mockDb.syncQueue.add.mock.calls[0][0];
    expect(queued.data.title).toHaveLength(CARD_TITLE_MAX);
    expect(queued.data.description).toHaveLength(CARD_DESCRIPTION_MAX);

    // The locally stored card must match what the server will accept, otherwise
    // Dexie and the server diverge on the very first sync.
    const stored = mockDb.kanbanCards.add.mock.calls[0][0];
    expect(stored.title).toHaveLength(CARD_TITLE_MAX);
    expect(stored.description).toHaveLength(CARD_DESCRIPTION_MAX);
  });

  it('leaves values within the caps untouched', async () => {
    await createCard('col-1', { title: 'Fix bug', description: 'details' });

    const queued = mockDb.syncQueue.add.mock.calls[0][0];
    expect(queued.data.title).toBe('Fix bug');
    expect(queued.data.description).toBe('details');
  });
});

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

describe('kanbanService.moveCard', () => {
  type StoredCard = { id: string; columnId: string; position: number; createdAt: string };
  type UpdateCall = [string, { position?: number; columnId?: string }];

  const iso = (n: number) => new Date(1700000000000 + n).toISOString();
  let cardsByColumn: Record<string, StoredCard[]>;

  beforeEach(() => {
    vi.clearAllMocks();
    cardsByColumn = {};
    // where('columnId').equals(id).toArray(), routed per column id.
    // NOTE: mockImplementation survives vi.clearAllMocks(), so this block stays
    // last in the file; unknown columns resolve to [] and stay harmless.
    mockDb.kanbanCards.where.mockImplementation((field: string) => ({
      equals: (value: string) => ({
        toArray: async () => (field === 'columnId' ? cardsByColumn[value] ?? [] : []),
      }),
    }));
  });

  function positionWrites() {
    return (mockDb.kanbanCards.update.mock.calls as UpdateCall[]).map(([id, patch]) => ({
      id,
      position: patch.position,
    }));
  }

  it('shifts the siblings instead of stacking two cards on the same position', async () => {
    cardsByColumn['col-1'] = [
      { id: 'A', columnId: 'col-1', position: 0, createdAt: iso(1) },
      { id: 'B', columnId: 'col-1', position: 1, createdAt: iso(2) },
      { id: 'C', columnId: 'col-1', position: 2, createdAt: iso(3) },
      { id: 'D', columnId: 'col-1', position: 3, createdAt: iso(4) },
    ];
    mockDb.kanbanCards.get.mockResolvedValue(cardsByColumn['col-1'][0]);

    await moveCard('A', 'col-1', 2);

    const writes = positionWrites();
    expect(writes).toEqual([
      { id: 'B', position: 0 },
      { id: 'C', position: 1 },
      { id: 'A', position: 2 },
    ]);
    // D never moves: rewriting it would bump updatedAt for nothing.
    expect(writes.map((w) => w.id)).not.toContain('D');
  });

  it('closes the hole in the source column on a cross-column move', async () => {
    cardsByColumn['col-src'] = [
      { id: 'S0', columnId: 'col-src', position: 0, createdAt: iso(1) },
      { id: 'M', columnId: 'col-src', position: 1, createdAt: iso(2) },
      { id: 'S2', columnId: 'col-src', position: 2, createdAt: iso(3) },
    ];
    cardsByColumn['col-dst'] = [{ id: 'X', columnId: 'col-dst', position: 0, createdAt: iso(4) }];
    mockDb.kanbanCards.get.mockResolvedValue(cardsByColumn['col-src'][1]);

    await moveCard('M', 'col-dst', 0);

    expect(positionWrites()).toEqual([
      { id: 'S2', position: 1 }, // source: 2 -> 1, closes the hole M left behind
      { id: 'X', position: 1 },  // target: 0 -> 1, makes room at the top
      { id: 'M', position: 0 },  // the moved card lands at index 0
    ]);
  });

  it('sends the position the caller asked for to the sync queue, not the local one', async () => {
    // Dexie hydration is best-effort: the local column can be empty while the
    // server column is full. The queue must carry the user's intent — the
    // server clamps it itself (moveCard in backend/src/services/kanban/card.service.ts).
    mockDb.kanbanCards.get.mockResolvedValue(undefined);

    await moveCard('ghost', 'col-9', 7);

    expect(mockDb.syncQueue.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'UPDATE',
        entity: 'KANBAN_CARD',
        entityId: 'ghost',
        data: { columnId: 'col-9', position: 7 },
      }),
    );
  });
});
