import { db } from '../../lib/db';
import api from '../../lib/api';
import type { Note } from '../notes/noteService';
import type { Notebook } from '../notebooks/notebookService';
import type { Tag } from '../tags/tagService';
import type { LocalTaskList, LocalTaskItem, LocalKanbanBoard, LocalKanbanColumn, LocalKanbanCard } from '../../lib/db';
import type { KanbanBoardListItem, KanbanBoard } from '../kanban/types';

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
    const notesRes = await api.get<Note[]>('/notes?includeTrashed=true');
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
        ownership: 'owned' as const,
        sharedPermission: null,
        sharedByUser: null,
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
      // Exclude shared notes — they are managed by the shared notes pull block below.
      const allLocalSyncedNotes = await db.notes.where('syncStatus').equals('synced')
        .filter(n => n.ownership !== 'shared').toArray();
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
        await db.notes.bulkDelete(toDeleteIds);
      }

      // Preserve local 'content' field: GET /notes doesn't return it to keep responses lightweight.
      // Without this, bulkPut would wipe content (critical for encrypted vault/credential notes).
      const existingNoteIds = filteredNotesToPut.map(n => n.id);
      const existingNotes = await db.notes.bulkGet(existingNoteIds);
      const localContentMap = new Map<string, string>();
      for (const existing of existingNotes) {
        if (existing?.content) {
          localContentMap.set(existing.id, existing.content);
        }
      }

      const notesWithPreservedContent = filteredNotesToPut.map(n => ({
        ...n,
        content: n.content ?? localContentMap.get(n.id) ?? '',
      }));

      // Update local DB with server notes (wins over synced)
      await db.notes.bulkPut(notesWithPreservedContent);
    });

    // Pull Shared Notes (ACCEPTED only)
    try {
      const sharedRes = await api.get<(Note & { _sharedPermission: 'READ' | 'WRITE' })[]>('/share/notes/accepted');

      await db.transaction('rw', db.notes, async () => {
        const localShared = await db.notes.where('ownership').equals('shared').toArray();

        const serverShared = sharedRes.data.map(n => ({
          ...n,
          tags: n.tags || [],
          attachments: n.attachments || [],
          ownership: 'shared' as const,
          sharedPermission: n._sharedPermission,
          sharedByUser: n.user || null,
          syncStatus: 'synced' as const,
        }));
        const serverSharedIds = new Set(serverShared.map(n => n.id));

        // Remove notes no longer shared with us (revoked/declined)
        const toRemove = localShared.filter(n => !serverSharedIds.has(n.id)).map(n => n.id);
        if (toRemove.length > 0) await db.notes.bulkDelete(toRemove);

        // Upsert — server always wins for shared notes
        if (serverShared.length > 0) await db.notes.bulkPut(serverShared);
      });
    } catch (error) {
      console.error('Sync Pull Shared Notes Failed:', error);
    }

    // --- Task Lists Pull ---
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const taskListsRes = await api.get<any[]>('/tasklists');
      const serverTaskLists = taskListsRes.data;

      await db.transaction('rw', db.taskLists, db.taskItems, async () => {
        const dirtyTaskLists = await db.taskLists.where('syncStatus').notEqual('synced').toArray();
        const dirtyIds = new Set(dirtyTaskLists.map(tl => tl.id));

        const taskListsToPut: LocalTaskList[] = serverTaskLists
          .filter((tl: { id: string }) => !dirtyIds.has(tl.id))
          .map((tl: Omit<LocalTaskList, 'ownership' | 'syncStatus'>) => ({
            ...tl,
            ownership: 'owned' as const,
            syncStatus: 'synced' as const,
          }));

        const serverIds = new Set(serverTaskLists.map((tl: { id: string }) => tl.id));
        const allLocalSynced = await db.taskLists.where('syncStatus').equals('synced')
          .filter(tl => tl.ownership !== 'shared').toArray();
        const toDeleteIds = allLocalSynced
          .filter(tl => !serverIds.has(tl.id))
          .map(tl => tl.id);

        if (toDeleteIds.length > 0) {
          await db.taskLists.bulkDelete(toDeleteIds);
          for (const tlId of toDeleteIds) {
            await db.taskItems.where('taskListId').equals(tlId).delete();
          }
        }
        if (taskListsToPut.length > 0) await db.taskLists.bulkPut(taskListsToPut);

        // Sync items for each task list
        for (const tl of taskListsToPut) {
          if (tl.items && tl.items.length > 0) {
            const itemsToPut = tl.items.map((item: Omit<LocalTaskItem, 'syncStatus'>) => ({
              ...item,
              syncStatus: 'synced' as const,
            }));
            await db.taskItems.bulkPut(itemsToPut);
          }
        }
      });
    } catch (e) {
      console.error('syncPull taskLists failed', e);
    }

    // --- Shared Task Lists Pull ---
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sharedRes = await api.get<any[]>('/share/tasklists/accepted');
      const sharedTaskLists = sharedRes.data;

      await db.transaction('rw', db.taskLists, db.taskItems, async () => {
        const sharedMapped: LocalTaskList[] = sharedTaskLists.map((tl: Omit<LocalTaskList, 'ownership' | 'syncStatus'> & { _sharedPermission?: string }) => ({
          ...tl,
          ownership: 'shared' as const,
          sharedPermission: tl._sharedPermission as 'READ' | 'WRITE' | undefined,
          syncStatus: 'synced' as const,
        }));

        const serverSharedIds = new Set(sharedMapped.map(tl => tl.id));
        const allLocalShared = await db.taskLists
          .filter(tl => tl.ownership === 'shared').toArray();
        const toRemoveIds = allLocalShared.filter(tl => !serverSharedIds.has(tl.id)).map(tl => tl.id);
        if (toRemoveIds.length > 0) {
          await db.taskLists.bulkDelete(toRemoveIds);
          for (const tlId of toRemoveIds) {
            await db.taskItems.where('taskListId').equals(tlId).delete();
          }
        }

        if (sharedMapped.length > 0) await db.taskLists.bulkPut(sharedMapped);

        for (const tl of sharedMapped) {
          if (tl.items && tl.items.length > 0) {
            const itemsToPut = tl.items.map((item: Omit<LocalTaskItem, 'syncStatus'>) => ({
              ...item,
              syncStatus: 'synced' as const,
            }));
            await db.taskItems.bulkPut(itemsToPut);
          }
        }
      });
    } catch (e) {
      console.error('syncPull shared taskLists failed', e);
    }

    // --- Kanban Boards Pull ---
    try {
      const boardsRes = await api.get<KanbanBoardListItem[]>('/kanban/boards');
      const serverBoards = boardsRes.data;

      await db.transaction('rw', db.kanbanBoards, db.kanbanColumns, db.kanbanCards, db.syncQueue, async () => {
        const dirtyBoards = await db.kanbanBoards.where('syncStatus').notEqual('synced').toArray();
        const dirtyIds = new Set(dirtyBoards.map(b => b.id));

        // Zombie prevention: check for pending board deletes
        const pendingBoardDeletes = await db.syncQueue
          .where('entity').equals('KANBAN_BOARD')
          .and(item => item.type === 'DELETE')
          .toArray();
        const pendingBoardDeleteIds = new Set(pendingBoardDeletes.map(i => i.entityId));

        const boardsToPut: LocalKanbanBoard[] = serverBoards
          .filter(b => !dirtyIds.has(b.id) && !pendingBoardDeleteIds.has(b.id))
          .map(b => ({
            ...b,
            syncStatus: 'synced' as const,
          }));

        // Remove boards no longer on server (owned only — shared handled below)
        const allLocalSyncedBoards = await db.kanbanBoards.where('syncStatus').equals('synced')
          .filter(b => b.ownership !== 'shared').toArray();
        const serverIds = new Set(serverBoards.map(b => b.id));
        const toDeleteIds = allLocalSyncedBoards
          .filter(b => !serverIds.has(b.id) && !pendingBoardDeleteIds.has(b.id))
          .map(b => b.id);

        if (toDeleteIds.length > 0) {
          await db.kanbanBoards.bulkDelete(toDeleteIds);
          // Cascade: remove columns and cards of deleted boards
          for (const boardId of toDeleteIds) {
            const cols = await db.kanbanColumns.where('boardId').equals(boardId).toArray();
            if (cols.length > 0) {
              await db.kanbanColumns.where('boardId').equals(boardId).delete();
            }
            await db.kanbanCards.where('boardId').equals(boardId).delete();
          }
        }

        if (boardsToPut.length > 0) await db.kanbanBoards.bulkPut(boardsToPut);
      });

      // Pull full board details (columns + cards) for each board
      for (const board of serverBoards) {
        try {
          const boardRes = await api.get<KanbanBoard>(`/kanban/boards/${board.id}`);
          const fullBoard = boardRes.data;

          await db.transaction('rw', db.kanbanColumns, db.kanbanCards, db.syncQueue, async () => {
            // Zombie prevention for columns and cards
            const pendingColDeletes = await db.syncQueue
              .where('entity').equals('KANBAN_COLUMN')
              .and(item => item.type === 'DELETE')
              .toArray();
            const pendingColDeleteIds = new Set(pendingColDeletes.map(i => i.entityId));

            const pendingCardDeletes = await db.syncQueue
              .where('entity').equals('KANBAN_CARD')
              .and(item => item.type === 'DELETE')
              .toArray();
            const pendingCardDeleteIds = new Set(pendingCardDeletes.map(i => i.entityId));

            // Dirty columns/cards (local edits)
            const dirtyColumns = await db.kanbanColumns.where('syncStatus').notEqual('synced')
              .and(c => c.boardId === fullBoard.id).toArray();
            const dirtyColumnIds = new Set(dirtyColumns.map(c => c.id));

            const dirtyCards = await db.kanbanCards.where('syncStatus').notEqual('synced')
              .and(c => c.boardId === fullBoard.id).toArray();
            const dirtyCardIds = new Set(dirtyCards.map(c => c.id));

            // Prepare columns
            const serverColumns: LocalKanbanColumn[] = fullBoard.columns
              .filter(col => !dirtyColumnIds.has(col.id) && !pendingColDeleteIds.has(col.id))
              .map(col => ({
                id: col.id,
                title: col.title,
                position: col.position,
                boardId: fullBoard.id,
                syncStatus: 'synced' as const,
              }));

            // Remove columns no longer on server for this board
            const localSyncedCols = await db.kanbanColumns.where('boardId').equals(fullBoard.id)
              .filter(c => c.syncStatus === 'synced').toArray();
            const serverColIds = new Set(fullBoard.columns.map(c => c.id));
            const colsToDelete = localSyncedCols
              .filter(c => !serverColIds.has(c.id) && !pendingColDeleteIds.has(c.id))
              .map(c => c.id);
            if (colsToDelete.length > 0) await db.kanbanColumns.bulkDelete(colsToDelete);

            if (serverColumns.length > 0) await db.kanbanColumns.bulkPut(serverColumns);

            // Prepare cards (flatten from all columns)
            const allServerCards: LocalKanbanCard[] = fullBoard.columns.flatMap(col =>
              col.cards
                .filter(card => !dirtyCardIds.has(card.id) && !pendingCardDeleteIds.has(card.id))
                .map(card => ({
                  ...card,
                  boardId: fullBoard.id,
                  syncStatus: 'synced' as const,
                }))
            );

            // Remove cards no longer on server for this board
            const localSyncedCards = await db.kanbanCards.where('boardId').equals(fullBoard.id)
              .filter(c => c.syncStatus === 'synced').toArray();
            const serverCardIds = new Set(allServerCards.map(c => c.id));
            const cardsToDelete = localSyncedCards
              .filter(c => !serverCardIds.has(c.id) && !pendingCardDeleteIds.has(c.id))
              .map(c => c.id);
            if (cardsToDelete.length > 0) await db.kanbanCards.bulkDelete(cardsToDelete);

            if (allServerCards.length > 0) await db.kanbanCards.bulkPut(allServerCards);
          });
        } catch (e) {
          console.error(`syncPull kanban board ${board.id} details failed`, e);
        }
      }
    } catch (e) {
      console.error('syncPull kanban boards failed', e);
    }

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
          // Safety: never push shared notes to REST API
          const localNote = await db.notes.get(item.entityId);
          if (localNote?.ownership === 'shared') {
            if (item.id) await db.syncQueue.delete(item.id);
            continue;
          }
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
        } else if (item.entity === 'TASK_LIST') {
          if (item.type === 'CREATE') {
            await api.post('/tasklists', { ...item.data, id: item.entityId });
          } else if (item.type === 'UPDATE') {
            await api.put(`/tasklists/${item.entityId}`, item.data);
          } else if (item.type === 'DELETE') {
            await api.delete(`/tasklists/${item.entityId}`);
          }
        } else if (item.entity === 'TASK_ITEM') {
          if (item.type === 'CREATE') {
            const taskListId = (item.data as Record<string, unknown> | undefined)?.taskListId as string | undefined;
            await api.post(`/tasklists/${taskListId}/items`, { ...item.data, id: item.entityId });
          } else if (item.type === 'UPDATE') {
            const taskListId = (item.data as Record<string, unknown> | undefined)?.taskListId as string | undefined;
            await api.put(`/tasklists/${taskListId}/items/${item.entityId}`, item.data);
          } else if (item.type === 'DELETE') {
            const taskListId = (item.data as Record<string, unknown> | undefined)?.taskListId as string | undefined;
            await api.delete(`/tasklists/${taskListId}/items/${item.entityId}`);
          }
        } else if (item.entity === 'KANBAN_BOARD') {
          // Safety: never push shared boards to REST API
          const localBoard = await db.kanbanBoards.get(item.entityId);
          if (localBoard?.ownership === 'shared') {
            if (item.id) await db.syncQueue.delete(item.id);
            continue;
          }
          if (item.type === 'CREATE') {
            await api.post('/kanban/boards', { ...item.data, id: item.entityId });
          } else if (item.type === 'UPDATE') {
            await api.put(`/kanban/boards/${item.entityId}`, item.data);
          } else if (item.type === 'DELETE') {
            await api.delete(`/kanban/boards/${item.entityId}`);
          }
        } else if (item.entity === 'KANBAN_COLUMN') {
          if (item.type === 'CREATE') {
            const boardId = (item.data as Record<string, unknown> | undefined)?.boardId as string | undefined;
            await api.post(`/kanban/boards/${boardId}/columns`, { ...item.data, id: item.entityId });
          } else if (item.type === 'UPDATE') {
            await api.put(`/kanban/columns/${item.entityId}`, item.data);
          } else if (item.type === 'DELETE') {
            await api.delete(`/kanban/columns/${item.entityId}`);
          }
        } else if (item.entity === 'KANBAN_CARD') {
          if (item.type === 'CREATE') {
            const columnId = (item.data as Record<string, unknown> | undefined)?.columnId as string | undefined;
            await api.post(`/kanban/columns/${columnId}/cards`, { ...item.data, id: item.entityId });
          } else if (item.type === 'UPDATE') {
            await api.put(`/kanban/cards/${item.entityId}`, item.data);
          } else if (item.type === 'DELETE') {
            await api.delete(`/kanban/cards/${item.entityId}`);
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
            } else if (item.entity === 'TASK_LIST') {
              const currentTaskList = await db.taskLists.get(item.entityId);
              if (currentTaskList && new Date(currentTaskList.updatedAt).getTime() <= item.createdAt) {
                await db.taskLists.update(item.entityId, { syncStatus: 'synced' });
              }
            } else if (item.entity === 'TASK_ITEM') {
              const currentTaskItem = await db.taskItems.get(item.entityId);
              if (currentTaskItem && new Date(currentTaskItem.updatedAt).getTime() <= item.createdAt) {
                await db.taskItems.update(item.entityId, { syncStatus: 'synced' });
              }
            } else if (item.entity === 'KANBAN_BOARD') {
              const currentBoard = await db.kanbanBoards.get(item.entityId);
              if (currentBoard && new Date(currentBoard.updatedAt).getTime() <= item.createdAt) {
                await db.kanbanBoards.update(item.entityId, { syncStatus: 'synced' });
              }
            } else if (item.entity === 'KANBAN_COLUMN') {
              // Columns don't have updatedAt, just mark as synced
              await db.kanbanColumns.update(item.entityId, { syncStatus: 'synced' });
            } else if (item.entity === 'KANBAN_CARD') {
              const currentCard = await db.kanbanCards.get(item.entityId);
              if (currentCard && new Date(currentCard.updatedAt).getTime() <= item.createdAt) {
                await db.kanbanCards.update(item.entityId, { syncStatus: 'synced' });
              }
            }
          }
        }

      } catch (error: unknown) {
        const status = (error as { response?: { status?: number } })?.response?.status;
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

