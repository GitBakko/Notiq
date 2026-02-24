# Board-Level Note Linking + Board Avatar — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add board-level note linking (1:1 with same sharing rules as card notes) and a board avatar image displayed everywhere the board is referenced.

**Architecture:** Extend the existing KanbanBoard model with 3 new nullable fields (`noteId`, `noteLinkedById`, `avatarUrl`). Mirror the card-level note linking pattern for board-level. Mirror the cover image upload pattern for avatar. Extend `getLinkedBoardsForNote()` to return both card-linked and board-linked results with a `linkedAs` discriminator. Update all frontend locations where the board appears.

**Tech Stack:** Prisma 7, Fastify 5 (multipart file upload), React 19, TanStack Query v5, Tailwind CSS 3, i18next, Lucide icons

---

## Task 1: Prisma Schema + Migration

**Files:**
- Modify: `backend/prisma/schema.prisma` (lines 405-420, KanbanBoard model)
- Modify: `backend/prisma/schema.prisma` (User model ~line 61, Note model ~line 138)
- Create: `backend/prisma/migrations/20260224_board_note_avatar/migration.sql` (auto-generated)

**Step 1: Add fields to KanbanBoard model**

In `backend/prisma/schema.prisma`, add to the `KanbanBoard` model (after `coverImage`):

```prisma
model KanbanBoard {
  id              String              @id @default(uuid())
  title           String
  description     String?
  coverImage      String?
  avatarUrl       String?                                          // NEW
  noteId          String?                                          // NEW
  note            Note?               @relation("KanbanBoardNote", fields: [noteId], references: [id])  // NEW
  noteLinkedById  String?                                          // NEW
  noteLinkedBy    User?               @relation("KanbanBoardNoteLinker", fields: [noteLinkedById], references: [id])  // NEW
  ownerId         String
  owner           User                @relation("KanbanOwner", fields: [ownerId], references: [id])
  columns         KanbanColumn[]
  shares          SharedKanbanBoard[]
  chatMessages    KanbanBoardChat[]
  reminders       KanbanReminder[]
  createdAt       DateTime            @default(now())
  updatedAt       DateTime            @updatedAt

  @@index([ownerId])
  @@index([noteId])                                                // NEW
}
```

**Step 2: Add reverse relations to User and Note models**

On the `User` model, add after `kanbanLinkedCards`:
```prisma
  kanbanLinkedBoards   KanbanBoard[]       @relation("KanbanBoardNoteLinker")
```

On the `Note` model, add after `kanbanCards`:
```prisma
  kanbanBoards KanbanBoard[] @relation("KanbanBoardNote")
```

**Step 3: Generate migration**

```bash
cd backend && npx prisma migrate dev --name board_note_avatar
```

**Step 4: Verify**

```bash
cd backend && npx prisma generate
```

**Step 5: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/
git commit -m "feat(schema): add noteId, noteLinkedById, avatarUrl to KanbanBoard"
```

---

## Task 2: Backend Service — Board Note Link/Unlink

**Files:**
- Modify: `backend/src/services/kanban.service.ts` (add after `unlinkNoteFromCard` at ~line 1003)

**Step 1: Add `linkNoteToBoard()` function**

Add after `unlinkNoteFromCard()` (~line 1003):

```typescript
/**
 * Link a note to a board (1:1). Optionally auto-share with specified users.
 */
export async function linkNoteToBoard(
  boardId: string,
  noteId: string,
  actorId: string,
  shareWithUserIds?: string[]
) {
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: { noteId: true, title: true },
  });
  if (!board) throw new Error('Board not found');
  if (board.noteId) throw new Error('Board already has a linked note');

  const note = await prisma.note.findUnique({
    where: { id: noteId },
    select: { id: true, title: true, userId: true },
  });
  if (!note) throw new Error('Note not found');

  // Only the note owner can link their note
  if (note.userId !== actorId) throw new Error('Only the note owner can link this note');

  await prisma.kanbanBoard.update({
    where: { id: boardId },
    data: { noteId, noteLinkedById: actorId },
  });

  // Auto-share with selected users
  if (shareWithUserIds && shareWithUserIds.length > 0) {
    const { autoShareNoteForBoard } = await import('./sharing.service');
    await autoShareNoteForBoard(actorId, noteId, shareWithUserIds, 'READ', board.title);
  }

  // Broadcast update
  broadcast(boardId, { type: 'board:updated', boardId });

  return prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: {
      noteId: true,
      noteLinkedById: true,
      note: { select: { id: true, title: true, userId: true } },
    },
  });
}
```

**Step 2: Add `unlinkNoteFromBoard()` function**

```typescript
/**
 * Unlink a note from a board. Only the user who linked it can unlink.
 */
