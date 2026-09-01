import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../../../lib/queryKeys';
import { getBoard, byPosition } from '../kanbanService';
import { db } from '../../../lib/db';
import type { LocalKanbanColumn, LocalKanbanCard } from '../../../lib/db';
import type { KanbanBoard, KanbanColumn, KanbanCard } from '../types';

/**
 * Rebuild a KanbanBoard from Dexie's three flat tables — inverts the mapping
 * the queryFn below writes on a successful fetch. Used only when the server
 * GET fails; returns null when the board was never cached locally (nothing to
 * reassemble, caller falls back to navigate-away).
 *
 * Ordering mirrors the server's getBoard() exactly (see
 * backend/src/services/kanban/board.service.ts): columns by [position, id],
 * cards by [position, createdAt] via the same `byPosition` moveCard/
 * duplicateCard use.
 * Archived cards need no explicit filter — Dexie never holds one: getBoard()
 * only ever sends live cards (archivedAt: null) to hydrate from, and syncPull
 * prunes any local card the server stops listing for its board.
 */
async function reconstructBoardFromDexie(boardId: string): Promise<KanbanBoard | null> {
  const localBoard = await db.kanbanBoards.get(boardId);
  if (!localBoard) return null;

  const [localColumns, localCards] = await Promise.all([
    db.kanbanColumns.where('boardId').equals(boardId).toArray(),
    db.kanbanCards.where('boardId').equals(boardId).toArray(),
  ]);

  const toCard = (card: LocalKanbanCard): KanbanCard => ({
    id: card.id,
    title: card.title,
    description: card.description,
    position: card.position,
    columnId: card.columnId,
    assigneeId: card.assigneeId,
    assignee: card.assignee,
    dueDate: card.dueDate,
    priority: card.priority,
    noteId: card.noteId,
    noteLinkedById: card.noteLinkedById,
    note: card.note,
    commentCount: card.commentCount,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  });

  const columns: KanbanColumn[] = [...localColumns]
    // Task 6 fix round 1: column position has no uniqueness constraint (same
    // class of collision cards have), so match the server's own tiebreaker —
    // getBoard() orders columns [{position:'asc'},{id:'asc'}] — instead of
    // position alone.
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map((col) => ({
      id: col.id,
      title: col.title,
      position: col.position,
      boardId: col.boardId,
      isCompleted: col.isCompleted,
      cards: localCards
        .filter((card) => card.columnId === col.id)
        .sort(byPosition)
        .map(toCard),
    }));

  return {
    id: localBoard.id,
    title: localBoard.title,
    description: localBoard.description,
    coverImage: localBoard.coverImage,
    avatarUrl: localBoard.avatarUrl,
    // Not captured in Dexie (kanbanBoards has no columns for them) — offline
    // renders without note/task-list links and the archived-cards badge
    // rather than guessing at values that could be stale or wrong.
    noteId: null,
    noteLinkedById: null,
    note: null,
    taskListId: null,
    taskList: null,
    taskListLinkedBy: null,
    archivedCardsCount: 0,
    ownerId: localBoard.ownerId,
    owner: localBoard.owner
      ? {
          id: localBoard.owner.id,
          name: localBoard.owner.name,
          email: localBoard.owner.email,
          color: null, // not captured locally
          avatarUrl: localBoard.owner.avatarUrl ?? null,
        }
      : undefined,
    columns,
    // The /kanban/boards list that hydrates local shares only ever returns
    // ACCEPTED ones (see listBoards in board.service.ts) and never selects
    // their own id — status: 'ACCEPTED' here is a safe inference from that
    // invariant, not a guess, and userId (unique per board) stands in for id
    // (only ever used as a React list key, see ShareBoardModal).
    shares: localBoard.shares?.map((s) => ({
      id: s.userId,
      userId: s.userId,
      user: s.user,
      permission: s.permission,
      status: 'ACCEPTED' as const,
    })),
    createdAt: localBoard.createdAt,
    updatedAt: localBoard.updatedAt,
  };
}

export function useKanbanBoard(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.kanban.board(boardId!),
    queryFn: async () => {
      let board: KanbanBoard;
      try {
        board = await getBoard(boardId!);
      } catch (err) {
        // A 403 is a real "you may no longer see this" (revoked share) — never
        // paper over it with a stale local copy, even one still cached here.
        // Anything else (offline, timeout, a 404 for a board that only exists
        // locally so far) falls back to Dexie; reconstructBoardFromDexie itself
        // returns null when there is truly nothing to show, and that null
        // rethrows the original error so the page still navigates away.
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status !== 403) {
          const local = await reconstructBoardFromDexie(boardId!);
          if (local) return local;
        }
        throw err;
      }

      // Write columns + cards to Dexie for offline reads (board list, sync)
      try {
        await db.transaction('rw', db.kanbanColumns, db.kanbanCards, async () => {
          const serverColumns: LocalKanbanColumn[] = board.columns.map(col => ({
            id: col.id,
            title: col.title,
            position: col.position,
            boardId: board.id,
            isCompleted: col.isCompleted ?? false,
            syncStatus: 'synced' as const,
          }));

          const serverCards: LocalKanbanCard[] = board.columns.flatMap(col =>
            col.cards.map(card => ({
              id: card.id,
              title: card.title,
              description: card.description,
              position: card.position,
              columnId: card.columnId,
              boardId: board.id,
              assigneeId: card.assigneeId,
              assignee: card.assignee,
              dueDate: card.dueDate,
              priority: card.priority,
              noteId: card.noteId,
              noteLinkedById: card.noteLinkedById,
              note: card.note,
              commentCount: card.commentCount,
              createdAt: card.createdAt,
              updatedAt: card.updatedAt,
              syncStatus: 'synced' as const,
            }))
          );

          // Only overwrite synced items (don't clobber dirty local changes)
          for (const col of serverColumns) {
            const local = await db.kanbanColumns.get(col.id);
            if (!local || local.syncStatus === 'synced') {
              await db.kanbanColumns.put(col);
            }
          }
          for (const card of serverCards) {
            const local = await db.kanbanCards.get(card.id);
            if (!local || local.syncStatus === 'synced') {
              await db.kanbanCards.put(card);
            }
          }
        });
      } catch (err) {
        // Non-critical: Dexie hydration failure shouldn't break the board view
        // (the view renders from server data). But log it — when hydration fails,
        // cards aren't cached locally, which breaks offline reads and used to make
        // card deletes silently no-op. Surfacing the error makes the cause
        // diagnosable instead of vanishing into a swallowed catch.
        console.error('useKanbanBoard: Dexie hydration failed for board', boardId, err);
      }

      return board;
    },
    enabled: !!boardId,
    retry: false, // Don't retry 404s (deleted boards)
  });
}
