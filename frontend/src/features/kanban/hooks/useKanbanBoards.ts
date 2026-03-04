import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../../lib/db';
import type { LocalKanbanBoard } from '../../../lib/db';

export function useKanbanBoards() {
  const boards = useLiveQuery(async () => {
    return db.kanbanBoards.orderBy('updatedAt').reverse().toArray();
  });

  return {
    data: boards,
    isLoading: boards === undefined,
  };
}

export type { LocalKanbanBoard };
