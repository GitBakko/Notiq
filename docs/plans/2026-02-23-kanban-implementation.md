# Kanban Board Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add a collaborative Kanban board system to Notiq with drag-and-drop, sharing, real-time SSE updates, and notifications.

**Architecture:** Online-only (no Dexie sync for v1). TanStack Query for data fetching, SSE for real-time board updates, @dnd-kit for drag-and-drop. Sharing follows the existing centralized `/api/share` pattern with PENDING/ACCEPTED flow. Notifications for board sharing, card assignment, and comments on assigned cards.

**Tech Stack:** React 19, Fastify 5, Prisma 7, @dnd-kit, SSE via `reply.raw`, TanStack Query v5, Zustand (optimistic DnD state)

**Key Decisions:**
- **Real-time:** SSE (not polling) — in-memory `Map<boardId, Set<ServerResponse>>` broadcast registry
- **DnD:** @dnd-kit (already installed) — NOT native HTML5 DnD
- **Offline:** Online-only for v1 — TanStack Query cache only, no Dexie tables
- **Permission model:** Reuse existing `Permission` enum (not String)
- **Sharing routes:** Add to existing `sharing.ts` (not in kanban.ts) — follows codebase convention
- **Default columns:** Store keys in DB ('TODO', 'IN_PROGRESS', 'DONE'), translate in frontend
- **Column delete:** Error if has cards (no move option)
- **Board list UI:** Grid of cards (like notebooks)
- **Model naming:** `SharedKanbanBoard` (not `KanbanBoardShare`) — matches `SharedNote`, `SharedNotebook`, `SharedTaskList`
- **IDs:** `@default(uuid())` — matches existing convention (not `cuid()`)
- **Notification types:** `KANBAN_BOARD_SHARED`, `KANBAN_CARD_ASSIGNED`, `KANBAN_COMMENT_ADDED`

---

## Task 1: Prisma Schema + Migration

**Files:**
- Modify: `backend/prisma/schema.prisma`

**Step 1: Add 5 new models and 3 new enum values**

Add to `NotificationType` enum:
```prisma
  KANBAN_BOARD_SHARED
  KANBAN_CARD_ASSIGNED
  KANBAN_COMMENT_ADDED
```

Add to `User` model (at the end of relations):
```prisma
  kanbanBoards         KanbanBoard[]       @relation("KanbanOwner")
  kanbanAssignedCards  KanbanCard[]         @relation("KanbanAssignee")
  kanbanComments       KanbanComment[]      @relation("KanbanCommentAuthor")
  sharedKanbanBoards   SharedKanbanBoard[]  @relation("KanbanBoardShares")
```

Add to `Note` model (at the end of relations):
```prisma
  kanbanCards          KanbanCard[]
```

Add 5 new models (after existing models, before enums):

```prisma
model KanbanBoard {
  id          String              @id @default(uuid())
  title       String
  description String?
  ownerId     String
  owner       User                @relation("KanbanOwner", fields: [ownerId], references: [id])
  columns     KanbanColumn[]
  shares      SharedKanbanBoard[]
  createdAt   DateTime            @default(now())
  updatedAt   DateTime            @updatedAt

  @@index([ownerId])
}

model KanbanColumn {
  id       String       @id @default(uuid())
  title    String
  position Int
  boardId  String
  board    KanbanBoard  @relation(fields: [boardId], references: [id], onDelete: Cascade)
  cards    KanbanCard[]

  @@index([boardId])
}

model KanbanCard {
  id          String          @id @default(uuid())
  title       String
  description String?
  position    Int
  columnId    String
  column      KanbanColumn    @relation(fields: [columnId], references: [id], onDelete: Cascade)
  assigneeId  String?
  assignee    User?           @relation("KanbanAssignee", fields: [assigneeId], references: [id])
  dueDate     DateTime?
  noteId      String?
  note        Note?           @relation(fields: [noteId], references: [id])
  comments    KanbanComment[]
  createdAt   DateTime        @default(now())
  updatedAt   DateTime        @updatedAt

  @@index([columnId])
  @@index([assigneeId])
}

model KanbanComment {
  id        String     @id @default(uuid())
  content   String
  cardId    String
  card      KanbanCard @relation(fields: [cardId], references: [id], onDelete: Cascade)
  authorId  String
  author    User       @relation("KanbanCommentAuthor", fields: [authorId], references: [id])
  createdAt DateTime   @default(now())

  @@index([cardId])
}

model SharedKanbanBoard {
  id         String      @id @default(uuid())
  boardId    String
  board      KanbanBoard @relation(fields: [boardId], references: [id], onDelete: Cascade)
  userId     String
  user       User        @relation("KanbanBoardShares", fields: [userId], references: [id], onDelete: Cascade)
  permission Permission  @default(READ)
  status     ShareStatus @default(PENDING)
  createdAt  DateTime    @default(now())

  @@unique([boardId, userId])
  @@index([userId, status])
}
```

**Step 2: Run migration**

```bash
cd backend && npx prisma migrate dev --name add_kanban
```

**Step 3: Verify**

```bash
cd backend && npx prisma generate
cd backend && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/
git commit -m "feat(prisma): add Kanban board schema (5 models, 3 notification types)"
```

---

## Task 2: Backend Permission Helper

**Files:**
- Create: `backend/src/services/kanbanPermissions.ts`

**Step 1: Create the permission service**

This service provides `assertBoardAccess(boardId, userId, requiredPermission)` that:
1. Finds the board by ID (throw 404 if not found)
2. If user is owner → always allowed
3. If not owner → check `SharedKanbanBoard` for accepted share with sufficient permission
4. READ permission allows READ access; WRITE permission allows both READ and WRITE
5. Throw 403 if insufficient permission

