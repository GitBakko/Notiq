# Notiq Tech Debt Roadmap — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Address 41 technical debt findings across 4 independently deployable phases, from P0 (Kanban offline sync + group sharing) through P3 (polish + backlog).

**Architecture:** Offline-first Dexie sync extended to Kanban (3 new tables, v14), group sharing unified across all 4 entity types, security hardening via indexes + auth + rate limits, quality improvements via E2E tests + type safety + vault KDF migration.

**Tech Stack:** Dexie.js v14, Prisma 7 migrations, Fastify 5 rate-limiting, CryptoJS PBKDF2, Playwright E2E, vitest backend unit tests.

**Design doc:** `docs/plans/2026-02-25-tech-debt-roadmap-design.md`

---

## Phase 1: Kanban Offline + Group Sharing (v1.7.0)

**Session scope:** 13 tasks. Adds kanban to Dexie offline sync + group sharing for kanban boards and task lists.

**Key patterns to follow:**
- Dexie offline: `frontend/src/features/tasks/taskListService.ts` (write Dexie → syncQueue → sync)
- syncPull/syncPush: `frontend/src/features/sync/syncService.ts` (dirty-id skip, zombie prevention, cascade delete)
- Group sharing backend: `backend/src/routes/sharing.ts:172-227` (loop group members, call existing share fn)
- Group sharing frontend: `frontend/src/features/tasks/TaskListSharingModal.tsx:95-145` (group select + Orbit button)

---

### Task 1: Dexie Kanban Interfaces

**Files:**
- Modify: `frontend/src/lib/db.ts`

**Step 1: Add interfaces after `LocalTaskItem` (after line 98)**

```typescript
export interface LocalKanbanBoard {
  id: string;
  title: string;
  description?: string | null;
  coverImage?: string | null;
  avatarUrl?: string | null;
  ownerId: string;
  noteId?: string | null;
  noteLinkedById?: string | null;
  createdAt: string;
  updatedAt: string;
  ownership: 'owned' | 'shared';
  sharedPermission?: 'READ' | 'WRITE' | null;
  sharedByUser?: { id: string; name: string | null; email: string } | null;
  syncStatus: 'synced' | 'pending' | 'error';
}

export interface LocalKanbanColumn {
  id: string;
  title: string;
  position: number;
  boardId: string;
  syncStatus: 'synced' | 'pending' | 'error';
}

export interface LocalKanbanCard {
  id: string;
  title: string;
  description?: string | null;
  position: number;
  columnId: string;
  boardId: string;
  assigneeId?: string | null;
  assignee?: { id: string; name: string | null; email: string; color?: string | null; avatarUrl?: string | null } | null;
  dueDate?: string | null;
  noteId?: string | null;
  noteLinkedById?: string | null;
  createdAt: string;
  updatedAt: string;
  syncStatus: 'synced' | 'pending' | 'error';
}
```

**Step 2: Extend SyncQueueItem entity union (line ~103)**

Change:
```typescript
entity: 'NOTE' | 'NOTEBOOK' | 'TAG' | 'TASK_LIST' | 'TASK_ITEM';
```
To:
```typescript
entity: 'NOTE' | 'NOTEBOOK' | 'TAG' | 'TASK_LIST' | 'TASK_ITEM' | 'KANBAN_BOARD' | 'KANBAN_COLUMN' | 'KANBAN_CARD';
```

**Step 3: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: 0 errors

**Step 4: Commit**

```bash
git add frontend/src/lib/db.ts
git commit -m "feat(sync): add Dexie interfaces for kanban offline"
```

---

### Task 2: Dexie v14 Schema

**Files:**
- Modify: `frontend/src/lib/db.ts`

**Step 1: Add table declarations to class body (after taskItems declaration)**

```typescript
kanbanBoards!: Dexie.Table<LocalKanbanBoard, string>;
kanbanColumns!: Dexie.Table<LocalKanbanColumn, string>;
kanbanCards!: Dexie.Table<LocalKanbanCard, string>;
```

**Step 2: Add version 14 after v13 (after line ~191)**

```typescript
this.version(14).stores({
  notes: 'id, notebookId, userId, isTrashed, isPinned, isVault, createdAt, syncStatus, ownership, noteType',
  notebooks: 'id, userId, syncStatus',
  tags: 'id, userId, isVault, syncStatus',
  taskLists: 'id, userId, isTrashed, syncStatus, ownership',
  taskItems: 'id, taskListId, syncStatus',
  kanbanBoards: 'id, ownerId, syncStatus, ownership',
  kanbanColumns: 'id, boardId, syncStatus',
  kanbanCards: 'id, columnId, boardId, syncStatus',
  syncQueue: '++id, entity, entityId, userId',
});
```

**Important:** Copy ALL existing stores from v13 and add the 3 new ones. Never modify existing index definitions.

**Step 3: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: 0 errors

**Step 4: Commit**

```bash
git add frontend/src/lib/db.ts
git commit -m "feat(sync): add Dexie v14 with kanban tables"
```

---

### Task 3: Backend Kanban Sync Endpoint

**Files:**
- Modify: `backend/src/services/kanban.service.ts` — add `getKanbanSyncData()`
- Modify: `backend/src/routes/kanban.ts` — add `GET /sync`

**Step 1: Add sync function in kanban.service.ts (after `listBoards`)**

```typescript
export const getKanbanSyncData = async (userId: string) => {
  const [ownedBoards, sharedEntries] = await Promise.all([
    prisma.kanbanBoard.findMany({
      where: { ownerId: userId },
      include: {
        columns: {
          orderBy: { position: 'asc' },
          include: {
            cards: {
              orderBy: { position: 'asc' },
              include: {
                assignee: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
              },
            },
          },
        },
      },
    }),
    prisma.sharedKanbanBoard.findMany({
      where: { userId, status: 'ACCEPTED' },
      include: {
        board: {
          include: {
            columns: {
              orderBy: { position: 'asc' },
              include: {
                cards: {
                  orderBy: { position: 'asc' },
                  include: {
                    assignee: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
                  },
                },
              },
            },
            owner: { select: { id: true, name: true, email: true } },
          },
        },
      },
    }),
  ]);

  const boards: Record<string, unknown>[] = [];
  const columns: Record<string, unknown>[] = [];
  const cards: Record<string, unknown>[] = [];

  const processBoard = (board: typeof ownedBoards[0], ownership: string, sharedPermission: string | null, sharedByUser: unknown) => {
    boards.push({
      id: board.id, title: board.title, description: board.description,
      coverImage: board.coverImage, avatarUrl: board.avatarUrl, ownerId: board.ownerId,
      noteId: board.noteId, noteLinkedById: board.noteLinkedById,
      createdAt: board.createdAt.toISOString(), updatedAt: board.updatedAt.toISOString(),
      ownership, sharedPermission, sharedByUser,
    });
    for (const col of board.columns) {
      columns.push({ id: col.id, title: col.title, position: col.position, boardId: col.boardId });
      for (const card of col.cards) {
        cards.push({
          id: card.id, title: card.title, description: card.description,
          position: card.position, columnId: card.columnId, boardId: col.boardId,
          assigneeId: card.assigneeId, assignee: card.assignee,
          dueDate: card.dueDate?.toISOString() ?? null,
          noteId: card.noteId, noteLinkedById: card.noteLinkedById,
          createdAt: card.createdAt.toISOString(), updatedAt: card.updatedAt.toISOString(),
        });
      }
    }
  };

  for (const board of ownedBoards) processBoard(board, 'owned', null, null);
  for (const share of sharedEntries) processBoard(share.board as any, 'shared', share.permission, (share.board as any).owner);

  return { boards, columns, cards };
};
```

