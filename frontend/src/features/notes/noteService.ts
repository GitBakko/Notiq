import api from '../../lib/api';
import type { Tag } from '../tags/tagService';


export interface Note {
  id: string;
  title: string;
  content: string;
  searchText?: string;
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
  noteType?: 'NOTE' | 'CREDENTIAL';
  sharedWith?: {
    id: string;
    userId: string;
    permission: 'READ' | 'WRITE';
    status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
    user: { id: string; name: string | null; email: string };
  }[];
  user?: { id: string; name: string | null; email: string };
  notebook?: { id: string; name: string };
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

export const createNote = async (data: { title: string; notebookId: string; content?: string; isVault?: boolean; isEncrypted?: boolean; noteType?: 'NOTE' | 'CREDENTIAL' }) => {
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
    noteType: data.noteType || 'NOTE',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: [],
    attachments: [],
    ownership: 'owned' as const,
    sharedPermission: null,
    sharedByUser: null,
    syncStatus: 'created' as const
  };

  await db.notes.add(newNote);
  await db.syncQueue.add({
    type: 'CREATE',
    entity: 'NOTE',
    entityId: id,
    userId,
    data: { ...data, id, noteType: data.noteType || 'NOTE' }, // Send ID + noteType to backend
    createdAt: Date.now()
  });

  // Sync is handled reactively by useSync hook observing the queue.
  // We return immediately for optimistic UI.

  return newNote;
};

export const updateNote = async (id: string, data: Partial<Note>) => {
  // Shared notes: only update locally, Hocuspocus handles server sync
  const existing = await db.notes.get(id);
  if (existing?.ownership === 'shared') {
    return updateNoteLocalOnly(id, data);
  }

  await db.notes.update(id, { ...data, updatedAt: new Date().toISOString(), syncStatus: 'updated' });
  const userId = useAuthStore.getState().user?.id || 'current-user';
  await db.syncQueue.add({
    type: 'UPDATE',
    entity: 'NOTE',
    entityId: id,
    userId,
    data,
    createdAt: Date.now()
  });
  return db.notes.get(id);
};

export const updateNoteLocalOnly = async (id: string, data: Partial<Note>) => {
  // Updates local DB for UI/offline purposes but DOES NOT trigger sync queue.
  // We assume Hocuspocus handles the server sync for this update.
  // We DO NOT set syncStatus='updated' to avoid REST push.
  // We DO update updatedAt so the UI shows it as recent.
  await db.notes.update(id, { ...data, updatedAt: new Date().toISOString() });
  return db.notes.get(id);
};

export const deleteNote = async (id: string) => {
  await db.notes.update(id, { isTrashed: true, syncStatus: 'updated' });

  const userId = useAuthStore.getState().user?.id || 'current-user';
  await db.syncQueue.add({
    type: 'UPDATE',
    entity: 'NOTE',
    entityId: id,
    userId,
    data: { isTrashed: true },
    createdAt: Date.now()
  });
};

export const restoreNote = async (id: string) => {
  await db.notes.update(id, { isTrashed: false, syncStatus: 'updated' });
  const userId = useAuthStore.getState().user?.id || 'current-user';
  await db.syncQueue.add({
    type: 'UPDATE',
    entity: 'NOTE',
    entityId: id,
    userId,
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
  const userId = useAuthStore.getState().user?.id || 'current-user';
  await db.syncQueue.add({
    type: 'DELETE',
    entity: 'NOTE',
    entityId: id,
    userId,
    createdAt: Date.now()
  });
};
