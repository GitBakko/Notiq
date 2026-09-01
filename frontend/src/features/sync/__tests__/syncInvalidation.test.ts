import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Task 6 fix round 2: pullAndInvalidateBoards is the one place syncPull's
// "which boards did you prune" contract is honored — extracted so useSync and
// useImport share it instead of each hand-rolling the loop (useImport didn't,
// which is exactly what fix round 2 closes). This pins the shared behavior
// once; useSync.test.ts and useImport.test.tsx only need to prove they call it.
// ---------------------------------------------------------------------------

const { mockSyncPull } = vi.hoisted(() => ({ mockSyncPull: vi.fn() }));
vi.mock('../syncService', () => ({ syncPull: mockSyncPull }));

import { pullAndInvalidateBoards } from '../syncInvalidation';

beforeEach(() => {
  vi.clearAllMocks();
});

function fakeQueryClient() {
  return { invalidateQueries: vi.fn() };
}

describe('pullAndInvalidateBoards', () => {
  it('invalidates the query for every board id syncPull reports pruned', async () => {
    mockSyncPull.mockResolvedValue(['board-a', 'board-b']);
    const queryClient = fakeQueryClient();

    await pullAndInvalidateBoards(queryClient as never);

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['kanban-board', 'board-a'] });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['kanban-board', 'board-b'] });
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it('invalidates nothing when syncPull prunes no boards', async () => {
    mockSyncPull.mockResolvedValue([]);
    const queryClient = fakeQueryClient();

    await pullAndInvalidateBoards(queryClient as never);

    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });

  it('returns syncPull\u2019s pruned-id list', async () => {
    mockSyncPull.mockResolvedValue(['board-x']);
    const queryClient = fakeQueryClient();

    const result = await pullAndInvalidateBoards(queryClient as never);

    expect(result).toEqual(['board-x']);
  });
});
