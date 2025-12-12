import { db } from '../../lib/db';
import { v4 as uuidv4 } from 'uuid';
import type { LocalNotebook } from '../../lib/db';

export type Notebook = LocalNotebook;

export const getNotebooks = async () => {
  return db.notebooks.orderBy('name').toArray();
};

import { useAuthStore } from '../../store/authStore';

export const createNotebook = async (name: string) => {
  const userId = useAuthStore.getState().user?.id || 'current-user';
  // Check for duplicate name
  const existing = await db.notebooks.where('name').equals(name).first();
  if (existing) {
    return existing;
  }

  const id = uuidv4();
  const newNotebook: LocalNotebook = {
    id,
    name,
    userId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    syncStatus: 'created'
  };

  await db.notebooks.add(newNotebook);
  await db.syncQueue.add({
    type: 'CREATE',
    entity: 'NOTEBOOK',
    entityId: id,
    userId,
    data: { id, name },
    createdAt: Date.now()
  });

  return newNotebook;
};

export const updateNotebook = async (id: string, name: string) => {
  // Check for duplicate name (excluding current notebook)
  const existing = await db.notebooks.where('name').equals(name).first();
  if (existing && existing.id !== id) {
    throw new Error('A notebook with this name already exists.');
  }

  await db.notebooks.update(id, { name, updatedAt: new Date().toISOString(), syncStatus: 'updated' });
  const userId = useAuthStore.getState().user?.id || 'current-user';
  await db.syncQueue.add({
    type: 'UPDATE',
    entity: 'NOTEBOOK',
    entityId: id,
    userId,
    data: { name },
    createdAt: Date.now()
  });
};

export const deleteNotebook = async (id: string) => {
  // Check if notebook is empty
  const notesCount = await db.notes.where('notebookId').equals(id).filter(n => !n.isTrashed).count();
  if (notesCount > 0) {
    throw new Error('Cannot delete a non-empty notebook. Please move or delete notes first.');
  }

  await db.notebooks.delete(id);
  const userId = useAuthStore.getState().user?.id || 'current-user';
  await db.syncQueue.add({
    type: 'DELETE',
    entity: 'NOTEBOOK',
    entityId: id,
    userId,
    createdAt: Date.now()
  });
};

import api from '../../lib/api';

export const shareNotebook = async (id: string, email: string, permission: 'READ' | 'WRITE' = 'READ') => {
  const res = await api.post(`/share/notebooks/${id}`, { email, permission });
  return res.data;
};

export const revokeNotebookShare = async (id: string, userId: string) => {
  await api.delete(`/share/notebooks/${id}/${userId}`);
};

export const getSharedNotebooks = async () => {
  const res = await api.get<any[]>('/share/notebooks');
  return res.data;
};
