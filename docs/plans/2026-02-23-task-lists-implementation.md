# Task Lists — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a standalone Task Lists feature to Notiq with offline-first sync, sharing, and real-time notifications.

**Architecture:** New Prisma models (TaskList, TaskItem, SharedTaskList) with full Dexie offline sync, REST API following existing patterns (Fastify + Zod), sharing reusing the SharedNote pattern, and a new `/tasks` page with expandable cards. The existing "Attivita" section is renamed to "Promemoria" (`/reminders`).

**Tech Stack:** Prisma 7, Fastify 5, Zod, Dexie.js v4, React 19, TanStack Query v5, Tailwind CSS 3, Lucide icons, i18next, @dnd-kit/core (new dep for drag & drop).

**Design doc:** `docs/plans/2026-02-23-task-lists-design.md`

---

## Task 1: Prisma Schema — Models, Enums, Migration

**Files:**
- Modify: `backend/prisma/schema.prisma`

**Step 1: Add TaskPriority enum**

After the existing `NoteType` enum, add:

```prisma
enum TaskPriority {
  LOW
  MEDIUM
  HIGH
}
```

**Step 2: Extend NotificationType enum**

Add these values to the existing `NotificationType` enum:

```prisma
  TASK_ITEM_ADDED
  TASK_ITEM_CHECKED
  TASK_ITEM_REMOVED
  TASK_LIST_SHARED
```

**Step 3: Add TaskList model**

```prisma
model TaskList {
  id          String           @id @default(uuid())
  title       String
  userId      String
  user        User             @relation(fields: [userId], references: [id])
  items       TaskItem[]
  sharedWith  SharedTaskList[]
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt
  isTrashed   Boolean          @default(false)

  @@index([userId, isTrashed])
}
```

**Step 4: Add TaskItem model**

```prisma
model TaskItem {
  id          String        @id @default(uuid())
  taskListId  String
  taskList    TaskList      @relation(fields: [taskListId], references: [id], onDelete: Cascade)
  text        String
  isChecked   Boolean       @default(false)
  priority    TaskPriority  @default(MEDIUM)
  dueDate     DateTime?
  position    Int           @default(0)
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt

  @@index([taskListId])
}
```

**Step 5: Add SharedTaskList model**

```prisma
model SharedTaskList {
  id          String      @id @default(uuid())
  taskListId  String
  taskList    TaskList    @relation(fields: [taskListId], references: [id], onDelete: Cascade)
  userId      String
  user        User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  permission  Permission  @default(READ)
  status      ShareStatus @default(PENDING)
  createdAt   DateTime    @default(now())

  @@unique([taskListId, userId])
  @@index([userId, status])
}
```

**Step 6: Add relations to User model**

Add to the existing `User` model:

```prisma
  taskLists       TaskList[]
  sharedTaskLists SharedTaskList[]
```

**Step 7: Generate migration**

Run: `cd backend && npx prisma migrate dev --name add-task-lists`
Expected: Migration created, client regenerated.

**Step 8: Verify**

Run: `cd backend && npx prisma generate`
Expected: Prisma Client generated successfully.

**Step 9: Commit**

```bash
git add backend/prisma/
git commit -m "feat(schema): add TaskList, TaskItem, SharedTaskList models and TaskPriority enum"
```

---

## Task 2: Backend Service — tasklist.service.ts

**Files:**
- Create: `backend/src/services/tasklist.service.ts`

**Context:** Follow the exact pattern from `note.service.ts` — named exports, import `prisma` from `'../plugins/prisma'`, import `logger` from `'../utils/logger'`. Throw `new Error('...')` for not-found/access errors.

**Step 1: Create the service file with all CRUD operations**

The service must export these functions:

