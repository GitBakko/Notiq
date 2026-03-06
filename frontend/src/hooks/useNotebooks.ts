import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { createNotebook, updateNotebook, deleteNotebook } from '../features/notebooks/notebookService';

import { useAuthStore } from '../store/authStore';

export function useNotebooks() {
  const user = useAuthStore((state) => state.user);

  // Single useLiveQuery reading both tables — Dexie tracks reads on db.notebooks AND db.notes,
  // so changes to either table re-fire this query (same proven pattern as useTags).
  const notebooks = useLiveQuery(async () => {
    if (!user?.id) return [];

    const rawNotebooks = await db.notebooks.where('userId').equals(user.id).sortBy('name');

    const allNotes = await db.notes
      .filter(n => !n.isTrashed && !n.isVault && (n.userId === user.id || n.ownership === 'shared'))
      .toArray();

    const counts: Record<string, number> = {};
    for (const note of allNotes) {
      const nbId = note.ownership === 'shared' ? note.recipientNotebookId : note.notebookId;
      if (nbId) counts[nbId] = (counts[nbId] || 0) + 1;
    }
    return rawNotebooks.map(n => ({ ...n, count: counts[n.id] || 0 }));
  }, [user?.id]);

  return {
    notebooks,
    createNotebook,
    updateNotebook,
    deleteNotebook
  };
}
