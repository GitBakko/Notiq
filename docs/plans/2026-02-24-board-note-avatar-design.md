# Board-Level Note Linking + Board Avatar

**Date:** 2026-02-24
**Status:** Approved

## Overview

Two additions to Kanban boards:
1. **Board note** — Link a single note to the entire board (1:1), with the same sharing rules as card-level notes
2. **Board avatar** — Upload an avatar image for the board, displayed everywhere the board is referenced

## Decisions

| Aspect | Choice |
|--------|--------|
| Board note cardinality | 1:1 (one note per board) |
| Board avatar visibility | Everywhere: list, header, reminders, NoteEditor link |
| NoteEditor differentiation | Separate labels: "Board: X" vs "Card: Y (X)" |
| Sharing rules | Identical to card note linking |
| Permission model | Note owner links; linker unlinks; sharing gap detection + auto-share |

## Feature 1: Board-Level Note

### Schema

Add to `KanbanBoard`:
```prisma
noteId          String?
note            Note?    @relation("KanbanBoardNote", fields: [noteId], references: [id])
noteLinkedById  String?
noteLinkedBy    User?    @relation("KanbanBoardNoteLinker", fields: [noteLinkedById], references: [id])
```

### Backend Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/boards/:id/check-note-sharing?noteId=` | Sharing gap check |
| POST | `/boards/:id/link-note` | Link note to board |
| DELETE | `/boards/:id/link-note` | Unlink note from board |

### Service Functions (in kanban.service.ts)

- `checkNoteSharingForBoard()` — Already exists, reused as-is (takes boardId)
- `linkNoteToBoard(boardId, noteId, actorId, shareWithUserIds?)` — New, mirrors `linkNoteToCard()`
- `unlinkNoteFromBoard(boardId, actorId)` — New, mirrors `unlinkNoteFromCard()`
- `getLinkedBoardsForNote()` — Extended to also search `KanbanBoard.noteId`

### Permission Rules (same as card)

| Action | Who Can |
|--------|---------|
| Link note | Note owner with WRITE access on board |
| Unlink note | The user who linked it |
| View note data | Users with note access (owner or ACCEPTED share) |

### Frontend

**KanbanBoardPage header:**
- Below title/description, above columns
- No note: "Link note" button (WRITE users only, opens NoteLinkPicker)
- Has note: clickable title → `/notes?noteId=...` + unlink button (linker only)
- SharingGapModal reused identically

**KanbanBoardLink in NoteEditor:**
- Board link: `LayoutDashboard` icon + "Board: {boardTitle}"
- Card link: `SquareKanban` icon + "Card: {cardTitle} ({boardTitle})"
- Both shown if note is linked to both board and cards
- Each navigates to `/kanban?boardId=...`

### getLinkedBoardsForNote() Response

```typescript
interface LinkedBoardInfo {
  boardId: string;
  boardTitle: string;
  boardAvatarUrl: string | null;   // NEW
  linkedAs: 'board' | 'card';      // NEW
  cardIds: string[];                // empty if linkedAs='board'
  cardTitles: string[];             // NEW — for card label display
}
```

## Feature 2: Board Avatar

### Schema

Add to `KanbanBoard`:
```prisma
avatarUrl  String?
```

### Backend Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/boards/:id/avatar` | Upload avatar (multipart, max 2MB, jpeg/png/gif/webp) |
| DELETE | `/boards/:id/avatar` | Remove avatar |

File storage: `/uploads/kanban/avatars/{uuid}.{ext}`

### Where Avatar Appears

| Location | Component | Detail |
|----------|-----------|--------|
| Board list | `BoardCard.tsx` | 40px circle, top-left or beside title |
| Board header | `KanbanBoardPage.tsx` | 32px circle beside title |
| Kanban reminders | `RemindersPage.tsx` | 20px circle in reminder row |
| NoteEditor link | `KanbanBoardLink.tsx` | 16px circle in badge |

Fallback (no avatar): `Kanban` Lucide icon as today.

### Upload Flow

Same pattern as cover image:
1. Hidden `<input type="file">` triggered by click on avatar area
2. Multipart POST to `/boards/:id/avatar`
3. Backend saves file, deletes old avatar, updates DB
4. Returns `{ avatarUrl: string }`
5. Query invalidation refreshes UI

## Files Impacted (13 modified, 0 new)

| # | File | Change | TIER |
|---|------|--------|------|
| 1 | `backend/prisma/schema.prisma` | +3 fields on KanbanBoard + relations | TIER 1 (additive) |
| 2 | `backend/src/services/kanban.service.ts` | Board note link/unlink, extended search | TIER 2 |
| 3 | `backend/src/routes/kanban.ts` | 5 new endpoints | - |
| 4 | `backend/src/services/sharing.service.ts` | Minimal — reuse autoShareNoteForBoard | TIER 2 |
| 5 | `frontend/src/features/kanban/types.ts` | New fields in types | - |
| 6 | `frontend/src/features/kanban/kanbanService.ts` | New API calls | - |
| 7 | `frontend/src/features/kanban/hooks/useKanbanMutations.ts` | New mutations | - |
| 8 | `frontend/src/features/kanban/KanbanBoardPage.tsx` | Board note section + avatar in header | - |
| 9 | `frontend/src/features/kanban/components/BoardCard.tsx` | Avatar in list | - |
| 10 | `frontend/src/features/kanban/components/KanbanBoardLink.tsx` | Separate labels + avatar | - |
| 11 | `frontend/src/features/reminders/RemindersPage.tsx` | Avatar in reminder rows | - |
| 12 | `frontend/src/locales/en.json` | i18n keys | - |
| 13 | `frontend/src/locales/it.json` | i18n keys | - |

## Edge Cases

| Case | Handling |
|------|----------|
| Board deleted | Note link cleared (Prisma cascade on column? No — noteId is nullable FK, board deletion doesn't cascade to Note. The noteId/noteLinkedById fields are just set to null implicitly when the board row is deleted) |
| Note deleted | Cards/boards with that noteId get null (Prisma SetNull or Cascade depending on config) |
| User leaves board (share revoked) | Their note access from auto-share persists (same as card unlink behavior) |
| New user accepts board share | No auto-catch-up for board note (unlike reminders). They see the linked note only if they already have access |
| Board note + card note = same note | Both links coexist independently. NoteEditor shows both labels |
