import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const { mockSyncPush, mockMoveCard } = vi.hoisted(() => ({
  mockSyncPush: vi.fn(),
  mockMoveCard: vi.fn(),
}));

vi.mock('../../../sync/syncService', () => ({ syncPush: mockSyncPush }));
vi.mock('../../kanbanService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../kanbanService')>()),
  moveCard: mockMoveCard,
}));

import { useKanbanMutations } from '../useKanbanMutations';
import { queryKeys } from '../../../../lib/queryKeys';

// 3.4 — every local-first mutation refetched the board right away, before its
// queued write reached the server: a quick second move rendered the pre-push
// snapshot and the card jumped back. The refetch now waits for the push.
describe('useKanbanMutations', () => {
  let queryClient: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    mockMoveCard.mockResolvedValue(undefined);
  });

  it('refetches the board only after the push has finished', async () => {
    let finishPush!: (pushed: boolean) => void;
    mockSyncPush.mockReturnValue(new Promise<boolean>(resolve => { finishPush = resolve; }));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useKanbanMutations('board-1'), { wrapper });
    act(() => {
      result.current.moveCard.mutate({ cardId: 'card-1', toColumnId: 'col-2', position: 0 });
    });

    await waitFor(() => expect(mockSyncPush).toHaveBeenCalled());
    expect(invalidate).not.toHaveBeenCalled();

    await act(async () => { finishPush(true); });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.kanban.board('board-1') });
  });

  it('still refetches (from Dexie, offline) when the push fails', async () => {
    mockSyncPush.mockRejectedValue(new Error('offline'));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useKanbanMutations('board-1'), { wrapper });
    act(() => {
      result.current.moveCard.mutate({ cardId: 'card-1', toColumnId: 'col-2', position: 0 });
    });

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.kanban.board('board-1') }),
    );
  });
});
