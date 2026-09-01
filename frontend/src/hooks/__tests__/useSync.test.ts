import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Task 5 (offline-first mutations): syncPush's onSuccess-only invalidation
// leaves the kanban board query showing the pre-push server snapshot after a
// reconnect (refetchOnReconnect fires before the 30s sync tick). useSync must
// invalidate the kanban queries itself, once syncPush has actually completed
// AND actually pushed something — never on an empty/offline/no-op tick.
// ---------------------------------------------------------------------------

const { mockQueryClient, mockSyncPush, mockSyncPull } = vi.hoisted(() => ({
  mockQueryClient: { invalidateQueries: vi.fn() },
  mockSyncPush: vi.fn(),
  mockSyncPull: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => mockQueryClient }));
vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => 1 })); // pendingCount = 1 (truthy) fires the push effect
vi.mock('../../lib/db', () => ({ db: { syncQueue: { count: vi.fn().mockResolvedValue(1) } } }));
vi.mock('../../store/authStore', () => ({ useAuthStore: () => ({ token: 'test-token' }) }));
vi.mock('../../features/sync/syncService', () => ({
  syncPush: mockSyncPush,
  syncPull: mockSyncPull,
}));

import { useSync } from '../useSync';

beforeEach(() => {
  vi.clearAllMocks();
  mockSyncPull.mockResolvedValue(undefined);
});

describe('useSync — post-push kanban invalidation', () => {
  it('invalidates the kanban queries once syncPush resolves having pushed something', async () => {
    mockSyncPush.mockResolvedValue(true);

    renderHook(() => useSync());

    await waitFor(() => {
      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['kanban-boards'] });
      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['kanban-board'] });
    });
  });

  it('does NOT invalidate anything when syncPush pushed nothing (empty queue, offline guard, or in-flight run)', async () => {
    mockSyncPush.mockResolvedValue(false);

    renderHook(() => useSync());

    // Let both effects' async work settle before asserting the negative.
    await waitFor(() => expect(mockSyncPush).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalled();
  });
});
