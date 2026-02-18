import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { useAuthStore } from '../store/authStore';

export function useNotes(notebookId?: string, search?: string, tagId?: string, onlyTrashed: boolean = false) {
  const user = useAuthStore((state) => state.user);

  return useLiveQuery(async () => {
    if (!user?.id) return [];

    try {
      let collection = db.notes.orderBy('createdAt').reverse();

      collection = collection.filter(note => {
        // Must belong to current user
        if (note.userId !== user.id) return false;

        // Exclude vault notes
        if (note.isVault) return false;

        if (notebookId) {
          return note.notebookId === notebookId;
        }
        return true; // If no notebookId is specified and not a vault note, include it.
      });

      if (tagId) {
        // This is tricky with Dexie for array of objects.
        // We might need a better schema or just filter in JS for now (small dataset).
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
              userId: n.userId, // Mock or retrieve
              syncStatus: 'synced' as const // Mock
            }
          }))
        }));
      });
    } catch (error) {
      console.error('useNotes Error:', error);
      return [];
    }
  }, [notebookId, search, tagId, onlyTrashed, user?.id]);
}