Also export helper functions:
- `getBoardWithAccess(boardId, userId)` — returns board or throws
- `getColumnWithAccess(columnId, userId, requiredPermission)` — resolves column → board → checks access
- `getCardWithAccess(cardId, userId, requiredPermission)` — resolves card → column → board → checks access

Follow the pattern from `tasklist.service.ts` `assertWriteAccess`:

```typescript
import { prisma } from '../plugins/prisma';

export async function assertBoardAccess(
  boardId: string,
  userId: string,
  requiredPermission: 'READ' | 'WRITE'
): Promise<{ isOwner: boolean }> {
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: { ownerId: true },
  });
  if (!board) throw new Error('Board not found');
  if (board.ownerId === userId) return { isOwner: true };

  const share = await prisma.sharedKanbanBoard.findUnique({
    where: { boardId_userId: { boardId, userId } },
    select: { permission: true, status: true },
  });
  if (!share || share.status !== 'ACCEPTED') throw new Error('Access denied');
  if (requiredPermission === 'WRITE' && share.permission !== 'WRITE') {
    throw new Error('Write access required');
  }
  return { isOwner: false };
}

// getColumnWithAccess and getCardWithAccess follow same pattern,
// looking up the parent chain to find the boardId, then calling assertBoardAccess
```

**Step 2: Verify**

```bash
cd backend && npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add backend/src/services/kanbanPermissions.ts
git commit -m "feat(backend): add Kanban permission helper service"
```

---

## Task 3: SSE Broadcast Registry

**Files:**
- Create: `backend/src/services/kanbanSSE.ts`

**Step 1: Create the in-memory SSE broadcast registry**

Follow the existing SSE pattern from `backend/src/routes/ai.ts` (`reply.raw.writeHead` + `reply.raw.write`).

```typescript
import { ServerResponse } from 'http';

// In-memory registry: boardId → Set of active SSE connections
const boardConnections = new Map<string, Set<ServerResponse>>();

export function addConnection(boardId: string, res: ServerResponse): void {
  if (!boardConnections.has(boardId)) {
    boardConnections.set(boardId, new Set());
  }
  boardConnections.get(boardId)!.add(res);

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 30000);

  // Clean up on disconnect
  res.on('close', () => {
    boardConnections.get(boardId)?.delete(res);
    if (boardConnections.get(boardId)?.size === 0) {
      boardConnections.delete(boardId);
    }
    clearInterval(heartbeat);
  });
}

export function broadcast(boardId: string, event: KanbanEvent): void {
  const connections = boardConnections.get(boardId);
  if (!connections) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of connections) {
    try { res.write(data); } catch { /* connection dead, will be cleaned up */ }
  }
}

export type KanbanEvent =
  | { type: 'card:moved';    boardId: string; cardId: string; toColumnId: string; position: number }
  | { type: 'card:created';  boardId: string; card: object }
  | { type: 'card:updated';  boardId: string; card: object }
  | { type: 'card:deleted';  boardId: string; cardId: string }
  | { type: 'column:created';  boardId: string; column: object }
  | { type: 'column:updated';  boardId: string; column: object }
  | { type: 'column:deleted';  boardId: string; columnId: string }
  | { type: 'columns:reordered'; boardId: string; columns: { id: string; position: number }[] }
  | { type: 'comment:added'; boardId: string; cardId: string; comment: object };
```

**Step 2: Verify**

```bash
cd backend && npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add backend/src/services/kanbanSSE.ts
git commit -m "feat(backend): add SSE broadcast registry for Kanban real-time"
```

---

## Task 4: Backend Kanban Service

**Files:**
- Create: `backend/src/services/kanban.service.ts`

**Step 1: Create the Kanban service with all business logic**

Named exports following existing service pattern. Functions:

**Board CRUD:**
- `listBoards(userId)` — boards owned + shared (ACCEPTED). Returns with column/card counts.
- `createBoard(userId, title, description?)` — creates board + 3 default columns ('TODO' pos 0, 'IN_PROGRESS' pos 1, 'DONE' pos 2) in a transaction
- `getBoard(boardId)` — full board with columns (ordered by position) + cards (ordered by position) + card assignee info + shares
- `updateBoard(boardId, data: { title?, description? })` — partial update
- `deleteBoard(boardId)` — cascading delete

**Column CRUD:**
- `createColumn(boardId, title)` — position = max(existing positions) + 1
- `updateColumn(columnId, title)` — rename only
- `reorderColumns(boardId, items: { id, position }[])` — batch update positions in transaction
- `deleteColumn(columnId)` — check for cards first, throw if any exist

**Card CRUD:**
- `createCard(columnId, title, description?)` — position = max(existing positions in column) + 1
- `updateCard(cardId, data: { title?, description?, assigneeId?, dueDate?, noteId? })` — partial update
- `moveCard(cardId, toColumnId, newPosition)` — update positions of affected cards in both source and target columns
- `deleteCard(cardId)` — delete + reorder remaining cards in column

**Comments:**
- `getComments(cardId, page, limit)` — paginated, ordered by createdAt ASC, include author info
- `createComment(cardId, authorId, content)` — create + return with author
- `deleteComment(commentId, userId)` — only own comments

**Notification helpers:**
- `notifyBoardCollaborators(actorId, boardId, type, data)` — notify owner + all ACCEPTED shares except actor
- On card assign → notify assignee with `KANBAN_CARD_ASSIGNED`
- On comment on card with assignee → notify assignee with `KANBAN_COMMENT_ADDED`

Each mutation function should call `broadcast()` from kanbanSSE.ts after the DB write.

**Step 2: Verify**

```bash
cd backend && npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add backend/src/services/kanban.service.ts
git commit -m "feat(backend): add Kanban service with full CRUD + SSE broadcast + notifications"
```

---

## Task 5: Backend Kanban Routes

