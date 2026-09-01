import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Task 6 (offline-first mutations): when the server GET fails, useKanbanBoard
// must reassemble the board from Dexie instead of returning undefined — that's
// the only thing that makes the previous five tasks' offline kanban mutations
// reachable at all. useQuery itself is mocked away (same "capture and call the
// queryFn directly" trick useKanbanBoards.test.tsx uses for useLiveQuery) so
// these are plain unit tests of the reassembly + navigate-away decision.
// ---------------------------------------------------------------------------

const { captured } = vi.hoisted(() => ({
  captured: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- react-query UseQueryOptions, not worth importing here
    options: null as null | { queryFn: () => Promise<any>; networkMode?: string },
  },
}));

vi.mock('@tanstack/react-query', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for UseQueryOptions
  useQuery: (options: any) => {
    captured.options = options;
    return { data: undefined, isLoading: true, isError: false };
  },
}));

const { mockGetBoard } = vi.hoisted(() => ({ mockGetBoard: vi.fn() }));
vi.mock('../../kanbanService', () => ({
  getBoard: mockGetBoard,
  byPosition: (a: { position: number; createdAt: string }, b: { position: number; createdAt: string }) => a.position - b.position || a.createdAt.localeCompare(b.createdAt),
  // Real implementation is a one-liner (ownerId/viewerId match) — mirrored here
  // rather than imported, same as byPosition above.
  isBoardOwnedByUser: (board: { ownerId?: string; viewerId?: string }, userId: string) =>
    board.ownerId === userId || board.viewerId === userId,
}));

// Mutable so a test can flip to a different account — see useKanbanBoards.test.tsx
// for the same pattern applied to that sibling hook.
const { currentUser } = vi.hoisted(() => ({
  currentUser: { user: { id: 'user-1' } as { id: string } | undefined },
}));
vi.mock('../../../../store/authStore', () => ({
  useAuthStore: { getState: () => ({ user: currentUser.user }) },
}));

// Chainable Dexie table mocks, same shape as the real .where('boardId').equals(id).toArray().
const { mockDb, boards, columns, cards } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Dexie row shape varies per test
  const boards: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const columns: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cards: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function byBoardId(rows: any[]) {
    return { equals: (id: string) => ({ toArray: async () => rows.filter((r) => r.boardId === id) }) };
  }
  return {
    boards,
    columns,
    cards,
    mockDb: {
      kanbanBoards: { get: vi.fn(async (id: string) => boards.find((b) => b.id === id)) },
      kanbanColumns: { where: vi.fn(() => byBoardId(columns)), get: vi.fn(async () => undefined), put: vi.fn() },
      kanbanCards: { where: vi.fn(() => byBoardId(cards)), get: vi.fn(async () => undefined), put: vi.fn() },
      // The success-path hydration write isn't under test here — just needs to
      // resolve quietly so it doesn't spam stderr through the existing swallowed catch.
      transaction: vi.fn(async (_mode: string, ..._rest: unknown[]) => {
        const fn = _rest[_rest.length - 1] as () => Promise<void>;
        await fn();
      }),
    },
  };
});
vi.mock('../../../../lib/db', () => ({ db: mockDb }));

import { useKanbanBoard } from '../useKanbanBoard';