export async function unlinkNoteFromBoard(boardId: string, actorId: string) {
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: { noteId: true, noteLinkedById: true, note: { select: { title: true } } },
  });
  if (!board) throw new Error('Board not found');
  if (!board.noteId) throw new Error('Board has no linked note');
  if (board.noteLinkedById !== actorId) throw new Error('Only the user who linked the note can unlink it');

  await prisma.kanbanBoard.update({
    where: { id: boardId },
    data: { noteId: null, noteLinkedById: null },
  });

  broadcast(boardId, { type: 'board:updated', boardId });

  return { success: true };
}
```

**Step 3: Extend `getLinkedBoardsForNote()` to include board-level links**

Replace the existing `getLinkedBoardsForNote()` function (~line 1043) with:

```typescript
export async function getLinkedBoardsForNote(noteId: string, userId: string) {
  // 1. Find all CARDS linked to this note
  const cards = await prisma.kanbanCard.findMany({
    where: { noteId },
    select: {
      id: true,
      title: true,
      column: {
        select: {
          board: {
            select: {
              id: true,
              title: true,
              avatarUrl: true,
              ownerId: true,
              shares: {
                where: { userId, status: 'ACCEPTED' },
                select: { id: true },
              },
            },
          },
        },
      },
    },
  });

  // 2. Find all BOARDS directly linked to this note
  const boards = await prisma.kanbanBoard.findMany({
    where: { noteId },
    select: {
      id: true,
      title: true,
      avatarUrl: true,
      ownerId: true,
      shares: {
        where: { userId, status: 'ACCEPTED' },
        select: { id: true },
      },
    },
  });

  const results: {
    boardId: string;
    boardTitle: string;
    boardAvatarUrl: string | null;
    linkedAs: 'board' | 'card';
    cardIds: string[];
    cardTitles: string[];
  }[] = [];

  // 3. Process card-level links (group by board)
  const cardBoardMap = new Map<string, { boardId: string; boardTitle: string; boardAvatarUrl: string | null; cardIds: string[]; cardTitles: string[] }>();
  for (const card of cards) {
    const board = card.column.board;
    const hasAccess = board.ownerId === userId || board.shares.length > 0;
    if (!hasAccess) continue;

    const existing = cardBoardMap.get(board.id);
    if (existing) {
      existing.cardIds.push(card.id);
      existing.cardTitles.push(card.title);
    } else {
      cardBoardMap.set(board.id, {
        boardId: board.id,
        boardTitle: board.title,
        boardAvatarUrl: board.avatarUrl,
        cardIds: [card.id],
        cardTitles: [card.title],
      });
    }
  }
  for (const entry of cardBoardMap.values()) {
    results.push({ ...entry, linkedAs: 'card' });
  }

  // 4. Process board-level links
  for (const board of boards) {
    const hasAccess = board.ownerId === userId || board.shares.length > 0;
    if (!hasAccess) continue;

    results.push({
      boardId: board.id,
      boardTitle: board.title,
      boardAvatarUrl: board.avatarUrl,
      linkedAs: 'board',
      cardIds: [],
      cardTitles: [],
    });
  }

  return results;
}
```

**Step 4: Extend `getBoard()` to include board-level note with visibility check**

In `getBoard()` (~line 206), add `note` to the `include`:

After the line `include: {` add:
```typescript
      note: { select: { id: true, title: true, userId: true } },
```

Then after the existing card-level note visibility filtering block (~line 260), add board-level note visibility:

```typescript
  // Filter board-level note visibility
  if (requestingUserId && board.noteId) {
    const noteIds_board = [board.noteId];
    const accessibleBoardNoteShares = await prisma.sharedNote.findMany({
      where: { noteId: { in: noteIds_board }, userId: requestingUserId, status: 'ACCEPTED' },
      select: { noteId: true },
    });
    const ownedBoardNote = await prisma.note.findMany({
      where: { id: { in: noteIds_board }, userId: requestingUserId },
      select: { id: true },
    });
    const accessibleBoardNoteIds = new Set([
      ...accessibleBoardNoteShares.map((s) => s.noteId),
      ...ownedBoardNote.map((n) => n.id),
    ]);

    if (!accessibleBoardNoteIds.has(board.noteId)) {
      (board as Record<string, unknown>).note = null;
    }
  }
```

**Step 5: Extend `listBoards()` to include `avatarUrl`**

In `listBoards()`, add `avatarUrl: true` to both owned and shared board selects. Then include in the mapping:
- Owned boards (~line 110): add `avatarUrl: true,`
- Shared boards (~line 131): add `avatarUrl: true,`
- Owned mapping (~line 152): add `avatarUrl: b.avatarUrl,`
- Shared mapping (~line 165): add `avatarUrl: s.board.avatarUrl,`

**Step 6: Add `board:updated` SSE event type**

The `broadcast()` function already handles any event shape. No change needed for the broadcast function itself. The frontend SSE handler may need to handle `board:updated` — we'll address this in the frontend task.

**Step 7: Commit**

```bash
git add backend/src/services/kanban.service.ts
git commit -m "feat(service): board note link/unlink, extended getLinkedBoardsForNote, avatarUrl in queries"
```

---

## Task 3: Backend Routes — Board Note + Avatar Endpoints

**Files:**
- Modify: `backend/src/routes/kanban.ts` (add 5 new endpoints)

**Step 1: Add board note endpoints (after the existing cover image routes, before SSE)**

Insert after the `DELETE /boards/:id/cover` handler (~line 270), before the SSE section:

```typescript
  // ── Board Note Linking ────────────────────────────────────────

  // Check note sharing gap for board-level link
  fastify.get('/boards/:id/check-note-sharing', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { noteId } = z.object({ noteId: z.string().uuid() }).parse(request.query);
      await assertBoardAccess(id, request.user.id, 'READ');
      return await kanbanService.checkNoteSharingForBoard(noteId, id, request.user.id);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  // Link a note to a board
  fastify.post('/boards/:id/link-note', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await assertBoardAccess(id, request.user.id, 'WRITE');
      const { noteId, shareWithUserIds } = linkNoteSchema.parse(request.body);
      return await kanbanService.linkNoteToBoard(id, noteId, request.user.id, shareWithUserIds);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  // Unlink a note from a board
  fastify.delete('/boards/:id/link-note', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await assertBoardAccess(id, request.user.id, 'WRITE');
      return await kanbanService.unlinkNoteFromBoard(id, request.user.id);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });
```

**Step 2: Add avatar upload/delete endpoints**

Insert right after the board note endpoints:

```typescript
  // ── Board Avatar ─────────────────────────────────────────────

  const KANBAN_AVATARS_DIR = path.join(UPLOADS_DIR, 'kanban', 'avatars');
  const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2MB

  fastify.post('/boards/:id/avatar', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await assertBoardAccess(id, request.user.id, 'WRITE');

      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ message: 'No file uploaded' });
      }
      if (!ALLOWED_IMAGE_TYPES.has(data.mimetype)) {
        return reply.status(400).send({ message: 'Only JPEG, PNG, GIF, WebP images are allowed' });
      }

      const chunks: Buffer[] = [];
      let totalSize = 0;
      for await (const chunk of data.file) {
        totalSize += chunk.length;
        if (totalSize > MAX_AVATAR_SIZE) {
          return reply.status(400).send({ message: 'File too large (max 2MB)' });
        }
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      if (!fs.existsSync(KANBAN_AVATARS_DIR)) {
        fs.mkdirSync(KANBAN_AVATARS_DIR, { recursive: true });
      }

      // Delete old avatar if present
      const currentBoard = await prisma.kanbanBoard.findUnique({
        where: { id },
        select: { avatarUrl: true },
      });
      if (currentBoard?.avatarUrl) {
        const oldFile = path.join(UPLOADS_DIR, currentBoard.avatarUrl.replace(/^\/uploads\//, ''));
        if (fs.existsSync(oldFile)) {
          fs.unlinkSync(oldFile);
        }
      }

      const ext = path.extname(data.filename || '.jpg').toLowerCase();
      const filename = `${randomUUID()}${ext}`;
      const filepath = path.join(KANBAN_AVATARS_DIR, filename);
      fs.writeFileSync(filepath, buffer);

      const avatarUrl = `/uploads/kanban/avatars/${filename}`;
      await prisma.kanbanBoard.update({
        where: { id },
        data: { avatarUrl },
      });

      return { avatarUrl };
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  fastify.delete('/boards/:id/avatar', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await assertBoardAccess(id, request.user.id, 'WRITE');

      const board = await prisma.kanbanBoard.findUnique({
        where: { id },
        select: { avatarUrl: true },
      });
      if (board?.avatarUrl) {
        const oldFile = path.join(UPLOADS_DIR, board.avatarUrl.replace(/^\/uploads\//, ''));
        if (fs.existsSync(oldFile)) {
          fs.unlinkSync(oldFile);
        }
      }

      await prisma.kanbanBoard.update({
        where: { id },
        data: { avatarUrl: null },
      });

      return { success: true };
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });
```

**Step 3: Verify backend compiles**

```bash
cd backend && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add backend/src/routes/kanban.ts
git commit -m "feat(routes): board note link/unlink + avatar upload/delete endpoints"
```

---

## Task 4: Frontend Types + API Service

**Files:**
- Modify: `frontend/src/features/kanban/types.ts`
- Modify: `frontend/src/features/kanban/kanbanService.ts`

**Step 1: Update types**

In `types.ts`, add fields to `KanbanBoard`:

```typescript
export interface KanbanBoard {
  id: string;
  title: string;
  description: string | null;
  coverImage: string | null;
  avatarUrl: string | null;           // NEW
  noteId: string | null;              // NEW
  noteLinkedById: string | null;      // NEW
  note: { id: string; title: string; userId: string } | null;  // NEW
  ownerId: string;
  owner?: { id: string; name: string | null; email: string; color: string | null };
  columns: KanbanColumn[];
  shares?: SharedKanbanBoard[];
  createdAt: string;
  updatedAt: string;
}
```

Add `avatarUrl` to `KanbanBoardListItem`:

```typescript
export interface KanbanBoardListItem {
  // ... existing fields ...
  avatarUrl: string | null;           // NEW (after coverImage)
  // ...
}
```

**Step 2: Update `LinkedBoardInfo` and add API calls in `kanbanService.ts`**

Replace `LinkedBoardInfo` interface:

```typescript
export interface LinkedBoardInfo {
  boardId: string;
  boardTitle: string;
  boardAvatarUrl: string | null;
  linkedAs: 'board' | 'card';
  cardIds: string[];
  cardTitles: string[];
}
```

Add new API functions after the existing note linking section:

```typescript
// ── Board Note Linking ───────────────────────────────────────────────────

export async function checkBoardNoteSharing(boardId: string, noteId: string): Promise<NoteSharingCheck> {
  const res = await api.get<NoteSharingCheck>(`/kanban/boards/${boardId}/check-note-sharing`, {
    params: { noteId },
  });
  return res.data;
}

export async function linkNoteToBoard(
  boardId: string,
  noteId: string,
  shareWithUserIds?: string[],
): Promise<{ noteId: string; noteLinkedById: string; note: { id: string; title: string; userId: string } }> {
  const res = await api.post(`/kanban/boards/${boardId}/link-note`, { noteId, shareWithUserIds });
  return res.data;
}

export async function unlinkNoteFromBoard(boardId: string): Promise<void> {
  await api.delete(`/kanban/boards/${boardId}/link-note`);
}

// ── Board Avatar ─────────────────────────────────────────────────────────

export async function uploadAvatar(boardId: string, file: File): Promise<{ avatarUrl: string }> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await api.post<{ avatarUrl: string }>(`/kanban/boards/${boardId}/avatar`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}

export async function deleteAvatar(boardId: string): Promise<void> {
  await api.delete(`/kanban/boards/${boardId}/avatar`);
}
```

**Step 3: Commit**

```bash
git add frontend/src/features/kanban/types.ts frontend/src/features/kanban/kanbanService.ts
git commit -m "feat(frontend): types + API service for board note linking and avatar"
```

---

## Task 5: Frontend Mutations Hook

**Files:**
- Modify: `frontend/src/features/kanban/hooks/useKanbanMutations.ts`

**Step 1: Add new mutations**

Add after `unlinkNote` (~line 103):

```typescript
  const linkBoardNote = useMutation({
    mutationFn: ({ boardId: bid, noteId, shareWithUserIds }: { boardId: string; noteId: string; shareWithUserIds?: string[] }) =>
      kanbanService.linkNoteToBoard(bid, noteId, shareWithUserIds),
    onSuccess: invalidateBoard,
  });

  const unlinkBoardNote = useMutation({
    mutationFn: kanbanService.unlinkNoteFromBoard,
    onSuccess: invalidateBoard,
  });

  const uploadAvatar = useMutation({
    mutationFn: ({ bid, file }: { bid: string; file: File }) =>
      kanbanService.uploadAvatar(bid, file),
    onSuccess: invalidateBoard,
  });

  const deleteAvatar = useMutation({
    mutationFn: kanbanService.deleteAvatar,
    onSuccess: invalidateBoard,
  });
```

**Step 2: Add to return object**

```typescript
  return {
    // ... existing ...
    linkBoardNote,
    unlinkBoardNote,
    uploadAvatar,
    deleteAvatar,
  };
```

**Step 3: Commit**

```bash
git add frontend/src/features/kanban/hooks/useKanbanMutations.ts
git commit -m "feat(mutations): board note link/unlink + avatar upload/delete"
```

---

## Task 6: i18n Keys

**Files:**
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/it.json`

**Step 1: Add English keys**

In `en.json`, add under the `kanban` section:

```json
"boardNote": {
  "link": "Link note",
  "unlink": "Unlink note",
  "linkedNote": "Board note",
  "noAccess": "Linked note (no access)"
},
"avatar": {
  "upload": "Upload avatar",
  "change": "Change avatar",
  "remove": "Remove avatar"
},
"noteLink": {
  "goToBoard": "Go to board {{boardTitle}}",
  "boardLabel": "Board: {{boardTitle}}",
  "cardLabel": "Card: {{cardTitle}} ({{boardTitle}})"
}
```

**Step 2: Add Italian keys**

In `it.json`, add matching keys:

```json
"boardNote": {
  "link": "Collega nota",
  "unlink": "Scollega nota",
  "linkedNote": "Nota della board",
  "noAccess": "Nota collegata (nessun accesso)"
},
"avatar": {
  "upload": "Carica avatar",
  "change": "Cambia avatar",
  "remove": "Rimuovi avatar"
},
"noteLink": {
  "goToBoard": "Vai alla board {{boardTitle}}",
  "boardLabel": "Board: {{boardTitle}}",
  "cardLabel": "Card: {{cardTitle}} ({{boardTitle}})"
}
```

**Step 3: Commit**

```bash
git add frontend/src/locales/en.json frontend/src/locales/it.json
git commit -m "feat(i18n): board note linking + avatar keys (EN/IT)"
```

---

## Task 7: KanbanBoardPage — Board Note Section + Avatar

**Files:**
- Modify: `frontend/src/features/kanban/KanbanBoardPage.tsx`

This is the largest frontend change. It involves:

**Step 1: Add state + imports**

Add imports:
```typescript
import { FileText, Link2, Unlink } from 'lucide-react';
import NoteLinkPicker from './components/NoteLinkPicker';
import SharingGapModal from './components/SharingGapModal';
import type { NoteSharingCheck, NoteSearchResult } from './types';
import * as kanbanService from './kanbanService';
```

Add state inside the component (with existing state):
```typescript
const [isNoteLinkPickerOpen, setIsNoteLinkPickerOpen] = useState(false);
const [boardSharingCheck, setBoardSharingCheck] = useState<NoteSharingCheck | null>(null);
const [pendingBoardNote, setPendingBoardNote] = useState<NoteSearchResult | null>(null);
const [isSharingGapOpen, setIsSharingGapOpen] = useState(false);
const avatarInputRef = useRef<HTMLInputElement>(null);
```

**Step 2: Add handlers for board note**

```typescript
// Board note linking
async function handleBoardNoteSelected(note: NoteSearchResult): Promise<void> {
  setIsNoteLinkPickerOpen(false);
  setPendingBoardNote(note);
  try {
    const check = await kanbanService.checkBoardNoteSharing(boardId, note.id);
    if (check.alreadyFullyShared) {
      mutations.linkBoardNote.mutate({ boardId, noteId: note.id });
      setPendingBoardNote(null);
    } else {
      setBoardSharingCheck(check);
      setIsSharingGapOpen(true);
    }
  } catch {
    setPendingBoardNote(null);
  }
}

function handleBoardNoteSharingConfirm(selectedUserIds: string[]): void {
  if (!pendingBoardNote) return;
  mutations.linkBoardNote.mutate(
    { boardId, noteId: pendingBoardNote.id, shareWithUserIds: selectedUserIds },
    {
      onSuccess: () => {
        setIsSharingGapOpen(false);
        setBoardSharingCheck(null);
        setPendingBoardNote(null);
      },
    },
  );
}

function handleUnlinkBoardNote(): void {
  mutations.unlinkBoardNote.mutate(boardId);
}
```

**Step 3: Add avatar upload handler**

```typescript
function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>): void {
  const file = e.target.files?.[0];
  if (!file) return;
  mutations.uploadAvatar.mutate(
    { bid: boardId, file },
    { onError: () => toast.error(t('common.genericError')) },
  );
  e.target.value = '';
}
```

**Step 4: Add avatar UI in the header (beside the title)**

In the header section (~line 468-510), add avatar before the title. Replace the title `<h1>` area with:

```tsx
{/* Avatar */}
<div className="relative group/avatar flex-shrink-0">
  {board.avatarUrl ? (
    <img
      src={board.avatarUrl}
      alt=""
      className="w-8 h-8 rounded-full object-cover cursor-pointer"
      onClick={() => !readOnly && avatarInputRef.current?.click()}
    />
  ) : (
    !readOnly && (
      <button
        onClick={() => avatarInputRef.current?.click()}
        className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-gray-400 dark:text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
        title={t('kanban.avatar.upload')}
      >
        <ImagePlus size={14} />
      </button>
    )
  )}
  {!readOnly && board.avatarUrl && (
    <button
      onClick={() => mutations.deleteAvatar.mutate(boardId)}
      className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center text-[8px] opacity-0 group-hover/avatar:opacity-100 transition-opacity"
      title={t('kanban.avatar.remove')}
    >
      <X size={8} />
    </button>
  )}
</div>
```

Add hidden file input (near the existing `coverInputRef`):
```tsx
<input
  ref={avatarInputRef}
  type="file"
  accept="image/jpeg,image/png,image/gif,image/webp"
  className="hidden"
  onChange={handleAvatarUpload}
/>
```

**Step 5: Add board note section below the header**

After the header `<div>` and before the columns area, add:

```tsx
{/* Board-linked note */}
{(board.noteId || !readOnly) && (
  <div className="flex-shrink-0 border-b border-gray-200 dark:border-gray-800 px-4 py-2">
    {board.note ? (
      <div className="flex items-center gap-2 text-sm">
        <FileText size={14} className="text-emerald-500 flex-shrink-0" />
        <span className="text-xs text-gray-500 dark:text-gray-400">{t('kanban.boardNote.linkedNote')}:</span>
        <button
          onClick={() => navigate(`/notes?noteId=${board.note!.id}`)}
          className="text-emerald-600 dark:text-emerald-400 hover:underline truncate"
        >
          {board.note.title}
        </button>
        {!readOnly && user?.id === board.noteLinkedById && (
          <button
            onClick={handleUnlinkBoardNote}
            className="ml-auto flex-shrink-0 p-1 text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
            title={t('kanban.boardNote.unlink')}
          >
            <Unlink size={14} />
          </button>
        )}
      </div>
    ) : board.noteId ? (
      <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500 italic">
        <FileText size={14} />
        {t('kanban.boardNote.noAccess')}
      </div>
    ) : !readOnly ? (
      <button
        onClick={() => setIsNoteLinkPickerOpen(true)}
        className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
      >
        <Link2 size={14} />
        {t('kanban.boardNote.link')}
      </button>
    ) : null}
  </div>
)}
```

**Step 6: Add modals at the bottom of the JSX return**

Add before the closing `</div>` of the component:

```tsx
{/* Board note picker + sharing gap modal */}
<NoteLinkPicker
  isOpen={isNoteLinkPickerOpen}
  onClose={() => setIsNoteLinkPickerOpen(false)}
  onSelect={handleBoardNoteSelected}
/>
{boardSharingCheck && (
  <SharingGapModal
    isOpen={isSharingGapOpen}
    onClose={() => { setIsSharingGapOpen(false); setBoardSharingCheck(null); setPendingBoardNote(null); }}
    sharingCheck={boardSharingCheck}
    onConfirm={handleBoardNoteSharingConfirm}
    isPending={mutations.linkBoardNote.isPending}
  />
)}
```

**Step 7: Commit**

```bash
git add frontend/src/features/kanban/KanbanBoardPage.tsx
git commit -m "feat(ui): board note section + avatar in KanbanBoardPage header"
```

---

## Task 8: BoardCard — Avatar in List View

**Files:**
- Modify: `frontend/src/features/kanban/components/BoardCard.tsx`

**Step 1: Add avatar beside the title**

Replace the title `<h3>` section (~line 112-114) with:

```tsx
{/* Title row with avatar */}
<div className="flex items-center gap-2 pr-8">
  {board.avatarUrl ? (
    <img
      src={board.avatarUrl}
      alt=""
      className="w-6 h-6 rounded-full object-cover flex-shrink-0"
    />
  ) : (
    <div className="w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
      <Kanban size={12} className="text-emerald-600 dark:text-emerald-400" />
    </div>
  )}
  <h3 className="text-sm font-bold text-gray-900 dark:text-white truncate">
    {board.title}
  </h3>
</div>
```

Add `Kanban` to the Lucide imports at line 4.

**Step 2: Commit**

```bash
git add frontend/src/features/kanban/components/BoardCard.tsx
git commit -m "feat(ui): board avatar in BoardCard list view"
```

---

## Task 9: KanbanBoardLink — Separate Labels + Avatar

**Files:**
- Modify: `frontend/src/features/kanban/components/KanbanBoardLink.tsx`

**Step 1: Replace the entire component**

```typescript
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LayoutDashboard, SquareKanban } from 'lucide-react';
import { getLinkedBoardsForNote } from '../kanbanService';

interface KanbanBoardLinkProps {
  noteId: string;
}

export default function KanbanBoardLink({ noteId }: KanbanBoardLinkProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const { data: linkedBoards } = useQuery({
    queryKey: ['kanban-linked-boards', noteId],
    queryFn: () => getLinkedBoardsForNote(noteId),
    enabled: !!noteId,
    staleTime: 30_000,
  });

  if (!linkedBoards || linkedBoards.length === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap px-4 py-1.5 border-b border-gray-100 dark:border-gray-800">
      {linkedBoards.map((entry) => {
        const isBoard = entry.linkedAs === 'board';
        const Icon = isBoard ? LayoutDashboard : SquareKanban;
        const label = isBoard
          ? t('kanban.noteLink.boardLabel', { boardTitle: entry.boardTitle })
          : entry.cardTitles.length === 1
            ? t('kanban.noteLink.cardLabel', { cardTitle: entry.cardTitles[0], boardTitle: entry.boardTitle })
            : `${entry.cardTitles.length} cards (${entry.boardTitle})`;

        const url = isBoard
          ? `/kanban?boardId=${entry.boardId}`
          : `/kanban?boardId=${entry.boardId}&highlightCards=${entry.cardIds.join(',')}`;

        return (
          <button
            key={`${entry.boardId}-${entry.linkedAs}`}
            onClick={() => navigate(url)}
            className="flex items-center gap-1 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors"
            title={t('kanban.noteLink.goToBoard', { boardTitle: entry.boardTitle })}
          >
            {entry.boardAvatarUrl ? (
              <img src={entry.boardAvatarUrl} alt="" className="w-4 h-4 rounded-full object-cover" />
            ) : (
              <Icon size={12} />
            )}
            {label}
          </button>
        );
      })}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add frontend/src/features/kanban/components/KanbanBoardLink.tsx
git commit -m "feat(ui): KanbanBoardLink separate labels for board vs card + avatar"
```

---

## Task 10: RemindersPage — Avatar in Kanban Reminders

**Files:**
- Modify: `frontend/src/features/reminders/RemindersPage.tsx`

**Step 1: Add `boardAvatarUrl` to `UnifiedReminder`**

```typescript
interface UnifiedReminder {
  id: string;
  title: string;
  dueDate: string;
  isDone: boolean;
  type: 'note' | 'kanban';
  noteId?: string;
  cardId?: string;
  boardId?: string;
  boardTitle?: string;
  boardAvatarUrl?: string;    // NEW
  columnTitle?: string;
}
```

**Step 2: Pass `boardAvatarUrl` when building kanban reminders**

In the section that maps kanban reminders to `UnifiedReminder`, include `boardAvatarUrl: r.boardAvatarUrl` (this requires the API response to include it — check the `useKanbanReminders` hook).

**Step 3: Display avatar in the kanban reminder row**

Where the kanban board title is shown (near the `LayoutDashboard` icon), replace with:

```tsx
{reminder.boardAvatarUrl ? (
  <img src={reminder.boardAvatarUrl} alt="" className="w-4 h-4 rounded-full object-cover" />
) : (
  <LayoutDashboard size={14} />
)}
```

**Step 4: Commit**

```bash
git add frontend/src/features/reminders/RemindersPage.tsx
git commit -m "feat(ui): board avatar in kanban reminder rows"
```

---

## Task 11: Verify + Final Build

**Step 1: Backend type check**

```bash
cd backend && npx tsc --noEmit
```

**Step 2: Frontend type check + build**

```bash
cd frontend && npx tsc --noEmit && npm run build
```

**Step 3: Fix any TypeScript errors**

Address unused imports, missing fields, type mismatches.

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: board-level note linking + board avatar (v1.6.0)"
```

---

## Verification Checklist

1. Create a board → no avatar, no note → default Kanban icon in BoardCard
2. Upload avatar → appears in BoardCard list, header, and KanbanBoardLink
3. Remove avatar → falls back to Kanban icon
4. Link note to board → note title appears in header, clickable → navigates to note
5. Unlink note → only linker sees unlink button, note removed
6. Sharing gap → when linking note to board with unshared participants, SharingGapModal appears
7. NoteEditor → board-linked note shows "Board: Sprint 5", card-linked shows "Card: Review PR (Sprint 5)"
8. Both links on same note → both labels shown in NoteEditor
9. Reminders page → kanban reminders show board avatar
10. Dark mode → all new UI elements have `dark:` variants
11. Read-only users → no link/unlink/avatar buttons visible
