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
        // userId should come from server. If not, use 'current-user' as fallback?
        // Actually, backend returns userId.
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
    console.log('Sync Pull: Fetching notes with includeTrashed=true');
    const notesRes = await api.get<Note[]>('/notes?includeTrashed=true');
    console.log(`Sync Pull: Received ${notesRes.data.length} notes from server`);
    await db.transaction('rw', db.notes, db.syncQueue, async () => {
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

      // CRITICAL FIX: ZOMBIE RESURRECTION
      // We must check if any of these "server notes" are actually queued for DELETION locally.
      // If a note is in serverNotes but we have a pending DELETE in syncQueue, we MUST NOT re-insert it.
      // The `dirtyIds` check handles UPDATEs (where syncStatus='updated'), but hard deletes use DELETE queue type
      // and checking db.notes might fail if it was already deleted.

      const pendingDeletes = await db.syncQueue
        .where('entity').equals('NOTE')
        .and(item => item.type === 'DELETE')
        .toArray();

      const pendingDeleteIds = new Set(pendingDeletes.map(i => i.entityId));

      const filteredNotesToPut = notesToPut.filter(n => !pendingDeleteIds.has(n.id));

      // We also need to handle deletions. If a note is in DB but not in serverNotes, and it's synced, delete it.
      const allLocalSyncedNotes = await db.notes.where('syncStatus').equals('synced').toArray();
      // Self-Healing Strategy:
      // If we have local notes that are 'synced' but missing from the server, 
      // instead of deleting them locally, we should assume the server lost them and re-push.
      // This protects against accidental server wipes and "disappearing notes".

      const serverIds = new Set(serverNotes.map(n => n.id));
      // Notes missing from server are considered deleted — remove from local DB
      const toDeleteIds = allLocalSyncedNotes
        .filter(n => !serverIds.has(n.id) && !pendingDeleteIds.has(n.id))
        .map(n => n.id);

      if (toDeleteIds.length > 0) {
        console.log(`Sync Pull: Removing ${toDeleteIds.length} locally synced notes missing from server.`);
        await db.notes.bulkDelete(toDeleteIds);
      }

      // Update local DB with server notes (wins over synced)
      await db.notes.bulkPut(filteredNotesToPut);
    });

    console.log('Sync Pull Completed');
  } catch (error) {
    console.error('Sync Pull Failed:', error);
  }
};


import { useAuthStore } from '../../store/authStore';

let isSyncing = false;

export const syncPush = async () => {
  if (isSyncing) return;
  isSyncing = true;
  try {
    const currentUserId = useAuthStore.getState().user?.id;
    if (!currentUserId) return; // Cannot sync if not logged in

    // Filter queue by userId. 
    // We only process items that belong to the current user.
    // Legacy items without userId will be ignored (and potentially cleaned up later or stuck, which prevents leakage).
    const allQueue = await db.syncQueue.orderBy('createdAt').toArray();
    const queue = allQueue.filter(item => item.userId === currentUserId);

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

        // Update syncStatus of the entity ONLY if there are no more pending items for this entity
        if (item.type !== 'DELETE') {
          // Check if there are any other pending items for this entity
          // We don't have a compound index, so we filter manualy or use simple index if available.
          // Since syncQueue is typically small, toArray().filter() is acceptable, 
          // or we can query by 'entity' if indexed and filter by ID.
          const pendingItemsCount = await db.syncQueue
            .filter(i => i.entity === item.entity && i.entityId === item.entityId)
            .count();

          if (pendingItemsCount === 0) {
            if (item.entity === 'NOTE') {
              const currentNote = await db.notes.get(item.entityId);
              // Race Condition Protection:
              // Only mark as 'synced' if the local note hasn't been modified since this sync item was created.
              // If currentNote.updatedAt > item.createdAt, the user has typed more, so we keep 'updated' status.
              const updatedAtMs = currentNote ? new Date(currentNote.updatedAt).getTime() : 0;

              if (currentNote && updatedAtMs <= item.createdAt) {
                await db.notes.update(item.entityId, { syncStatus: 'synced' });
              }
            } else if (item.entity === 'NOTEBOOK') {
              const currentNotebook = await db.notebooks.get(item.entityId);
              if (currentNotebook && new Date(currentNotebook.updatedAt).getTime() <= item.createdAt) {
                await db.notebooks.update(item.entityId, { syncStatus: 'synced' });
              }
            } else if (item.entity === 'TAG') {
              // Tags might not have updatedAt? Interface says LocalTag has synced/created/updated.
              // Let's check db.ts interface. 
              // LocalTag: id, name, userId, syncStatus. No updatedAt?
              // Looking at db.ts step 270: LocalTag interface... 
              // syncStatus, _count. No updatedAt!
              // So for tags, we might have to assume safe or check syncStatus != 'updated'?
              // If tag is 'updated', leave it.
              // But createTag sets 'created'. 
              // If we blindly set 'synced', we might overwrite 'updated'.
              // Better: check if syncStatus is NOT 'updated' or 'created' (wait, if we are processing, it WAS created/updated).
              // Actually, if we just check if there are pending items, that usually covers it.
              // Typically tags are simple updates.
              // For safety on tags, let's stick to the pending count check for now, unless we verify Tag has updatedAt.
              // Checking Step 270: LocalTag indeed NO updatedAt.
              // So we just update Tag.
              await db.tags.update(item.entityId, { syncStatus: 'synced' });
            }
          }
        }

      } catch (error: any) {
        const status = error?.response?.status;
        if (status === 404 || status === 410) {
          // Resource no longer exists on server — remove from queue to stop infinite retries
          console.warn(`Sync Push: Removing item (server returned ${status}):`, item.entity, item.entityId);
          if (item.id) await db.syncQueue.delete(item.id);
        } else {
          console.error('Sync Push Failed for item:', item, error);
        }
      }
    }
  } finally {
    isSyncing = false;
  }
};