beforeEach(() => {
  vi.clearAllMocks();
  boards.length = 0;
  columns.length = 0;
  cards.length = 0;
  captured.options = null;
  currentUser.user = { id: 'user-1' };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runQueryFn(): Promise<any> {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- useQuery is mocked away, so the hook is a plain function here
  useKanbanBoard('board-1');
  if (!captured.options) throw new Error('useQuery was never called');
  return captured.options.queryFn();
}

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

describe('useKanbanBoard — offline fallback', () => {
  it('reassembles the board from Dexie when the server fetch fails, ordering columns and cards correctly', async () => {
    mockGetBoard.mockRejectedValue(new Error('Network Error'));

    boards.push({
      id: 'board-1',
      title: 'My Board',
      description: null,
      coverImage: null,
      avatarUrl: null,
      ownerId: 'user-1',
      ownership: 'owned',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    // Out of order on purpose — reassembly must sort by position.
    columns.push({ id: 'col-2', title: 'Done', position: 1, boardId: 'board-1', isCompleted: true });
    columns.push({ id: 'col-1', title: 'To Do', position: 0, boardId: 'board-1', isCompleted: false });
    // Two cards sharing a position in col-1: tiebreak must fall to createdAt asc.
    cards.push({ id: 'card-later', title: 'B', position: 0, columnId: 'col-1', boardId: 'board-1', createdAt: '2026-01-01T00:00:02.000Z', updatedAt: '2026-01-01T00:00:02.000Z', description: null, assigneeId: null, assignee: null, dueDate: null, priority: null, noteId: null, noteLinkedById: null, note: null, commentCount: 0 });
    cards.push({ id: 'card-earlier', title: 'A', position: 0, columnId: 'col-1', boardId: 'board-1', createdAt: '2026-01-01T00:00:01.000Z', updatedAt: '2026-01-01T00:00:01.000Z', description: null, assigneeId: null, assignee: null, dueDate: null, priority: null, noteId: null, noteLinkedById: null, note: null, commentCount: 0 });
    cards.push({ id: 'card-done', title: 'C', position: 0, columnId: 'col-2', boardId: 'board-1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', description: null, assigneeId: null, assignee: null, dueDate: null, priority: null, noteId: null, noteLinkedById: null, note: null, commentCount: 0 });

    const result = await runQueryFn();

    expect(result).toBeDefined();
    expect(result.id).toBe('board-1');
    expect(result.columns.map((c: { id: string }) => c.id)).toEqual(['col-1', 'col-2']);
    expect(result.columns[0].cards.map((c: { id: string }) => c.id)).toEqual(['card-earlier', 'card-later']);
    expect(result.columns[1].cards.map((c: { id: string }) => c.id)).toEqual(['card-done']);
  });

  it('rethrows (so the page navigates away) when the board is not in Dexie either', async () => {
    mockGetBoard.mockRejectedValue(httpError(404));
    // Dexie has nothing for this id — genuinely never seen locally.

    await expect(runQueryFn()).rejects.toThrow('HTTP 404');
  });

  it('rethrows on 403 (revoked share) even when a stale copy lingers in Dexie', async () => {
    mockGetBoard.mockRejectedValue(httpError(403));
    boards.push({
      id: 'board-1',
      title: 'Stale Shared Board',
      description: null,
      coverImage: null,
      avatarUrl: null,
      ownerId: 'user-2',
      ownership: 'shared',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(runQueryFn()).rejects.toThrow('HTTP 403');
  });

  it('returns the server board unchanged when the fetch succeeds', async () => {
    const serverBoard = { id: 'board-1', title: 'Live', columns: [] };
    mockGetBoard.mockResolvedValue(serverBoard);

    const result = await runQueryFn();

    expect(result).toBe(serverBoard);
  });

  // Fix round 1 finding 3: column position has no uniqueness constraint (two
  // columns created offline, or a concurrent reorder, can collide) — the
  // server breaks ties with id asc, so reassembly must too.
  it('breaks a column position tie with id, matching the server order', async () => {
    mockGetBoard.mockRejectedValue(new Error('Network Error'));
    boards.push({ id: 'board-1', title: 'B', description: null, coverImage: null, avatarUrl: null, ownerId: 'user-1', ownership: 'owned', createdAt: 't0', updatedAt: 't1' });
    columns.push({ id: 'col-z', title: 'Z', position: 0, boardId: 'board-1', isCompleted: false });
    columns.push({ id: 'col-a', title: 'A', position: 0, boardId: 'board-1', isCompleted: false });

    const result = await runQueryFn();

    expect(result.columns.map((c: { id: string }) => c.id)).toEqual(['col-a', 'col-z']);
  });

  // Fix round 1 finding 4: pins the reasoning the report makes in prose —
  // without these assertions, fabricating share.id or dropping the
  // 'ACCEPTED' literal (or any of the null/0 defaults) would still pass
  // every other test in this file.
  it('reconstructs owner/shares from what Dexie stores and defaults the fields it does not', async () => {
    mockGetBoard.mockRejectedValue(new Error('Network Error'));
    boards.push({
      id: 'board-1',
      title: 'Shared Board',
      description: null,
      coverImage: null,
      avatarUrl: null,
      ownerId: 'user-2',
      viewerId: 'user-1', // stamped by syncPull's shared-board pull for the mocked current user
      ownership: 'shared',
      owner: { id: 'user-2', name: 'Owner Name', email: 'owner@example.com' }, // no avatarUrl, no color — never selected for this shape
      shares: [{ userId: 'user-3', permission: 'WRITE', user: { id: 'user-3', name: 'Viewer', email: 'viewer@example.com' } }], // no id, no status — /kanban/boards only ever returns ACCEPTED ones
      createdAt: 't0',
      updatedAt: 't1',
    });

    const result = await runQueryFn();

    expect(result.owner).toEqual({ id: 'user-2', name: 'Owner Name', email: 'owner@example.com', color: null, avatarUrl: null });
    expect(result.shares).toEqual([
      { id: 'user-3', userId: 'user-3', permission: 'WRITE', status: 'ACCEPTED', user: { id: 'user-3', name: 'Viewer', email: 'viewer@example.com' } },
    ]);
    expect(result.noteId).toBeNull();
    expect(result.note).toBeNull();
    expect(result.noteLinkedById).toBeNull();
    expect(result.taskListId).toBeNull();
    expect(result.taskList).toBeNull();
    expect(result.taskListLinkedBy).toBeNull();
    expect(result.archivedCardsCount).toBe(0);
  });

  // Regression: Dexie is one IndexedDB per browser profile and survives logout,
  // so a previous account's board rows are still there when the next account
  // logs in on the same browser. Without an ownership check here, the offline
  // fallback would happily reassemble and render someone else's board —
  // shares[] and all. Mirrors useKanbanBoards' own ownerId/viewerId filter.
  it('returns null (rethrows the original error) when the cached board belongs to a different account', async () => {
    mockGetBoard.mockRejectedValue(new Error('Network Error'));
    boards.push({
      id: 'board-1',
      title: 'Not Mine',
      description: null,
      coverImage: null,
      avatarUrl: null,
      ownerId: 'user-2', // a different account than the mocked current user (user-1)
      ownership: 'owned',
      createdAt: 't0',
      updatedAt: 't1',
    });

    await expect(runQueryFn()).rejects.toThrow('Network Error');
  });

  it('reconstructs the board when it is owned by the current user', async () => {
    mockGetBoard.mockRejectedValue(new Error('Network Error'));
    boards.push({
      id: 'board-1',
      title: 'Mine',
      description: null,
      coverImage: null,
      avatarUrl: null,
      ownerId: 'user-1', // matches the mocked current user
      ownership: 'owned',
      createdAt: 't0',
      updatedAt: 't1',
    });

    const result = await runQueryFn();

    expect(result.id).toBe('board-1');
  });

  // The offline fallback is the entire point of this hook — it must actually
  // run while offline. TanStack Query v5 defaults queries to networkMode:
  // 'online', which never invokes queryFn at all while navigator reports
  // offline (see frontend/src/lib/networkMode.ts).
  it('sets networkMode: "always" so the fallback can run while offline', () => {
    useKanbanBoard('board-1');
    expect(captured.options?.networkMode).toBe('always');
  });
});
