import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { createTag, deleteTag } from '../features/tags/tagService';

import { useAuthStore } from '../store/authStore';

export function useTags(isVault: boolean = false) {
  const user = useAuthStore((state) => state.user);

  const tags = useLiveQuery(async () => {
    if (!user?.id) return [];

    // Filter tags by isVault AND userId
    const allTags = await db.tags
      .filter(t => t.userId === user.id && !!t.isVault === isVault)
      .toArray();
    // Note: If we had a compound index [userId+isVault], we could use that.
    // Current index on tags is 'userId' (added in v8) and 'isVault'.
    // .where('userId').equals(user.id).filter(...) is better if we have many users? 
    // Current implementation scans but filters by userId.

    // Calculate counts
    const counts = new Map<string, number>();

    // Filter notes also by isVault AND userId
    const allNotes = await db.notes
      .filter(n => n.userId === user.id && !n.isTrashed && !!n.isVault === isVault)
      .toArray();

    for (const note of allNotes) {
      if (note.tags) {
        for (const t of note.tags) {
          counts.set(t.tag.id, (counts.get(t.tag.id) || 0) + 1);
        }
      }
    }

    return allTags.map(tag => ({
      ...tag,
      _count: {
        notes: counts.get(tag.id) || 0
      }
    })).sort((a, b) => a.name.localeCompare(b.name));
  }, [isVault, user?.id]);

  return {
    tags,
    createTag,
    deleteTag
  };
}
