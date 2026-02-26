import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';

export interface TaskReminderItem {
  id: string;
  taskListId: string;
  taskListTitle: string;
  text: string;
  dueDate: string;
  isChecked: boolean;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
}

export function useTaskReminders() {
  return useLiveQuery(async () => {
    const taskLists = await db.taskLists
      .filter((tl) => !tl.isTrashed)
      .toArray();

    const taskListMap = new Map(taskLists.map((tl) => [tl.id, tl.title]));
    const taskListIds = new Set(taskLists.map((tl) => tl.id));

    const items = await db.taskItems
      .filter((item) => !!item.dueDate && !item.isChecked && taskListIds.has(item.taskListId))
      .toArray();

    return items
      .map((item) => ({
        id: item.id,
        taskListId: item.taskListId,
        taskListTitle: taskListMap.get(item.taskListId) || '',
        text: item.text,
        dueDate: item.dueDate!,
        isChecked: item.isChecked,
        priority: item.priority,
      }))
      .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
  });
}