**Step 2: Add route in kanban.ts (inside the authenticated block, before board routes)**

```typescript
fastify.get('/sync', async (request) => {
  return kanbanService.getKanbanSyncData(request.user.id);
});
```

**Step 3: Verify**

Run: `cd backend && npx tsc --noEmit`
Expected: 0 errors

**Step 4: Commit**

```bash
git add backend/src/services/kanban.service.ts backend/src/routes/kanban.ts
git commit -m "feat(sync): add kanban sync endpoint for offline pull"
```

---

### Task 4: syncPull — Kanban Data

**Files:**
- Modify: `frontend/src/features/sync/syncService.ts`

**Step 1: Add import at top**

```typescript
import type { LocalKanbanBoard, LocalKanbanColumn, LocalKanbanCard } from '../../lib/db';
```

**Step 2: Add kanban pull block at end of syncPull (after shared task lists, before final catch)**

Follow patterns from existing pull blocks. Key structure:

```typescript
// Pull Kanban (boards + columns + cards in one request)
const kanbanRes = await api.get<{
  boards: LocalKanbanBoard[];
  columns: LocalKanbanColumn[];
  cards: LocalKanbanCard[];
}>('/kanban/sync');

await db.transaction('rw', db.kanbanBoards, db.kanbanColumns, db.kanbanCards, db.syncQueue, async () => {
  // Zombie prevention: skip entities with pending deletes
  const pendingDeletes = await db.syncQueue
    .where('entity').anyOf(['KANBAN_BOARD', 'KANBAN_COLUMN', 'KANBAN_CARD'])
    .and(item => item.type === 'DELETE')
    .toArray();
  const pendingDeleteIds = new Set(pendingDeletes.map(i => i.entityId));

  // Dirty items: skip items being locally modified
  const dirtyBoards = await db.kanbanBoards.where('syncStatus').notEqual('synced').toArray();
  const dirtyBoardIds = new Set(dirtyBoards.map(b => b.id));
  const dirtyColumns = await db.kanbanColumns.where('syncStatus').notEqual('synced').toArray();
  const dirtyColumnIds = new Set(dirtyColumns.map(c => c.id));
  const dirtyCards = await db.kanbanCards.where('syncStatus').notEqual('synced').toArray();
  const dirtyCardIds = new Set(dirtyCards.map(c => c.id));

  // ── Boards ──
  const serverBoards = kanbanRes.data.boards.map(b => ({ ...b, syncStatus: 'synced' as const }));
  const boardsToPut = serverBoards.filter(b => !dirtyBoardIds.has(b.id) && !pendingDeleteIds.has(b.id));
  const serverBoardIds = new Set(serverBoards.map(b => b.id));

  // Delete synced boards that no longer exist on server + cascade
  const localSyncedBoards = await db.kanbanBoards.where('syncStatus').equals('synced').toArray();
  const boardsToDelete = localSyncedBoards.filter(b => !serverBoardIds.has(b.id)).map(b => b.id);
  if (boardsToDelete.length > 0) {
    await db.kanbanCards.where('boardId').anyOf(boardsToDelete).delete();
    const colKeys = await db.kanbanColumns.where('boardId').anyOf(boardsToDelete).primaryKeys();
    await db.kanbanColumns.bulkDelete(colKeys);
    await db.kanbanBoards.bulkDelete(boardsToDelete);
  }
  await db.kanbanBoards.bulkPut(boardsToPut);

  // ── Columns ──
  const serverColumns = kanbanRes.data.columns.map(c => ({ ...c, syncStatus: 'synced' as const }));
  const columnsToPut = serverColumns.filter(c => !dirtyColumnIds.has(c.id) && !pendingDeleteIds.has(c.id));
  const serverColumnIds = new Set(serverColumns.map(c => c.id));

  const localSyncedColumns = await db.kanbanColumns.where('syncStatus').equals('synced').toArray();
  const colsToDelete = localSyncedColumns.filter(c => !serverColumnIds.has(c.id)).map(c => c.id);
  if (colsToDelete.length > 0) {
    await db.kanbanCards.where('columnId').anyOf(colsToDelete).delete();
    await db.kanbanColumns.bulkDelete(colsToDelete);
  }
  await db.kanbanColumns.bulkPut(columnsToPut);

  // ── Cards ──
  const serverCards = kanbanRes.data.cards.map(c => ({ ...c, syncStatus: 'synced' as const }));
  const cardsToPut = serverCards.filter(c => !dirtyCardIds.has(c.id) && !pendingDeleteIds.has(c.id));
  const serverCardIds = new Set(serverCards.map(c => c.id));

  const localSyncedCards = await db.kanbanCards.where('syncStatus').equals('synced').toArray();
  const cardsToRemove = localSyncedCards.filter(c => !serverCardIds.has(c.id)).map(c => c.id);
  await db.kanbanCards.bulkDelete(cardsToRemove);
  await db.kanbanCards.bulkPut(cardsToPut);
});
```

**Step 3: Verify**

Run: `cd frontend && npx tsc --noEmit`
Expected: 0 errors

**Step 4: Commit**

```bash
git add frontend/src/features/sync/syncService.ts
git commit -m "feat(sync): add kanban to syncPull with zombie prevention"
```

---

### Task 5: syncPush — Kanban Entities

**Files:**
- Modify: `frontend/src/features/sync/syncService.ts`

**Step 1: Add kanban entity handlers in syncPush (after TASK_ITEM block)**

