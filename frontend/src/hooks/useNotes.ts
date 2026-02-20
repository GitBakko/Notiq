import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { useAuthStore } from '../store/authStore';

export function useNotes(notebookId?: string, search?: string, tagId?: string, onlyTrashed: boolean = false, ownershipFilter: 'all' | 'owned' | 'shared' = 'all') {
  const user = useAuthStore((state) => state.user);

  return useLiveQuery(async () => {
    if (!user?.id) return [];

    try {
      let collection = db.notes.orderBy('createdAt').reverse();

      collection = collection.filter(note => {
        // Ownership filtering
        if (note.ownership === 'shared') {
          // Shared note: include only if filter allows
          if (ownershipFilter === 'owned') return false;
        } else {
          // Personal note: must belong to current user
          if (note.userId !== user.id) return false;
          if (ownershipFilter === 'shared') return false;
        }

        // Exclude vault notes
        if (note.isVault) return false;

        // Notebook filter (only for owned notes)
        if (notebookId) {
          if (note.ownership === 'shared') return false;
          return note.notebookId === notebookId;
        }
        return true;
      });

      if (tagId) {
        collection = collection.filter(note => note.tags.some(t => t.tag.id === tagId));
      }

      if (search) {
        const lowerSearch = search.toLowerCase();
        collection = collection.filter(note =>
          note.title.toLowerCase().includes(lowerSearch) ||
          (note.searchText || '').toLowerCase().includes(lowerSearch)
        );
      }

      return collection.filter(n => n.isTrashed === onlyTrashed).toArray().then(async notes => {
        const notebookIds = [...new Set(notes.map(n => n.notebookId))];
        const notebooks = await db.notebooks.where('id').anyOf(notebookIds).toArray();
        const notebookMap = new Map(notebooks.map(nb => [nb.id, nb]));

        return notes.map(n => ({
          ...n,
          notebook: notebookMap.get(n.notebookId),
          tags: (n.tags || []).map(t => ({
            tag: {
              ...t.tag,
              userId: n.userId,
              syncStatus: 'synced' as const
            }
          }))
        }));
      });
    } catch (error) {
      console.error('useNotes Error:', error);
      return [];
    }
  }, [notebookId, search, tagId, onlyTrashed, ownershipFilter, user?.id]);
}
