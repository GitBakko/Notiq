import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { createNotebook, updateNotebook, deleteNotebook } from '../features/notebooks/notebookService';

import { useAuthStore } from '../store/authStore';

export function useNotebooks() {
  const user = useAuthStore((state) => state.user);

  const notebooks = useLiveQuery(async () => {
    if (!user?.id) return [];

    const allNotebooks = await db.notebooks
      .where('userId').equals(user.id)
      .sortBy('name');

    const notebooksWithCounts = await Promise.all(allNotebooks.map(async (n) => {
      const count = await db.notes
        .where('notebookId').equals(n.id)
        .filter(note => note.userId === user.id && !note.isTrashed && !note.isVault)
        .count();
      return { ...n, count };
    }));
    return notebooksWithCounts;
  }, [user?.id]);

  return {
    notebooks,
    createNotebook,
    updateNotebook,
    deleteNotebook
  };
}