```typescript
} else if (item.entity === 'KANBAN_BOARD') {
  if (item.type === 'CREATE') {
    await api.post('/kanban/boards', item.data);
  } else if (item.type === 'UPDATE') {
    await api.put(`/kanban/boards/${item.entityId}`, item.data);
  } else if (item.type === 'DELETE') {
    await api.delete(`/kanban/boards/${item.entityId}`);
  }
} else if (item.entity === 'KANBAN_COLUMN') {
  if (item.type === 'CREATE') {
    await api.post(`/kanban/boards/${item.data.boardId}/columns`, { title: item.data.title });
  } else if (item.type === 'UPDATE') {
    await api.put(`/kanban/columns/${item.entityId}`, { title: item.data.title });
  } else if (item.type === 'DELETE') {
    await api.delete(`/kanban/columns/${item.entityId}`);
  }
} else if (item.entity === 'KANBAN_CARD') {
  if (item.type === 'CREATE') {
    await api.post(`/kanban/columns/${item.data.columnId}/cards`, {
      title: item.data.title,
      description: item.data.description,
    });
  } else if (item.type === 'UPDATE') {
    await api.put(`/kanban/cards/${item.entityId}`, item.data);
  } else if (item.type === 'DELETE') {
    await api.delete(`/kanban/cards/${item.entityId}`);
  }
}
```

**Step 2: Verify the existing 404/410 error drain catches all entities** (it should — it checks `err.response?.status` generically).

**Step 3: Verify**

Run: `cd frontend && npx tsc --noEmit`
Expected: 0 errors

**Step 4: Commit**

```bash
git add frontend/src/features/sync/syncService.ts
git commit -m "feat(sync): add kanban entities to syncPush"
```

---

### Task 6: Kanban Offline Service

**Files:**
- Create: `frontend/src/features/kanban/kanbanOfflineService.ts`

**Step 1: Create the offline service file**

Pattern: identical to `taskListService.ts` — all mutations write Dexie first, then enqueue for sync.

```typescript
import { db } from '../../lib/db';
import type { LocalKanbanBoard, LocalKanbanColumn, LocalKanbanCard } from '../../lib/db';
import { useAuthStore } from '../../store/authStore';

// ── Boards ──────────────────────────────────────────────────────────────

export const createBoard = async (title: string, description?: string): Promise<LocalKanbanBoard> => {
  const user = useAuthStore.getState().user;
  if (!user) throw new Error('Not authenticated');

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const board: LocalKanbanBoard = {
    id, title, description: description ?? null,
    coverImage: null, avatarUrl: null,
    ownerId: user.id, noteId: null, noteLinkedById: null,
    createdAt: now, updatedAt: now,
    ownership: 'owned', sharedPermission: null, sharedByUser: null,
    syncStatus: 'pending',
  };

  await db.kanbanBoards.put(board);
  await db.syncQueue.add({
    type: 'CREATE', entity: 'KANBAN_BOARD', entityId: id,
    userId: user.id, data: { title, description }, createdAt: Date.now(),
  });

  // Create 3 default columns locally (matching backend createBoard)
  const defaultTitles = ['To Do', 'In Progress', 'Done'];
  for (let i = 0; i < defaultTitles.length; i++) {
    const colId = crypto.randomUUID();
    await db.kanbanColumns.put({
      id: colId, title: defaultTitles[i], position: i, boardId: id, syncStatus: 'pending',
    });
    await db.syncQueue.add({
      type: 'CREATE', entity: 'KANBAN_COLUMN', entityId: colId,
      userId: user.id, data: { boardId: id, title: defaultTitles[i] }, createdAt: Date.now(),
    });
  }

  return board;
};

export const updateBoard = async (id: string, data: { title?: string; description?: string | null }): Promise<void> => {
  const user = useAuthStore.getState().user;
  if (!user) throw new Error('Not authenticated');
  await db.kanbanBoards.update(id, { ...data, updatedAt: new Date().toISOString(), syncStatus: 'pending' });
  await db.syncQueue.add({
    type: 'UPDATE', entity: 'KANBAN_BOARD', entityId: id,
    userId: user.id, data, createdAt: Date.now(),
  });
};

export const deleteBoard = async (id: string): Promise<void> => {
  const user = useAuthStore.getState().user;
  if (!user) throw new Error('Not authenticated');
  await db.transaction('rw', db.kanbanBoards, db.kanbanColumns, db.kanbanCards, db.syncQueue, async () => {
    await db.kanbanCards.where('boardId').equals(id).delete();
    await db.kanbanColumns.where('boardId').equals(id).delete();
    await db.kanbanBoards.delete(id);
    await db.syncQueue.add({
      type: 'DELETE', entity: 'KANBAN_BOARD', entityId: id,
      userId: user.id, data: {}, createdAt: Date.now(),
    });
  });
};

// ── Columns ─────────────────────────────────────────────────────────────

export const createColumn = async (boardId: string, title: string): Promise<LocalKanbanColumn> => {
  const user = useAuthStore.getState().user;
  if (!user) throw new Error('Not authenticated');
  const existing = await db.kanbanColumns.where('boardId').equals(boardId).toArray();
  const maxPos = existing.reduce((max, c) => Math.max(max, c.position), -1);
  const id = crypto.randomUUID();
  const column: LocalKanbanColumn = { id, title, position: maxPos + 1, boardId, syncStatus: 'pending' };
  await db.kanbanColumns.put(column);
  await db.syncQueue.add({
    type: 'CREATE', entity: 'KANBAN_COLUMN', entityId: id,
    userId: user.id, data: { boardId, title }, createdAt: Date.now(),
  });
  return column;
};

export const updateColumn = async (id: string, title: string): Promise<void> => {
  const user = useAuthStore.getState().user;
  if (!user) throw new Error('Not authenticated');
  await db.kanbanColumns.update(id, { title, syncStatus: 'pending' });
  await db.syncQueue.add({
    type: 'UPDATE', entity: 'KANBAN_COLUMN', entityId: id,
    userId: user.id, data: { title }, createdAt: Date.now(),
  });
};

export const deleteColumn = async (id: string): Promise<void> => {
  const user = useAuthStore.getState().user;
  if (!user) throw new Error('Not authenticated');
  await db.transaction('rw', db.kanbanColumns, db.kanbanCards, db.syncQueue, async () => {
    await db.kanbanCards.where('columnId').equals(id).delete();
    await db.kanbanColumns.delete(id);
    await db.syncQueue.add({
      type: 'DELETE', entity: 'KANBAN_COLUMN', entityId: id,
      userId: user.id, data: {}, createdAt: Date.now(),
    });
  });
};

// ── Cards ───────────────────────────────────────────────────────────────

export const createCard = async (
  columnId: string, boardId: string, title: string, description?: string,
): Promise<LocalKanbanCard> => {
  const user = useAuthStore.getState().user;
  if (!user) throw new Error('Not authenticated');
  const existing = await db.kanbanCards.where('columnId').equals(columnId).toArray();
  const maxPos = existing.reduce((max, c) => Math.max(max, c.position), -1);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const card: LocalKanbanCard = {
    id, title, description: description ?? null,
    position: maxPos + 1, columnId, boardId,
    assigneeId: null, assignee: null, dueDate: null,
    noteId: null, noteLinkedById: null,
    createdAt: now, updatedAt: now, syncStatus: 'pending',
  };
  await db.kanbanCards.put(card);
  await db.syncQueue.add({
    type: 'CREATE', entity: 'KANBAN_CARD', entityId: id,
    userId: user.id, data: { columnId, title, description }, createdAt: Date.now(),
  });
  return card;
};

export const updateCard = async (
  id: string, data: Partial<Pick<LocalKanbanCard, 'title' | 'description' | 'assigneeId' | 'dueDate'>>,
): Promise<void> => {
  const user = useAuthStore.getState().user;
  if (!user) throw new Error('Not authenticated');
  await db.kanbanCards.update(id, { ...data, updatedAt: new Date().toISOString(), syncStatus: 'pending' });
  await db.syncQueue.add({
    type: 'UPDATE', entity: 'KANBAN_CARD', entityId: id,
    userId: user.id, data, createdAt: Date.now(),
  });
};

export const deleteCard = async (id: string): Promise<void> => {
  const user = useAuthStore.getState().user;
  if (!user) throw new Error('Not authenticated');
  await db.kanbanCards.delete(id);
  await db.syncQueue.add({
    type: 'DELETE', entity: 'KANBAN_CARD', entityId: id,
    userId: user.id, data: {}, createdAt: Date.now(),
  });
};
```