```typescript
import prisma from '../plugins/prisma';
import logger from '../utils/logger';
import * as notificationService from './notification.service';

// --- TaskList CRUD ---

export const createTaskList = async (userId: string, title: string, id?: string) => {
  return prisma.taskList.create({
    data: { id: id || undefined, title, userId },
    include: { items: true },
  });
};

export const getTaskLists = async (userId: string) => {
  return prisma.taskList.findMany({
    where: { userId, isTrashed: false },
    include: {
      items: { orderBy: { position: 'asc' } },
      sharedWith: {
        include: { user: { select: { id: true, name: true, email: true } } },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });
};

export const getTaskList = async (userId: string, id: string) => {
  const taskList = await prisma.taskList.findUnique({
    where: { id },
    include: {
      items: { orderBy: { position: 'asc' } },
      sharedWith: {
        include: { user: { select: { id: true, name: true, email: true } } },
      },
    },
  });
  if (!taskList) throw new Error('TaskList not found');
  // Check access: owner or accepted shared
  if (taskList.userId !== userId) {
    const shared = await prisma.sharedTaskList.findUnique({
      where: { taskListId_userId: { taskListId: id, userId } },
    });
    if (!shared || shared.status !== 'ACCEPTED') throw new Error('TaskList not found');
  }
  return taskList;
};

export const updateTaskList = async (userId: string, id: string, data: { title?: string }) => {
  await assertWriteAccess(userId, id);
  return prisma.taskList.update({ where: { id }, data });
};

export const deleteTaskList = async (userId: string, id: string) => {
  const taskList = await prisma.taskList.findUnique({ where: { id } });
  if (!taskList || taskList.userId !== userId) throw new Error('TaskList not found');
  return prisma.taskList.update({ where: { id }, data: { isTrashed: true } });
};

// --- TaskItem CRUD ---

export const addTaskItem = async (
  userId: string, taskListId: string,
  data: { id?: string; text: string; priority?: 'LOW' | 'MEDIUM' | 'HIGH'; dueDate?: string | null }
) => {
  await assertWriteAccess(userId, taskListId);
  const maxPos = await prisma.taskItem.aggregate({
    where: { taskListId },
    _max: { position: true },
  });
  const item = await prisma.taskItem.create({
    data: {
      id: data.id || undefined,
      taskListId,
      text: data.text,
      priority: data.priority || 'MEDIUM',
      dueDate: data.dueDate ? new Date(data.dueDate) : null,
      position: (maxPos._max.position ?? -1) + 1,
    },
  });
  await notifyCollaborators(userId, taskListId, 'TASK_ITEM_ADDED', item.text);
  return item;
};

export const updateTaskItem = async (
  userId: string, taskListId: string, itemId: string,
  data: { text?: string; isChecked?: boolean; priority?: 'LOW' | 'MEDIUM' | 'HIGH'; dueDate?: string | null; position?: number }
) => {
  await assertWriteAccess(userId, taskListId);
  const item = await prisma.taskItem.findUnique({ where: { id: itemId } });
  if (!item || item.taskListId !== taskListId) throw new Error('TaskItem not found');

  const updated = await prisma.taskItem.update({
    where: { id: itemId },
    data: {
      text: data.text,
      isChecked: data.isChecked,
      priority: data.priority,
      dueDate: data.dueDate !== undefined ? (data.dueDate ? new Date(data.dueDate) : null) : undefined,
      position: data.position,
    },
  });

  if (data.isChecked !== undefined) {
    await notifyCollaborators(userId, taskListId, 'TASK_ITEM_CHECKED', updated.text);
  }
  return updated;
};

export const deleteTaskItem = async (userId: string, taskListId: string, itemId: string) => {
  await assertWriteAccess(userId, taskListId);
  const item = await prisma.taskItem.findUnique({ where: { id: itemId } });
  if (!item || item.taskListId !== taskListId) throw new Error('TaskItem not found');
  await prisma.taskItem.delete({ where: { id: itemId } });
  await notifyCollaborators(userId, taskListId, 'TASK_ITEM_REMOVED', item.text);
};

export const reorderTaskItems = async (
  userId: string, taskListId: string,
  items: { id: string; position: number }[]
) => {
  await assertWriteAccess(userId, taskListId);
  await prisma.$transaction(
    items.map(item => prisma.taskItem.update({
      where: { id: item.id },
      data: { position: item.position },
    }))
  );
};

// --- Sharing ---

export const getAcceptedSharedTaskLists = async (userId: string) => {
  const shared = await prisma.sharedTaskList.findMany({
    where: { userId, status: 'ACCEPTED' },
    include: {
      taskList: {
        include: {
          items: { orderBy: { position: 'asc' } },
          user: { select: { id: true, name: true, email: true } },
          sharedWith: {
            include: { user: { select: { id: true, name: true, email: true } } },
          },
        },
      },
    },
  });
  return shared.map(s => ({
    ...s.taskList,
    _sharedPermission: s.permission,
  }));
};

// --- Helpers ---

async function assertWriteAccess(userId: string, taskListId: string) {
  const taskList = await prisma.taskList.findUnique({ where: { id: taskListId } });
  if (!taskList) throw new Error('TaskList not found');
  if (taskList.userId === userId) return; // Owner always has access
  const shared = await prisma.sharedTaskList.findUnique({
    where: { taskListId_userId: { taskListId, userId } },
  });
  if (!shared || shared.status !== 'ACCEPTED' || shared.permission !== 'WRITE') {
    throw new Error('Access denied');
  }
}

async function notifyCollaborators(
  actorUserId: string, taskListId: string,
  type: 'TASK_ITEM_ADDED' | 'TASK_ITEM_CHECKED' | 'TASK_ITEM_REMOVED',
  itemText: string
) {
  try {
    const taskList = await prisma.taskList.findUnique({
      where: { id: taskListId },
      include: {
        user: { select: { id: true, name: true, email: true } },
        sharedWith: {
          where: { status: 'ACCEPTED' },
          select: { userId: true },
        },
      },
    });
    if (!taskList) return;

    const actor = await prisma.user.findUnique({
      where: { id: actorUserId },
      select: { name: true, email: true },
    });
    const actorName = actor?.name || actor?.email || 'Unknown';

    // All recipients = owner + accepted collaborators, minus the actor
    const recipientIds = new Set<string>();
    recipientIds.add(taskList.userId);
    taskList.sharedWith.forEach(s => recipientIds.add(s.userId));
    recipientIds.delete(actorUserId);

    const localizationKey = `notifications.${type === 'TASK_ITEM_ADDED' ? 'taskItemAdded'
      : type === 'TASK_ITEM_CHECKED' ? 'taskItemChecked' : 'taskItemRemoved'}`;

    for (const recipientId of recipientIds) {
      await notificationService.createNotification(
        recipientId,
        type,
        `Task List: ${taskList.title}`,
        `${actorName} ${type === 'TASK_ITEM_ADDED' ? 'added' : type === 'TASK_ITEM_CHECKED' ? 'checked' : 'removed'} "${itemText}"`,
        {
          taskListId,
          taskListTitle: taskList.title,
          taskItemText: itemText,
          actionBy: actorName,
          localizationKey,
          localizationArgs: { userName: actorName, itemText, listTitle: taskList.title },
        }
      );
    }
  } catch (e) {
    logger.error(e, 'Failed to send task list notification');
  }
}
```

