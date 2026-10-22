import api from '../../lib/api';
import queryClient from '../../lib/queryClient';
import { queryKeys } from '../../lib/queryKeys';
import type { Tag } from '../tags/tagService';
import { ENVELOPE_RE } from '../../utils/vaultCrypto';


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
  ownership?: 'owned' | 'shared';
  sharedPermission?: 'READ' | 'WRITE' | null;
  recipientNotebookId?: string | null;
  sharedByUser?: { id: string; name: string | null; email: string; avatarUrl?: string | null } | null;
  sharedWith?: {
    id: string;
    userId: string;
    permission: 'READ' | 'WRITE';
    status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
    recipientNotebookId?: string | null;
    user: { id: string; name: string | null; email: string; avatarUrl?: string | null };
  }[];
  user?: { id: string; name: string | null; email: string; avatarUrl?: string | null };
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

  // Optimistic Dexie update: refresh sharedWith so badges appear immediately
  try {
    const freshRes = await api.get(`/notes/${id}`);
    if (freshRes.data?.sharedWith) {
      await db.notes.update(id, { sharedWith: freshRes.data.sharedWith });
    }
  } catch { /* non-critical: syncPull will eventually refresh */ }

  return res.data;
};

export const revokeShare = async (id: string, userId: string) => {
  const res = await api.delete(`/share/notes/${id}/${userId}`);

  // Optimistic Dexie update: remove revoked user from sharedWith
  try {
    const existing = await db.notes.get(id);
    if (existing?.sharedWith) {
      const updated = existing.sharedWith.filter((s: { userId: string }) => s.userId !== userId);
      await db.notes.update(id, { sharedWith: updated });
    }
  } catch { /* non-critical: syncPull will eventually refresh */ }

  return res.data;
};

export const getSharedNotes = async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await api.get<any[]>('/share/notes'); // Returns SharedNote[] — typed at call site
  return res.data;
};

export const getPublicNote = async (shareId: string) => {
  const res = await api.get<Note>(`/share/public/${shareId}`);
  return res.data;
};

import { db } from '../../lib/db';
import { v4 as uuidv4 } from 'uuid';
import { useAuthStore } from '../../store/authStore';

/** Rete di sicurezza vault (P2 5.9): errore tipizzato per le scritture che metterebbero testo in chiaro in una nota vault. */
export class VaultPlaintextGuardError extends Error {
  constructor(reason: string) {
    super(`vault.plaintextGuard: ${reason}`);
    this.name = 'VaultPlaintextGuardError';
  }
}

const rejectVaultWrite = (reason: string): never => {
  console.warn('[noteService] scrittura vault rifiutata:', reason);
  throw new VaultPlaintextGuardError(reason);
};

export const createNote = async (data: { title: string; notebookId: string; content?: string; isVault?: boolean; isEncrypted?: boolean; noteType?: 'NOTE' | 'CREDENTIAL' }) => {
  if (data.isVault && (data.title !== '' || !ENVELOPE_RE.test(data.content ?? '') || data.isEncrypted === false)) {
    rejectVaultWrite('createNote vault richiede envelope, title vuoto e isEncrypted non false');
  }
  const id = uuidv4();
  const userId = useAuthStore.getState().user?.id || 'current-user';
  const newNote = {
    id,
    ...data,
    content: data.content || '',
    userId,
    isTrashed: false,
    isVault: data.isVault || false,
    isEncrypted: data.isVault ? true : (data.isEncrypted || false),
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

// `opts.userId`: il flusher del vault al logout scrive dopo che authStore ha gia' azzerato l'utente (usa quello del contesto catturato).
export const updateNote = async (id: string, data: Partial<Note>, opts?: { userId?: string }) => {
  // Solo vaultMove cambia isVault (scrive Dexie direttamente)
  if ('isVault' in data) rejectVaultWrite('updateNote non puo cambiare isVault');
  const updatedAt = new Date().toISOString();
  const userId = opts?.userId ?? (useAuthStore.getState().user?.id || 'current-user');
  // Lettura, guardia, update e coda nella stessa transazione: guardia e scrittura vedono la stessa riga.
  const shared = await db.transaction('rw', db.notes, db.syncQueue, async () => {
    const existing = await db.notes.get(id);
    if (existing?.isVault) {
      if (data.content !== undefined && !ENVELOPE_RE.test(data.content)) rejectVaultWrite('content non envelope su nota vault');
      if (data.title !== undefined && data.title !== '') rejectVaultWrite('title non vuoto su nota vault');
      if (data.isEncrypted === false) rejectVaultWrite('isEncrypted:false su nota vault');
    }
    // Shared notes: only update locally, Hocuspocus handles server sync
    if (existing?.ownership === 'shared') return true;
    await db.notes.update(id, { ...data, updatedAt, syncStatus: 'updated' });
    await db.syncQueue.add({
      type: 'UPDATE',
      entity: 'NOTE',
      entityId: id,
      userId,
      data,
      createdAt: Date.now()
    });
    return false;
  });
  if (shared) return updateNoteLocalOnly(id, data);

  // Keep React Query cache in sync so switching notes doesn't show stale content
  queryClient.setQueryData(queryKeys.notes.detail(id), (old: Note | undefined) =>
    old ? { ...old, ...data, updatedAt } : old
  );

  return db.notes.get(id);
};

export const updateNoteLocalOnly = async (id: string, data: Partial<Note>) => {
  // Updates local DB for UI/offline purposes but DOES NOT trigger sync queue.
  // We assume Hocuspocus handles the server sync for this update.
  // We DO NOT set syncStatus='updated' to avoid REST push.
  // We DO update updatedAt so the UI shows it as recent.
  const updatedAt = new Date().toISOString();
  await db.notes.update(id, { ...data, updatedAt });

  // Keep React Query cache in sync so switching notes doesn't show stale content
  queryClient.setQueryData(queryKeys.notes.detail(id), (old: Note | undefined) =>
    old ? { ...old, ...data, updatedAt } : old
  );

  return db.notes.get(id);
};

export const updateSharedNoteNotebook = async (noteId: string, recipientNotebookId: string | null) => {
  await api.put(`/share/notes/${noteId}/metadata`, { recipientNotebookId });
  // Transaction ensures mutation event fires cleanly after commit,
  // triggering all useLiveQuery subscribers (useNotebooks, useNotes, etc.)
  await db.transaction('rw', db.notes, async () => {
    const note = await db.notes.get(noteId);
    if (note) {
      await db.notes.put({ ...note, recipientNotebookId, _localMetaUpdatedAt: Date.now() });
    }
  });
};

export const saveSharedNoteData = async (noteId: string, data: { content?: string; title?: string }) => {
  await api.put(`/share/notes/${noteId}/content`, data);
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

export interface NoteVersionDto {
  id: string;
  title: string;
  content: string;
  createdAt: string;
}

export const getNoteVersions = async (noteId: string): Promise<NoteVersionDto[]> => {
  const { data } = await api.get<NoteVersionDto[]>(`/notes/${noteId}/versions`);
  return data;
};

export const restoreNoteVersion = async (noteId: string, versionId: string): Promise<void> => {
  await api.post(`/notes/${noteId}/versions/${versionId}/restore`);
};