**Step 2: Verify**

Run: `cd frontend && npx tsc --noEmit`
Expected: 0 errors

**Step 3: Commit**

```bash
git add frontend/src/features/kanban/kanbanOfflineService.ts
git commit -m "feat(sync): add kanban offline service with Dexie CRUD"
```

---

### Task 7: KanbanPage Reads from Dexie

**Files:**
- Modify: `frontend/src/features/kanban/KanbanPage.tsx`

**Step 1: Add imports**

```typescript
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../lib/db';
import * as kanbanOffline from './kanbanOfflineService';
```

**Step 2: Replace `useKanbanBoards()` React Query hook with `useLiveQuery`**

```typescript
const userId = useAuthStore.getState().user?.id;
const boards = useLiveQuery(
  () => userId ? db.kanbanBoards.toArray() : [],
  [userId]
);
const isLoading = boards === undefined;
```

**Step 3: Update create/delete handlers to use offline service**

Replace `createBoard.mutate(...)` with `await kanbanOffline.createBoard(title, description)`.
Replace `deleteBoard.mutate(boardId)` with `await kanbanOffline.deleteBoard(boardId)`.

**Step 4: Remove unused `useKanbanBoards` import and `useKanbanMutations` if fully replaced**

**Step 5: Verify**

Run: `cd frontend && npx tsc --noEmit`
Expected: 0 errors

**Step 6: Commit**

```bash
git add frontend/src/features/kanban/KanbanPage.tsx
git commit -m "feat(sync): KanbanPage reads board list from Dexie"
```

---

### Task 8: KanbanBoardPage Hybrid Offline/Online

**Files:**
- Modify: `frontend/src/features/kanban/KanbanBoardPage.tsx`

**Context:** This is the most complex component (~915 lines). Strategy: add Dexie as parallel data source, keep React Query for online hydration, keep SSE + DnD as online-only.

**Step 1: Add Dexie imports**

```typescript
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../lib/db';
```

**Step 2: Add offline data hooks alongside existing React Query hooks**

```typescript
const offlineBoard = useLiveQuery(
  () => boardId ? db.kanbanBoards.get(boardId) : undefined, [boardId]
);
const offlineColumns = useLiveQuery(
  () => boardId ? db.kanbanColumns.where('boardId').equals(boardId).sortBy('position') : [], [boardId]
);
const offlineCards = useLiveQuery(
  () => boardId ? db.kanbanCards.where('boardId').equals(boardId).toArray() : [], [boardId]
);
```

**Step 3: Merge data sources — prefer online, fall back to offline**

```typescript
const board = onlineBoard ?? (offlineBoard ? {
  ...offlineBoard,
  columns: (offlineColumns ?? []).map(col => ({
    ...col,
    cards: (offlineCards ?? []).filter(c => c.columnId === col.id).sort((a, b) => a.position - b.position),
  })),
} : undefined);
```

Adjust variable names to match existing component state variables (read the component first).

**Step 4: Update CRUD mutation handlers for columns/cards**

For `createColumn`, `updateColumn`, `deleteColumn`, `createCard`, `updateCard`, `deleteCard` — add Dexie write via `kanbanOfflineService` alongside existing React Query mutations. Keep `moveCard` (DnD) as online-only.

**Step 5: SSE event handler updates**

In the SSE event handler (`useKanbanRealtime`), when events arrive (e.g. `card:created`, `card:updated`), also write the changes to Dexie tables so offline data stays fresh.

**Step 6: Verify**

Run: `cd frontend && npx tsc --noEmit`
Expected: 0 errors

**Step 7: Commit**

```bash
git add frontend/src/features/kanban/KanbanBoardPage.tsx
git commit -m "feat(sync): KanbanBoardPage hybrid offline/online support"
```

---

### Task 9: Backend — TaskList Group Sharing Endpoint

**Files:**
- Modify: `backend/src/routes/sharing.ts`

**Context:** Frontend `TaskListSharingModal.tsx` already calls `POST /share/tasklists/:id/group` but the backend endpoint doesn't exist. Frontend `groupService.ts:93` has `shareTaskListWithGroup()`.

**Step 1: Find the import for `shareTaskList` function**

Check `sharing.service.ts` or `taskList.service.ts` for the function that shares a task list by email. The existing route `POST /share/tasklists/:id` (line 232) calls it.

**Step 2: Add group sharing endpoint (after GET /tasklists/accepted, before kanbans section)**

```typescript
// Share task list with group
fastify.post<{ Params: { id: string } }>(
  '/tasklists/:id/group',
  { onRequest: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const { groupId, permission = 'READ' } = request.body as { groupId: string; permission?: string };
    const group = await groupService.getGroup(groupId, request.user.id);
    let shared = 0;
    for (const member of group.members) {
      if (member.userId === request.user.id) continue;
      try {
        // Use the same share function as POST /tasklists/:id
        await sharingService.shareTaskList(request.user.id, id, member.user.email, permission as 'READ' | 'WRITE');
        shared++;
      } catch {
        // Skip if already shared
      }
    }
    return { shared };
  }
);
```