**Step 2: Update notification.service.ts type**

In `backend/src/services/notification.service.ts`, update the `type` parameter union to include the new types:

```typescript
type: 'SHARE_NOTE' | 'SHARE_NOTEBOOK' | 'SYSTEM' | 'REMINDER' | 'CHAT_MESSAGE' | 'GROUP_INVITE' | 'GROUP_REMOVE' | 'TASK_ITEM_ADDED' | 'TASK_ITEM_CHECKED' | 'TASK_ITEM_REMOVED' | 'TASK_LIST_SHARED',
```

**Step 3: Commit**

```bash
git add backend/src/services/tasklist.service.ts backend/src/services/notification.service.ts
git commit -m "feat(backend): add tasklist service with CRUD, sharing helpers, and notifications"
```

---

## Task 3: Backend Routes — tasklists.ts

**Files:**
- Create: `backend/src/routes/tasklists.ts`
- Modify: `backend/src/app.ts` (register route)

**Context:** Follow `notes.ts` pattern — default export async function, `fastify.addHook('onRequest', fastify.authenticate)` at top, Zod schemas at module scope, `.parse(request.body)` for validation.

**Step 1: Create the route file**

```typescript
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as tasklistService from '../services/tasklist.service';

const createTaskListSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1),
});

const updateTaskListSchema = z.object({
  title: z.string().min(1),
});

const createTaskItemSchema = z.object({
  id: z.string().uuid().optional(),
  text: z.string().min(1),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional().default('MEDIUM'),
  dueDate: z.string().nullable().optional(),
});

const updateTaskItemSchema = z.object({
  text: z.string().optional(),
  isChecked: z.boolean().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  dueDate: z.string().nullable().optional(),
  position: z.number().int().optional(),
});

const reorderSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    position: z.number().int(),
  })),
});

export default async function taskListRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // --- TaskList CRUD ---

  fastify.get('/', async (request) => {
    return tasklistService.getTaskLists(request.user.id);
  });

  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await tasklistService.getTaskList(request.user.id, id);
    } catch (err: any) {
      if (err.message === 'TaskList not found') return reply.status(404).send({ message: 'TaskList not found' });
      throw err;
    }
  });

  fastify.post('/', async (request) => {
    const { id, title } = createTaskListSchema.parse(request.body);
    return tasklistService.createTaskList(request.user.id, title, id);
  });

  fastify.put('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = updateTaskListSchema.parse(request.body);
    try {
      return await tasklistService.updateTaskList(request.user.id, id, data);
    } catch (err: any) {
      if (err.message === 'TaskList not found' || err.message === 'Access denied')
        return reply.status(404).send({ message: err.message });
      throw err;
    }
  });

  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await tasklistService.deleteTaskList(request.user.id, id);
    } catch (err: any) {
      if (err.message === 'TaskList not found') return reply.status(404).send({ message: 'TaskList not found' });
      throw err;
    }
  });

  // --- TaskItem CRUD ---

  fastify.post('/:id/items', async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = createTaskItemSchema.parse(request.body);
    try {
      return await tasklistService.addTaskItem(request.user.id, id, data);
    } catch (err: any) {
      if (err.message === 'TaskList not found' || err.message === 'Access denied')
        return reply.status(404).send({ message: err.message });
      throw err;
    }
  });

  fastify.put('/:id/items/:itemId', async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const data = updateTaskItemSchema.parse(request.body);
    try {
      return await tasklistService.updateTaskItem(request.user.id, id, itemId, data);
    } catch (err: any) {
      if (['TaskList not found', 'TaskItem not found', 'Access denied'].includes(err.message))
        return reply.status(404).send({ message: err.message });
      throw err;
    }
  });

  fastify.delete('/:id/items/:itemId', async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    try {
      await tasklistService.deleteTaskItem(request.user.id, id, itemId);
      return { message: 'Item deleted' };
    } catch (err: any) {
      if (['TaskList not found', 'TaskItem not found', 'Access denied'].includes(err.message))
        return reply.status(404).send({ message: err.message });
      throw err;
    }
  });

  fastify.put('/:id/items/reorder', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { items } = reorderSchema.parse(request.body);
    try {
      await tasklistService.reorderTaskItems(request.user.id, id, items);
      return { message: 'Reordered' };
    } catch (err: any) {
      if (err.message === 'TaskList not found' || err.message === 'Access denied')
        return reply.status(404).send({ message: err.message });
      throw err;
    }
  });
}
```

**Step 2: Register route in app.ts**

In `backend/src/app.ts`, add import and registration:

```typescript
import taskListRoutes from './routes/tasklists';
// ... after other route registrations:
server.register(taskListRoutes, { prefix: '/api/tasklists' });
```

**Step 3: Verify backend compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: No errors.

**Step 4: Commit**

```bash
git add backend/src/routes/tasklists.ts backend/src/app.ts
git commit -m "feat(backend): add tasklist routes with Zod validation"
```

---

## Task 4: Backend Sharing Routes for Task Lists

**Files:**
- Modify: `backend/src/routes/sharing.ts`
- Create: `backend/src/services/tasklist-sharing.service.ts`

**Context:** Follow the exact pattern from `sharing.service.ts` for `shareNote` — find target user, upsert SharedTaskList, send email + notification. Add the three routes (POST share, DELETE revoke, GET shared) to the existing `sharing.ts` route file.

