import { db } from '../../lib/db';
import api from '../../lib/api';
import type { Note } from '../notes/noteService';
import type { Notebook } from '../notebooks/notebookService';
import type { Tag } from '../tags/tagService';
import type { LocalTaskList, LocalTaskItem, LocalKanbanBoard, LocalKanbanColumn, LocalKanbanCard, SyncQueueItem } from '../../lib/db';
import type { KanbanBoardListItem, KanbanBoard } from '../kanban/types';
import toast from 'react-hot-toast';
import i18n from 'i18next';
import queryClient from '../../lib/queryClient';
import { queryKeys } from '../../lib/queryKeys';

// Kanban 5.2: the list's contentVersion of each board as of its last successful detail
// pull, keyed by user and board. syncPull runs every 30 s and used to GET every board's
// details every time; now it skips a board whose version has not moved. In memory on
// purpose: a reload starts from a full pull, and nothing persisted can go stale.
const boardDetailsPulled = new Map<string, { version: string; at: number }>();
// contentVersion doesn't see comment counts or a linked note's title, and a local edit
// the server rejected can leave a row wrong while the version stays put. A periodic
// full refresh bounds how long any of that can last.
const BOARD_DETAILS_MAX_AGE_MS = 10 * 60 * 1000;

export const syncPull = async () => {
  // Task 6 fix round 1: board ids this pull actually deletes from Dexie (owned,
  // no longer on server; or shared, no longer accepted) — a board someone had
  // open in an already-mounted tab keeps rendering the stale copy forever
  // otherwise, since nothing else invalidates that query on a pure prune (no
  // queue item is pushed, so syncPush's own invalidation never fires for it).
  // useSync reads this to invalidate just those board queries. Declared before
  // the try/catch so a failure anywhere still returns whatever was pruned
  // before the failure, instead of throwing away real deletions already made.
  const prunedBoardIds: string[] = [];
  try {
    // Captured once, synchronously, before any await in this pull run — an
    // account switch mid-pull (logout+login while a request is in flight)
    // cannot leave a later write site stamping a different user than the one
    // this pull started under. Matches syncPush's own entry guard.
    const currentUserId = useAuthStore.getState().user?.id;
    if (!currentUserId) return prunedBoardIds; // Cannot sync if not logged in

    try {
      // Pull Notebooks
      const notebooksRes = await api.get<Notebook[]>('/notebooks');
      await db.transaction('rw', db.notebooks, db.syncQueue, async () => {
        const dirtyNotebooks = await db.notebooks.where('syncStatus').notEqual('synced').toArray();
        const dirtyIds = new Set(dirtyNotebooks.map(n => n.id));

        const serverNotebooks = notebooksRes.data.map(n => ({
          ...n,
          syncStatus: 'synced' as const
        }));

        // Zombie prevention (mirrors the notes pull): a locally-deleted notebook with
        // a pending DELETE in the queue must not be resurrected by the server response.
        const pendingDeletes = await db.syncQueue
          .where('entity').equals('NOTEBOOK')
          .and(item => item.type === 'DELETE')
          .toArray();
        const pendingDeleteIds = new Set(pendingDeletes.map(i => i.entityId));

        const notebooksToPut = serverNotebooks.filter(n => !dirtyIds.has(n.id) && !pendingDeleteIds.has(n.id));

        const allLocalSyncedNotebooks = await db.notebooks.where('syncStatus').equals('synced').toArray();
        const serverIds = new Set(serverNotebooks.map(n => n.id));
        const toDeleteIds = allLocalSyncedNotebooks
          .filter(n => !serverIds.has(n.id) && !pendingDeleteIds.has(n.id))
          .map(n => n.id);

        await db.notebooks.bulkDelete(toDeleteIds);
        await db.notebooks.bulkPut(notebooksToPut);
      });
    } catch (e) {
      // Each of the first three sections gets its own try, like the ones below:
      // a failing endpoint must not skip the rest of the pull — in particular the
      // kanban prune that removes deleted and revoked boards.
      console.error('Sync Pull Notebooks Failed:', e);
    }

    try {
      // Pull Tags
      const tagsRes = await api.get<Tag[]>('/tags');
      await db.transaction('rw', db.tags, db.syncQueue, async () => {
        const dirtyTags = await db.tags.where('syncStatus').notEqual('synced').toArray();
        const dirtyIds = new Set(dirtyTags.map(t => t.id));

        const serverTags = tagsRes.data.map(t => ({
          ...t,
          // userId should come from server. If not, use 'current-user' as fallback?
          // Actually, backend returns userId.
          syncStatus: 'synced' as const
        }));

        // Zombie prevention (mirrors the notes pull): a locally-deleted tag with a
        // pending DELETE in the queue must not be resurrected by the server response.
        const pendingDeletes = await db.syncQueue
          .where('entity').equals('TAG')
          .and(item => item.type === 'DELETE')
          .toArray();
        const pendingDeleteIds = new Set(pendingDeletes.map(i => i.entityId));

        const tagsToPut = serverTags.filter(t => !dirtyIds.has(t.id) && !pendingDeleteIds.has(t.id));

        const allLocalSyncedTags = await db.tags.where('syncStatus').equals('synced').toArray();
        const serverIds = new Set(serverTags.map(t => t.id));
        const toDeleteIds = allLocalSyncedTags
          .filter(t => !serverIds.has(t.id) && !pendingDeleteIds.has(t.id))
          .map(t => t.id);

        await db.tags.bulkDelete(toDeleteIds);
        await db.tags.bulkPut(tagsToPut);
      });
    } catch (e) {
      console.error('Sync Pull Tags Failed:', e);
    }

    try {
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
    } catch (e) {
      console.error('Sync Pull Notes Failed:', e);
    }

    // Pull Shared Notes (ACCEPTED only)
    try {
      // Record pull start time BEFORE fetch — used to detect race conditions with local metadata updates
      const sharedPullStartTime = Date.now();
      const sharedRes = await api.get<(Note & { _sharedPermission: 'READ' | 'WRITE'; _recipientNotebookId?: string | null })[]>('/share/notes/accepted');

      await db.transaction('rw', db.notes, db.syncQueue, async () => {
        // Zombie prevention (mirrors the owned-notes pull): a locally-deleted shared note with a
        // pending DELETE in the queue must not be resurrected by the server response.
        const pendingSharedDeletes = await db.syncQueue
          .where('entity').equals('NOTE')
          .and(item => item.type === 'DELETE')
          .toArray();
        const pendingSharedDeleteIds = new Set(pendingSharedDeletes.map(i => i.entityId));

        const localShared = await db.notes.where('ownership').equals('shared').toArray();
        const localSharedMap = new Map(localShared.map(n => [n.id, n]));

        const serverShared = sharedRes.data.filter(n => !pendingSharedDeleteIds.has(n.id)).map(n => {
          const mapped = {
            ...n,
            tags: n.tags || [],
            attachments: n.attachments || [],
            ownership: 'shared' as const,
            sharedPermission: n._sharedPermission,
            sharedByUser: n.user || null,
            recipientNotebookId: n._recipientNotebookId || null,
            syncStatus: 'synced' as const,
          };

          // Race condition guard: if per-user metadata (tags, recipientNotebookId) was updated
          // locally DURING this pull (i.e., after the fetch started but before it completed),
          // preserve the local values — the server response contains stale data for these fields.
          const local = localSharedMap.get(n.id) as (typeof mapped & { _localMetaUpdatedAt?: number }) | undefined;
          if (local?._localMetaUpdatedAt && local._localMetaUpdatedAt >= sharedPullStartTime) {
            return {
              ...mapped,
              recipientNotebookId: local.recipientNotebookId,
              tags: local.tags,
              _localMetaUpdatedAt: local._localMetaUpdatedAt,
            };
          }

          return mapped;
        });
        const serverSharedIds = new Set(serverShared.map(n => n.id));

        // Remove notes no longer shared with us (revoked/declined)
        const toRemove = localShared.filter(n => !serverSharedIds.has(n.id)).map(n => n.id);
        if (toRemove.length > 0) await db.notes.bulkDelete(toRemove);

        // Upsert — server wins for shared notes (except per-user metadata during race)
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

      await db.transaction('rw', db.taskLists, db.taskItems, db.syncQueue, async () => {
        const dirtyTaskLists = await db.taskLists.where('syncStatus').notEqual('synced').toArray();
        const dirtyIds = new Set(dirtyTaskLists.map(tl => tl.id));

        // Zombie prevention: check for pending task list deletes
        const pendingTaskListDeletes = await db.syncQueue
          .where('entity').equals('TASK_LIST')
          .and(item => item.type === 'DELETE')
          .toArray();
        const pendingTaskListDeleteIds = new Set(pendingTaskListDeletes.map(i => i.entityId));

        // Zombie prevention: check for pending task item deletes
        const pendingTaskItemDeletes = await db.syncQueue
          .where('entity').equals('TASK_ITEM')
          .and(item => item.type === 'DELETE')
          .toArray();
        const pendingTaskItemDeleteIds = new Set(pendingTaskItemDeletes.map(i => i.entityId));

        const taskListsToPut: LocalTaskList[] = serverTaskLists
          .filter((tl: { id: string }) => !dirtyIds.has(tl.id) && !pendingTaskListDeleteIds.has(tl.id))
          .map((tl: Omit<LocalTaskList, 'ownership' | 'syncStatus'>) => ({
            ...tl,
            ownership: 'owned' as const,
            syncStatus: 'synced' as const,
          }));

        const serverIds = new Set(serverTaskLists.map((tl: { id: string }) => tl.id));
        const allLocalSynced = await db.taskLists.where('syncStatus').equals('synced')
          .filter(tl => tl.ownership !== 'shared').toArray();
        const toDeleteIds = allLocalSynced
          .filter(tl => !serverIds.has(tl.id) && !pendingTaskListDeleteIds.has(tl.id))
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
            const itemsToPut = tl.items
              .filter((item: { id: string }) => !pendingTaskItemDeleteIds.has(item.id))
              .map((item: Omit<LocalTaskItem, 'syncStatus'>) => ({
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
            // Whose list this row belongs to. On a shared board ownerId is the
            // OWNER, so useKanbanBoards has nothing else to scope by.
            viewerId: currentUserId,
            syncStatus: 'synced' as const,
          }));

        // [BACKUP] 2026-09-29 — 3.6: this prune used to skip shared rows ("shared handled
        // below"). A second block then re-pulled /share/kanbans/accepted only to prune them
        // and to rewrite rows this block had already written, worse: without shares/shareCount
        // and with the archived cards back in Dexie. /kanban/boards already lists the ACCEPTED
        // shared boards and the detail loop below pulls their columns and cards, so that block
        // is gone (see git history) and its prune lives here, with the same scope.
        // Derived from the RAW server response, not boardsToPut: a dirty row the server still
        // lists must not be taken for a deleted one.
        const serverIds = new Set(serverBoards.map(b => b.id));

        // Owned rows. Scoped to the current user's own rows: an unscoped scan here would
        // treat another account's still-valid synced board as "not on my server list"
        // and bulkDelete it (cascading to its columns/cards) the moment this user
        // pulls, race or not.
        const allLocalSyncedBoards = await db.kanbanBoards.where('syncStatus').equals('synced')
          .filter(b => b.ownership !== 'shared' && b.ownerId === currentUserId).toArray();
        const ownedToDeleteIds = allLocalSyncedBoards
          .filter(b => !serverIds.has(b.id) && !pendingBoardDeleteIds.has(b.id))
          .map(b => b.id);

        // Shared rows. Scoped to rows stamped for THIS viewer — a pre-upgrade row with no
        // viewerId can't be told apart from another account's leftover share, so it is
        // deliberately left out rather than guessed at (it stays hidden by useKanbanBoards).
        // No syncStatus filter: a share revoked while the row had local edits must still go,
        // the server rejects those edits anyway.
        const localSharedBoards = (await db.kanbanBoards.where('ownership').equals('shared').toArray())
          .filter(b => b.viewerId === currentUserId);
        const sharedToDeleteIds = localSharedBoards
          .filter(b => !serverIds.has(b.id))
          .map(b => b.id);

        const toDeleteIds = [...ownedToDeleteIds, ...sharedToDeleteIds];

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
          prunedBoardIds.push(...toDeleteIds);
        }

        if (boardsToPut.length > 0) await db.kanbanBoards.bulkPut(boardsToPut);
      });

      // Pull full board details (columns + cards) for each board whose content changed
      for (const board of serverBoards) {
        const pulledKey = `${currentUserId}:${board.id}`;
        const pulled = boardDetailsPulled.get(pulledKey);
        if (
          board.contentVersion &&
          pulled?.version === board.contentVersion &&
          Date.now() - pulled.at < BOARD_DETAILS_MAX_AGE_MS &&
          // Dexie cleared or partially written since (e.g. logout): pull again.
          (await db.kanbanColumns.where('boardId').equals(board.id).count()) === board.columnCount
        ) {
          continue;
        }
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
                isCompleted: col.isCompleted ?? false,
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
          // Only after the write landed: a failed pull must be retried next time.
          if (board.contentVersion) {
            boardDetailsPulled.set(pulledKey, { version: board.contentVersion, at: Date.now() });
          }
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
  return prunedBoardIds;
};


import { useAuthStore } from '../../store/authStore';

// [BACKUP] 2026-09-29 — kanban 3.4: was `let isSyncing = false;`. A call made while a
// push was running returned false at once and a follow-up ran 1 s later via
// setTimeout, so `await syncPush()` did not wait for anything: the kanban board
// refetched before a second quick move reached the server and the card jumped back.
let inFlight: Promise<boolean> | null = null;
let syncPushScheduled = false;

/**
 * A NOTE UPDATE or CREATE that moves the note or sets its tags references a notebook/tags
 * that may have been created offline too. If their CREATE is still queued and NOT
 * `failed` (pending or in backoff) the server does not know them yet: pushing now
 * 404s (updateNote verifies the notebook, P3) and the update would be dropped; a NOTE
 * CREATE would silently land in another notebook (note.service falls back).
 * Reads the live queue, so a CREATE pushed earlier in this same run no longer counts.
 * K1: a 'failed' reference CREATE does not hold an UPDATE; L6: for a note CREATE, a 'failed' NOTEBOOK CREATE still
 * counts as pending (the note stays local until the notebook is retried).
 */
async function hasQueuedReferenceCreate(item: SyncQueueItem): Promise<boolean> {
  const data = item.data as { notebookId?: string; tags?: { tag: { id: string } }[] } | undefined;
  // R5: a NOTE CREATE payload is a snapshot; the note may have been moved to another notebook since (the POST below
  // sends the current Dexie notebookId), so the reference to wait for is the current one.
  const local = item.entity === 'NOTE' && item.type === 'CREATE' ? await db.notes.get(item.entityId) : undefined;
  // S3: a NOTE CREATE whose Dexie row is gone (note deleted locally) has nothing to protect: don't hold it (or the
  // DELETE queued behind it) for a notebook CREATE.
  if (item.entity === 'NOTE' && item.type === 'CREATE' && !local) return false;
  const notebookId = local?.notebookId ?? data?.notebookId;
  const tagIds = new Set((data?.tags ?? []).map(t => t.tag.id));
  if (!notebookId && tagIds.size === 0) return false;
  const pending = await db.syncQueue
    // K1: a 'failed' CREATE is terminal (manual retry only): it must not hold the note forever.
    // The move then goes out, takes the 404/400 and revertRejectedNoteMove puts the note back.
    // L6: a NOTE CREATE is the exception for a failed NOTEBOOK CREATE: it would land in another notebook, so it
    // stays local (red banner) until the notebook is retried.
    .filter(i => i.userId === item.userId && i.type === 'CREATE' &&
      (i.status !== 'failed' || (item.type === 'CREATE' && i.entity === 'NOTEBOOK')) && (
      (i.entity === 'NOTEBOOK' && i.entityId === notebookId) ||
      (i.entity === 'TAG' && tagIds.has(i.entityId))
    ))
    .count();
  return pending > 0;
}

/**
 * The server rejected a note move because the target notebook is gone (deleted on
 * another device). The queue item is dropped, but the local note still points at
 * the dead notebook and, being dirty, syncPull would never correct it. Put it back
 * where the server has it — and mark it synced only when nothing else is queued for
 * it and it was not edited after the move, the same rule as a successful push.
 */
async function revertRejectedNoteMove(item: SyncQueueItem): Promise<void> {
  try {
    const { data: serverNote } = await api.get<{ notebookId: string }>(`/notes/${item.entityId}`);
    const local = await db.notes.get(item.entityId);
    if (!local || !serverNote?.notebookId) return;
    const stillQueued = await db.syncQueue
      .filter(i => i.entity === 'NOTE' && i.entityId === item.entityId)
      .count();
    const editedSince = new Date(local.updatedAt).getTime() > item.createdAt;
    await db.notes.update(
      item.entityId,
      stillQueued === 0 && !editedSince
        ? { notebookId: serverNote.notebookId, syncStatus: 'synced' as const }
        : { notebookId: serverNote.notebookId },
    );
    toast.error(i18n.t('sync.noteMoveReverted'));
  } catch (err) {
    // Offline again or the note is gone too: the next successful pull/push settles it.
    console.warn('Sync Push: could not restore the rejected note move:', item.entityId, err);
  }
}

/**
 * The server archived this note's content into its version history instead of
 * writing it, because the note is open in a live collab session (the live doc
 * wins). Tell the user, refresh the detail query so an open editor picks up
 * `sharedWith` and switches to the collab provider, and realign the local copy
 * with the server — syncPull preserves local content of non-dirty notes only
 * when it matches, so it would never realign it. Same safety rule as a
 * successful push: only when nothing is queued and the note was not edited since.
 */
async function handleContentDeferred(item: SyncQueueItem): Promise<void> {
  try {
    // Decide from state, not from this item's payload: the delete flow queues the content save and the
    // trash flag as two separate items, so the trash may be in Dexie or still waiting in the queue.
    const localNote = await db.notes.get(item.entityId);
    const queuedForNote = await db.syncQueue
      .filter(i => i.entity === 'NOTE' && i.entityId === item.entityId)
      .toArray();
    const isTrashed =
      localNote?.isTrashed === true ||
      (item.data as { isTrashed?: boolean } | undefined)?.isTrashed === true ||
      queuedForNote.some(i => (i.data as { isTrashed?: boolean } | undefined)?.isTrashed === true);
    if (!isTrashed) {
      toast(i18n.t('sync.contentDeferred'), { id: `content-deferred-${item.entityId}`, duration: 8000 });
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.notes.detail(item.entityId) });
    const { data: serverNote } = await api.get<{ content?: string }>(`/notes/${item.entityId}`);
    if (typeof serverNote?.content !== 'string') return;
    await db.transaction('rw', db.notes, db.syncQueue, async () => {
      const local = await db.notes.get(item.entityId);
      if (!local) return;
      const stillQueued = await db.syncQueue
        .filter(i => i.entity === 'NOTE' && i.entityId === item.entityId)
        .count();
      // G6/K3: realign only if Dexie still holds exactly the string that was pushed. No updatedAt check:
      // syncPull overwrites it with the server's value, so it says nothing about local edits.
      const sameAsPushed = local.content === (item.data as { content?: string } | undefined)?.content;
      if (stillQueued === 0 && sameAsPushed) {
        await db.notes.update(item.entityId, { content: serverNote.content, syncStatus: 'synced' as const });
      }
    });
  } catch (err) {
    // Offline again: the device keeps its text, which is already in the version history.
    console.warn('Sync Push: could not align the deferred note content:', item.entityId, err);
  }
}

// Retry backoff: track failures per queue item to avoid tight retry loops
const failureCounts = new Map<number, { count: number; nextRetryAt: number }>();
const MAX_RETRIES = 5;

// A transport failure (no `.response` -- see the `break` branch below) never
// reaches recordFailure, so it gets zero backoff and never increments
// `attempts`: a persistently-unreachable item (oversized payload reset by a
// proxy, a broken deployment link) would otherwise be retried at full
// frequency forever, head-of-line-blocking the whole queue with no signal
// ever reaching SyncStatusIndicator's red banner (status never becomes
// 'failed') and no escape hatch (retryFailedSyncItems only re-enables items
// already 'failed'). Track wall-clock elapsed since the FIRST transport
// failure for an item, not an attempt count -- retries aren't paced (a burst
// of local writes can trigger many pushes within seconds), so counting
// attempts would trip on activity level, not on how long the network has
// actually been broken. 10 minutes matches the order of magnitude of
// recordFailure's own worst-case backoff window (5-minute cap, ~7-10 min to
// reach MAX_RETRIES): long enough that an ordinary wifi blip or captive
// portal that clears in under a minute never trips it, short enough that
// the user isn't left with a silently wedged queue for the rest of the day.
// ponytail: in-memory only, resets on page reload (like failureCounts
// without its Dexie-seeded `attempts` backstop) -- an item is never lost by
// that, it just gets a fresh 10-minute window; add Dexie persistence only
// if "reload resets the clock" turns out to matter in practice.
const transportFailureSince = new Map<number, number>();
const TRANSPORT_FAILURE_CEILING_MS = 10 * 60 * 1000;

// S4: when retryFailedSyncItems refreshes a NOTE CREATE payload from Dexie, the payload now reflects the row at that
// moment, so the "modified since the item was created" check must compare against the refresh time, not item.createdAt.
// In-memory only (like failureCounts); dropped by clearFailure.
const createRefreshedAt = new Map<number, number>();

function shouldRetry(itemId: number | undefined): boolean {
  if (!itemId) return true;
  const info = failureCounts.get(itemId);
  if (!info) return true;
  if (info.count >= MAX_RETRIES) return false; // defensive backstop — terminal items are skipped via status==='failed' before this runs
  return Date.now() >= info.nextRetryAt;
}

// [BACKUP] 2026-06-11 — old recordFailure was in-memory only (sync surfacing M2 adds persistence):
// function recordFailure(itemId: number | undefined): void {
//   if (!itemId) return;
//   const info = failureCounts.get(itemId) || { count: 0, nextRetryAt: 0 };
//   info.count += 1;
//   // Exponential backoff: 5s, 15s, 45s, 135s, 405s
//   info.nextRetryAt = Date.now() + Math.min(5000 * Math.pow(3, info.count - 1), 5 * 60 * 1000);
//   failureCounts.set(itemId, info);
// }
async function recordFailure(item: SyncQueueItem, error: unknown): Promise<void> {
  if (!item.id) return;
  // Seed from persisted attempts so bounded retries survive page reloads
  const info = failureCounts.get(item.id) || { count: item.attempts ?? 0, nextRetryAt: 0 };
  info.count += 1;
  // Exponential backoff: 5s, 15s, 45s, 135s, 405s — ±20% jitter avoids synchronized retry storms
  const base = Math.min(5000 * Math.pow(3, info.count - 1), 5 * 60 * 1000);
  info.nextRetryAt = Date.now() + base + Math.round(base * 0.2 * (Math.random() * 2 - 1));
  failureCounts.set(item.id, info);

  const lastError = error instanceof Error ? error.message : String(error);
  try {
    if (info.count >= MAX_RETRIES) {
      await db.syncQueue.update(item.id, { attempts: info.count, status: 'failed' as const, lastError });
      // Terminal state — prune the in-memory map; only an explicit user retry re-enables the item
      failureCounts.delete(item.id);
    } else {
      await db.syncQueue.update(item.id, { attempts: info.count, status: 'pending' as const, lastError });
    }
  } catch (e) {
    console.error('Sync Push: failed to persist failure metadata', e);
    // Q6: never leave the in-memory count at MAX_RETRIES without a persisted 'failed' status: shouldRetry would
    // refuse the item forever with no banner. Step back so it is retried after the backoff.
    if (info.count >= MAX_RETRIES) {
      info.count = MAX_RETRIES - 1;
      failureCounts.set(item.id, info);
    }
  }
}

/**
 * Q1/Q3: after `done` left the queue (2xx, or 404/410 for a DELETE), drop the earlier items of the same entity it
 * makes obsolete. DELETE: all of them. UPDATE: the earlier 'failed' UPDATEs whose data keys are all contained in its
 * own, so a manual retry can never restore older values. Best-effort: a failure here only leaves items for later.
 */
async function dropSupersededItems(done: SyncQueueItem): Promise<void> {
  if (done.type === 'CREATE' || done.id === undefined) return;
  try {
    const keysOf = (d: unknown) => Object.keys((d ?? {}) as object);
    const doneKeys = new Set(keysOf(done.data));
    const doneId = done.id;
    const all = await db.syncQueue.toArray();
    const victims = all.filter(i =>
      i.id !== undefined && i.id !== doneId &&
      i.userId === done.userId && i.entity === done.entity && i.entityId === done.entityId &&
      (i.createdAt < done.createdAt || (i.createdAt === done.createdAt && i.id < doneId)) &&
      (done.type === 'DELETE' ||
        (i.status === 'failed' && i.type === 'UPDATE' && keysOf(i.data).length > 0 && keysOf(i.data).every(k => doneKeys.has(k)))));
    // A TASK_LIST delete is a soft-trash: the TASK_ITEM rows stay in Dexie, so O1 (entityRowExists) never drops their
    // queued items. Purge them by parent id. (Kanban board/column deletes hard-delete the child Dexie rows, so O1
    // already covers those.)
    if (done.type === 'DELETE' && done.entity === 'TASK_LIST') {
      for (const i of all) {
        if (i.id !== undefined && i.userId === done.userId && i.entity === 'TASK_ITEM' &&
          (i.data as { taskListId?: string } | undefined)?.taskListId === done.entityId) victims.push(i);
      }
    }
    for (const v of victims) {
      await db.syncQueue.delete(v.id as number);
      clearFailure(v.id);
    }
  } catch (e) {
    console.warn('Sync Push: could not drop superseded queue items:', done.entity, done.entityId, e);
  }
}

/**
 * O1: false only when the entity's Dexie row is CONFIRMED gone. Soft-deleted rows (e.g. trashed task lists) still
 * exist in Dexie, so they count as present. A Dexie error counts as present (never drop on doubt).
 */
async function entityRowExists(item: SyncQueueItem): Promise<boolean> {
  const tables: Record<SyncQueueItem['entity'], { get(k: string): Promise<unknown> }> = {
    NOTE: db.notes, NOTEBOOK: db.notebooks, TAG: db.tags, TASK_LIST: db.taskLists, TASK_ITEM: db.taskItems,
    KANBAN_BOARD: db.kanbanBoards, KANBAN_COLUMN: db.kanbanColumns, KANBAN_CARD: db.kanbanCards,
  };
  try {
    return !!(await tables[item.entity].get(item.entityId));
  } catch (e) {
    console.warn('Sync Push: could not check the Dexie row of', item.entity, item.entityId, e);
    return true;
  }
}

/** O1: remove `item` (a CREATE of an entity that no longer exists locally) and every later queue item of that entity. */
async function dropOrphanedEntityItems(item: SyncQueueItem): Promise<number[]> {
  const dropped: number[] = [];
  try {
    const all = await db.syncQueue.toArray();
    const victims = all.filter(i => i.id !== undefined &&
      (i.id === item.id ||
        (i.userId === item.userId && i.entity === item.entity && i.entityId === item.entityId &&
          (i.createdAt > item.createdAt || (i.createdAt === item.createdAt && i.id > (item.id ?? 0))))));
    if (item.id !== undefined && !victims.some(v => v.id === item.id)) await db.syncQueue.delete(item.id);
    for (const v of victims) {
      await db.syncQueue.delete(v.id as number);
      clearFailure(v.id);
      dropped.push(v.id as number);
    }
  } catch (e) {
    console.warn('Sync Push: could not drop orphaned queue items:', item.entity, item.entityId, e);
  }
  if (item.id !== undefined) { clearFailure(item.id); dropped.push(item.id); }
  return dropped;
}

function clearFailure(itemId: number | undefined): void {
  if (itemId) {
    failureCounts.delete(itemId);
    transportFailureSince.delete(itemId);
    createRefreshedAt.delete(itemId);
  }
}

/**
 * A queued card CREATE/move payload can carry a DEAD column id: the
 * KANBAN_BOARD/CREATE branch below remaps local column ids to server ids
 * after the board round-trips (and repoints the card's Dexie row), but
 * never rewrites payloads already sitting in the queue. Dexie's card row
 * is more current — but only trust its columnId once that column is
 * confirmed synced.
 *
 * That guard matters for the opposite race too: add a card to an
 * already-synced column, then add a NEW column, then drag the card into
 * it, all offline. Dexie's card row now points at the new column, but
 * that column's own CREATE is a later, still-unprocessed queue item — the
 * card would 404 against a column that doesn't exist YET rather than one
 * that's dead. Falling back to the queued value when the Dexie column
 * isn't 'synced' keeps the original (still-valid) destination instead.
 */
async function resolveCardColumnId(cardId: string, queuedColumnId: string | undefined): Promise<string | undefined> {
  const dexieColumnId = (await db.kanbanCards.get(cardId))?.columnId;
  if (!dexieColumnId) return queuedColumnId;
  const dexieCol = await db.kanbanColumns.get(dexieColumnId);
  return dexieCol?.syncStatus === 'synced' ? dexieColumnId : queuedColumnId;
}

/**
 * Returns whether the run pushed at least one item to the server — NOT just
 * whether it ran without throwing. Callers (useSync, useKanbanMutations) use
 * this to decide whether to invalidate the kanban react-query cache:
 * invalidating after a run that pushed nothing (empty queue, offline, logged
 * out) would be pointless at best and a refetch storm at worst, since syncPush
 * also runs on every 30s tick whether or not there's anything to do.
 * A call made while a run is in progress shares that run (and its result),
 * which then makes one more pass for what was queued meanwhile.
 * A transport-failure `break` partway through still returns true if earlier
 * items in the same run succeeded — those did change server state.
 */
export const syncPush = (): Promise<boolean> => {
  // ponytail: cheap bail-out before touching Dexie or the queue at all. Does
  // NOT cover a captive portal / connected-but-dead network — navigator.onLine
  // stays true there — the response-less-error `break` below is what catches
  // that case, by stopping the run after the first request that never gets a
  // reply instead of relying on this flag to have caught it up front.
  if (!navigator.onLine) return Promise.resolve(false);
  if (inFlight) {
    // Never two runs at once. The caller gets the run in progress, which makes
    // one more pass for whatever this caller just queued: its await resolves
    // only once that is on the server (or the run gave up).
    syncPushScheduled = true;
    return inFlight;
  }
  inFlight = (async () => {
    let pushedAny = false;
    try {
      do {
        syncPushScheduled = false;
        if (await pushQueueOnce()) pushedAny = true;
      } while (syncPushScheduled && navigator.onLine);
      return pushedAny;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
};

/** One pass over the current user's queue. Only syncPush calls it, never two at once. */
const pushQueueOnce = async (): Promise<boolean> => {
  let pushedAny = false;
  const currentUserId = useAuthStore.getState().user?.id;
  if (!currentUserId) return false; // Cannot sync if not logged in

  // Filter queue by userId.
  // We only process items that belong to the current user.
  // Legacy items without userId will be ignored (and potentially cleaned up later or stuck, which prevents leakage).
  const allQueue = await db.syncQueue.orderBy('createdAt').toArray();
  const queue = allQueue.filter(item => item.userId === currentUserId);

  // J1: FIFO per entity. Once an item of an entity is skipped (backoff / waiting on a reference) or fails with
  // a retryable error, every LATER item of that entity is skipped in this run (stays pending, attempts untouched):
  // a stale UPDATE must not overtake the earlier one.
  // Q1: a CREATE of the entity that is 'failed' (any reason) or fails in this run holds back every later item of the
  // entity except DELETE (an UPDATE would 404 against an entity the server never got). The DELETE goes out and, once
  // done, purges the earlier items (dropSupersededItems).
  // Q3: a non-CREATE 'failed' item never blocks (it would wedge the entity: a deterministic 413/5xx retries the same
  // payload forever); a later UPDATE that covers its keys supersedes it (dropSupersededItems).
  const blocked = new Set<string>();
  const failedCreate = new Set<string>();
  for (const item of queue) {
    const entityKey = `${item.entity}:${item.entityId}`;
    // Failed items are terminal — only an explicit user retry (retryFailedSyncItems) re-enables them
    if (item.status === 'failed') {
      if (item.type === 'CREATE') failedCreate.add(entityKey);
      continue;
    }
    if (blocked.has(entityKey)) continue;
    if (failedCreate.has(entityKey) && item.type !== 'DELETE') continue;
    // Skip items in backoff period
    if (!shouldRetry(item.id)) { blocked.add(entityKey); continue; }

    // Wait for the notebook/tags this note update references to reach the server
    // first. Not a failure: no backoff, the item simply stays queued for the next run.
    if (item.entity === 'NOTE' && (item.type === 'UPDATE' || item.type === 'CREATE') && await hasQueuedReferenceCreate(item)) { blocked.add(entityKey); continue; }

    let contentDeferred = false;
    try {
      if (item.entity === 'NOTE') {
        // Safety: never push shared notes to REST API
        const localNote = await db.notes.get(item.entityId);
        if (localNote?.ownership === 'shared') {
          if (item.id) await db.syncQueue.delete(item.id);
          clearFailure(item.id);
          continue;
        }
        if (item.type === 'CREATE') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { id, ...data } = item.data as any;
          // R5: current notebook from Dexie (the payload may predate a move of the note)
          await api.post('/notes', { ...data, notebookId: localNote?.notebookId ?? data.notebookId, id });
        } else if (item.type === 'UPDATE') {
          const res = await api.put(`/notes/${item.entityId}`, item.data);
          contentDeferred = res?.data?.contentDeferred === true;
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
        } else if (item.type === 'UPDATE') {
          await api.put(`/tags/${item.entityId}`, item.data);
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
        // [BACKUP] 2026-09-01 — used to skip ANY queued item for a shared board
        // and delete it without calling the API at all ("never push shared
        // boards to REST API"). The backend explicitly authorizes a WRITE
        // collaborator's board update (assertBoardAccess(id, userId, 'WRITE')
        // in board.service.ts) and the UI offers a rename to one — dropping the
        // queue item made the edit look like it saved, then the next pull
        // silently reverted it, with no error surfaced (the item was deleted,
        // not failed). An unauthorized case still fails loudly: a 403 is
        // already handled as terminal below.
        //   const localBoard = await db.kanbanBoards.get(item.entityId);
        //   if (localBoard?.ownership === 'shared') {
        //     if (item.id) await db.syncQueue.delete(item.id);
        //     clearFailure(item.id);
        //     continue;
        //   }
        if (item.type === 'CREATE') {
          const boardData = item.data as Record<string, unknown>;
          const localColumnIds = (boardData._localColumnIds as string[] | undefined) || [];
          // Don't send internal metadata to the API
          const { _localColumnIds, ...apiData } = boardData;
          void _localColumnIds; // suppress unused lint
          const res = await api.post('/kanban/boards', { ...apiData, id: item.entityId });
          // Reconcile local column IDs with server-generated column IDs (by position)
          if (localColumnIds.length > 0 && res.data?.columns) {
            const serverColumns = (res.data.columns as { id: string; position: number }[])
              .sort((a, b) => a.position - b.position);
            const sortedLocalIds = [...localColumnIds]; // already in position order (0, 1, 2)
            await db.transaction('rw', db.kanbanColumns, db.kanbanCards, async () => {
              for (let i = 0; i < Math.min(sortedLocalIds.length, serverColumns.length); i++) {
                const localId = sortedLocalIds[i];
                const serverId = serverColumns[i].id;
                if (localId === serverId) continue;
                // Update any cards referencing the local column ID
                const cardsInCol = await db.kanbanCards.where('columnId').equals(localId).toArray();
                for (const card of cardsInCol) {
                  await db.kanbanCards.update(card.id, { columnId: serverId });
                }
                // Replace local column with server column
                const localCol = await db.kanbanColumns.get(localId);
                if (localCol) {
                  await db.kanbanColumns.delete(localId);
                  await db.kanbanColumns.put({ ...localCol, id: serverId, syncStatus: 'synced' });
                }
              }
            });
          }
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
          // See resolveCardColumnId() above for why this reads Dexie instead
          // of trusting the queued payload outright.
          // The stale columnId left in the body is harmless: createCardSchema
          // (backend/src/routes/kanban.ts:41-45) strips unknown keys and the
          // column comes from the URL.
          const queuedColumnId = (item.data as Record<string, unknown> | undefined)?.columnId as string | undefined;
          const columnId = await resolveCardColumnId(item.entityId, queuedColumnId);
          await api.post(`/kanban/columns/${columnId}/cards`, { ...item.data, id: item.entityId });
        } else if (item.type === 'UPDATE') {
          const cardData = item.data as Record<string, unknown> | undefined;
          if (cardData?.columnId) {
            // Move operation — route to dedicated move endpoint. Same dead/not-yet-
            // created column id hazard as the CREATE branch — see resolveCardColumnId().
            const toColumnId = await resolveCardColumnId(item.entityId, cardData.columnId as string);
            // Kanban 5.6: a bulk move is announced by one grouped notification
            // (POST bulk-move-notify), so each of its moves goes out silent.
            await api.put(`/kanban/cards/${item.entityId}/move${cardData.silent ? '?silent=true' : ''}`, {
              toColumnId,
              position: cardData.position ?? 0,
            });
          } else {
            await api.put(`/kanban/cards/${item.entityId}`, item.data);
          }
        } else if (item.type === 'DELETE') {
          await api.delete(`/kanban/cards/${item.entityId}`);
        }
      }

      // S4: read before clearFailure() drops it
      const refreshedAt = item.id ? createRefreshedAt.get(item.id) : undefined;
      // If successful, remove from queue and clear backoff
      if (item.id) await db.syncQueue.delete(item.id);
      clearFailure(item.id);
      await dropSupersededItems(item);
      pushedAny = true;
      // G6: fire-and-forget (never throws: try/catch covers the whole body) so its GET cannot stall the push queue.
      if (contentDeferred) void handleContentDeferred(item);

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

            if (currentNote && updatedAtMs <= Math.max(item.createdAt, refreshedAt ?? 0)) {
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
      // Q1/Q2: a CREATE that fails in this run (any branch) holds back the later items of its entity.
      if (item.type === 'CREATE') blocked.add(entityKey);
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 503 && (error as { response?: { data?: { message?: string } } })?.response?.data?.message === 'errors.notes.archiveBusy') {
        // K2: transient server congestion, not a rejection of the payload: no attempt consumed, item stays
        // pending. Fixed 2 min pause (same in-memory map as the backoff), later items of the note wait.
        if (item.id) {
          const info = failureCounts.get(item.id) || { count: item.attempts ?? 0, nextRetryAt: 0 };
          info.nextRetryAt = Date.now() + 2 * 60 * 1000;
          failureCounts.set(item.id, info);
        }
        blocked.add(entityKey);
        console.warn('Sync Push: archiveBusy, retrying in 2 min:', item.entity, item.entityId);
      } else if ((status === 404 || status === 410) && item.type !== 'CREATE') {
        // Resource no longer exists on server — remove from queue to stop infinite retries.
        // NOT for a CREATE: a 404/410 there means the thing the user made never reached
        // the server, so silently dropping it would make it vanish with no trace. (A
        // column reconciled to 'synced' and then locally re-edited to 'updated' makes
        // resolveCardColumnId distrust it and fall back to a dead queued column id,
        // which is exactly how a card CREATE reaches a 404 here.)
        console.warn(`Sync Push: Removing item (server returned ${status}):`, item.entity, item.entityId);
        if (item.id) await db.syncQueue.delete(item.id);
        clearFailure(item.id);
        // M3: a DELETE that finds the entity already gone still converges: purge the earlier items.
        if (item.type === 'DELETE') await dropSupersededItems(item);
        const errorKey = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
        if (item.entity === 'NOTE' && item.type === 'UPDATE' && errorKey === 'errors.notebooks.notFound') {
          await revertRejectedNoteMove(item);
        }
      } else if ((status === 404 || status === 410) && !(await entityRowExists(item))) {
        // O1: the entity was deleted locally (its Dexie row is gone) before this CREATE ever reached the server:
        // nothing to surface, drop the CREATE and the later items of the same entity.
        console.warn(`Sync Push: CREATE returned ${status} for an entity no longer in Dexie, dropping:`, item.entity, item.entityId);
        await dropOrphanedEntityItems(item);
      } else if (status === 404 || status === 410) {
        // Same status, but a CREATE — surface it instead (status: 'failed' lights up
        // SyncStatusIndicator's red banner + retry button), same treatment as 400/422.
        console.error(`Sync Push: CREATE returned ${status}, marking failed instead of dropping:`, item.entity, item.entityId);
        if (item.id) {
          await db.syncQueue.update(item.id, { status: 'failed' as const, lastError: 'not_found' });
        }
        clearFailure(item.id);
      } else if (status === 400 || status === 413 || status === 422 ||
        // R6: a 409 on a client-id CREATE of NOTEBOOK/TAG (unique name clash) is as deterministic as a 400
        (status === 409 && item.type === 'CREATE' && (item.entity === 'NOTEBOOK' || item.entity === 'TAG'))) {
        // 413 (payload too large) is as deterministic as 400/422: the same bytes would be rejected on every retry.
        // [BACKUP] 2026-08-23 — 400/422 previously fell through to recordFailure()
        // (backoff retry). A validation error is permanent: the queued payload is
        // byte-identical on every attempt, so the item stayed poisoned in the queue
        // and retried forever (observed in prod: a kanban card whose title exceeded
        // the backend's 500-char cap). Mark it 'failed' immediately so
        // SyncStatusIndicator surfaces it instead of looping silently.
        console.error('Sync Push: validation rejected by server, marking failed:', item.entity, item.entityId, error);
        if (item.id) {
          await db.syncQueue.update(item.id, { status: 'failed' as const, lastError: 'validation' });
        }
        clearFailure(item.id);
      } else if (status === 403) {
        // Forbidden is permanent (insufficient permission) — retrying will never
        // succeed. Mark the item 'failed' IMMEDIATELY (instead of ~5 backoff
        // retries over ~10 min) so SyncStatusIndicator surfaces it to the user
        // right away (error toast + retry banner) rather than failing silently.
        console.error('Sync Push: forbidden (permission denied), marking failed:', item.entity, item.entityId);
        if (item.id) {
          await db.syncQueue.update(item.id, { status: 'failed' as const, lastError: 'forbidden' });
        }
        clearFailure(item.id);
      } else if (!(error as { response?: unknown })?.response) {
        // Transport failure: the request never got a reply at all (network
        // drop, DNS failure, timeout) — not the server rejecting this
        // item's payload. Don't burn a retry attempt on it (recordFailure
        // is for the server saying no, not for the network being gone),
        // and stop the whole run instead of walking the rest of the queue:
        // every item after this one would fail the exact same way for a
        // reason that belongs to none of them. The next syncPush call
        // (periodic retry, or the next local write) starts over from here.
        if (item.id) {
          const since = transportFailureSince.get(item.id) ?? Date.now();
          transportFailureSince.set(item.id, since);
          if (Date.now() - since >= TRANSPORT_FAILURE_CEILING_MS) {
            // Stuck for ~10 real minutes, not just N attempts — surface it
            // the same way a genuine server rejection does (status:
            // 'failed' lights up SyncStatusIndicator's red banner + retry
            // button; retryFailedSyncItems re-enables it), without ever
            // touching `attempts`, which stays reserved for real rejections.
            console.error('Sync Push: transport failure persisted past the 10min ceiling, marking failed:', item.entity, item.entityId);
            await db.syncQueue.update(item.id, { status: 'failed' as const, lastError: 'network' });
            transportFailureSince.delete(item.id);
          }
        }
        console.error('Sync Push: transport failure, stopping run:', item.entity, item.entityId, error);
        break;
      } else {
        await recordFailure(item, error);
        // Still retryable (not promoted to terminal 'failed'): hold back the entity's later items.
        if (item.id && failureCounts.has(item.id)) blocked.add(entityKey);
        console.error('Sync Push Failed for item:', item, error);
      }
    }
  }

  return pushedAny;
};

// T2: user-editable fields a failed CREATE refreshes from the current Dexie row (see retryFailedSyncItems).
const CREATE_REFRESH_FIELDS = {
  KANBAN_CARD: ['title', 'description'],
  TASK_ITEM: ['text', 'priority', 'dueDate'],
  TASK_LIST: ['title'],
  KANBAN_BOARD: ['title', 'description'],
  KANBAN_COLUMN: ['title'],
} as const;
const refreshRowTables = (): Record<keyof typeof CREATE_REFRESH_FIELDS, { get(k: string): Promise<unknown> }> => ({
  KANBAN_CARD: db.kanbanCards, TASK_ITEM: db.taskItems, TASK_LIST: db.taskLists,
  KANBAN_BOARD: db.kanbanBoards, KANBAN_COLUMN: db.kanbanColumns,
});

/**
 * Re-enable all failed queue items for the current user and trigger a push.
 * Called from the SyncStatusIndicator retry action.
 */
export const retryFailedSyncItems = async (): Promise<void> => {
  const currentUserId = useAuthStore.getState().user?.id;
  if (!currentUserId) return;
  const failed = await db.syncQueue.where('status').equals('failed')
    .filter(item => item.userId === currentUserId).toArray();
  const dropped = new Set<number>();
  for (const item of failed) {
    if (!item.id || dropped.has(item.id)) continue;
    // O1: a failed CREATE whose entity no longer exists locally has nothing left to retry: drop it and its followers.
    if (item.type === 'CREATE' && !(await entityRowExists(item))) {
      for (const id of await dropOrphanedEntityItems(item)) dropped.add(id);
      continue;
    }
    // clearFailure(), not a bare failureCounts.delete(): it also drops any
    // stale transportFailureSince entry, so a fresh transport failure right
    // after this retry gets its own 10-minute window instead of inheriting
    // one that may already be nearly (or fully) elapsed.
    clearFailure(item.id);
    // P1 (replaces the old L2 re-queue of an UPDATE {title, content}): a failed CREATE may carry a stale or
    // rejected payload (e.g. oversized content, or UPDATEs dropped on an old 404). Refresh the user-editable
    // fields from the CURRENT Dexie row, so after the retry the server receives the Dexie values. Queued UPDATEs
    // that follow still apply in order and end on the same values. Vault/encrypted notes and missing rows are left
    // untouched.
    let data: Record<string, unknown> | undefined;
    if (item.type === 'CREATE') {
      try {
        let fields: Record<string, unknown> | undefined;
        if (item.entity === 'NOTE') {
          const n = await db.notes.get(item.entityId);
          // S2: the payload flags count too (a Dexie row can have lost them while the queued payload is ciphertext)
          const p = item.data as { isVault?: boolean; isEncrypted?: boolean } | undefined;
          if (n && !n.isVault && !n.isEncrypted && !p?.isVault && !p?.isEncrypted) {
            fields = { title: n.title, content: n.content };
            createRefreshedAt.set(item.id, Date.now());
          }
        } else if (item.entity === 'NOTEBOOK') {
          const nb = await db.notebooks.get(item.entityId);
          if (nb) fields = { name: nb.name };
        } else if (item.entity === 'TAG') {
          const t = await db.tags.get(item.entityId);
          if (t) fields = { name: t.name };
        } else if (item.entity in CREATE_REFRESH_FIELDS) {
          // Only keys already in the queued payload are refreshed (the CREATE schema may not accept others). A null
          // optional value is dropped (create schemas take optional-but-not-nullable), except dueDate which is nullable.
          const row = await refreshRowTables()[item.entity as keyof typeof CREATE_REFRESH_FIELDS].get(item.entityId) as Record<string, unknown> | undefined;
          if (row) {
            const payload = { ...(item.data as Record<string, unknown>) };
            for (const f of CREATE_REFRESH_FIELDS[item.entity as keyof typeof CREATE_REFRESH_FIELDS]) {
              if (!(f in payload) || row[f] === undefined) continue;
              if (row[f] !== null) payload[f] = row[f];
              else if (f === 'dueDate') payload[f] = null;
              else if (f === 'description') delete payload[f];
            }
            data = payload;
          }
        }
        if (fields) data = { ...(item.data as Record<string, unknown>), ...fields };
      } catch (e) {
        console.warn('Sync Push: could not refresh the CREATE payload from Dexie:', e);
      }
    }
    await db.syncQueue.update(item.id, { status: 'pending' as const, attempts: 0, ...(data ? { data } : {}) });
  }
  // The liveQuery count doesn't change on status updates, so useSync won't re-fire — push explicitly
  if (failed.length > 0) void syncPush();
};

