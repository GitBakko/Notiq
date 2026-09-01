import type { QueryClient } from '@tanstack/react-query';
import { syncPull } from './syncService';
import { queryKeys } from '../../lib/queryKeys';

/**
 * Runs syncPull() and invalidates the TanStack query for every kanban board
 * it pruned (owned board gone from the server, or a share revoked) — the ONE
 * thing every syncPull caller must do with its return value, or a tab already
 * sitting on that board keeps rendering the stale copy indefinitely (nothing
 * else invalidates it: no queue item was pushed for a pure prune, and the next
 * pull has nothing left locally to notice the deletion of).
 *
 * Task 6 fix round 2: useImport called bare syncPull() and dropped the return
 * value, quietly reopening the exact window fix round 1 closed in useSync —
 * proof this is easy to get wrong per call site. Wrapping it here means every
 * caller gets the invalidation for free instead of having to remember it.
 *
 * No QueryClient import in syncService.ts itself (TIER 1, no React
 * dependency) — this is the seam: callers own a QueryClient (from
 * useQueryClient()) and hand it in.
 */
export async function pullAndInvalidateBoards(queryClient: QueryClient): Promise<string[]> {
  const prunedBoardIds = await syncPull();
  for (const boardId of prunedBoardIds ?? []) {
    queryClient.invalidateQueries({ queryKey: queryKeys.kanban.board(boardId) });
  }
  return prunedBoardIds;
}