**Files:**
- Create: `backend/src/routes/kanban.ts`
- Modify: `backend/src/app.ts` — register route

**Step 1: Create route file with Zod validation**

Follow the pattern from `backend/src/routes/tasklists.ts`. All routes protected with `fastify.addHook('onRequest', fastify.authenticate)` at plugin level.

**Zod schemas at top of file:**

```typescript
const createBoardSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const updateBoardSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
});

const createColumnSchema = z.object({
  title: z.string().min(1).max(100),
});

const reorderColumnsSchema = z.object({
  columns: z.array(z.object({
    id: z.string().uuid(),
    position: z.number().int().min(0),
  })),
});

const createCardSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
});

const updateCardSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  noteId: z.string().uuid().nullable().optional(),
});

const moveCardSchema = z.object({
  toColumnId: z.string().uuid(),
  position: z.number().int().min(0),
});

const createCommentSchema = z.object({
  content: z.string().min(1).max(5000),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(50),
});
```

**Routes:**

```
GET    /boards              → listBoards
POST   /boards              → createBoard
GET    /boards/:id          → getBoard (+ assertBoardAccess READ)
PUT    /boards/:id          → updateBoard (+ assertBoardAccess WRITE)
DELETE /boards/:id          → deleteBoard (+ assertBoardAccess, owner only)

POST   /boards/:id/columns  → createColumn (+ assertBoardAccess WRITE)
PUT    /columns/:id         → updateColumn (+ getColumnWithAccess WRITE)
PATCH  /columns/reorder     → reorderColumns (+ assertBoardAccess WRITE, boardId from body or first column)
DELETE /columns/:id         → deleteColumn (+ getColumnWithAccess WRITE)

POST   /columns/:id/cards   → createCard (+ getColumnWithAccess WRITE)
PUT    /cards/:id           → updateCard (+ getCardWithAccess WRITE)
PATCH  /cards/:id/move      → moveCard (+ getCardWithAccess WRITE)
DELETE /cards/:id           → deleteCard (+ getCardWithAccess WRITE)

GET    /cards/:id/comments  → getComments (+ getCardWithAccess READ)
POST   /cards/:id/comments  → createComment (+ getCardWithAccess WRITE)
DELETE /comments/:id        → deleteComment (own comment only)

GET    /boards/:id/events   → SSE stream (+ assertBoardAccess READ)
```

**SSE endpoint pattern** (from `ai.ts`):

```typescript
fastify.get('/boards/:id/events', async (request, reply) => {
  const { id } = request.params as { id: string };
  const userId = request.user.id;
  await assertBoardAccess(id, userId, 'READ');

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  addConnection(id, reply.raw);

  // Send initial connected event
  reply.raw.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  // Keep connection open — Fastify won't auto-end since we wrote to raw
  request.raw.on('close', () => {
    // Connection cleanup handled by addConnection's close listener
  });
});
```

**Error handling convention (per handler):**

```typescript
try {
  // ... service call
} catch (error: any) {
  if (error.message === 'Board not found') return reply.status(404).send({ message: error.message });
  if (error.message === 'Access denied') return reply.status(403).send({ message: error.message });
  if (error.message === 'Write access required') return reply.status(403).send({ message: error.message });
  throw error;
}
```

**Step 2: Register route in app.ts**

Add import and registration:
```typescript
import kanbanRoutes from './routes/kanban';
// ...
server.register(kanbanRoutes, { prefix: '/api/kanban' });
```

**Step 3: Verify**

```bash
cd backend && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add backend/src/routes/kanban.ts backend/src/app.ts
git commit -m "feat(backend): add Kanban REST + SSE routes with Zod validation"
```

---

## Task 6: Backend Sharing Integration

**Files:**
- Modify: `backend/src/routes/sharing.ts` — add kanban sharing routes
- Modify: `backend/src/services/sharing.service.ts` — add kanban sharing logic

**Step 1: Add to sharing.service.ts**

Add 3 functions following the exact TaskList sharing pattern:

- `shareKanbanBoard(ownerId, boardId, email, permission)` — verify ownership, find user by email, upsert SharedKanbanBoard, send notification + email
- `revokeKanbanBoardShare(ownerId, boardId, targetUserId)` — verify ownership, delete share
- `respondToKanbanShare(boardId, userId, action: 'accept' | 'decline')` — update status

Use `KANBAN_BOARD_SHARED` notification type with `localizationKey: 'notifications.kanbanBoardShared'` and `localizationArgs: { sharerName, itemName: board.title }`.

**Step 2: Add to sharing.ts routes**

Add after the tasklists section (before the plugin closing):

```typescript
// --- Kanban Board sharing ---
fastify.post('/kanbans/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const { email, permission } = shareSchema.parse(request.body);
  const result = await sharingService.shareKanbanBoard(request.user.id, id, email, permission);
  return result;
});

fastify.delete('/kanbans/:id/:userId', async (request, reply) => {
  const { id, userId } = request.params as { id: string; userId: string };
  await sharingService.revokeKanbanBoardShare(request.user.id, id, userId);
  return { success: true };
});

fastify.get('/kanbans', async (request, reply) => {
  // List all kanban boards shared with this user
  const shares = await prisma.sharedKanbanBoard.findMany({
    where: { userId: request.user.id },
    include: { board: { select: { id: true, title: true, description: true, ownerId: true, owner: { select: { id: true, name: true, email: true } } } } },
  });
  return shares;
});
```

Also update `respondByIdSchema.type` to include `'KANBAN'`:
```typescript
type: z.enum(['NOTE', 'NOTEBOOK', 'TASKLIST', 'KANBAN']),
```

And add the respond logic for KANBAN type in the `respond-id` handler.

**Step 3: Verify**

```bash
cd backend && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add backend/src/routes/sharing.ts backend/src/services/sharing.service.ts
git commit -m "feat(backend): add Kanban board sharing integration"
```

