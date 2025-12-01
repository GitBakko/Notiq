import api from '../../lib/api';
import type { Tag } from '../tags/tagService';


export interface Note {
  id: string;
  title: string;
  content: string;
  notebookId: string;
  userId: string;
  isTrashed: boolean;
  createdAt: string;
  updatedAt: string;
  tags?: { tag: Tag }[];
  attachments?: { id: string; url: string; filename: string; mimeType: string; size: number }[];
  reminderDate?: string | null;
  isReminderDone?: boolean;
  isPublic?: boolean;
  shareId?: string | null;
  isPinned?: boolean;
  isVault?: boolean;
  isEncrypted?: boolean;
  sharedWith?: {
    id: string;
    userId: string;
    permission: 'READ' | 'WRITE';
    user: { id: string; name: string | null; email: string };
  }[];
  user?: { id: string; name: string | null; email: string };
}

export const getNotes = async (notebookId?: string, search?: string, tagId?: string) => {
  const params = new URLSearchParams();
  if (notebookId) params.append('notebookId', notebookId);
  if (search) params.append('search', search);
  if (tagId) params.append('tagId', tagId);

  const response = await api.get<Note[]>(`/notes?${params.toString()}`);
  return response.data;
};

export const getNote = async (id: string) => {
  const res = await api.get<Note>(`/notes/${id}`);
  return res.data;
};

import { syncPush } from '../../features/sync/syncService';

export const toggleShare = async (id: string) => {
  await syncPush(); // Ensure note exists on backend
  const res = await api.post<Note>(`/notes/${id}/share`);
  return res.data;
};

export const shareNote = async (id: string, email: string, permission: 'READ' | 'WRITE' = 'READ') => {
  await syncPush(); // Ensure note exists on backend
  const res = await api.post(`/share/notes/${id}`, { email, permission });
  return res.data;
};

export const revokeShare = async (id: string, userId: string) => {
  const res = await api.delete(`/share/notes/${id}/${userId}`);
  return res.data;
};

export const getSharedNotes = async () => {
  const res = await api.get<any[]>('/share/notes'); // Returns SharedNote[] which includes note data
  return res.data;
};

export const getPublicNote = async (shareId: string) => {
  const res = await api.get<Note>(`/share/public/${shareId}`);
  return res.data;
};

import { db } from '../../lib/db';
import { v4 as uuidv4 } from 'uuid';
import { useAuthStore } from '../../store/authStore';

export const createNote = async (data: { title: string; notebookId: string; content?: string; isVault?: boolean; isEncrypted?: boolean }) => {
  const id = uuidv4();
  const userId = useAuthStore.getState().user?.id || 'current-user';
  const newNote = {
    id,
    ...data,
    content: data.content || '',
    userId,
    isTrashed: false,
    isVault: data.isVault || false,
    isEncrypted: data.isEncrypted || false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: [],
    attachments: [],
    syncStatus: 'created' as const
  };

  await db.notes.add(newNote);
  await db.syncQueue.add({
    type: 'CREATE',
    entity: 'NOTE',
    entityId: id,
    data: { ...data, id }, // Send ID to backend if supported
    createdAt: Date.now()
  });

  // Trigger immediate sync to ensure backend has the note before navigation/Hocuspocus connection
  try {
    await syncPush();
  } catch (error) {
    console.warn('Immediate sync failed, will retry in background', error);
  }

  return newNote;
};

export const updateNote = async (id: string, data: Partial<Note>) => {
  await db.notes.update(id, { ...data, updatedAt: new Date().toISOString(), syncStatus: 'updated' });
  await db.syncQueue.add({
    type: 'UPDATE',
    entity: 'NOTE',
    entityId: id,
    data,
    createdAt: Date.now()
  });
  return db.notes.get(id);
};

export const deleteNote = async (id: string) => {
  await db.notes.update(id, { isTrashed: true, syncStatus: 'updated' });

  await db.syncQueue.add({
    type: 'UPDATE',
    entity: 'NOTE',
    entityId: id,
    data: { isTrashed: true },
    createdAt: Date.now()
  });
};

export const restoreNote = async (id: string) => {
  await db.notes.update(id, { isTrashed: false, syncStatus: 'updated' });
  await db.syncQueue.add({
    type: 'UPDATE',
    entity: 'NOTE',
    entityId: id,
    data: { isTrashed: false },
    createdAt: Date.now()
  });
};

export const permanentlyDeleteNote = async (id: string) => {
  await db.notes.delete(id);
  // We need to send a hard delete to backend.
  // If the previous deleteNote sent a DELETE, maybe the note is already gone on server?
  // If deleteNote sent DELETE, and backend did soft delete, then we need another DELETE to hard delete?
  // Or maybe deleteNote should have sent UPDATE isTrashed=true?

  // Let's fix deleteNote to be a soft delete (UPDATE) and permanentlyDeleteNote to be hard delete (DELETE).
  await db.syncQueue.add({
    type: 'DELETE',
    entity: 'NOTE',
    entityId: id,
    createdAt: Date.now()
  });
};