**Note:** If `shareTaskList` doesn't exist in `sharing.service.ts`, find the equivalent function used in the existing `POST /tasklists/:id` route handler and use the same pattern.

**Step 3: Verify**

Run: `cd backend && npx tsc --noEmit`
Expected: 0 errors

**Step 4: Commit**

```bash
git add backend/src/routes/sharing.ts
git commit -m "feat(sharing): add task list group sharing endpoint"
```

---

### Task 10: Backend — Kanban Group Sharing Endpoint

**Files:**
- Modify: `backend/src/routes/sharing.ts`

**Step 1: Add endpoint (after existing kanbans section, around line 322)**

```typescript
// Share kanban board with group
fastify.post<{ Params: { id: string } }>(
  '/kanbans/:id/group',
  { onRequest: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const { groupId, permission = 'READ' } = request.body as { groupId: string; permission?: string };
    const group = await groupService.getGroup(groupId, request.user.id);
    let shared = 0;
    for (const member of group.members) {
      if (member.userId === request.user.id) continue;
      try {
        await sharingService.shareKanbanBoard(request.user.id, id, member.user.email, permission as 'READ' | 'WRITE');
        shared++;
      } catch {
        // Skip if already shared
      }
    }
    return { shared };
  }
);
```

**Step 2: Verify**

Run: `cd backend && npx tsc --noEmit`
Expected: 0 errors

**Step 3: Commit**

```bash
git add backend/src/routes/sharing.ts
git commit -m "feat(sharing): add kanban board group sharing endpoint"
```

---

### Task 11: Frontend — shareBoardWithGroup + ShareBoardModal Group Picker

**Files:**
- Modify: `frontend/src/features/groups/groupService.ts` — add `shareBoardWithGroup()`
- Modify: `frontend/src/features/kanban/components/ShareBoardModal.tsx` — add group section

**Step 1: Add API function to groupService.ts (after `shareTaskListWithGroup`)**

```typescript
export const shareBoardWithGroup = async (boardId: string, groupId: string, permission: 'READ' | 'WRITE' = 'READ') => {
  const res = await api.post(`/share/kanbans/${boardId}/group`, { groupId, permission });
  return res.data;
};
```

**Step 2: Add group sharing UI to ShareBoardModal.tsx**

Follow the exact pattern from `TaskListSharingModal.tsx:95-145`:

1. Import: `import { getGroupsForSharing, shareBoardWithGroup } from '../../groups/groupService';`
2. Import: `import { Orbit } from 'lucide-react';`
3. Add state: `selectedGroupId`, `groupPermission`, `isGroupSharing`
4. Add query: `useQuery({ queryKey: ['groups-for-sharing'], queryFn: getGroupsForSharing, staleTime: 5 * 60 * 1000, enabled: isOpen })`
5. Add group section JSX (conditional on `groups && groups.length > 0`):
   - Section label with `Orbit` icon: `t('sharing.shareWithGroup')`
   - Group `<select>` dropdown
   - Permission `<select>` (READ/WRITE)
   - Share button calling `shareBoardWithGroup(boardId, selectedGroupId, groupPermission)`
   - Success toast: `t('sharing.shareGroupSuccess', { count: result.shared })`

**Step 3: Verify**

Run: `cd frontend && npx tsc --noEmit`
Expected: 0 errors

**Step 4: Commit**

```bash
git add frontend/src/features/groups/groupService.ts frontend/src/features/kanban/components/ShareBoardModal.tsx
git commit -m "feat(sharing): add kanban board group sharing UI"
```

---

### Task 12: i18n Keys for Group Sharing

**Files:**
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/it.json`

**Step 1: Verify existing i18n keys**

Check if `sharing.shareWithGroup` and `sharing.shareGroupSuccess` already exist (they should — used by `SharingModal.tsx` and `TaskListSharingModal.tsx`). If they exist, no new keys needed.

**Step 2: Add any missing keys** (only if not already present)

**en.json:**
```json
"sharing.shareWithGroup": "Share with group",
"sharing.shareGroupSuccess": "Shared with {{count}} group members"
```

**it.json:**
```json
"sharing.shareWithGroup": "Condividi con gruppo",
"sharing.shareGroupSuccess": "Condiviso con {{count}} membri del gruppo"
```

**Step 3: Commit (only if changes made)**

```bash
git add frontend/src/locales/en.json frontend/src/locales/it.json
git commit -m "feat(i18n): add group sharing keys if missing"
```

---

### Task 13: Phase 1 Verification + Version Bump

**Files:**
- Modify: `frontend/package.json`, `backend/package.json`
- Modify: `frontend/src/data/changelog.ts`

**Step 1: Full TypeScript verification**

```bash
cd backend && npx tsc --noEmit
cd ../frontend && npx tsc --noEmit
```
Expected: 0 errors on both

**Step 2: Full build**

```bash
cd backend && npm run build
cd ../frontend && npm run build
```
Expected: Both succeed

**Step 3: Version bump**

```bash
cd frontend && npm version minor --no-git-tag-version
cd ../backend && npm version minor --no-git-tag-version
```

**Step 4: Update changelog.ts**

Add v1.7.0 entry with features:
- Kanban offline sync (boards, columns, cards work offline)
- Kanban board group sharing
- Task list group sharing

Add corresponding i18n keys to `en.json` and `it.json` for the What's New entries.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: v1.7.0 — kanban offline sync + group sharing"
```

---

## Phase 2: Security & Data Integrity (v1.7.1)

**Session scope:** 6 tasks. Database indexes, Hocuspocus auth hardening, quick security fixes.

---

### Task 14: Database Indexes Migration

**Files:**
- Modify: `backend/prisma/schema.prisma`

**Step 1: Add indexes to existing models**

```prisma
// In GroupMember model (after @@id):
@@index([userId])

// In KanbanBoardChat model (after existing fields):
@@index([boardId, createdAt])

// In AuditLog model (update existing @@index):
@@index([userId, createdAt])

// In Notification model (add):
@@index([createdAt])
```

**Step 2: Run migration**

```bash
cd backend && npx prisma migrate dev --name add_performance_indexes
```
Expected: Migration created and applied successfully

**Step 3: Verify**

```bash
cd backend && npx tsc --noEmit
```
Expected: 0 errors

**Step 4: Commit**

```bash
git add backend/prisma/
git commit -m "perf: add database indexes for GroupMember, KanbanBoardChat, AuditLog, Notification"
```

---

### Task 15: Hocuspocus WebSocket Auth Hardening

**Files:**
- Modify: `backend/src/hocuspocus.ts`

**Context:** `onAuthenticate` (lines 278-329) already validates JWT + note ownership/shared access. Review and harden.