---

## Task 7: Frontend Types + API Service

**Files:**
- Create: `frontend/src/features/kanban/types.ts`
- Create: `frontend/src/features/kanban/kanbanService.ts`

**Step 1: Create TypeScript interfaces**

```typescript
// types.ts
export interface KanbanBoard {
  id: string;
  title: string;
  description: string | null;
  ownerId: string;
  owner?: { id: string; name: string | null; email: string };
  columns: KanbanColumn[];
  shares?: SharedKanbanBoard[];
  createdAt: string;
  updatedAt: string;
}

export interface KanbanBoardListItem {
  id: string;
  title: string;
  description: string | null;
  ownerId: string;
  owner?: { id: string; name: string | null; email: string };
  columnCount: number;
  cardCount: number;
  ownership: 'owned' | 'shared';
  permission?: 'READ' | 'WRITE';
  createdAt: string;
  updatedAt: string;
}

export interface KanbanColumn {
  id: string;
  title: string;
  position: number;
  boardId: string;
  cards: KanbanCard[];
}

export interface KanbanCard {
  id: string;
  title: string;
  description: string | null;
  position: number;
  columnId: string;
  assigneeId: string | null;
  assignee: { id: string; name: string | null; email: string; color: string | null } | null;
  dueDate: string | null;
  noteId: string | null;
  note: { id: string; title: string } | null;
  comments?: KanbanComment[];
  createdAt: string;
  updatedAt: string;
}

export interface KanbanComment {
  id: string;
  content: string;
  cardId: string;
  authorId: string;
  author: { id: string; name: string | null; email: string; color: string | null };
  createdAt: string;
}

export interface SharedKanbanBoard {
  id: string;
  userId: string;
  user: { id: string; name: string | null; email: string };
  permission: 'READ' | 'WRITE';
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
}

// Column key → i18n key mapping for default columns
export const DEFAULT_COLUMN_KEYS: Record<string, string> = {
  'TODO': 'kanban.column.todo',
  'IN_PROGRESS': 'kanban.column.inProgress',
  'DONE': 'kanban.column.done',
};

// SSE event types
export type KanbanSSEEvent =
  | { type: 'connected' }
  | { type: 'card:moved'; boardId: string; cardId: string; toColumnId: string; position: number }
  | { type: 'card:created'; boardId: string; card: KanbanCard }
  | { type: 'card:updated'; boardId: string; card: KanbanCard }
  | { type: 'card:deleted'; boardId: string; cardId: string }
  | { type: 'column:created'; boardId: string; column: KanbanColumn }
  | { type: 'column:updated'; boardId: string; column: KanbanColumn }
  | { type: 'column:deleted'; boardId: string; columnId: string }
  | { type: 'columns:reordered'; boardId: string; columns: { id: string; position: number }[] }
  | { type: 'comment:added'; boardId: string; cardId: string; comment: KanbanComment };
```

**Step 2: Create API service**

```typescript
// kanbanService.ts — pure API wrappers (online-only, no Dexie)
import api from '../../lib/api';
import type { KanbanBoard, KanbanBoardListItem, KanbanCard, KanbanComment } from './types';

// Boards
export const listBoards = async (): Promise<KanbanBoardListItem[]> =>
  (await api.get('/kanban/boards')).data;

export const createBoard = async (data: { title: string; description?: string }): Promise<KanbanBoard> =>
  (await api.post('/kanban/boards', data)).data;

export const getBoard = async (boardId: string): Promise<KanbanBoard> =>
  (await api.get(`/kanban/boards/${boardId}`)).data;

export const updateBoard = async (boardId: string, data: { title?: string; description?: string | null }): Promise<void> => {
  await api.put(`/kanban/boards/${boardId}`, data);
};

export const deleteBoard = async (boardId: string): Promise<void> => {
  await api.delete(`/kanban/boards/${boardId}`);
};

// Columns
export const createColumn = async (boardId: string, title: string) =>
  (await api.post(`/kanban/boards/${boardId}/columns`, { title })).data;

export const updateColumn = async (columnId: string, title: string) =>
  (await api.put(`/kanban/columns/${columnId}`, { title })).data;

export const reorderColumns = async (columns: { id: string; position: number }[]) =>
  (await api.patch('/kanban/columns/reorder', { columns })).data;

export const deleteColumn = async (columnId: string) =>
  await api.delete(`/kanban/columns/${columnId}`);

// Cards
export const createCard = async (columnId: string, data: { title: string; description?: string }) =>
  (await api.post(`/kanban/columns/${columnId}/cards`, data)).data;

export const updateCard = async (cardId: string, data: Partial<Pick<KanbanCard, 'title' | 'description' | 'assigneeId' | 'dueDate' | 'noteId'>>) =>
  (await api.put(`/kanban/cards/${cardId}`, data)).data;

export const moveCard = async (cardId: string, toColumnId: string, position: number) =>
  (await api.patch(`/kanban/cards/${cardId}/move`, { toColumnId, position })).data;

export const deleteCard = async (cardId: string) =>
  await api.delete(`/kanban/cards/${cardId}`);

// Comments
export const getComments = async (cardId: string): Promise<KanbanComment[]> =>
  (await api.get(`/kanban/cards/${cardId}/comments`)).data;

export const createComment = async (cardId: string, content: string): Promise<KanbanComment> =>
  (await api.post(`/kanban/cards/${cardId}/comments`, { content })).data;

export const deleteComment = async (commentId: string) =>
  await api.delete(`/kanban/comments/${commentId}`);

// Sharing
export const shareBoard = async (boardId: string, email: string, permission: 'READ' | 'WRITE') =>
  (await api.post(`/share/kanbans/${boardId}`, { email, permission })).data;

export const revokeShare = async (boardId: string, userId: string) =>
  await api.delete(`/share/kanbans/${boardId}/${userId}`);

export const getShares = async (boardId: string): Promise<SharedKanbanBoard[]> =>
  // Shares come as part of getBoard response
  [];
```

