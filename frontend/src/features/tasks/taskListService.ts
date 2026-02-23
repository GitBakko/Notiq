import { db } from '../../lib/db';
import { v4 as uuidv4 } from 'uuid';
import type { LocalTaskList, LocalTaskItem } from '../../lib/db';
import { useAuthStore } from '../../store/authStore';
import api from '../../lib/api';
import { syncPush } from '../sync/syncService';

const getUserId = () => {
  const userId = useAuthStore.getState().user?.id;
  if (!userId) throw new Error('Not authenticated');
  return userId;
};

export const createTaskList = async (title: string) => {
  const userId = getUserId();
  const id = uuidv4();
  const now = new Date().toISOString();

  const taskList: LocalTaskList = {
    id,
    title,
    userId,
    createdAt: now,
    updatedAt: now,
    isTrashed: false,
    ownership: 'owned',
    syncStatus: 'created',
  };

  await db.taskLists.add(taskList);
  await db.syncQueue.add({
    type: 'CREATE',
    entity: 'TASK_LIST',
    entityId: id,
    userId,
    data: { id, title },
    createdAt: Date.now(),
  });

  return taskList;
};

export const updateTaskList = async (id: string, data: { title?: string }) => {
  const userId = getUserId();
  const now = new Date().toISOString();

  await db.taskLists.update(id, { ...data, updatedAt: now, syncStatus: 'updated' });
  await db.syncQueue.add({
    type: 'UPDATE',
    entity: 'TASK_LIST',
    entityId: id,
    userId,
    data: { ...data },
    createdAt: Date.now(),
  });
};

export const deleteTaskList = async (id: string) => {
  const userId = getUserId();
  const now = new Date().toISOString();

  await db.taskLists.update(id, { isTrashed: true, updatedAt: now, syncStatus: 'updated' });
  await db.syncQueue.add({
    type: 'UPDATE',
    entity: 'TASK_LIST',
    entityId: id,
    userId,
    data: { isTrashed: true },
    createdAt: Date.now(),
  });
};

export const addTaskItem = async (
  taskListId: string,
  text: string,
  priority: 'LOW' | 'MEDIUM' | 'HIGH' = 'MEDIUM',
  dueDate?: string | null
) => {
  const userId = getUserId();
  const id = uuidv4();
  const now = new Date().toISOString();

  // Get max position
  const items = await db.taskItems.where('taskListId').equals(taskListId).toArray();
  const maxPos = items.reduce((max, item) => Math.max(max, item.position), -1);

  const taskItem: LocalTaskItem = {
    id,
    taskListId,
    text,
    isChecked: false,
    priority,
    dueDate: dueDate || null,
    position: maxPos + 1,
    createdAt: now,
    updatedAt: now,
    syncStatus: 'created',
  };

  await db.taskItems.add(taskItem);

  // Also touch the parent task list updatedAt
  await db.taskLists.update(taskListId, { updatedAt: now });

  await db.syncQueue.add({
    type: 'CREATE',
    entity: 'TASK_ITEM',
    entityId: id,
    userId,
    data: { id, taskListId, text, priority, dueDate: dueDate || null },
    createdAt: Date.now(),
  });

  return taskItem;
};

export const updateTaskItem = async (id: string, data: Partial<Pick<LocalTaskItem, 'text' | 'isChecked' | 'priority' | 'dueDate' | 'position'>>) => {
  const userId = getUserId();
  const now = new Date().toISOString();

  const item = await db.taskItems.get(id);
  if (!item) throw new Error('TaskItem not found');

  await db.taskItems.update(id, { ...data, updatedAt: now, syncStatus: 'updated' });

  // Touch parent task list
  await db.taskLists.update(item.taskListId, { updatedAt: now });

  await db.syncQueue.add({
    type: 'UPDATE',
    entity: 'TASK_ITEM',
    entityId: id,
    userId,
    data: { ...data, taskListId: item.taskListId },
    createdAt: Date.now(),
  });
};

export const deleteTaskItem = async (id: string) => {
  const userId = getUserId();
  const now = new Date().toISOString();

  const item = await db.taskItems.get(id);
  if (!item) return;

  await db.taskItems.delete(id);

  // Touch parent task list
  await db.taskLists.update(item.taskListId, { updatedAt: now });

  await db.syncQueue.add({
    type: 'DELETE',
    entity: 'TASK_ITEM',
    entityId: id,
    userId,
    data: { taskListId: item.taskListId },
    createdAt: Date.now(),
  });
};

export const reorderTaskItems = async (items: { id: string; position: number }[]) => {
  const userId = getUserId();
  const now = new Date().toISOString();

  await db.transaction('rw', db.taskItems, db.syncQueue, async () => {
    for (const { id, position } of items) {
      const item = await db.taskItems.get(id);
      if (!item) continue;
      await db.taskItems.update(id, { position, updatedAt: now, syncStatus: 'updated' });
      await db.syncQueue.add({
        type: 'UPDATE',
        entity: 'TASK_ITEM',
        entityId: id,
        userId,
        data: { position, taskListId: item.taskListId },
        createdAt: Date.now(),
      });
    }
  });
};

// API wrappers for sharing (used by sharing modal)
export const shareTaskList = async (taskListId: string, email: string, permission: 'READ' | 'WRITE' = 'READ') => {
  await syncPush(); // Ensure task list exists on backend
  const res = await api.post(`/share/tasklists/${taskListId}`, { email, permission });
  return res.data;
};

export const revokeTaskListShare = async (taskListId: string, userId: string) => {
  const res = await api.delete(`/share/tasklists/${taskListId}/${userId}`);
  return res.data;
};

export const getSharedTaskLists = async () => {
  const res = await api.get<any[]>('/share/tasklists');
  return res.data;
};