**Step 1: Read current `onAuthenticate` implementation**

Verify it:
1. Validates JWT token
2. Checks `tokenVersion` matches DB (prevents invalidated tokens)
3. Verifies note exists
4. Checks user is owner OR has ACCEPTED share
5. Sets `readOnly` correctly for shared READ permission

**Step 2: Add `tokenVersion` check if missing**

```typescript
const user = await prisma.user.findUnique({ where: { id: userId } });
if (!user || user.tokenVersion !== decoded.tokenVersion) {
  throw new Error('Token invalidated');
}
```

**Step 3: Add explicit error for non-existent notes**

```typescript
if (!note) {
  throw new Error('Note not found');
}
```

**Step 4: Verify**

```bash
cd backend && npx tsc --noEmit
```

**Step 5: Commit**

```bash
git add backend/src/hocuspocus.ts
git commit -m "security: harden Hocuspocus WebSocket auth with tokenVersion check"
```

---

### Task 16: Quick Security Fixes — lastActiveAt + FRONTEND_URL

**Files:**
- Modify: `backend/src/app.ts` — lastActiveAt error logging
- Modify: `backend/src/services/email.service.ts` — FRONTEND_URL hard fail

**Step 1: In app.ts, find the `lastActiveAt` update block and add error logging**

```typescript
try {
  await prisma.user.update({ where: { id: request.user.id }, data: { lastActiveAt: new Date() } });
} catch (err) {
  request.log.warn({ err, userId: request.user.id }, 'Failed to update lastActiveAt');
}
```

**Step 2: In email.service.ts, replace `console.warn` with a hard fail in production**

Change (around line 15-18):
```typescript
const FRONTEND_URL = process.env.FRONTEND_URL;
if (!FRONTEND_URL) {
  console.warn('FRONTEND_URL is not defined...');
}
```
To:
```typescript
const FRONTEND_URL = process.env.FRONTEND_URL;
if (!FRONTEND_URL && process.env.NODE_ENV === 'production') {
  throw new Error('FRONTEND_URL must be set in production. Email links will be broken.');
}
if (!FRONTEND_URL) {
  logger.warn('FRONTEND_URL is not defined in .env — email links will be broken');
}
```

**Step 3: Verify**

```bash
cd backend && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add backend/src/app.ts backend/src/services/email.service.ts
git commit -m "security: add lastActiveAt error logging + FRONTEND_URL hard fail in prod"
```

---

### Task 17: Invite Locale from DB

**Files:**
- Modify: `backend/src/services/invite.service.ts`

**Step 1: In `approveInvitationRequest` (line ~103), replace hardcoded `locale: 'it'`**

```typescript
// Find the request to get the email, then look up if user exists
const request = await prisma.invitationRequest.findUnique({ where: { id: requestId } });
const existingUser = request ? await prisma.user.findUnique({ where: { email: request.email } }) : null;
const locale = existingUser?.locale ?? 'en';
```

Use `locale` instead of hardcoded `'it'`.

**Step 2: Same for `rejectInvitationRequest` (line ~142)**

**Step 3: Verify**

```bash
cd backend && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add backend/src/services/invite.service.ts
git commit -m "fix: read invite locale from DB instead of hardcoding 'it'"
```

---

### Task 18: Kanban Write Permissions Audit

**Files:**
- Modify: `backend/src/routes/kanban.ts`

**Step 1: Audit all routes that modify data**

Read each route handler. Verify that:
- All write operations (POST, PUT, DELETE) check WRITE permission via `assertBoardAccess(boardId, userId, 'WRITE')`
- Delete board checks `isOwner` (it does — line 180-192)
- Cover/avatar upload checks WRITE (they do — lines 196-370)
- Column/card CRUD checks WRITE via `getColumnWithAccess`/`getCardWithAccess`

**Step 2: Add explicit checks where missing**

If any route uses only READ when it should use WRITE, fix it.

**Step 3: Verify**

```bash
cd backend && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add backend/src/routes/kanban.ts
git commit -m "security: audit and enforce kanban write permissions"
```

---

### Task 19: Phase 2 Verification + Version Bump

**Step 1: Full verification**

```bash
cd backend && npx tsc --noEmit && npm run build
cd ../frontend && npx tsc --noEmit && npm run build
```

**Step 2: Version bump to v1.7.1**

```bash
cd frontend && npm version patch --no-git-tag-version
cd ../backend && npm version patch --no-git-tag-version
```

**Step 3: Update changelog.ts with v1.7.1 entry + i18n keys**

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: v1.7.1 — security fixes + database indexes"
```

---

## Phase 3: Quality & Testing (v1.8.0)

**Session scope:** 10 tasks. E2E tests, `any` cleanup, rate limiting, vault KDF, sharing modal unification.

---

### Task 20: E2E Tests — Kanban Board CRUD + Columns + Cards

**Files:**
- Create: `frontend/e2e/kanban.spec.ts`

**Step 1: Create E2E test file**

Follow patterns from `frontend/e2e/notes.spec.ts` and `frontend/e2e/tasks.spec.ts`.

```typescript
import { test, expect } from '@playwright/test';

test.describe('Kanban Boards', () => {
  test.beforeEach(async ({ page }) => {
    // Login flow — reuse pattern from existing specs
    await page.goto('/login');
    await page.fill('input[name="email"]', process.env.E2E_EMAIL!);
    await page.fill('input[name="password"]', process.env.E2E_PASSWORD!);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/(notes|kanban)/);
  });

  test('create, rename, and delete board', async ({ page }) => {
    await page.goto('/kanban');
    // Create board
    await page.click('button:has-text("New Board")');
    const title = `E2E Board ${Date.now()}`;
    await page.fill('input[placeholder*="title"]', title);
    await page.click('button:has-text("Create")');
    await expect(page.locator(`text=${title}`)).toBeVisible();
    // Rename (if inline editing exists)
    // Delete
  });

  test('create and delete column', async ({ page }) => {
    // Navigate to board, add column, verify, delete
  });

  test('create, update, and delete card', async ({ page }) => {
    // Create card in column, open detail modal, update fields, delete
  });
});
```

**Step 2: Run tests**

```bash
cd frontend && npx playwright test kanban.spec.ts
```

**Step 3: Commit**

```bash
git add frontend/e2e/kanban.spec.ts
git commit -m "test: add E2E tests for kanban board/column/card CRUD"
```

---

### Task 21: E2E Tests — Kanban Sharing + Note Linking

**Files:**
- Modify: `frontend/e2e/kanban.spec.ts`

**Step 1: Add sharing and note linking test cases**

```typescript
test('open share modal and verify UI', async ({ page }) => {
  // Navigate to board, click Share button
  // Verify modal shows email input, permission select
  // Verify group sharing section appears if user has groups
});

