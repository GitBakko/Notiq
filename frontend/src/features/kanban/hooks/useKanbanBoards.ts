import { useQuery } from '@tanstack/react-query';
import { listBoards } from '../kanbanService';

export function useKanbanBoards() {
  return useQuery({
    queryKey: ['kanban-boards'],
    queryFn: listBoards,
  });
}
