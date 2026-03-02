import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../../../lib/queryKeys';
import { getBoard } from '../kanbanService';

export function useKanbanBoard(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.kanban.board(boardId!),
    queryFn: () => getBoard(boardId!),
    enabled: !!boardId,
    retry: false, // Don't retry 404s (deleted boards)
  });
}
