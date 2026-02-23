# PROMPT CONTRACT — Notiq Kanban Feature
**Version:** 1.0  
**Target:** Claude Code  
**Project:** Notiq (https://github.com/GitBakko/Notiq)  
**Feature:** Simple Kanban Board with Sharing & Real-time Collaboration

---

## § 1 — IDENTITY & SCOPE

You are implementing a **Kanban board system** inside the existing Notiq PWA.  
The feature must integrate naturally with the **sharing system** and **real-time collaborative editing** already present in the codebase.  
Keep the implementation **minimal and coherent** with the existing stack. Do not introduce new external dependencies unless strictly necessary.

---

## § 2 — TECH STACK CONSTRAINTS

| Layer | Technology | Constraint |
|---|---|---|
| Frontend | React 19 + TypeScript + Vite | No new UI libs. Use existing TailwindCSS + shadcn patterns |
| State | Zustand + TanStack Query | Follow existing store/hook patterns |
| Routing | React Router v7 | Add `/kanban` and `/kanban/:boardId` routes |
| Offline | Dexie.js (IndexedDB) | Kanban boards must be offline-capable like notes |
| i18n | i18next | All strings via `t()` — add `en` and `it` keys |
| Backend | Fastify + Prisma + PostgreSQL | Follow existing route/plugin/service architecture |
| Auth | JWT (existing middleware) | All Kanban endpoints require authentication |
| Real-time | Existing WebSocket/SSE infrastructure | Extend for Kanban card updates |

---

## § 3 — DATA MODEL (Prisma)

Add the following models to `backend/prisma/schema.prisma`.  
**Preserve all existing models untouched.**

```prisma
model KanbanBoard {
  id          String   @id @default(cuid())
  title       String
  description String?
  ownerId     String
  owner       User     @relation("KanbanOwner", fields: [ownerId], references: [id])
  columns     KanbanColumn[]
  shares      KanbanBoardShare[]
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model KanbanColumn {
  id       String  @id @default(cuid())
  title    String
  position Int
  boardId  String
  board    KanbanBoard @relation(fields: [boardId], references: [id], onDelete: Cascade)
  cards    KanbanCard[]
}

model KanbanCard {
  id          String   @id @default(cuid())
  title       String
  description String?
  position    Int
  columnId    String
  column      KanbanColumn @relation(fields: [columnId], references: [id], onDelete: Cascade)
  assigneeId  String?
  assignee    User?    @relation("KanbanAssignee", fields: [assigneeId], references: [id])
  dueDate     DateTime?
  noteId      String?           // Optional link to an existing Notiq note
  note        Note?    @relation(fields: [noteId], references: [id])
  comments    KanbanComment[]
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model KanbanComment {
  id        String   @id @default(cuid())
  content   String
  cardId    String
  card      KanbanCard @relation(fields: [cardId], references: [id], onDelete: Cascade)
  authorId  String
  author    User     @relation("KanbanCommentAuthor", fields: [authorId], references: [id])
  createdAt DateTime @default(now())
}

model KanbanBoardShare {
  id         String   @id @default(cuid())
  boardId    String
  board      KanbanBoard @relation(fields: [boardId], references: [id], onDelete: Cascade)
  userId     String
  user       User     @relation("KanbanBoardShares", fields: [userId], references: [id])
  permission String   @default("READ")   // "READ" | "WRITE"
  createdAt  DateTime @default(now())

  @@unique([boardId, userId])
}
```

**Migration command to run after schema update:**
```bash
cd backend && npx prisma migrate dev --name add_kanban
```

---

## § 4 — BACKEND API

Create file: `backend/src/routes/kanban.ts`  
Register it in `backend/src/app.ts` under the prefix `/api/kanban`.

### 4.1 Board endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/boards` | ✅ | List boards owned by or shared with user |
| `POST` | `/boards` | ✅ | Create board (auto-creates 3 default columns) |
| `GET` | `/boards/:id` | ✅ | Get full board (columns + cards) |
| `PUT` | `/boards/:id` | ✅ Owner/WRITE | Update title/description |
| `DELETE` | `/boards/:id` | ✅ Owner only | Delete board |

### 4.2 Column endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/boards/:id/columns` | ✅ WRITE | Add column |
| `PUT` | `/columns/:id` | ✅ WRITE | Rename column |
| `PATCH` | `/columns/reorder` | ✅ WRITE | Reorder columns (array of `{id, position}`) |
| `DELETE` | `/columns/:id` | ✅ WRITE | Delete column (fails if cards present) |

### 4.3 Card endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/columns/:id/cards` | ✅ WRITE | Create card |
| `PUT` | `/cards/:id` | ✅ WRITE | Update card (title, desc, assignee, dueDate, noteId) |
| `PATCH` | `/cards/:id/move` | ✅ WRITE | Move card to column + new position |
| `DELETE` | `/cards/:id` | ✅ WRITE | Delete card |

### 4.4 Comment endpoints (reuse chat pattern)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/cards/:id/comments` | ✅ READ | List comments |
| `POST` | `/cards/:id/comments` | ✅ WRITE | Add comment |
| `DELETE` | `/comments/:id` | ✅ Own comment | Delete own comment |

### 4.5 Sharing endpoints (mirror existing sharing routes)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/boards/:id/share` | ✅ Owner | Share board with user (`{ email, permission }`) |
| `DELETE` | `/boards/:id/share/:userId` | ✅ Owner | Revoke access |
| `GET` | `/boards/:id/share` | ✅ Owner | List shares |

**Validation:** Use Zod schemas (follow existing pattern in `backend/src/routes/`).  
**Permission check helper:** Create `backend/src/services/kanbanPermissions.ts` — expose `assertBoardAccess(boardId, userId, requiredPermission)`.

---

## § 5 — REAL-TIME UPDATES

Extend the existing real-time mechanism (check current implementation — SSE or WebSocket) to emit events for Kanban.

### Events to emit (on mutation)

```typescript
// Event shape (follow existing event pattern in the codebase)
type KanbanEvent =
  | { type: 'card:moved';    boardId: string; cardId: string; toColumnId: string; position: number }
  | { type: 'card:created';  boardId: string; card: KanbanCard }
  | { type: 'card:updated';  boardId: string; card: KanbanCard }
  | { type: 'card:deleted';  boardId: string; cardId: string }
  | { type: 'comment:added'; boardId: string; cardId: string; comment: KanbanComment }
```

**Broadcast scope:** emit to all users who have access to the board (owner + all share entries).

---

## § 6 — FRONTEND STRUCTURE

### 6.1 File tree to create

```
frontend/src/features/kanban/
├── KanbanPage.tsx           # Route /kanban — board list
├── KanbanBoardPage.tsx      # Route /kanban/:boardId — board view
├── components/
│   ├── BoardCard.tsx        # Board thumbnail in list
│   ├── KanbanColumn.tsx     # Column with card list
│   ├── KanbanCard.tsx       # Card chip (drag handle + info)
│   ├── CardDetailModal.tsx  # Full card detail + comments
│   ├── ShareBoardModal.tsx  # Reuse/mirror ShareModal from sharing feature
│   └── CreateBoardModal.tsx
├── hooks/
│   ├── useKanbanBoard.ts    # TanStack Query fetcher for board
│   ├── useKanbanMutations.ts
│   └── useKanbanRealtime.ts # Subscribe to board events
├── store/
│   └── kanbanStore.ts       # Zustand: optimistic updates for drag & drop
└── types.ts                 # TypeScript interfaces (KanbanBoard, Column, Card, Comment)
```

### 6.2 Drag & Drop

Use the **HTML5 Drag & Drop API** (no external library).  
Implement in `KanbanColumn.tsx` + `KanbanCard.tsx` with `onDragStart / onDragOver / onDrop`.  
On drop → call `PATCH /cards/:id/move` AND emit optimistic update via `kanbanStore`.

### 6.3 Card Detail Modal

`CardDetailModal.tsx` must include:
- Editable title and description
- Assignee selector (search users from `/api/user/search` or existing user search endpoint)
- Due date picker
- **Link to Note:** dropdown to attach an existing Notiq note (reuse note search)
- **Comments section** — list + compose input (mirror the existing chat/comment UI pattern)

### 6.4 Sharing UI

`ShareBoardModal.tsx` must **reuse** existing components from `frontend/src/components/sharing/`.  
If a generic `ShareModal` exists, extend it with a `mode="board"` prop rather than duplicating code.

### 6.5 Sidebar Integration

In `frontend/src/components/layout/Sidebar.tsx`:
- Add a **Kanban** nav item (icon: `LayoutDashboard` from lucide-react, already used in the project)
- Position it between Notes and Tasks in the nav list
- Active state consistent with existing nav items

### 6.6 Offline support

In `frontend/src/features/sync/`:
- Add `kanban` tables to the Dexie schema: `kanbanBoards`, `kanbanColumns`, `kanbanCards`, `kanbanComments`
- Follow the existing offline sync pattern (queue mutations, sync on reconnect)

---

## § 7 — i18n KEYS

Add to `frontend/src/locales/en/translation.json`:

```json
"kanban": {
  "title": "Kanban",
  "newBoard": "New Board",
  "boardTitle": "Board title",
  "noBoards": "No boards yet. Create your first one!",
  "column": {
    "todo": "To Do",
    "inProgress": "In Progress",
    "done": "Done",
    "addColumn": "Add column",
    "deleteConfirm": "Delete this column? Cards inside must be moved first."
  },
  "card": {
    "addCard": "Add card",
    "untitled": "Untitled card",
    "assignee": "Assignee",
    "dueDate": "Due date",
    "linkedNote": "Linked note",
    "noDescription": "No description",
    "deleteConfirm": "Delete this card permanently?"
  },
  "comment": {
    "placeholder": "Write a comment...",
    "send": "Send",
    "noComments": "No comments yet."
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

Mirror all keys in `frontend/src/locales/it/translation.json` in Italian.

---

## § 8 — ACCEPTANCE CRITERIA

Claude Code MUST verify each criterion before marking the task done.

### Backend
- [ ] Migration runs without errors: `npx prisma migrate dev --name add_kanban`
- [ ] `GET /api/kanban/boards` returns only boards accessible to the authenticated user
- [ ] `POST /api/kanban/boards` auto-creates columns: "To Do" (pos 0), "In Progress" (pos 1), "Done" (pos 2)
- [ ] Moving a card updates `position` of all affected cards in the target column (no gaps/duplicates)
- [ ] Sharing a board with a non-existent email returns 404 with clear message
- [ ] All endpoints return 401 if JWT is missing/invalid
- [ ] WRITE endpoints return 403 if user has READ permission

### Frontend
- [ ] `/kanban` route renders board list with create button
- [ ] `/kanban/:boardId` renders columns and cards
- [ ] Drag & drop moves a card to another column and persists via API
- [ ] `CardDetailModal` opens on card click and shows comments
- [ ] New comment appears instantly (optimistic) and is confirmed by server event
- [ ] `ShareBoardModal` allows sharing by email with READ/WRITE picker
- [ ] Sidebar shows Kanban nav item with correct active state
- [ ] Dark mode: all new components respect `dark:` Tailwind classes
- [ ] i18n: switching language updates all Kanban strings

### General
- [ ] No TypeScript `any` types introduced
- [ ] No existing tests broken (run `npx playwright test`)
- [ ] Offline: creating a card while offline queues the mutation and syncs on reconnect

---

## § 9 — FORBIDDEN ACTIONS

- ❌ Do NOT modify `prisma/schema.prisma` existing models (only ADD)
- ❌ Do NOT install `react-beautiful-dnd`, `dnd-kit`, or any DnD library — use native HTML5 DnD
- ❌ Do NOT create a new authentication system — reuse existing JWT middleware
- ❌ Do NOT duplicate the ShareModal component — extend or reuse it
- ❌ Do NOT add inline styles — use Tailwind utility classes only
- ❌ Do NOT skip i18n for any user-facing string
- ❌ Do NOT use `any` type in TypeScript

---

## § 10 — IMPLEMENTATION ORDER

Follow this sequence to avoid broken intermediate states:

1. **Schema + migration** → `prisma/schema.prisma` + `npx prisma migrate dev`
2. **Backend service** → `kanbanPermissions.ts` + `kanban.ts` route file
3. **Register route** in `app.ts`
4. **Types** → `frontend/src/features/kanban/types.ts`
5. **Zustand store** → `kanbanStore.ts`
6. **TanStack Query hooks** → `useKanbanBoard.ts`, `useKanbanMutations.ts`
7. **Components** → Column → Card → CardDetailModal → ShareBoardModal → CreateBoardModal
8. **Pages** → `KanbanPage.tsx`, `KanbanBoardPage.tsx`
9. **Router** → add routes to React Router config
10. **Sidebar** → add nav item
11. **Real-time** → `useKanbanRealtime.ts` + backend emitter
12. **Offline** → extend Dexie schema + sync queue
13. **i18n** → add all keys to both locales
14. **Tests** → manual verification against acceptance criteria

---

## § 11 — CONTEXT FILES TO READ FIRST

Before writing any code, read these files to understand existing patterns:

```
backend/src/routes/notes.ts          # Route pattern + auth middleware
backend/src/routes/sharing.ts        # Sharing logic to mirror
backend/src/services/                # Service layer pattern
backend/prisma/schema.prisma         # Current schema (add-only)
frontend/src/features/notes/         # Note feature structure to mirror
frontend/src/components/sharing/     # ShareModal to reuse
frontend/src/store/                  # Zustand store pattern
frontend/src/hooks/                  # Custom hook pattern
frontend/src/features/sync/          # Offline/Dexie pattern
frontend/src/components/layout/Sidebar.tsx  # Nav item pattern
```

---

*End of Prompt Contract — NOTIQ_KANBAN v1.0*
