import { describe, it, expect, beforeEach, vi } from 'vitest';

// Chainable Dexie collection mock that ACTUALLY applies the .filter() predicate,
// so the test asserts on rows and not on call shapes.
const { mockDb, rows } = vi.hoisted(() => {
  const rows: Record<string, unknown>[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Vitest mock: Dexie collection is a self-referential chain
  const table: any = {
    _predicate: null as null | ((row: Record<string, unknown>) => boolean),
    orderBy: vi.fn(() => table),
    reverse: vi.fn(() => table),
    filter: vi.fn((fn: (row: Record<string, unknown>) => boolean) => { table._predicate = fn; return table; }),
    toArray: vi.fn(async () => (table._predicate ? rows.filter(table._predicate) : [...rows])),
  };
  return { mockDb: { kanbanBoards: table }, rows };
});

// useLiveQuery is replaced by a plain capture, so the hook can be called as an
// ordinary function — no React renderer, no waitFor.
const { captured } = vi.hoisted(() => ({
  captured: { querier: null as null | (() => Promise<unknown>) },
}));

vi.mock('../../../../lib/db', () => ({ db: mockDb }));
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (querier: () => Promise<unknown>) => { captured.querier = querier; return undefined; },
}));
vi.mock('../../../../store/authStore', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- zustand selector signature
  useAuthStore: (selector: (s: any) => unknown) => selector({ user: { id: 'user-1' } }),
}));

import { useKanbanBoards } from '../useKanbanBoards';

beforeEach(() => {
  vi.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Vitest mock internals
  (mockDb.kanbanBoards as any)._predicate = null;
  rows.length = 0;
  captured.querier = null;
});

async function runQuerier(): Promise<{ id: string }[]> {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- useLiveQuery is mocked away, so the hook is a plain function here
  useKanbanBoards();
  if (!captured.querier) throw new Error('useLiveQuery was never called');
  return (await captured.querier()) as { id: string }[];
}

describe('useKanbanBoards scoping', () => {
  it('returns boards owned by the current user', async () => {
    rows.push({ id: 'kb-mine', ownerId: 'user-1', ownership: 'owned', syncStatus: 'synced', updatedAt: '2026-01-02' });
    const result = await runQuerier();
    expect(result.map(b => b.id)).toEqual(['kb-mine']);
  });

  it('returns a shared board stamped with the current viewerId', async () => {
    rows.push({ id: 'kb-shared', ownerId: 'user-2', viewerId: 'user-1', ownership: 'shared', syncStatus: 'synced', updatedAt: '2026-01-02' });
    const result = await runQuerier();
    expect(result.map(b => b.id)).toEqual(['kb-shared']);
  });

  it('hides boards left behind in Dexie by another account on this browser', async () => {
    rows.push({ id: 'kb-other-owned', ownerId: 'user-2', ownership: 'owned', syncStatus: 'synced', updatedAt: '2026-01-02' });
    rows.push({ id: 'kb-other-shared', ownerId: 'user-3', viewerId: 'user-2', ownership: 'shared', syncStatus: 'synced', updatedAt: '2026-01-01' });
    const result = await runQuerier();
    expect(result).toEqual([]);
  });

  it('hides a dirty board created offline by another account (the pull never prunes it)', async () => {
    rows.push({ id: 'kb-ghost', ownerId: 'user-2', ownership: 'owned', syncStatus: 'created', updatedAt: '2026-01-02' });
    const result = await runQuerier();
    expect(result).toEqual([]);
  });
});
