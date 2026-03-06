# Kanban Context Menu, Marquee Selection & Bulk Move

**Date:** 2026-03-06
**Status:** Approved

## Overview

Three interconnected features for the Kanban board:
1. **Context menu** (right-click on card) with 7 actions
2. **Marquee selection** (drag from board background) for multi-card selection
3. **Bulk move** with grouped notification

Plus: fix three-dot menu hover visibility, add duplicate card action.

## 1. Marquee Selection

### Hook `useMarqueeSelection`

- **Trigger:** `mousedown` on board background (not on `[data-dnd-handle]`, `button`, `input`, or children of `[data-kanban-card]`)
- **Desktop only:** Disabled on touch devices via `window.matchMedia('(pointer: fine)')`
- **Behavior:**
  1. `mousedown` on background -> record start point, begin tracking
  2. `mousemove` -> draw semi-transparent rectangle (`bg-blue-500/10 border border-blue-500/50`) as absolute overlay
  3. Each frame: calculate intersection rect <-> cards via `getBoundingClientRect()` on `[data-kanban-card]` elements. Intersected cards enter `selectedCardIds: Set<string>`
  4. `mouseup` -> if `selectedCardIds.size > 0`, show BulkMoveMenu at release point
  5. Click outside menu or Escape -> deselect all

### Selected card style

- `ring-2 ring-blue-500 dark:ring-blue-400`
- `scale-[1.02]`
- `bg-blue-50 dark:bg-blue-900/20`
- `transition-all duration-150`

### DnD conflict

None. DnD uses `[data-dnd-handle]` (grip bar), marquee starts from empty background only.

## 2. Context Menu (right-click on card)

### Component `CardContextMenu`

- **Trigger:** `contextmenu` event on `[data-kanban-card]`, prevents native browser menu
- **Position:** Fixed at cursor point, viewport-bounded

### Menu structure

```
Sposta in ->          (submenu: columns, excluding current)
Assegna a ->          (submenu: owner + accepted shared users)
Priorita ->           (submenu: None, Standby, Low, Medium, High, Critical with colored icons)
Imposta scadenza      (inline date picker)
Collega nota          (opens NoteLinkPicker)
---
Duplica
---
Elimina               (red text, ConfirmDialog)
```

### Submenu behavior

- Appears to the right on hover/click
- Falls back to left if no viewport space

### Action reuse

- Move: `mutations.moveCard.mutate()`
- Assign: `mutations.updateCard.mutate({ cardId, assigneeId })`
- Priority: `mutations.updateCard.mutate({ cardId, priority })`
- Due date: `mutations.updateCard.mutate({ cardId, dueDate })`
- Link note: opens `NoteLinkPicker` -> `mutations.linkNote.mutate()`
- Duplicate: new `duplicateCard` (creates card via `createCard` with copied title/desc/priority)
- Delete: `mutations.deleteCard.mutate()` with `ConfirmDialog` variant `danger`

### Assignee list

Board owner + users with ACCEPTED share (from `board.shares`), not just existing assignees.

## 3. Bulk Move Menu (post-selection)

### Component `BulkMoveMenu`

- **Trigger:** Appears on `mouseup` after marquee with >=1 card selected
- **Position:** At mouse release point

### Structure

```
N card selezionate          (header with count)
---
Sposta in:
  ( ) To Do (3)             (radio, column + current card count)
  ( ) In Progress (5)
  ( ) Done (2)
---
[Sposta]       [Annulla]
```

- Shows all columns; cards already in target column are silently skipped
- "Sposta" button disabled until column selected
- Radio selection (single destination)

### Execution flow

1. User selects target column, clicks "Sposta"
2. Frontend calls `mutations.moveCard.mutate()` sequentially for each card not already in target (avoids position race conditions)
3. Optimistic UI: cards move immediately
4. Deselect all, close menu
5. Frontend calls `POST /kanban/boards/:boardId/bulk-move-notify` with move summary

### No bulk endpoint for the moves themselves

Reuses single `moveCard` calls. Cards are few (3-10 typically). A bulk endpoint would require sync queue + SSE changes for minimal benefit.

## 4. Grouped Notification

### Flow

1. Individual `moveCard` calls use `?silent=true` query param to skip per-card notifications
2. After all moves complete, frontend calls `POST /kanban/boards/:boardId/bulk-move-notify`:

```json
{
  "moves": [
    { "cardId": "...", "fromColumnId": "...", "toColumnId": "..." }
  ]
}
```

3. Backend groups by `fromColumn -> toColumn`, generates ONE notification via `notifyBoardUsersTiered()`

### Notification format

- Type: `KANBAN_BULK_MOVE`
- i18n key: `kanban.notifications.bulkMove`
- EN: `"Marco moved 5 cards on Sprint 1: 3 from To Do -> Done, 2 from In Progress -> Done"`
- IT: `"Marco ha spostato 5 card su Sprint 1: 3 da Da fare -> Completato, 2 da In corso -> Completato"`

### Activity log

Each individual move still logs `logCardActivity(MOVED)` — activity stays granular, only push/email notifications are grouped.

## 5. Fixes & Additions

### Three-dot menu hover fix

KanbanCard container missing `group` class. The MoreVertical button has `group-hover:opacity-100` but no parent `group`. Fix: add `group` to card outer div.

### Duplicate Card

- Frontend `duplicateCard` in `kanbanService.ts`: creates card via `createCard` with copied title ("Copy of ..."), description, priority
- Same column, position = original + 1
- Does NOT copy: assignee, dueDate, comments, activity, noteId
- Offline-first: Dexie + syncQueue

## Files Impacted (12: 3 new, 9 modified)

| File | Type | Description |
|------|------|-------------|
| `frontend/src/features/kanban/hooks/useMarqueeSelection.ts` | NEW | Marquee rect + card intersection hook |
| `frontend/src/features/kanban/components/CardContextMenu.tsx` | NEW | Right-click context menu (7 actions) |
| `frontend/src/features/kanban/components/BulkMoveMenu.tsx` | NEW | Post-selection move menu |
| `frontend/src/features/kanban/components/KanbanCard.tsx` | MODIFY | `group` class, `data-kanban-card` attr, selection style, `onContextMenu` |
| `frontend/src/features/kanban/components/KanbanColumn.tsx` | MODIFY | Pass-through context menu + selection props |
| `frontend/src/features/kanban/KanbanBoardPage.tsx` | MODIFY | Integrate marquee, context menu, bulk move |
| `frontend/src/features/kanban/hooks/useKanbanMutations.ts` | MODIFY | Add `duplicateCard` mutation |
| `frontend/src/features/kanban/kanbanService.ts` | MODIFY | `duplicateCard()` function |
| `backend/src/routes/kanban.ts` | MODIFY | `?silent=true` on move, new `bulk-move-notify` endpoint |
| `backend/src/services/kanban/card.service.ts` | MODIFY | `skipNotification` param on `moveCard`, new `bulkMoveNotify` |
| `frontend/src/locales/en.json` | MODIFY | i18n keys for context menu + bulk move |
| `frontend/src/locales/it.json` | MODIFY | i18n keys for context menu + bulk move |

No TIER 1/2 files touched. Backend changes are additive only.
