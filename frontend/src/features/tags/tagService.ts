import { db } from '../../lib/db';
import { v4 as uuidv4 } from 'uuid';
import api from '../../lib/api';

export interface Tag {
  id: string;
  name: string;
  userId: string;
  isVault?: boolean;
  syncStatus: 'synced' | 'created' | 'updated';
  _count?: {
    notes: number;
  };
}

export const getTags = async () => {
  return db.tags.orderBy('name').toArray();
};

import { useAuthStore } from '../../store/authStore';

export const createTag = async (name: string, isVault: boolean = false) => {
  const userId = useAuthStore.getState().user?.id || 'current-user';
  // Check for duplicate name
  const existing = await db.tags.where('name').equals(name).and(t => !!t.isVault === isVault).first();
  if (existing) {
    throw new Error('A tag with this name already exists.');
  }

  const id = uuidv4();
  const newTag: Tag = {
    id,
    name,
    userId,
    isVault,
    syncStatus: 'created' as const
  };

  await db.tags.add(newTag);
  await db.syncQueue.add({
    type: 'CREATE',
    entity: 'TAG',
    entityId: id,
    userId,
    data: { name, id, isVault },
    createdAt: Date.now()
  });

  return newTag;
};

export const updateTag = async (id: string, data: { name?: string }) => {
  await db.tags.update(id, { ...data, syncStatus: 'updated' });
  const userId = useAuthStore.getState().user?.id || 'current-user';
  await db.syncQueue.add({
    type: 'UPDATE',
    entity: 'TAG',
    entityId: id,
    userId,
    data,
    createdAt: Date.now()
  });
};

export const deleteTag = async (id: string) => {
  await db.tags.delete(id);
  const userId = useAuthStore.getState().user?.id || 'current-user';
  await db.syncQueue.add({
    type: 'DELETE',
    entity: 'TAG',
    entityId: id,
    userId,
    createdAt: Date.now()
  });
};

export const addTagToNote = async (noteId: string, tagId: string) => {
  const note = await db.notes.get(noteId);
  const tag = await db.tags.get(tagId);
  if (!note || !tag) return;

  // Check if tag is already associated
  if (note.tags?.some(t => t.tag.id === tagId)) return;

  const updatedTags = [...(note.tags || []), { tag: { id: tag.id, name: tag.name } }];

  if (note.ownership === 'shared') {
    // Shared notes: call API directly (not through sync queue)
    await api.post('/tags/note', { noteId, tagId });
    // _localMetaUpdatedAt prevents syncPull race condition from overwriting this change
    await db.notes.update(noteId, { tags: updatedTags, _localMetaUpdatedAt: Date.now() });
  } else {
    // Owned notes: offline-first flow via sync queue
    await db.notes.update(noteId, { tags: updatedTags, syncStatus: 'updated' });
    const userId = useAuthStore.getState().user?.id || 'current-user';
    await db.syncQueue.add({
      type: 'UPDATE',
      entity: 'NOTE',
      entityId: noteId,
      userId,
      data: { tags: updatedTags },
      createdAt: Date.now()
    });
  }
};

export const removeTagFromNote = async (noteId: string, tagId: string) => {
  const note = await db.notes.get(noteId);
  if (!note) return;

  const updatedTags = note.tags.filter(t => t.tag.id !== tagId);

  if (note.ownership === 'shared') {
    // Shared notes: call API directly
    await api.delete('/tags/note', { data: { noteId, tagId } });
    // _localMetaUpdatedAt prevents syncPull race condition from overwriting this change
    await db.notes.update(noteId, { tags: updatedTags, _localMetaUpdatedAt: Date.now() });
  } else {
    // Owned notes: offline-first flow
    await db.notes.update(noteId, { tags: updatedTags, syncStatus: 'updated' });
    const userId = useAuthStore.getState().user?.id || 'current-user';
    await db.syncQueue.add({
      type: 'UPDATE',
      entity: 'NOTE',
      entityId: noteId,
      userId,
      data: { tags: updatedTags },
      createdAt: Date.now()
    });
  }
};