**Step 1: Create tasklist-sharing.service.ts**

Functions to implement (follow `sharing.service.ts` patterns exactly):
- `shareTaskList(ownerId, taskListId, targetEmail, permission)` — upsert SharedTaskList, create TASK_LIST_SHARED notification, send email invite
- `revokeTaskListShare(ownerId, taskListId, targetUserId)` — delete SharedTaskList record
- `getSharedTaskLists(userId)` — return all SharedTaskList records for user with taskList included
- `respondToTaskListShare(userId, taskListId, action: 'accept' | 'decline')` — update status, notify owner

**Step 2: Add routes to sharing.ts**

After the existing notebook sharing routes, add:

```typescript
// Share task list
fastify.post('/tasklists/:id', async (request, reply) => { ... });
// Revoke task list share
fastify.delete('/tasklists/:id/:userId', async (request, reply) => { ... });
// Get shared task lists
fastify.get('/tasklists', async (request) => { ... });
// Get accepted shared task lists (for sync)
fastify.get('/tasklists/accepted', async (request) => { ... });
```

**Step 3: Verify**

Run: `cd backend && npx tsc --noEmit`

**Step 4: Commit**

```bash
git add backend/src/services/tasklist-sharing.service.ts backend/src/routes/sharing.ts
git commit -m "feat(backend): add task list sharing routes and service"
```

---

## Task 5: Dexie Schema — Version 13

**Files:**
- Modify: `frontend/src/lib/db.ts` (**TIER 1 — propose diff first**)

**CRITICAL:** Never modify existing Dexie versions. Only add version 13.

**Step 1: Add interfaces**

After `LocalTag` interface, add:

```typescript
export interface LocalTaskList {
  id: string;
  title: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  isTrashed: boolean;
  ownership?: 'owned' | 'shared';
  sharedPermission?: 'READ' | 'WRITE' | null;
  sharedByUser?: { id: string; name: string | null; email: string } | null;
  sharedWith?: {
    id: string;
    userId: string;
    permission: 'READ' | 'WRITE';
    status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
    user: { id: string; name: string | null; email: string };
  }[];
  items?: LocalTaskItem[];
  syncStatus: 'synced' | 'created' | 'updated';
}

export interface LocalTaskItem {
  id: string;
  taskListId: string;
  text: string;
  isChecked: boolean;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  dueDate?: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  syncStatus: 'synced' | 'created' | 'updated';
}
```

**Step 2: Add table declarations to AppDatabase class**

```typescript
taskLists!: Table<LocalTaskList>;
taskItems!: Table<LocalTaskItem>;
```

**Step 3: Add version 13**

After the existing `this.version(12)` block:

```typescript
this.version(13).stores({
  taskLists: 'id, userId, updatedAt, syncStatus, isTrashed',
  taskItems: 'id, taskListId, updatedAt, syncStatus, position',
});
```

**Step 4: Extend SyncQueueItem entity union**

```typescript
entity: 'NOTE' | 'NOTEBOOK' | 'TAG' | 'TASK_LIST' | 'TASK_ITEM';
```

**Step 5: Verify frontend compiles**

Run: `cd frontend && npx tsc --noEmit`

**Step 6: Commit**

```bash
git add frontend/src/lib/db.ts
git commit -m "feat(dexie): add taskLists and taskItems tables (version 13)"
```

---

## Task 6: Frontend Task List Service (Dexie + API)

**Files:**
- Create: `frontend/src/features/tasks/taskListService.ts`

**Context:** Follow `noteService.ts` pattern — operations write to Dexie first (offline-first), then queue a SyncQueueItem for push.

**Step 1: Create the service**

Functions:
- `createTaskList(title)` — generate uuid, write to `db.taskLists` with `syncStatus: 'created'`, queue CREATE
- `updateTaskList(id, data)` — update in Dexie, set `syncStatus: 'updated'`, queue UPDATE
- `deleteTaskList(id)` — set `isTrashed: true` in Dexie, queue UPDATE
- `permanentlyDeleteTaskList(id)` — delete from Dexie, queue DELETE
- `addTaskItem(taskListId, text, priority?, dueDate?)` — generate uuid, write to `db.taskItems`, queue CREATE for TASK_ITEM
- `updateTaskItem(id, data)` — update in Dexie, queue UPDATE for TASK_ITEM
- `deleteTaskItem(id)` — delete from Dexie, queue DELETE for TASK_ITEM
- `reorderTaskItems(items: {id, position}[])` — batch update positions in Dexie, queue UPDATE for each

All queue operations use `db.syncQueue.add({ type, entity, entityId, userId, data, createdAt: Date.now() })`.

**Step 2: Commit**

```bash
git add frontend/src/features/tasks/taskListService.ts
git commit -m "feat(frontend): add task list service with Dexie operations and sync queue"
```

---

## Task 7: Sync Service Extension (TIER 1)

**Files:**
- Modify: `frontend/src/features/sync/syncService.ts` (**TIER 1 — propose diff first**)

**CRITICAL:** This is the sync engine. Changes must be minimal and follow existing patterns exactly.

**Step 1: Add imports**

```typescript
import type { LocalTaskList, LocalTaskItem } from '../../lib/db';
```

**Step 2: Extend syncPull — add after the shared notes block**

Follow the exact notebooks pull pattern:

```typescript
// --- Task Lists Pull ---
try {
  const taskListsRes = await api.get<any[]>('/tasklists');
  const serverTaskLists = taskListsRes.data;

  await db.transaction('rw', db.taskLists, db.taskItems, async () => {
    const dirtyTaskLists = await db.taskLists.where('syncStatus').notEqual('synced').toArray();
    const dirtyIds = new Set(dirtyTaskLists.map(tl => tl.id));

    const taskListsToPut: LocalTaskList[] = serverTaskLists
      .filter((tl: any) => !dirtyIds.has(tl.id))
      .map((tl: any) => ({
        ...tl,
        ownership: 'owned',
        syncStatus: 'synced' as const,
      }));

    const serverIds = new Set(serverTaskLists.map((tl: any) => tl.id));
    const allLocalSynced = await db.taskLists.where('syncStatus').equals('synced')
      .filter(tl => tl.ownership !== 'shared').toArray();
    const toDeleteIds = allLocalSynced
      .filter(tl => !serverIds.has(tl.id))
      .map(tl => tl.id);

    if (toDeleteIds.length > 0) {
      await db.taskLists.bulkDelete(toDeleteIds);
      // Also delete orphan items
      for (const tlId of toDeleteIds) {
        await db.taskItems.where('taskListId').equals(tlId).delete();
      }
    }
    if (taskListsToPut.length > 0) await db.taskLists.bulkPut(taskListsToPut);

    // Sync items for each task list
    for (const tl of taskListsToPut) {
      if (tl.items && tl.items.length > 0) {
        const itemsToPut = tl.items.map((item: any) => ({
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
  const sharedRes = await api.get<any[]>('/share/tasklists/accepted');
  const sharedTaskLists = sharedRes.data;

  await db.transaction('rw', db.taskLists, db.taskItems, async () => {
    const sharedMapped: LocalTaskList[] = sharedTaskLists.map((tl: any) => ({
      ...tl,
      ownership: 'shared',
      sharedPermission: tl._sharedPermission,
      syncStatus: 'synced' as const,
    }));

    // Remove local shared task lists not in server response (revoked)
    const serverSharedIds = new Set(sharedMapped.map(tl => tl.id));
    const allLocalShared = await db.taskLists.where('ownership').equals('shared').toArray();
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
        const itemsToPut = tl.items.map((item: any) => ({
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
```

**Step 3: Extend syncPush — add TASK_LIST and TASK_ITEM branches**

In the `for...of queue` loop, after the TAG branch:

```typescript
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
    const taskListId = (item.data as any)?.taskListId;
    await api.post(`/tasklists/${taskListId}/items`, { ...item.data, id: item.entityId });
  } else if (item.type === 'UPDATE') {
    const taskListId = (item.data as any)?.taskListId;
    await api.put(`/tasklists/${taskListId}/items/${item.entityId}`, item.data);
  } else if (item.type === 'DELETE') {
    const taskListId = (item.data as any)?.taskListId;
    await api.delete(`/tasklists/${taskListId}/items/${item.entityId}`);
  }
}
```

After the queue item deletion, add the syncStatus update for task entities (same race-condition guard pattern as notes):

```typescript
// After: await db.syncQueue.delete(item.id!);
if (item.type !== 'DELETE') {
  // ... existing note/notebook/tag status updates ...
  if (item.entity === 'TASK_LIST') {
    const remaining = await db.syncQueue.where('entity').equals('TASK_LIST')
      .and(q => q.entityId === item.entityId).count();
    if (remaining === 0) {
      const entity = await db.taskLists.get(item.entityId);
      if (entity && new Date(entity.updatedAt).getTime() <= item.createdAt) {
        await db.taskLists.update(item.entityId, { syncStatus: 'synced' });
      }
    }
  } else if (item.entity === 'TASK_ITEM') {
    const remaining = await db.syncQueue.where('entity').equals('TASK_ITEM')
      .and(q => q.entityId === item.entityId).count();
    if (remaining === 0) {
      const entity = await db.taskItems.get(item.entityId);
      if (entity && new Date(entity.updatedAt).getTime() <= item.createdAt) {
        await db.taskItems.update(item.entityId, { syncStatus: 'synced' });
      }
    }
  }
}
```

**Step 4: Verify**

Run: `cd frontend && npx tsc --noEmit`

**Step 5: Commit**

```bash
git add frontend/src/features/sync/syncService.ts
git commit -m "feat(sync): extend syncPull and syncPush for task lists and items"
```

---

## Task 8: Rename Attivita to Promemoria

**Files:**
- Rename: `frontend/src/features/tasks/TasksPage.tsx` → `frontend/src/features/reminders/RemindersPage.tsx`
- Rename: `frontend/src/hooks/useTasks.ts` → `frontend/src/hooks/useReminders.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/layout/Sidebar.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/it.json`

**Step 1: Create reminders directory and copy+rename files**

```bash
mkdir -p frontend/src/features/reminders
cp frontend/src/features/tasks/TasksPage.tsx frontend/src/features/reminders/RemindersPage.tsx
```

Edit `RemindersPage.tsx`:
- Rename component to `RemindersPage`
- Change `useTasks` import to `useReminders` from `../../hooks/useReminders`
- Change page title from `t('sidebar.tasks')` to `t('sidebar.reminders')`

Copy+rename `useTasks.ts` → `useReminders.ts`, rename the export to `useReminders`.

**Step 2: Update App.tsx routes**

