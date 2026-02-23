import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';

export function useTaskLists() {
  return useLiveQuery(async () => {
    const taskLists = await db.taskLists
      .filter(tl => !tl.isTrashed)
      .toArray();

    const listsWithItems = await Promise.all(
      taskLists.map(async (tl) => {
        const items = await db.taskItems
          .where('taskListId').equals(tl.id)
          .sortBy('position');
        return { ...tl, items };
      })
    );

    return listsWithItems.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  });
}