**Step 3: Verify**

```bash
cd frontend && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add frontend/src/features/kanban/
git commit -m "feat(frontend): add Kanban types and API service"
```

---

## Task 8: Frontend TanStack Query Hooks

**Files:**
- Create: `frontend/src/features/kanban/hooks/useKanbanBoards.ts`
- Create: `frontend/src/features/kanban/hooks/useKanbanBoard.ts`
- Create: `frontend/src/features/kanban/hooks/useKanbanMutations.ts`

**Step 1: Create board list hook**

```typescript
// useKanbanBoards.ts
import { useQuery } from '@tanstack/react-query';
import { listBoards } from '../kanbanService';

export function useKanbanBoards() {
  return useQuery({
    queryKey: ['kanban-boards'],
    queryFn: listBoards,
  });
}
```

**Step 2: Create single board hook**

```typescript
// useKanbanBoard.ts
import { useQuery } from '@tanstack/react-query';
import { getBoard } from '../kanbanService';

export function useKanbanBoard(boardId: string | undefined) {
  return useQuery({
    queryKey: ['kanban-board', boardId],
    queryFn: () => getBoard(boardId!),
    enabled: !!boardId,
  });
}
```

**Step 3: Create mutations hook**

```typescript
// useKanbanMutations.ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as kanbanService from '../kanbanService';

export function useKanbanMutations(boardId?: string) {
  const queryClient = useQueryClient();

  const invalidateBoard = () => {
    if (boardId) queryClient.invalidateQueries({ queryKey: ['kanban-board', boardId] });
    queryClient.invalidateQueries({ queryKey: ['kanban-boards'] });
  };

  const createBoard = useMutation({
    mutationFn: kanbanService.createBoard,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['kanban-boards'] }),
  });

  const deleteBoard = useMutation({
    mutationFn: kanbanService.deleteBoard,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['kanban-boards'] }),
  });

  const updateBoard = useMutation({
    mutationFn: ({ boardId, ...data }: { boardId: string } & Parameters<typeof kanbanService.updateBoard>[1]) =>
      kanbanService.updateBoard(boardId, data),
    onSuccess: invalidateBoard,
  });

  const createColumn = useMutation({
    mutationFn: ({ boardId, title }: { boardId: string; title: string }) =>
      kanbanService.createColumn(boardId, title),
    onSuccess: invalidateBoard,
  });

  const updateColumn = useMutation({
    mutationFn: ({ columnId, title }: { columnId: string; title: string }) =>
      kanbanService.updateColumn(columnId, title),
    onSuccess: invalidateBoard,
  });

  const deleteColumn = useMutation({
    mutationFn: kanbanService.deleteColumn,
    onSuccess: invalidateBoard,
  });

  const createCard = useMutation({
    mutationFn: ({ columnId, ...data }: { columnId: string; title: string; description?: string }) =>
      kanbanService.createCard(columnId, data),
    onSuccess: invalidateBoard,
  });

  const updateCard = useMutation({
    mutationFn: ({ cardId, ...data }: { cardId: string } & Parameters<typeof kanbanService.updateCard>[1]) =>
      kanbanService.updateCard(cardId, data),
    onSuccess: invalidateBoard,
  });

  const moveCard = useMutation({
    mutationFn: ({ cardId, toColumnId, position }: { cardId: string; toColumnId: string; position: number }) =>
      kanbanService.moveCard(cardId, toColumnId, position),
    onSuccess: invalidateBoard,
  });

  const deleteCard = useMutation({
    mutationFn: kanbanService.deleteCard,
    onSuccess: invalidateBoard,
  });

  return {
    createBoard, deleteBoard, updateBoard,
    createColumn, updateColumn, deleteColumn,
    createCard, updateCard, moveCard, deleteCard,
  };
}
```

**Step 4: Verify**

```bash
cd frontend && npx tsc --noEmit
```

**Step 5: Commit**

```bash
git add frontend/src/features/kanban/hooks/
git commit -m "feat(frontend): add Kanban TanStack Query hooks"
```

---

## Task 9: Frontend SSE Real-time Hook

**Files:**
- Create: `frontend/src/features/kanban/hooks/useKanbanRealtime.ts`

**Step 1: Create the SSE hook**

Follow the pattern from `frontend/src/hooks/useAiChat.ts` (fetch + ReadableStream reader, NOT EventSource, for JWT auth):

```typescript
// useKanbanRealtime.ts
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../../../store/authStore';
import api from '../../../lib/api';
import type { KanbanSSEEvent } from '../types';

export function useKanbanRealtime(boardId: string | undefined) {
  const queryClient = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!boardId) return;

    const token = useAuthStore.getState().token;
    if (!token) return;

    const abortController = new AbortController();
    abortRef.current = abortController;

    const connect = async () => {
      try {
        const response = await fetch(`${api.defaults.baseURL}/kanban/boards/${boardId}/events`, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: abortController.signal,
        });

        if (!response.ok || !response.body) return;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const event: KanbanSSEEvent = JSON.parse(line.slice(6));
              handleEvent(event);
            } catch { /* ignore parse errors */ }
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        // Reconnect after 5s on error
        setTimeout(connect, 5000);
      }
    };

    const handleEvent = (event: KanbanSSEEvent) => {
      if (event.type === 'connected') return;
      // Invalidate board query to refetch fresh data
      queryClient.invalidateQueries({ queryKey: ['kanban-board', boardId] });
    };

    connect();

    return () => {
      abortController.abort();
      abortRef.current = null;
    };
  }, [boardId, queryClient]);
}
```

