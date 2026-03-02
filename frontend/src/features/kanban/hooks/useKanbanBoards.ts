import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../../../lib/queryKeys';
import { listBoards } from '../kanbanService';

export function useKanbanBoards() {
  return useQuery({
    queryKey: queryKeys.kanban.boards,
    queryFn: listBoards,
  });
}
