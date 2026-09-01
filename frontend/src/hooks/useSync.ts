import { useCallback, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useQueryClient } from '@tanstack/react-query';
import { db } from '../lib/db';
import { syncPush } from '../features/sync/syncService';
import { pullAndInvalidateBoards } from '../features/sync/syncInvalidation';
import { useAuthStore } from '../store/authStore';
import { queryKeys } from '../lib/queryKeys';

/**
 * Kanban board-detail queries are keyed ['kanban-board', id] (queryKeys.kanban.board).
 * useSync has no board id of its own — any board the user has open offline could
 * be the one syncPush just wrote — so invalidation targets the shared prefix
 * rather than one id. Derived from queryKeys instead of a hardcoded literal so it
 * can't drift from the key kanban's own hooks use.
 */
const KANBAN_BOARD_PREFIX = queryKeys.kanban.board('')[0];

export function useSync() {
  const { token } = useAuthStore();
  const queryClient = useQueryClient();

  // Reactive Sync: Watch for pending items in the queue
  const pendingCount = useLiveQuery(() => db.syncQueue.count(), []);

  /**
   * Task 5 (offline-first mutations): kanban mutations invalidate their board
   * query in the mutation's own onSuccess, which is a no-op while offline (the
   * query is paused). On reconnect, TanStack's refetchOnReconnect (v5 default,
   * not overridden here) refetches the board from the server IMMEDIATELY — before
   * this hook's next syncPush tick — so it renders the pre-push snapshot, and
   * nothing invalidates it again once the push actually lands. Re-invalidating
   * here, after syncPush resolves, closes that gap. Gated on syncPush's own
   * return value so an empty/offline/already-running tick (this runs every 30s
   * regardless) never fires a pointless refetch.
   */
  const pushAndInvalidate = useCallback(async (): Promise<void> => {
    const pushedSomething = await syncPush();
    if (pushedSomething) {
      queryClient.invalidateQueries({ queryKey: queryKeys.kanban.boards });
      queryClient.invalidateQueries({ queryKey: [KANBAN_BOARD_PREFIX] });
    }
  }, [queryClient]);

  // Trigger PUSH whenever there are pending items
  useEffect(() => {
    if (!token || !pendingCount) return;

    const runPush = async () => {
      // Small delay to allow batching if multiple updates happen instanly?
      // syncPush processes the whole queue anyway.
      try {
        await pushAndInvalidate();
      } catch (error) {
        console.error('Auto-Push failed:', error);
      }
    };

    runPush();
  }, [pendingCount, token, pushAndInvalidate]);


  // Periodic PULL + PUSH retry (and initial sync)
  useEffect(() => {
    if (!token) return;

    const runSync = async () => {
      try {
        // Task 6 fix round 1: a board deleted on another device (or whose
        // share got revoked) while this tab was already sitting on it just
        // gets pruned from Dexie by syncPull — nothing else invalidates that
        // board's query, so an already-mounted KanbanBoardPage would otherwise
        // keep rendering the stale copy from cache indefinitely, and a
        // mutation made in that window would queue and only surface as a
        // silent drop at push time (syncPush deletes 404/410 queue items).
        // Reusing useKanbanBoard's own navigate-away path here: invalidating
        // forces a refetch, the refetch 404s, Dexie now has nothing left to
        // reconstruct from (syncPull just deleted it), so the existing hook
        // fallback rethrows and the page's existing effect navigates away.
        // pullAndInvalidateBoards (fix round 2) does the pull + the loop —
        // useImport needs the exact same two steps, so they now share it
        // instead of each hand-rolling the loop over syncPull's return value.
        await pullAndInvalidateBoards(queryClient);
      } catch (error) {
        console.error('Periodic Pull failed:', error);
      }
      // Retry kick for the push queue: the count-based effect above only fires when the
      // queue CHANGES, so items stuck after a connectivity loss would otherwise wait for
      // the next user edit. syncPush is cheap when the queue is empty or in backoff.
      try {
        await pushAndInvalidate();
      } catch (error) {
        console.error('Periodic Push retry failed:', error);
      }
    };

    // Initial sync on mount
    runSync();

    // Periodic sync every 30s
    const intervalId = setInterval(runSync, 30000);

    return () => clearInterval(intervalId);
    // queryClient is already transitively tracked via pushAndInvalidate (which
    // depends on it), listed explicitly too now that this effect also reads it
    // directly for the per-board invalidation above.
  }, [token, pushAndInvalidate, queryClient]);
}