test('link note to card and verify', async ({ page }) => {
  // Open card detail modal
  // Click "Link Note" button
  // Search and select a note
  // Verify note link appears on card
});
```

**Step 2: Run and commit**

---

### Task 22: Backend `any` Cleanup — Typed Interfaces

**Files:**
- Modify: `backend/src/services/kanban.service.ts`
- Modify: `backend/src/services/sharing.service.ts`
- Create: `backend/src/types/errors.ts` (if needed)

**Step 1: Create typed error interface**

```typescript
// backend/src/types/errors.ts
export interface ServiceError {
  message: string;
  statusCode?: number;
}
```

**Step 2: Replace `any` in kanban.service.ts (~170 occurrences across project, start with highest-risk files)**

Common replacements:
- `(err: any)` → `(err: unknown)` + type guard `if (err instanceof Error)`
- `as any` → proper type assertion or generic
- Function parameter `any` → specific interface or `unknown`

**Step 3: Replace `any` in sharing.service.ts**

Same patterns.

**Step 4: Verify**

```bash
cd backend && npx tsc --noEmit
```

**Step 5: Commit**

```bash
git add backend/src/
git commit -m "refactor: replace any types in kanban and sharing services"
```

---

### Task 23: Backend `any` Cleanup — Routes

**Files:**
- Modify: `backend/src/routes/*.ts`

**Step 1: Replace `any` in all route files**

Focus on:
- Route handler `request.body as any` → proper Zod-inferred types
- Error catches `(err: any)` → `(err: unknown)`
- Response types

**Step 2: Verify + commit**

---

### Task 24: Rate Limiting — Auth Routes

**Files:**
- Modify: `backend/src/app.ts` or `backend/src/routes/auth.ts`

**Step 1: Install rate limiting plugin**

```bash
cd backend && npm install @fastify/rate-limit
```

**Step 2: Register plugin in app.ts**

```typescript
import rateLimit from '@fastify/rate-limit';
await server.register(rateLimit, { global: false });
```

**Step 3: Add per-route limits in auth.ts**

```typescript
// Login
fastify.post('/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, handler);

// Register
fastify.post('/register', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, handler);

// Reset password
fastify.post('/reset-password', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, handler);
```

**Step 4: Verify + commit**

---

### Task 25: Rate Limiting — Sharing + Upload Routes

**Files:**
- Modify: `backend/src/routes/sharing.ts`
- Modify: `backend/src/routes/attachments.ts` (or wherever upload is)

**Step 1: Add user-scoped rate limits**

```typescript
// Sharing routes: 10 req/min per user
{ config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: (req) => req.user.id } } }

// Upload routes: 3 req/min per user
{ config: { rateLimit: { max: 3, timeWindow: '1 minute', keyGenerator: (req) => req.user.id } } }
```

**Step 2: Verify + commit**

---

### Task 26: Vault KDF — PBKDF2 Implementation + Migration

**Files:**
- Modify: `frontend/src/utils/crypto.ts`
- Modify: `frontend/src/store/vaultStore.ts`

**TIER 1 WARNING:** This modifies vault encryption. Must preserve backward compatibility.

**Step 1: Add PBKDF2 key derivation to crypto.ts**

```typescript
// New: derive key from PIN using PBKDF2
export const deriveKey = (pin: string, salt: string): string => {
  return CryptoJS.PBKDF2(pin, salt, {
    keySize: 256 / 32,
    iterations: 100000,
  }).toString();
};

// New: generate random salt
export const generateSalt = (): string => {
  return CryptoJS.lib.WordArray.random(128 / 8).toString();
};

// Updated encrypt: uses derived key
export const encryptContentKDF = (content: string, derivedKey: string): string => {
  return CryptoJS.AES.encrypt(content, derivedKey).toString();
};

// Updated decrypt: uses derived key
export const decryptContentKDF = (encryptedContent: string, derivedKey: string): string | null => {
  try {
    const bytes = CryptoJS.AES.decrypt(encryptedContent, derivedKey);
    const text = bytes.toString(CryptoJS.enc.Utf8);
    return text || null;
  } catch {
    return null;
  }
};
```

**Keep existing `encryptContent`/`decryptContent` unchanged for backward compatibility.**

**Step 2: Add salt to vaultStore.ts**

Add `salt: string | null` to persisted state. On first unlock with legacy vault:
1. Try decrypt with raw PIN (old method)
2. If success: generate salt, derive new key, re-encrypt all vault notes with new key
3. Save salt to store
4. Future unlocks: use PBKDF2(PIN, salt)

```typescript
// In unlock flow:
if (!state.salt) {
  // Legacy: try raw PIN
  const decrypted = decryptContent(testNote.content, pin);
  if (decrypted) {
    // Migrate: generate salt, re-encrypt
    const salt = generateSalt();
    const derivedKey = deriveKey(pin, salt);
    // Re-encrypt all vault notes...
    set({ salt });
  }
} else {
  // Modern: use PBKDF2
  const derivedKey = deriveKey(pin, state.salt);
  const decrypted = decryptContentKDF(testNote.content, derivedKey);
}
```

**Step 3: Verify TypeScript compiles + test vault unlock/lock cycle**

**Step 4: Commit**

```bash
git add frontend/src/utils/crypto.ts frontend/src/store/vaultStore.ts
git commit -m "security: add PBKDF2 key derivation for vault with backward-compatible migration"
```

---

### Task 27: Sharing Modal Unification — Unified Component

**Files:**
- Modify: `frontend/src/components/sharing/SharingModal.tsx`

**Step 1: Refactor SharingModal to accept `entityType` prop**

```typescript
interface UnifiedSharingModalProps {
  isOpen: boolean;
  onClose: () => void;
  entityId: string;
  entityTitle: string;
  entityType: 'NOTE' | 'NOTEBOOK' | 'TASK_LIST' | 'KANBAN_BOARD';
  sharedWith?: SharedUser[];
}
```

**Step 2: Map entityType to share/revoke functions**

```typescript
const shareFn = {
  NOTE: (email, perm) => shareNote(entityId, email, perm),
  NOTEBOOK: (email, perm) => shareNotebook(entityId, email, perm),
  TASK_LIST: (email, perm) => shareTaskList(entityId, email, perm),
  KANBAN_BOARD: (email, perm) => shareBoard(entityId, email, perm),
}[entityType];

const groupShareFn = {
  NOTE: (gid, perm) => shareNoteWithGroup(entityId, gid, perm),
  NOTEBOOK: (gid, perm) => shareNotebookWithGroup(entityId, gid, perm),
  TASK_LIST: (gid, perm) => shareTaskListWithGroup(entityId, gid, perm),
  KANBAN_BOARD: (gid, perm) => shareBoardWithGroup(entityId, gid, perm),
}[entityType];
```

**Step 3: Verify + commit**

---

### Task 28: Sharing Modal Unification — Replace Existing Modals

**Files:**
- Modify: Components that use `NotebookSharingModal`, `TaskListSharingModal`, `ShareBoardModal`
- Optionally delete: old modal files (or keep as re-exports for safety)

**Step 1: Replace usages with unified `SharingModal`**

Example:
```typescript
// Before:
<ShareBoardModal isOpen={...} onClose={...} boardId={...} boardTitle={...} sharedWith={...} />

// After:
<SharingModal isOpen={...} onClose={...} entityId={boardId} entityTitle={boardTitle} entityType="KANBAN_BOARD" sharedWith={...} />
```

**Step 2: Verify all sharing flows still work**

**Step 3: Commit**

---

### Task 29: Phase 3 Verification + Version Bump

**Step 1: Full verification**

```bash
cd backend && npx tsc --noEmit && npm run build
cd ../frontend && npx tsc --noEmit && npm run build
cd ../frontend && npx playwright test
```

**Step 2: Version bump to v1.8.0**

**Step 3: Changelog + i18n + commit**

---

## Phase 4: Backlog & Polish (v1.8.1)

**Session scope:** 7 tasks. Schema improvements, lint cleanup, backend unit tests.

---

### Task 30: Schema — KanbanCard isTrashed + Column Title i18n

**Files:**
- Modify: `backend/prisma/schema.prisma`

**Step 1: Add `isTrashed` to KanbanCard**

```prisma
model KanbanCard {
  // ... existing fields ...
  isTrashed   Boolean     @default(false)
}
```

**Step 2: Run migration**

```bash
cd backend && npx prisma migrate dev --name kanban_card_soft_delete
```

**Step 3: Update kanban.service.ts `deleteCard` to soft-delete**

```typescript
// Instead of prisma.kanbanCard.delete:
await prisma.kanbanCard.update({ where: { id: cardId }, data: { isTrashed: true } });
```

**Step 4: Filter out trashed cards in `getBoard` and `getKanbanSyncData`**

**Step 5: For column default titles**, create an enum or const map in the backend and use i18n keys on the frontend. The default column titles ('To Do', 'In Progress', 'Done') in `createBoard` become keys that the frontend translates.

**Step 6: Commit**

---

### Task 31: Schema — Audit Attachment Unused Fields

**Files:**
- Review: `backend/prisma/schema.prisma` — Attachment model fields `version`, `hash`, `isLatest`

**Step 1: Search codebase for usage of these fields**

```bash
grep -r "version\|hash\|isLatest" backend/src/ --include="*.ts" | grep -i attach
```

**Step 2: If unused, either remove them (with migration) or add comments documenting planned future use**

**Step 3: Commit**

---

### Task 32: ESLint Fix + Manual Lint Cleanup

**Files:**
- Various frontend files

**Step 1: Run auto-fix**

```bash
cd frontend && npx eslint --fix src/
```

**Step 2: Review and commit auto-fixes**

**Step 3: Manual fixes for remaining errors**

Focus on `no-explicit-any` and `no-unused-vars`. Common patterns:
- `_` prefix for intentionally unused variables
- Replace `any` with `unknown` or specific types
- Remove dead imports

**Step 4: Commit in batches by directory/feature**

---

### Task 33: Backend Unit Test Setup (vitest)

**Files:**
- Create: `backend/vitest.config.ts`
- Modify: `backend/package.json` — add test script
- Create: `backend/src/__tests__/setup.ts` — test database setup

**Step 1: Install vitest**

```bash
cd backend && npm install -D vitest
```

**Step 2: Create vitest config**

```typescript
// backend/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/__tests__/setup.ts'],
    testTimeout: 10000,
  },
});
```

**Step 3: Create test setup with test database**

```typescript
// backend/src/__tests__/setup.ts
import { beforeAll, afterAll } from 'vitest';
// Setup test database connection, seed data, cleanup
```

**Step 4: Update package.json**

```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest"
}
```

**Step 5: Commit**

---

### Task 34: Backend Unit Tests — Auth + Sharing

**Files:**
- Create: `backend/src/__tests__/auth.service.test.ts`
- Create: `backend/src/__tests__/sharing.service.test.ts`

**Step 1: Write auth service tests**

Cover: `register`, `login`, `verifyEmail`, `changePassword` (tokenVersion increment), role checks.

**Step 2: Write sharing service tests**

Cover: `shareNote` (upsert), `revokeNoteShare`, `respondToShareById`, `shareKanbanBoard`, group sharing flow.

**Step 3: Run tests**

```bash
cd backend && npm test
```

**Step 4: Commit**

---

### Task 35: Backend Unit Tests — Kanban + Notification

**Files:**
- Create: `backend/src/__tests__/kanban.service.test.ts`
- Create: `backend/src/__tests__/notification.service.test.ts`

**Step 1: Write kanban service tests**

Cover: `createBoard` (3 default columns), `createCard`, `updateCard` (assignee/dueDate/note changes), `moveCard` (position rebalancing), `deleteCard`.

**Step 2: Write notification service tests**

Cover: notification creation, `notifyBoardUsers` (excludes actor), marking as read.

**Step 3: Run tests + commit**

---

### Task 36: Phase 4 Verification + Version Bump

**Step 1: Full verification**

```bash
cd backend && npx tsc --noEmit && npm run build && npm test
cd ../frontend && npx tsc --noEmit && npm run build
cd ../frontend && npx playwright test
```

**Step 2: Version bump to v1.8.1**

**Step 3: Changelog + i18n + commit**

```bash
git commit -m "feat: v1.8.1 — schema polish, lint cleanup, backend unit tests"
```

---

## Summary

| Phase | Version | Tasks | Key Deliverables |
|-------|---------|-------|------------------|
| 1 | v1.7.0 | 1-13 | Kanban Dexie v14, offline sync, group sharing (kanban + tasklist) |
| 2 | v1.7.1 | 14-19 | 4 DB indexes, Hocuspocus auth, lastActiveAt logging, invite locale, FRONTEND_URL |
| 3 | v1.8.0 | 20-29 | E2E kanban tests, ~170 `any` → typed, rate limiting, vault PBKDF2, unified sharing modal |
| 4 | v1.8.1 | 30-36 | KanbanCard soft delete, lint cleanup, vitest setup + 4 test suites |

**Total: 36 tasks across 4 independently deployable phases.**

Each phase ends with a full TypeScript + build verification and version bump.
