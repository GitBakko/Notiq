import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';

export function useReminders() {
  return useLiveQuery(async () => {
    // Filter notes that have a reminderDate and are not trashed
    const notes = await db.notes
      .filter(note => !!note.reminderDate && !note.isTrashed)
      .toArray();

    // Sort by reminderDate
    return notes.sort((a, b) => {
        if (!a.reminderDate) return 1;
        if (!b.reminderDate) return -1;
        return new Date(a.reminderDate).getTime() - new Date(b.reminderDate).getTime();
    });
  });
}
