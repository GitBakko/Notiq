import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../../lib/db';
import type { LocalKanbanBoard } from '../../../lib/db';
import { useAuthStore } from '../../../store/authStore';

export function useKanbanBoards() {
  const userId = useAuthStore((s) => s.user?.id);

  const boards = useLiveQuery(async () => {
    if (!userId) return [];
    // Fail closed. Dexie is one IndexedDB per browser profile and survives logout,
    // so rows written for a previous account are still here. Owned rows carry the
    // current user in ownerId (including boards created offline by kanbanService,
    // which never sets viewerId); shared rows carry the OWNER in ownerId, so the
    // pull stamps viewerId on them. A row matching neither belongs to someone else.
    return db.kanbanBoards
      .orderBy('updatedAt')
      .reverse()
      .filter((b) => b.ownerId === userId || b.viewerId === userId)
      .toArray();
  }, [userId]);

  return {
    data: boards,
    isLoading: boards === undefined,
  };
}

export type { LocalKanbanBoard };