```tsx
import RemindersPage from './features/reminders/RemindersPage';
import TaskListsPage from './features/tasks/TaskListsPage'; // will create in Task 10
// ...
<Route path="reminders" element={<RemindersPage />} />
<Route path="tasks" element={<TaskListsPage />} />
// Remove the old: <Route path="tasks" element={<TasksPage />} />
```

**Step 3: Update Sidebar.tsx navItems**

Replace the CheckSquare tasks entry with two entries:

```typescript
{ icon: Bell, label: t('sidebar.reminders'), path: '/reminders' },
{ icon: ListChecks, label: t('sidebar.taskLists'), path: '/tasks' },
```

Import `Bell` and `ListChecks` from `lucide-react`.

**Step 4: Add i18n keys**

`en.json`:
```json
"sidebar.reminders": "Reminders",
"sidebar.taskLists": "Task Lists"
```

`it.json`:
```json
"sidebar.reminders": "Promemoria",
"sidebar.taskLists": "Task List"
```

**Step 5: Commit**

```bash
git add frontend/src/features/reminders/ frontend/src/hooks/useReminders.ts frontend/src/App.tsx frontend/src/components/layout/Sidebar.tsx frontend/src/locales/
git commit -m "feat(frontend): rename Attivita to Promemoria, add Task Lists sidebar entry"
```

---

## Task 9: i18n Keys — Full Set

**Files:**
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/it.json`

**Step 1: Add all task list keys to en.json**

```json
"taskLists": {
  "title": "Task Lists",
  "newList": "New List",
  "addItem": "Add item...",
  "deleteList": "Delete List",
  "deleteListConfirm": "Are you sure you want to delete this list? This action cannot be undone.",
  "editTitle": "Edit title",
  "noLists": "No task lists yet",
  "noListsDescription": "Create your first list to get started",
  "emptyList": "No items in this list",
  "progress": "{{done}}/{{total}} completed",
  "share": "Share List",
  "shared": "Shared",
  "sharedBy": "Shared by {{name}}",
  "priority": {
    "low": "Low",
    "medium": "Medium",
    "high": "High"
  },
  "dueDate": "Due date",
  "noDueDate": "No due date",
  "deleteItem": "Delete item",
  "deleteItemConfirm": "Remove this item?"
},
"notifications": {
  ...existing...,
  "taskItemAdded": "{{userName}} added \"{{itemText}}\" to {{listTitle}}",
  "taskItemChecked": "{{userName}} checked \"{{itemText}}\" in {{listTitle}}",
  "taskItemRemoved": "{{userName}} removed \"{{itemText}}\" from {{listTitle}}",
  "taskListShared": "{{sharerName}} shared the list \"{{listTitle}}\" with you"
}
```

**Step 2: Add all task list keys to it.json**

```json
"taskLists": {
  "title": "Task List",
  "newList": "Nuova Lista",
  "addItem": "Aggiungi elemento...",
  "deleteList": "Elimina Lista",
  "deleteListConfirm": "Sei sicuro di voler eliminare questa lista? L'azione non puo' essere annullata.",
  "editTitle": "Modifica titolo",
  "noLists": "Nessuna task list",
  "noListsDescription": "Crea la tua prima lista per iniziare",
  "emptyList": "Nessun elemento in questa lista",
  "progress": "{{done}}/{{total}} completati",
  "share": "Condividi Lista",
  "shared": "Condivisa",
  "sharedBy": "Condivisa da {{name}}",
  "priority": {
    "low": "Bassa",
    "medium": "Media",
    "high": "Alta"
  },
  "dueDate": "Scadenza",
  "noDueDate": "Nessuna scadenza",
  "deleteItem": "Elimina elemento",
  "deleteItemConfirm": "Rimuovere questo elemento?"
},
"notifications": {
  ...existing...,
  "taskItemAdded": "{{userName}} ha aggiunto \"{{itemText}}\" a {{listTitle}}",
  "taskItemChecked": "{{userName}} ha completato \"{{itemText}}\" in {{listTitle}}",
  "taskItemRemoved": "{{userName}} ha rimosso \"{{itemText}}\" da {{listTitle}}",
  "taskListShared": "{{sharerName}} ha condiviso la lista \"{{listTitle}}\" con te"
}
```

**Step 3: Commit**

```bash
git add frontend/src/locales/
git commit -m "feat(i18n): add all task list translation keys (en + it)"
```

---

## Task 10: Frontend — useTaskLists Hook

**Files:**
- Create: `frontend/src/hooks/useTaskLists.ts`

**Step 1: Create the hook**

```typescript
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';

export function useTaskLists() {
  return useLiveQuery(async () => {
    const taskLists = await db.taskLists
      .filter(tl => !tl.isTrashed)
      .toArray();

    // For each list, fetch its items
    const listsWithItems = await Promise.all(
      taskLists.map(async (tl) => {
        const items = await db.taskItems
          .where('taskListId').equals(tl.id)
          .sortBy('position');
        return { ...tl, items };
      })
    );

    return listsWithItems.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  });
}
```

**Step 2: Commit**

```bash
git add frontend/src/hooks/useTaskLists.ts
git commit -m "feat(frontend): add useTaskLists Dexie live query hook"
```

---

## Task 11: Frontend — TaskPriorityBadge Component

**Files:**
- Create: `frontend/src/features/tasks/TaskPriorityBadge.tsx`

**Step 1: Create component**

```tsx
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

const priorityConfig = {
  LOW: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400', dot: 'bg-green-500' },
  MEDIUM: { bg: 'bg-yellow-100 dark:bg-yellow-900/30', text: 'text-yellow-700 dark:text-yellow-400', dot: 'bg-yellow-500' },
  HIGH: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-400', dot: 'bg-red-500' },
};

