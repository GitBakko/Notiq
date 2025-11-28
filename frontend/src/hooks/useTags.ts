import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { createTag, deleteTag } from '../features/tags/tagService';

export function useTags() {
  const tags = useLiveQuery(async () => {
    const allTags = await db.tags.orderBy('name').toArray();
    
    // Use filter instead of where to avoid potential issues with boolean indexing in some environments
    const allNotes = await db.notes.filter(n => !n.isTrashed).toArray();

    // Calculate counts
    const counts = new Map<string, number>();
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
    }));
  });
  
  return {
    tags,
    createTag,
    deleteTag
  };
}
