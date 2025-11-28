import { db } from '../../lib/db';
import api from '../../lib/api';
import type { Note } from '../notes/noteService';
import type { Notebook } from '../notebooks/notebookService';
import type { Tag } from '../tags/tagService';

export const syncPull = async () => {
  try {
    // Pull Notebooks
    const notebooksRes = await api.get<Notebook[]>('/notebooks');
    await db.transaction('rw', db.notebooks, async () => {
      const dirtyNotebooks = await db.notebooks.where('syncStatus').notEqual('synced').toArray();
      const dirtyIds = new Set(dirtyNotebooks.map(n => n.id));

      const serverNotebooks = notebooksRes.data.map(n => ({
        ...n,
        syncStatus: 'synced' as const
      }));

      const notebooksToPut = serverNotebooks.filter(n => !dirtyIds.has(n.id));

      const allLocalSyncedNotebooks = await db.notebooks.where('syncStatus').equals('synced').toArray();
      const serverIds = new Set(serverNotebooks.map(n => n.id));
      const toDeleteIds = allLocalSyncedNotebooks.filter(n => !serverIds.has(n.id)).map(n => n.id);

      await db.notebooks.bulkDelete(toDeleteIds);
      await db.notebooks.bulkPut(notebooksToPut);
    });

    // Pull Tags
    const tagsRes = await api.get<Tag[]>('/tags');
    await db.transaction('rw', db.tags, async () => {
      const dirtyTags = await db.tags.where('syncStatus').notEqual('synced').toArray();
      const dirtyIds = new Set(dirtyTags.map(t => t.id));

      const serverTags = tagsRes.data.map(t => ({
        ...t,
        userId: 'current-user',
        syncStatus: 'synced' as const
      }));

      const tagsToPut = serverTags.filter(t => !dirtyIds.has(t.id));

      const allLocalSyncedTags = await db.tags.where('syncStatus').equals('synced').toArray();
      const serverIds = new Set(serverTags.map(t => t.id));
      const toDeleteIds = allLocalSyncedTags.filter(t => !serverIds.has(t.id)).map(t => t.id);

      await db.tags.bulkDelete(toDeleteIds);
      await db.tags.bulkPut(tagsToPut);
    });

    // Pull Notes
    const notesRes = await api.get<Note[]>('/notes');
    await db.transaction('rw', db.notes, async () => {
      // We need to be careful not to overwrite dirty notes
      // For MVP, let's just overwrite everything that is 'synced'
      // But wait, if we clear, we lose dirty notes.
      // Better: Get all dirty notes IDs.
      const dirtyNotes = await db.notes.where('syncStatus').notEqual('synced').toArray();
      const dirtyIds = new Set(dirtyNotes.map(n => n.id));

      const serverNotes = notesRes.data.map(n => ({
        ...n,
        tags: n.tags || [], // Ensure array
        attachments: n.attachments || [], // Ensure array
        syncStatus: 'synced' as const
      }));

      // Filter out server notes that conflict with local dirty notes (local wins temporarily until push)
      const notesToPut = serverNotes.filter(n => !dirtyIds.has(n.id));

      // We also need to handle deletions. If a note is in DB but not in serverNotes, and it's synced, delete it.
      const allLocalSyncedNotes = await db.notes.where('syncStatus').equals('synced').toArray();
      const serverIds = new Set(serverNotes.map(n => n.id));
      const toDeleteIds = allLocalSyncedNotes.filter(n => !serverIds.has(n.id)).map(n => n.id);

      await db.notes.bulkDelete(toDeleteIds);
      await db.notes.bulkPut(notesToPut);
    });

    console.log('Sync Pull Completed');
  } catch (error) {
    console.error('Sync Pull Failed:', error);
  }
};


let isSyncing = false;

export const syncPush = async () => {
  if (isSyncing) return;
  isSyncing = true;
  try {
    const queue = await db.syncQueue.orderBy('createdAt').toArray();

    for (const item of queue) {
      try {
        if (item.entity === 'NOTE') {
          if (item.type === 'CREATE') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { id, ...data } = item.data as any;
            await api.post('/notes', { ...data, id });
          } else if (item.type === 'UPDATE') {
            await api.put(`/notes/${item.entityId}`, item.data);
          } else if (item.type === 'DELETE') {
            await api.delete(`/notes/${item.entityId}`);
          }
        } else if (item.entity === 'NOTEBOOK') {
          if (item.type === 'CREATE') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { id, ...data } = item.data as any;
            await api.post('/notebooks', { ...data, id });
          } else if (item.type === 'UPDATE') {
            await api.put(`/notebooks/${item.entityId}`, item.data);
          } else if (item.type === 'DELETE') {
            await api.delete(`/notebooks/${item.entityId}`);
          }
        } else if (item.entity === 'TAG') {
          if (item.type === 'CREATE') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { id, ...data } = item.data as any;
            await api.post('/tags', { ...data, id });
          } else if (item.type === 'DELETE') {
            await api.delete(`/tags/${item.entityId}`);
          }
        }

        // If successful, remove from queue
        if (item.id) await db.syncQueue.delete(item.id);

        // Update syncStatus of the entity
        if (item.type !== 'DELETE') {
          if (item.entity === 'NOTE') {
            await db.notes.update(item.entityId, { syncStatus: 'synced' });
          } else if (item.entity === 'NOTEBOOK') {
            await db.notebooks.update(item.entityId, { syncStatus: 'synced' });
          } else if (item.entity === 'TAG') {
            await db.tags.update(item.entityId, { syncStatus: 'synced' });
          }
        }

      } catch (error) {
        console.error('Sync Push Failed for item:', item, error);
        // Keep in queue to retry later? Or move to dead letter queue?
        // For now, just log and maybe break to avoid blocking if it's a persistent error?
        // Or continue to try others?
      }
    }
  } finally {
    isSyncing = false;
  }
};