export default function TaskPriorityBadge({ priority }: { priority: 'LOW' | 'MEDIUM' | 'HIGH' }) {
  const { t } = useTranslation();
  const config = priorityConfig[priority];
  return (
    <span className={clsx('inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium', config.bg, config.text)}>
      <span className={clsx('w-1.5 h-1.5 rounded-full', config.dot)} />
      {t(`taskLists.priority.${priority.toLowerCase()}`)}
    </span>
  );
}
```

**Step 2: Commit**

```bash
git add frontend/src/features/tasks/TaskPriorityBadge.tsx
git commit -m "feat(frontend): add TaskPriorityBadge component"
```

---

## Task 12: Frontend — TaskItemRow Component

**Files:**
- Create: `frontend/src/features/tasks/TaskItemRow.tsx`

**Step 1: Create component**

An individual task item row with:
- Checkbox (toggle isChecked)
- Text (editable inline on click)
- Priority badge (dropdown to change)
- Due date (date picker)
- Delete button (on hover)
- Drag handle (for @dnd-kit)

Interactions:
- Click checkbox → `onToggle(itemId)`
- Edit text → blur or Enter → `onUpdate(itemId, { text })`
- Change priority → `onUpdate(itemId, { priority })`
- Set due date → `onUpdate(itemId, { dueDate })`
- Click delete → `onDelete(itemId)`

Props interface:
```typescript
interface TaskItemRowProps {
  item: LocalTaskItem;
  readOnly?: boolean;
  onToggle: (id: string) => void;
  onUpdate: (id: string, data: Partial<LocalTaskItem>) => void;
  onDelete: (id: string) => void;
}
```

**Step 2: Commit**

```bash
git add frontend/src/features/tasks/TaskItemRow.tsx
git commit -m "feat(frontend): add TaskItemRow component"
```

---

## Task 13: Frontend — TaskListCard Component

**Files:**
- Create: `frontend/src/features/tasks/TaskListCard.tsx`

**Step 1: Create component**

An expandable card with:
- Header: title (editable), progress badge (X/Y), share icon, menu (delete)
- Body: list of TaskItemRow components, sorted by position (unchecked first, then checked)
- Footer: inline input to add new item
- Collapsed state: only header visible

Props:
```typescript
interface TaskListCardProps {
  taskList: LocalTaskList & { items: LocalTaskItem[] };
  readOnly?: boolean;
}
```

Operations all go through `taskListService.ts` which writes to Dexie + sync queue.

**Step 2: Commit**

```bash
git add frontend/src/features/tasks/TaskListCard.tsx
git commit -m "feat(frontend): add TaskListCard expandable component"
```

---

## Task 14: Frontend — NewTaskListModal Component

**Files:**
- Create: `frontend/src/features/tasks/NewTaskListModal.tsx`

**Step 1: Create component**

Follow `InputDialog` pattern from existing codebase. Simple modal with:
- Title input
- Create button
- Cancel button

Calls `taskListService.createTaskList(title)`.

**Step 2: Commit**

```bash
git add frontend/src/features/tasks/NewTaskListModal.tsx
git commit -m "feat(frontend): add NewTaskListModal component"
```

---

## Task 15: Frontend — TaskListSharingModal Component

**Files:**
- Create: `frontend/src/features/tasks/TaskListSharingModal.tsx`

**Step 1: Create component**

Follow the exact pattern from `SharingModal.tsx`:
- Email input + permission selector (READ/WRITE)
- Share button → calls API `POST /api/share/tasklists/:id`
- List of shared users with revoke button
- Group sharing support

The only differences from SharingModal:
- API endpoints use `/share/tasklists/:id` instead of `/share/notes/:id`
- Props take `taskListId` instead of `noteId`

**Step 2: Commit**

```bash
git add frontend/src/features/tasks/TaskListSharingModal.tsx
git commit -m "feat(frontend): add TaskListSharingModal component"
```

---

## Task 16: Frontend — TaskListsPage

**Files:**
- Create: `frontend/src/features/tasks/TaskListsPage.tsx`

**Step 1: Create page**

Follow TasksPage shell pattern (`bg-gray-50`, mobile hamburger, max-w-3xl):

```tsx
export default function TaskListsPage() {
  const { t } = useTranslation();
  const taskLists = useTaskLists();
  const isMobile = useIsMobile();
  const { toggleSidebar } = useUIStore();
  const [isNewModalOpen, setIsNewModalOpen] = useState(false);

  if (!taskLists) return <LoadingSpinner />;

  return (
    <div className="flex-1 h-full overflow-y-auto bg-gray-50 p-8 dark:bg-gray-900">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          {isMobile && <button onClick={toggleSidebar}><Menu size={24} /></button>}
          <h1>{t('taskLists.title')}</h1>
        </div>
        <button onClick={() => setIsNewModalOpen(true)}>{t('taskLists.newList')}</button>
      </div>

      <div className="max-w-3xl mx-auto space-y-4">
        {taskLists.length === 0 ? (
          <EmptyState />
        ) : (
          taskLists.map(tl => <TaskListCard key={tl.id} taskList={tl} readOnly={tl.ownership === 'shared' && tl.sharedPermission === 'READ'} />)
        )}
      </div>

      <NewTaskListModal isOpen={isNewModalOpen} onClose={() => setIsNewModalOpen(false)} />
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add frontend/src/features/tasks/TaskListsPage.tsx
git commit -m "feat(frontend): add TaskListsPage with card list and new modal"
```

---

## Task 17: Frontend — SharedWithMePage + NotificationItem Updates

**Files:**
- Modify: `frontend/src/features/sharing/SharedWithMePage.tsx`
- Modify: `frontend/src/features/notifications/NotificationItem.tsx`

**Step 1: Add Task Lists tab to SharedWithMePage**

Add a third tab "Task Lists" that fetches from `GET /api/share/tasklists` and shows pending/accepted task list shares, following the exact same pattern as the Notes and Notebooks tabs.

**Step 2: Update NotificationItem icon mapping**

Add cases for the new notification types:

```typescript
case 'TASK_ITEM_ADDED':
case 'TASK_ITEM_CHECKED':
case 'TASK_ITEM_REMOVED':
case 'TASK_LIST_SHARED':
  return <ListChecks size={20} className="text-emerald-500" />;
```

**Step 3: Commit**

```bash
git add frontend/src/features/sharing/SharedWithMePage.tsx frontend/src/features/notifications/NotificationItem.tsx
git commit -m "feat(frontend): add task list tab to shared page, update notification icons"
```

---

## Task 18: Install @dnd-kit and Implement Drag & Drop

**Files:**
- Modify: `frontend/package.json` (new dep)
- Modify: `frontend/src/features/tasks/TaskListCard.tsx`
- Modify: `frontend/src/features/tasks/TaskItemRow.tsx`

**Step 1: Install dependency**

Run: `cd frontend && npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities`

**Step 2: Wrap TaskListCard item list in DndContext + SortableContext**

**Step 3: Make TaskItemRow a sortable item with useSortable**

**Step 4: On drag end, call `taskListService.reorderTaskItems()` and update positions**

**Step 5: Verify**

Run: `cd frontend && npx tsc --noEmit`

**Step 6: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): add drag & drop reordering for task items"
```

---

## Task 19: Integration Testing & TypeScript Verification

**Step 1: Backend build**

Run: `cd backend && npm run build`
Expected: No errors.

**Step 2: Frontend build**

Run: `cd frontend && npm run build`
Expected: No errors.

**Step 3: Manual testing checklist**

- [ ] Start dev environment (`docker compose up -d` for DB, `npm run dev` in backend + frontend)
- [ ] Create a new task list
- [ ] Add items with different priorities
- [ ] Check/uncheck items
- [ ] Set due dates
- [ ] Drag to reorder items
- [ ] Delete an item
- [ ] Delete a task list
- [ ] Share a task list via email
- [ ] Accept the share from another account
- [ ] Verify notification received for item changes
- [ ] Verify Reminders page still works at `/reminders`
- [ ] Verify offline: disconnect, add items, reconnect, verify sync

**Step 4: Commit any fixes**

---

## Task 20: Version Bump, Changelog, Build for Deploy

**Files:**
- Modify: `frontend/package.json` (version → 1.3.0)
- Modify: `backend/package.json` (version → 1.3.0)
- Modify: `frontend/src/data/changelog.ts`
- Modify: `frontend/src/locales/en.json` (whatsNew entries)
- Modify: `frontend/src/locales/it.json` (whatsNew entries)

**Step 1: Bump versions**

**Step 2: Add changelog entry**

```typescript
{
  version: '1.3.0',
  date: '2026-XX-XX',
  entries: [
    { type: 'feature', titleKey: 'whatsNew.entries.taskLists' },
    { type: 'feature', titleKey: 'whatsNew.entries.taskListSharing' },
    { type: 'feature', titleKey: 'whatsNew.entries.taskListNotifications' },
    { type: 'improvement', titleKey: 'whatsNew.entries.remindersRename' },
  ],
}
```

**Step 3: Add whatsNew i18n keys**

**Step 4: Final commit + push + build**

```bash
git add -A
git commit -m "feat: Notiq v1.3.0 — task lists with sharing and notifications"
git push
cd frontend && npm run build
cd ../backend && npm run build
```

---

## Dependency Graph

```
Task 1 (Prisma schema)
  └─→ Task 2 (Backend service)
       └─→ Task 3 (Backend routes)
       └─→ Task 4 (Sharing routes)
  └─→ Task 5 (Dexie schema)
       └─→ Task 6 (Frontend service)
       └─→ Task 7 (Sync extension)
       └─→ Task 10 (useTaskLists hook)

Task 8 (Rename Attivita)  — independent
Task 9 (i18n keys)        — independent

Task 10 (hook) + Task 11 (PriorityBadge) + Task 12 (ItemRow)
  └─→ Task 13 (TaskListCard)
       └─→ Task 16 (TaskListsPage)

Task 14 (NewModal) — independent
Task 15 (SharingModal) — independent, needs Task 4 API
Task 17 (SharedWithMe + Notifications) — needs Task 4 API
Task 18 (Drag & drop) — needs Task 13

Task 19 (Testing) — needs all above
Task 20 (Version bump) — last
```

**Parallelizable streams:**
- Stream A: Tasks 1 → 2 → 3 → 4
- Stream B: Tasks 5 → 6 → 7 (after Task 1 for types)
- Stream C: Tasks 8, 9 (independent anytime)
- Stream D: Tasks 10 → 11 → 12 → 13 → 16 (after Stream B)
- Stream E: Tasks 14, 15, 17 (after Stream A)
- Final: 18 → 19 → 20
