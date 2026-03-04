import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../../../lib/queryKeys';
import { getBoard } from '../kanbanService';
import { db } from '../../../lib/db';
import type { LocalKanbanColumn, LocalKanbanCard } from '../../../lib/db';

export function useKanbanBoard(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.kanban.board(boardId!),
    queryFn: async () => {
      const board = await getBoard(boardId!);

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
      } catch {
        // Non-critical: Dexie hydration failure shouldn't break the board view
      }

      return board;
    },
    enabled: !!boardId,
    retry: false, // Don't retry 404s (deleted boards)
  });
}