**Step 2: Verify**

```bash
cd frontend && npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add frontend/src/features/kanban/hooks/useKanbanRealtime.ts
git commit -m "feat(frontend): add Kanban SSE real-time hook"
```

---

## Task 10: Frontend Components — KanbanCard + KanbanColumn

**Files:**
- Create: `frontend/src/features/kanban/components/KanbanCard.tsx`
- Create: `frontend/src/features/kanban/components/KanbanColumn.tsx`

**Step 1: Create KanbanCard (draggable chip)**

Uses `useSortable` from @dnd-kit. Shows:
- Title (truncated)
- Assignee avatar (color circle with initial, like chat)
- Due date badge (red if overdue, amber if today, gray otherwise)
- Comment count icon
- Linked note icon
- Click opens CardDetailModal (via onSelect callback)
- Drag handle via `...listeners` on card body

**Step 2: Create KanbanColumn**

Uses `useDroppable` from @dnd-kit for cross-column drops. Shows:
- Column title (with inline rename on double-click, or display translated name if it's a default key)
- Card count badge
- "Add card" button at bottom (inline input that appears on click)
- Cards wrapped in `SortableContext` with `verticalListSortingStrategy`
- Delete column button (in dropdown menu, disabled if cards > 0)
- Column styled as a vertical card with header + scrollable card list

**Step 3: Verify**

```bash
cd frontend && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add frontend/src/features/kanban/components/KanbanCard.tsx frontend/src/features/kanban/components/KanbanColumn.tsx
git commit -m "feat(frontend): add KanbanCard and KanbanColumn components with @dnd-kit"
```

---

## Task 11: Frontend Components — CardDetailModal

**Files:**
- Create: `frontend/src/features/kanban/components/CardDetailModal.tsx`
- Create: `frontend/src/features/kanban/hooks/useKanbanComments.ts`

**Step 1: Create comments hook**

```typescript
// useKanbanComments.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as kanbanService from '../kanbanService';

export function useKanbanComments(cardId: string | undefined) {
  const queryClient = useQueryClient();

  const { data: comments, isLoading } = useQuery({
    queryKey: ['kanban-comments', cardId],
    queryFn: () => kanbanService.getComments(cardId!),
    enabled: !!cardId,
  });

  const addComment = useMutation({
    mutationFn: (content: string) => kanbanService.createComment(cardId!, content),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kanban-comments', cardId] });
      queryClient.invalidateQueries({ queryKey: ['kanban-board'] });
    },
  });

  const removeComment = useMutation({
    mutationFn: kanbanService.deleteComment,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['kanban-comments', cardId] }),
  });

  return { comments, isLoading, addComment, removeComment };
}
```

**Step 2: Create CardDetailModal**

Uses `Modal` from `components/ui/Modal.tsx`. Sections:

1. **Title** — editable inline (click to edit, Enter to save, Escape to cancel)
2. **Description** — editable textarea (auto-resize, saves on blur)
3. **Metadata row:**
   - Assignee — email input + search (shares existing `shareSchema` pattern — type email, backend resolves). Shows current assignee avatar + name. Clear button to unassign.
   - Due date — `<input type="date">` (native picker)
   - Linked note — dropdown/search for user's notes (fetch from `/api/notes` or existing hook)
4. **Comments section:**
   - List of comments with author avatar (color circle), name, time (formatDistanceToNow), content
   - Delete button on own comments (hover reveal)
   - Compose input at bottom: text input + send button (follows chat pattern)

**Read-only mode:** If user has READ permission, all fields are non-editable, comments are viewable but compose is hidden.

**Step 3: Verify**

```bash
cd frontend && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add frontend/src/features/kanban/components/CardDetailModal.tsx frontend/src/features/kanban/hooks/useKanbanComments.ts
git commit -m "feat(frontend): add CardDetailModal with comments"
```

---

## Task 12: Frontend Components — CreateBoardModal + ShareBoardModal + BoardCard

**Files:**
- Create: `frontend/src/features/kanban/components/CreateBoardModal.tsx`
- Create: `frontend/src/features/kanban/components/ShareBoardModal.tsx`
- Create: `frontend/src/features/kanban/components/BoardCard.tsx`

**Step 1: Create CreateBoardModal**

Follow `NewTaskListModal` pattern exactly. Fields: title (required), description (optional textarea). On submit, calls `createBoard` mutation. Uses `Modal` component.

**Step 2: Create ShareBoardModal**

Mirror `SharingModal.tsx` (`frontend/src/components/sharing/SharingModal.tsx`). Same structure:
- Email input + permission select + share button
- Group sharing section (if groups available)
- List of current shares with permission badge + revoke button
- Props: `{ isOpen, onClose, boardId, boardTitle, sharedWith? }`

API calls: `shareBoard`, `revokeShare` from kanbanService.

**Step 3: Create BoardCard**

Grid card component for the board list. Shows:
- Title (bold)
- Description (truncated, 2 lines)
- Footer: column count, card count, updatedAt (formatDistanceToNow)
- Share icon if shared (with tooltip showing collaborator count)
- Shared badge if `ownership === 'shared'`
- Click navigates to `/kanban?boardId=<id>` (matching the existing pattern of query-param navigation)
- Context menu (three-dot) with: Share, Delete (owner only)

Style: card with `rounded-xl`, hover shadow, `dark:` variants. Grid uses `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4`.

**Step 4: Verify**

```bash
cd frontend && npx tsc --noEmit
```

**Step 5: Commit**

```bash
git add frontend/src/features/kanban/components/
git commit -m "feat(frontend): add CreateBoardModal, ShareBoardModal, BoardCard components"
```

---

## Task 13: Frontend Pages — KanbanPage + KanbanBoardPage

**Files:**
- Create: `frontend/src/features/kanban/KanbanPage.tsx`
- Create: `frontend/src/features/kanban/KanbanBoardPage.tsx`

**Step 1: Create KanbanPage (board list)**

Follow `TaskListsPage.tsx` layout pattern:
- Sticky header with backdrop blur: title "Kanban" + "New Board" button
- Mobile hamburger menu (useIsMobile + toggleSidebar)
- Content area: grid of `BoardCard` components
- Loading state: spinner
- Empty state: icon + message + create button
- CreateBoardModal at bottom (controlled by state)
- ShareBoardModal at bottom (controlled by boardId state)

**Step 2: Create KanbanBoardPage**

The board view. Uses query param `boardId` from URL (pattern: `/kanban?boardId=<id>`).

Layout:
- Header: back arrow + board title (editable inline) + share button + menu (delete board)
- Horizontal scrollable area: columns side by side
- Each column is `min-w-[280px] w-[280px]` with `flex-shrink-0`
- "Add Column" button at the end of the horizontal scroll

DnD setup:
- `DndContext` wrapping all columns
- Each column has its own `SortableContext` for intra-column reorder
- Cross-column moves: use `onDragOver` to detect column change + `onDragEnd` to finalize
- `collisionDetection: closestCorners` for cross-column detection
- On drag end: call `moveCard` mutation (optimistic update via `queryClient.setQueryData`)

SSE: `useKanbanRealtime(boardId)` — auto-reconnects, invalidates board query on events.

**Step 3: Verify**

```bash
cd frontend && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add frontend/src/features/kanban/KanbanPage.tsx frontend/src/features/kanban/KanbanBoardPage.tsx
git commit -m "feat(frontend): add KanbanPage and KanbanBoardPage with DnD"
```

---

## Task 14: Router + Sidebar Integration

**Files:**
- Modify: `frontend/src/App.tsx` — add kanban route
- Modify: `frontend/src/components/layout/Sidebar.tsx` — add nav item

**Step 1: Add route to App.tsx**

Inside `<Route element={<AppLayout />}>`, add:

```tsx
import KanbanPage from './features/kanban/KanbanPage';

<Route path="kanban" element={<KanbanPage />} />
```

The KanbanPage component will internally check for `boardId` query param and render either the board list or the board view (similar pattern to how notes page works with `noteId`).

Alternatively, if the prompt's `/kanban/:boardId` pattern is preferred, add:
```tsx
<Route path="kanban" element={<KanbanPage />} />
<Route path="kanban/:boardId" element={<KanbanBoardPage />} />
```

Use the query-param approach to match existing codebase conventions.

**Step 2: Add sidebar nav item**

In `Sidebar.tsx`, add to `navItems` array between Notes and Tasks:

```typescript
{ icon: LayoutKanban, label: t('sidebar.kanban'), path: '/kanban' },
```

Import `LayoutKanban` from `lucide-react` (or `Kanban` — check available icons).

**Step 3: Verify**

```bash
cd frontend && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add frontend/src/App.tsx frontend/src/components/layout/Sidebar.tsx
git commit -m "feat(frontend): add Kanban route and sidebar navigation"
```

---

## Task 15: i18n — All Locale Keys

**Files:**
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/it.json`

**Step 1: Add all Kanban keys to en.json**

Add to `sidebar` section:
```json
"kanban": "Kanban"
```

Add new `kanban` section:
```json
"kanban": {
  "title": "Kanban",
  "newBoard": "New Board",
  "boardTitle": "Board title",
  "boardDescription": "Description (optional)",
  "noBoards": "No boards yet. Create your first one!",
  "deleteBoard": "Delete board",
  "deleteBoardConfirm": "Delete this board and all its cards permanently?",
  "sharedBoard": "Shared",
  "columns": "columns",
  "cards": "cards",
  "column": {
    "todo": "To Do",
    "inProgress": "In Progress",
    "done": "Done",
    "addColumn": "Add column",
    "columnTitle": "Column title",
    "deleteConfirm": "Delete this column?",
    "hasCards": "Move or delete all cards before removing this column."
  },
  "card": {
    "addCard": "Add card",
    "cardTitle": "Card title",
    "untitled": "Untitled card",
    "assignee": "Assignee",
    "unassigned": "Unassigned",
    "dueDate": "Due date",
    "overdue": "Overdue",
    "linkedNote": "Linked note",
    "noDescription": "No description",
    "description": "Description",
    "deleteConfirm": "Delete this card permanently?"
  },
  "comment": {
    "placeholder": "Write a comment...",
    "send": "Send",
    "noComments": "No comments yet.",
    "comments": "Comments"
  },
  "share": {
    "title": "Share board",
    "permissions": {
      "READ": "Can view",
      "WRITE": "Can edit"
    }
  },
  "sharedWithMe": "Shared with me"
}
```

Add to `notifications` section:
```json
"kanbanBoardShared": "{{sharerName}} shared the board \"{{itemName}}\" with you",
"kanbanBoardShared_TITLE": "Board Shared",
"kanbanCardAssigned": "{{assignerName}} assigned you to \"{{cardTitle}}\" in board \"{{boardTitle}}\"",
"kanbanCardAssigned_TITLE": "Card Assigned",
"kanbanCommentAdded": "{{authorName}} commented on \"{{cardTitle}}\" in board \"{{boardTitle}}\"",
"kanbanCommentAdded_TITLE": "New Comment"
```

**Step 2: Add all keys to it.json (Italian translations)**

Mirror all keys with Italian translations. Key translations:
- "Kanban" → "Kanban"
- "New Board" → "Nuova Board"
- "Board title" → "Titolo board"
- "To Do" → "Da fare"
- "In Progress" → "In corso"
- "Done" → "Completato"
- "Add column" → "Aggiungi colonna"
- "Add card" → "Aggiungi card"
- "Assignee" → "Assegnatario"
- "Due date" → "Scadenza"
- "Write a comment..." → "Scrivi un commento..."
- "Share board" → "Condividi board"
- etc.

**Step 3: Verify i18n scan**

```bash
cd frontend && node scripts/scan-i18n.js 2>/dev/null || true
```

**Step 4: Commit**

```bash
git add frontend/src/locales/en.json frontend/src/locales/it.json
git commit -m "feat(i18n): add all Kanban locale keys (EN + IT)"
```

---

## Task 16: Frontend Notification Integration

**Files:**
- Modify: `frontend/src/features/notifications/notificationService.ts` — add new types
- Modify: `frontend/src/features/notifications/NotificationItem.tsx` — add icon + i18n mapping

**Step 1: Update Notification type union**

In `notificationService.ts`, add to the `type` union:
```typescript
'KANBAN_BOARD_SHARED' | 'KANBAN_CARD_ASSIGNED' | 'KANBAN_COMMENT_ADDED'
```

**Step 2: Update NotificationItem**

Add icon mapping:
```typescript
case 'KANBAN_BOARD_SHARED':
case 'KANBAN_CARD_ASSIGNED':
case 'KANBAN_COMMENT_ADDED':
  return <LayoutKanban size={16} className="text-purple-500" />;
```

Add to `TYPE_TO_KEY`:
```typescript
KANBAN_BOARD_SHARED: 'notifications.kanbanBoardShared',
KANBAN_CARD_ASSIGNED: 'notifications.kanbanCardAssigned',
KANBAN_COMMENT_ADDED: 'notifications.kanbanCommentAdded',
```

Add to `buildArgs`:
```typescript
if (src.assignerName) args.assignerName = src.assignerName;
if (src.cardTitle) args.cardTitle = src.cardTitle;
if (src.boardTitle) args.boardTitle = src.boardTitle;
if (src.authorName) args.authorName = src.authorName;
```

**Step 3: Verify**

```bash
cd frontend && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add frontend/src/features/notifications/
git commit -m "feat(frontend): add Kanban notification types and rendering"
```

---

## Task 17: Update Documentation

**Files:**
- Modify: `CLAUDE.md` — update model count, add kanban to structure
- Modify: `README.md` — add Kanban to features

**Step 1: Update CLAUDE.md**

- Update Prisma models count (22 → 27, add KanbanBoard, KanbanColumn, KanbanCard, KanbanComment, SharedKanbanBoard)
- Update enums (NotificationType expanded)
- Update migration count
- Add `kanban.ts` to routes mention if appropriate

**Step 2: Update README.md**

- Add Kanban to features list
- Update model counts in project structure

**Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: update documentation for Kanban feature"
```

---

## Task 18: Full Verification

**Step 1: Backend TypeScript**

```bash
cd backend && npx tsc --noEmit
```

**Step 2: Frontend TypeScript**

```bash
cd frontend && npx tsc --noEmit
```

**Step 3: Backend build**

```bash
cd backend && npm run build
```

**Step 4: Frontend build**

```bash
cd frontend && npm run build
```

**Step 5: Manual verification checklist**

Backend:
- [ ] Migration runs without errors
- [ ] `GET /api/kanban/boards` returns only boards accessible to authenticated user
- [ ] `POST /api/kanban/boards` auto-creates 3 default columns
- [ ] Moving a card updates positions correctly (no gaps/duplicates)
- [ ] Sharing a board with non-existent email returns 404
- [ ] All endpoints return 401 without JWT
- [ ] WRITE endpoints return 403 for READ-only users

Frontend:
- [ ] `/kanban` renders board list with create button
- [ ] Board view renders columns and cards
- [ ] Drag & drop moves a card to another column and persists
- [ ] CardDetailModal opens on card click with comments
- [ ] New comment appears and is confirmed
- [ ] ShareBoardModal allows sharing by email
- [ ] Sidebar shows Kanban nav item with correct active state
- [ ] Dark mode: all components respect `dark:` classes
- [ ] i18n: switching language updates all strings

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: Notiq v1.4.0 — Kanban boards with sharing, SSE real-time, and DnD"
```

---

## Dependency Graph

```
Task 1 (Schema)
  ├── Task 2 (Permission helper)
  ├── Task 3 (SSE registry)
  │     │
  │     └── Task 4 (Kanban service) ← depends on 2 + 3
  │           │
  │           ├── Task 5 (Kanban routes) ← depends on 4
  │           └── Task 6 (Sharing integration) ← depends on 4
  │
  └── Task 7 (Frontend types + service) ← depends on 1 (schema knowledge)
        │
        ├── Task 8 (Query hooks) ← depends on 7
        ├── Task 9 (SSE hook) ← depends on 7
        │     │
        │     └── Task 10 (Column + Card components) ← depends on 8
        │           │
        │           ├── Task 11 (CardDetailModal) ← depends on 10
        │           └── Task 12 (Board modals + card) ← depends on 10
        │                 │
        │                 └── Task 13 (Pages) ← depends on 10, 11, 12, 9
        │                       │
        │                       └── Task 14 (Router + Sidebar) ← depends on 13
        │
        └── Task 15 (i18n) ← independent, can run in parallel with 8-14
              │
              └── Task 16 (Notification integration) ← depends on 15

Task 17 (Docs) ← after all tasks
Task 18 (Verification) ← final
```

**Parallelizable streams after Task 1:**
- Stream A: Tasks 2 → 3 → 4 → 5 → 6 (backend)
- Stream B: Tasks 7 → 8 + 9 (parallel) → 10 → 11 + 12 (parallel) → 13 → 14 (frontend)
- Stream C: Task 15 → 16 (i18n + notifications, can start after Task 7)

---

*End of Implementation Plan — NOTIQ_KANBAN v1.0*
