# Kanban Context Menu, Marquee Selection & Bulk Move — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add right-click context menu on kanban cards, marquee drag-selection from board background, and bulk move with grouped notifications.

**Architecture:** Custom `useMarqueeSelection` hook handles rectangle drawing and card intersection detection. `CardContextMenu` renders a portal-based context menu with 7 actions (submenu pattern). `BulkMoveMenu` appears after marquee selection for column targeting. Backend gets `?silent=true` flag on move and a new `bulk-move-notify` endpoint for grouped notifications.

**Tech Stack:** React 19, TailwindCSS 3, @dnd-kit (existing), Dexie.js (existing), Fastify 5, Prisma 7, i18next

**Design doc:** `docs/plans/2026-03-06-kanban-context-menu-marquee-design.md`

---

## Task 1: Fix three-dot menu hover + add `group` class and `data-kanban-card` attribute

**Files:**
- Modify: `frontend/src/features/kanban/components/KanbanCard.tsx`

**Step 1: Add `group` class and `data-kanban-card` attribute to card container**

In `KanbanCard.tsx`, the outer card `<div>` (line ~129) needs `group` class for the `group-hover:opacity-100` on the three-dot menu to work, and a `data-kanban-card` attribute with the card id for marquee intersection detection.

Change the card container div from:
```tsx
<div
  ref={setNodeRef}
  style={style}
  className={clsx(
    'rounded-lg bg-white dark:bg-neutral-800 p-3 shadow-sm',
    'border border-neutral-200/60 dark:border-neutral-700/40',
    'hover:shadow-md transition-all cursor-pointer hover-lift',
    isDragging && 'opacity-50 shadow-lg z-50',
    isHighlighted && 'ring-2 ring-emerald-400 dark:ring-emerald-500 animate-pulse shadow-md shadow-emerald-100 dark:shadow-emerald-900/30'
  )}
>
```

To:
```tsx
<div
  ref={setNodeRef}
  style={style}
  data-kanban-card={card.id}
  className={clsx(
    'group rounded-lg bg-white dark:bg-neutral-800 p-3 shadow-sm',
    'border border-neutral-200/60 dark:border-neutral-700/40',
    'hover:shadow-md transition-all cursor-pointer hover-lift',
    isDragging && 'opacity-50 shadow-lg z-50',
    isHighlighted && 'ring-2 ring-emerald-400 dark:ring-emerald-500 animate-pulse shadow-md shadow-emerald-100 dark:shadow-emerald-900/30'
  )}
>
```

**Step 2: Verify three-dot menu appears on hover**

Run: `cd frontend && npm run dev`
Hover over a kanban card on desktop — the MoreVertical (three dots) icon should become visible.

**Step 3: Commit**

```bash
git add frontend/src/features/kanban/components/KanbanCard.tsx
git commit -m "fix: add group class + data-kanban-card attr to KanbanCard for hover menu and marquee selection"
```

---

## Task 2: Add `duplicateCard` to kanbanService and mutations

**Files:**
- Modify: `frontend/src/features/kanban/kanbanService.ts`
- Modify: `frontend/src/features/kanban/hooks/useKanbanMutations.ts`

**Step 1: Add `duplicateCard` function to kanbanService.ts**

After the existing `deleteCard` function (line ~374), add:

```typescript
export async function duplicateCard(cardId: string): Promise<LocalKanbanCard> {
  const userId = getUserId();
  const original = await db.kanbanCards.get(cardId);
  if (!original) throw new Error('Card not found');

  const id = uuidv4();
  const now = new Date().toISOString();

  // Shift cards below the original to make room
  const cardsInColumn = await db.kanbanCards.where('columnId').equals(original.columnId).toArray();
  const newPosition = original.position + 1;

  const card: LocalKanbanCard = {
    id,
    title: `Copy of ${original.title}`,
    description: original.description,
    position: newPosition,
    columnId: original.columnId,
    boardId: original.boardId,
    assigneeId: null,
    assignee: null,
    dueDate: null,
    priority: original.priority,
    noteId: null,
    noteLinkedById: null,
    note: null,
    commentCount: 0,
    createdAt: now,
    updatedAt: now,
    syncStatus: 'created',
  };

  await db.transaction('rw', db.kanbanCards, db.kanbanBoards, db.syncQueue, async () => {
    // Shift cards at or below new position
    for (const c of cardsInColumn) {
      if (c.position >= newPosition) {
        await db.kanbanCards.update(c.id, { position: c.position + 1 });
      }
    }

    await db.kanbanCards.add(card);

    const board = await db.kanbanBoards.get(original.boardId);
    if (board) {
      await db.kanbanBoards.update(original.boardId, { cardCount: (board.cardCount || 0) + 1 });
    }

    await db.syncQueue.add({
      type: 'CREATE',
      entity: 'KANBAN_CARD',
      entityId: id,
      userId,
      data: { id, columnId: original.columnId, title: card.title, description: card.description, priority: card.priority },
      createdAt: Date.now(),
    });
  });

  return card;
}
```

**Step 2: Add `duplicateCard` mutation to useKanbanMutations.ts**

After the existing `deleteCard` mutation (line ~121), add:

```typescript
const duplicateCard = useMutation({
  mutationFn: kanbanService.duplicateCard,
  onSuccess: () => {
    flushSync();
    invalidateBoard();
  },
});
```

Add `duplicateCard` to the returned object (find the return statement that lists all mutations).

**Step 3: Build check**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: No errors.

**Step 4: Commit**

```bash
git add frontend/src/features/kanban/kanbanService.ts frontend/src/features/kanban/hooks/useKanbanMutations.ts
git commit -m "feat: add duplicateCard function and mutation for kanban"
```

---

## Task 3: Add i18n keys for context menu and bulk move

**Files:**
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/it.json`

**Step 1: Add keys to en.json**

Find the `kanban` section (around line 786). Inside the `kanban.card` subsection, add these keys:

```json
"contextMenu": {
  "moveTo": "Move to",
  "assignTo": "Assign to",
  "priority": "Priority",
  "setDueDate": "Set due date",
  "clearDueDate": "Clear due date",
  "linkNote": "Link note",
  "duplicate": "Duplicate",
  "delete": "Delete",
  "unassigned": "Unassigned",
  "noPriority": "No priority"
},
"bulkMove": {
  "title": "{{count}} card selected",
  "title_plural": "{{count}} cards selected",
  "moveTo": "Move to:",
  "move": "Move",
  "cancel": "Cancel"
}
```

Also find the `notifications` section and add:
```json
"kanbanBulkMove": "{{actorName}} moved {{count}} cards on {{boardTitle}}: {{summary}}"
```

**Step 2: Add same keys to it.json**

```json
"contextMenu": {
  "moveTo": "Sposta in",
  "assignTo": "Assegna a",
  "priority": "Priorita",
  "setDueDate": "Imposta scadenza",
  "clearDueDate": "Rimuovi scadenza",
  "linkNote": "Collega nota",
  "duplicate": "Duplica",
  "delete": "Elimina",
  "unassigned": "Non assegnato",
  "noPriority": "Nessuna priorita"
},
"bulkMove": {
  "title": "{{count}} card selezionate",
  "title_plural": "{{count}} card selezionate",
  "moveTo": "Sposta in:",
  "move": "Sposta",
  "cancel": "Annulla"
}
```

Notifications:
```json
"kanbanBulkMove": "{{actorName}} ha spostato {{count}} card su {{boardTitle}}: {{summary}}"
```

**Step 3: Commit**

```bash
git add frontend/src/locales/en.json frontend/src/locales/it.json
git commit -m "feat: add i18n keys for kanban context menu and bulk move"
```

---

## Task 4: Create `CardContextMenu` component

**Files:**
- Create: `frontend/src/features/kanban/components/CardContextMenu.tsx`

**Step 1: Create the component**

```tsx
import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import {
  ArrowRight,
  UserPlus,
  Flag,
  Calendar,
  FileText,
  Copy,
  Trash2,
  X,
  ChevronRight,
} from 'lucide-react';
import { PRIORITY_CONFIG, type PriorityLevel } from '../../../utils/priorityConfig';
import type { KanbanColumn, KanbanCard, KanbanBoard } from '../types';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';

interface CardContextMenuProps {
  card: KanbanCard;
  position: { x: number; y: number };
  board: KanbanBoard;
  currentColumnId: string;
  onClose: () => void;
  onMoveToColumn: (cardId: string, columnId: string) => void;
  onAssign: (cardId: string, assigneeId: string | null) => void;
  onSetPriority: (cardId: string, priority: PriorityLevel | null) => void;
  onSetDueDate: (cardId: string, dueDate: string | null) => void;
  onLinkNote: (cardId: string) => void;
  onDuplicate: (cardId: string) => void;
  onDelete: (cardId: string) => void;
}

export default function CardContextMenu({
  card,
  position,
  board,
  currentColumnId,
  onClose,
  onMoveToColumn,
  onAssign,
  onSetPriority,
  onSetDueDate,
  onLinkNote,
  onDuplicate,
  onDelete,
}: CardContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Viewport-bounded position
  const [menuPos, setMenuPos] = useState(position);

  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const x = Math.min(position.x, window.innerWidth - rect.width - 8);
    const y = Math.min(position.y, window.innerHeight - rect.height - 8);
    setMenuPos({ x: Math.max(8, x), y: Math.max(8, y) });
  }, [position]);

  // Close on Escape or click outside
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey);
    document.addEventListener('mousedown', handleClick);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [onClose]);

  const otherColumns = board.columns.filter(c => c.id !== currentColumnId);

  // Board members: owner + accepted shares
  const boardMembers = [
    board.owner,
    ...(board.shares?.filter(s => s.status === 'ACCEPTED').map(s => ({
      ...s.user,
      color: null as string | null,
    })) || []),
  ].filter(Boolean) as { id: string; name: string | null; email: string; color: string | null; avatarUrl: string | null }[];

  const priorities: (PriorityLevel | null)[] = [null, 'STANDBY', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

  const itemClass = 'flex items-center gap-2 w-full px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors text-left';

  const renderSubmenu = (items: React.ReactNode, submenuKey: string) => {
    if (activeSubmenu !== submenuKey) return null;

    return (
      <div className="absolute left-full top-0 ml-1 min-w-[200px] bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg py-1 z-[101]">
        {items}
      </div>
    );
  };

  return createPortal(
    <>
      <div
        ref={menuRef}
        className="fixed z-[100] min-w-[220px] bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl py-1"
        style={{ left: menuPos.x, top: menuPos.y }}
      >
        {/* Move to */}
        <div
          className="relative"
          onMouseEnter={() => setActiveSubmenu('move')}
          onMouseLeave={() => setActiveSubmenu(null)}
        >
          <button className={itemClass}>
            <ArrowRight size={14} />
            {t('kanban.card.contextMenu.moveTo')}
            <ChevronRight size={12} className="ml-auto text-neutral-400" />
          </button>
          {renderSubmenu(
            otherColumns.map(col => (
              <button
                key={col.id}
                className={itemClass}
                onClick={() => { onMoveToColumn(card.id, col.id); onClose(); }}
              >
                {col.title}
                <span className="ml-auto text-xs text-neutral-400">{col.cards.length}</span>
              </button>
            )),
            'move'
          )}
        </div>

        {/* Assign to */}
        <div
          className="relative"
          onMouseEnter={() => setActiveSubmenu('assign')}
          onMouseLeave={() => setActiveSubmenu(null)}
        >
          <button className={itemClass}>
            <UserPlus size={14} />
            {t('kanban.card.contextMenu.assignTo')}
            <ChevronRight size={12} className="ml-auto text-neutral-400" />
          </button>
          {renderSubmenu(
            <>
              <button
                className={clsx(itemClass, !card.assigneeId && 'bg-neutral-100 dark:bg-neutral-700')}
                onClick={() => { onAssign(card.id, null); onClose(); }}
              >
                {t('kanban.card.contextMenu.unassigned')}
              </button>
              {boardMembers.map(member => (
                <button
                  key={member.id}
                  className={clsx(itemClass, card.assigneeId === member.id && 'bg-neutral-100 dark:bg-neutral-700')}
                  onClick={() => { onAssign(card.id, member.id); onClose(); }}
                >
                  <span
                    className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] text-white font-medium flex-shrink-0"
                    style={{ backgroundColor: member.color || '#6b7280' }}
                  >
                    {(member.name || member.email)[0].toUpperCase()}
                  </span>
                  {member.name || member.email}
                </button>
              ))}
            </>,
            'assign'
          )}
        </div>

        {/* Priority */}
        <div
          className="relative"
          onMouseEnter={() => setActiveSubmenu('priority')}
          onMouseLeave={() => setActiveSubmenu(null)}
        >
          <button className={itemClass}>
            <Flag size={14} />
            {t('kanban.card.contextMenu.priority')}
            <ChevronRight size={12} className="ml-auto text-neutral-400" />
          </button>
          {renderSubmenu(
            priorities.map(p => {
              const config = p ? PRIORITY_CONFIG[p] : null;
              const PIcon = config?.icon;
              return (
                <button
                  key={p || 'none'}
                  className={clsx(itemClass, card.priority === p && 'bg-neutral-100 dark:bg-neutral-700')}
                  onClick={() => { onSetPriority(card.id, p); onClose(); }}
                >
                  {PIcon ? <PIcon size={14} className={config!.color} /> : <span className="w-[14px]" />}
                  {p ? t(`kanban.priority.${p}`) : t('kanban.card.contextMenu.noPriority')}
                </button>
              );
            }),
            'priority'
          )}
        </div>

        {/* Due date */}
        <button
          className={itemClass}
          onClick={() => {
            if (card.dueDate) {
              onSetDueDate(card.id, null);
              onClose();
            } else {
              // Open a native date picker via a hidden input
              const input = document.createElement('input');
              input.type = 'date';
              input.style.position = 'fixed';
              input.style.opacity = '0';
              input.style.pointerEvents = 'none';
              document.body.appendChild(input);
              input.addEventListener('change', () => {
                if (input.value) {
                  onSetDueDate(card.id, new Date(input.value).toISOString());
                }
                document.body.removeChild(input);
                onClose();
              });
              input.addEventListener('blur', () => {
                setTimeout(() => {
                  if (document.body.contains(input)) document.body.removeChild(input);
                }, 200);
              });
              input.showPicker();
            }
          }}
        >
          <Calendar size={14} />
          {card.dueDate ? t('kanban.card.contextMenu.clearDueDate') : t('kanban.card.contextMenu.setDueDate')}
        </button>

        {/* Link note */}
        <button
          className={itemClass}
          onClick={() => { onLinkNote(card.id); onClose(); }}
        >
          <FileText size={14} />
          {t('kanban.card.contextMenu.linkNote')}
        </button>

        {/* Separator */}
        <div className="my-1 border-t border-neutral-200 dark:border-neutral-700" />

        {/* Duplicate */}
        <button
          className={itemClass}
          onClick={() => { onDuplicate(card.id); onClose(); }}
        >
          <Copy size={14} />
          {t('kanban.card.contextMenu.duplicate')}
        </button>

        {/* Separator */}
        <div className="my-1 border-t border-neutral-200 dark:border-neutral-700" />

        {/* Delete */}
        <button
          className={clsx(itemClass, 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20')}
          onClick={() => setShowDeleteConfirm(true)}
        >
          <Trash2 size={14} />
          {t('kanban.card.contextMenu.delete')}
        </button>
      </div>

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onClose={() => { setShowDeleteConfirm(false); onClose(); }}
        onConfirm={() => { onDelete(card.id); onClose(); }}
        title={t('kanban.card.deleteConfirmTitle')}
        message={t('kanban.card.deleteConfirmMessage')}
        variant="danger"
      />
    </>,
    document.body
  );
}
```

**Step 2: Build check**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add frontend/src/features/kanban/components/CardContextMenu.tsx
git commit -m "feat: add CardContextMenu component with 7 actions"
```

---

## Task 5: Create `useMarqueeSelection` hook

**Files:**
- Create: `frontend/src/features/kanban/hooks/useMarqueeSelection.ts`

**Step 1: Create the hook**

```typescript
import { useState, useEffect, useCallback, useRef } from 'react';

interface MarqueeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface UseMarqueeSelectionOptions {
  containerRef: React.RefObject<HTMLElement | null>;
  enabled?: boolean;
}

export function useMarqueeSelection({ containerRef, enabled = true }: UseMarqueeSelectionOptions) {
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);

  const isDrawing = useRef(false);
  const startPoint = useRef<{ x: number; y: number } | null>(null);

  // Desktop only: check for fine pointer (mouse)
  const isDesktop = typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches;

  const clearSelection = useCallback(() => {
    setSelectedCardIds(new Set());
    setMarqueeRect(null);
    setMenuPosition(null);
    isDrawing.current = false;
    startPoint.current = null;
  }, []);

  const getIntersectedCards = useCallback((rect: MarqueeRect): Set<string> => {
    const cards = document.querySelectorAll<HTMLElement>('[data-kanban-card]');
    const ids = new Set<string>();

    for (const cardEl of cards) {
      const cardRect = cardEl.getBoundingClientRect();
      const cardId = cardEl.getAttribute('data-kanban-card');
      if (!cardId) continue;

      // Check rectangle intersection
      const intersects =
        rect.x < cardRect.right &&
        rect.x + rect.width > cardRect.left &&
        rect.y < cardRect.bottom &&
        rect.y + rect.height > cardRect.top;

      if (intersects) ids.add(cardId);
    }

    return ids;
  }, []);

  useEffect(() => {
    if (!enabled || !isDesktop || !containerRef.current) return;

    const container = containerRef.current;

    const handleMouseDown = (e: MouseEvent) => {
      // Only start on left mouse button
      if (e.button !== 0) return;

      // Don't start on interactive elements or cards
      const target = e.target as HTMLElement;
      if (
        target.closest('[data-kanban-card]') ||
        target.closest('[data-dnd-handle]') ||
        target.closest('button') ||
        target.closest('input') ||
        target.closest('textarea') ||
        target.closest('[role="dialog"]')
      ) {
        return;
      }

      e.preventDefault();
      isDrawing.current = true;
      startPoint.current = { x: e.clientX, y: e.clientY };
      setMarqueeRect(null);
      setMenuPosition(null);
      setSelectedCardIds(new Set());
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDrawing.current || !startPoint.current) return;

      const x = Math.min(startPoint.current.x, e.clientX);
      const y = Math.min(startPoint.current.y, e.clientY);
      const width = Math.abs(e.clientX - startPoint.current.x);
      const height = Math.abs(e.clientY - startPoint.current.y);

      // Only show marquee after minimum drag distance (5px)
      if (width < 5 && height < 5) return;

      const rect = { x, y, width, height };
      setMarqueeRect(rect);
      setSelectedCardIds(getIntersectedCards(rect));
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (!isDrawing.current) return;
      isDrawing.current = false;

      const currentSelected = marqueeRect ? getIntersectedCards(marqueeRect) : new Set<string>();

      if (currentSelected.size > 0) {
        setSelectedCardIds(currentSelected);
        setMenuPosition({ x: e.clientX, y: e.clientY });
      } else {
        setSelectedCardIds(new Set());
      }

      setMarqueeRect(null);
      startPoint.current = null;
    };

    container.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      container.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [enabled, isDesktop, containerRef, getIntersectedCards, marqueeRect]);

  // Close on Escape
  useEffect(() => {
    if (selectedCardIds.size === 0) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearSelection();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [selectedCardIds.size, clearSelection]);

  return {
    selectedCardIds,
    marqueeRect,
    menuPosition,
    clearSelection,
    isSelecting: isDrawing.current,
  };
}
```

**Step 2: Build check**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add frontend/src/features/kanban/hooks/useMarqueeSelection.ts
git commit -m "feat: add useMarqueeSelection hook for kanban board drag selection"
```

---

## Task 6: Create `BulkMoveMenu` component

**Files:**
- Create: `frontend/src/features/kanban/components/BulkMoveMenu.tsx`

**Step 1: Create the component**

```tsx
import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import type { KanbanColumn } from '../types';

interface BulkMoveMenuProps {
  selectedCount: number;
  position: { x: number; y: number };
  columns: KanbanColumn[];
  onMove: (targetColumnId: string) => void;
  onCancel: () => void;
}

export default function BulkMoveMenu({
  selectedCount,
  position,
  columns,
  onMove,
  onCancel,
}: BulkMoveMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState(position);

  // Viewport-bound positioning
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const x = Math.min(position.x, window.innerWidth - rect.width - 8);
    const y = Math.min(position.y, window.innerHeight - rect.height - 8);
    setMenuPos({ x: Math.max(8, x), y: Math.max(8, y) });
  }, [position]);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onCancel();
      }
    };
    // Delay to avoid the mouseup that triggered this menu
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [onCancel]);

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[100] w-[260px] bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-xl shadow-xl overflow-hidden"
      style={{ left: menuPos.x, top: menuPos.y }}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-700">
        <p className="text-sm font-medium text-neutral-900 dark:text-white">
          {t('kanban.card.bulkMove.title', { count: selectedCount })}
        </p>
      </div>

      {/* Column list */}
      <div className="p-2">
        <p className="px-2 py-1 text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
          {t('kanban.card.bulkMove.moveTo')}
        </p>
        <div className="space-y-1 mt-1">
          {columns.map(col => (
            <button
              key={col.id}
              onClick={() => setSelectedColumnId(col.id)}
              className={clsx(
                'flex items-center justify-between w-full px-3 py-2 rounded-lg text-sm transition-colors',
                selectedColumnId === col.id
                  ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 ring-1 ring-blue-500/30'
                  : 'text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700'
              )}
            >
              <span>{col.title}</span>
              <span className="text-xs text-neutral-400">({col.cards.length})</span>
            </button>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 px-4 py-3 border-t border-neutral-200 dark:border-neutral-700">
        <button
          onClick={onCancel}
          className="flex-1 px-3 py-2 text-sm text-neutral-600 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-700 rounded-lg hover:bg-neutral-200 dark:hover:bg-neutral-600 transition-colors"
        >
          {t('kanban.card.bulkMove.cancel')}
        </button>
        <button
          onClick={() => selectedColumnId && onMove(selectedColumnId)}
          disabled={!selectedColumnId}
          className={clsx(
            'flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-colors',
            selectedColumnId
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-400 dark:text-neutral-500 cursor-not-allowed'
          )}
        >
          {t('kanban.card.bulkMove.move')}
        </button>
      </div>
    </div>,
    document.body
  );
}
```

**Step 2: Build check**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add frontend/src/features/kanban/components/BulkMoveMenu.tsx
git commit -m "feat: add BulkMoveMenu component for marquee bulk card move"
```

---

## Task 7: Add selection styling to `KanbanCard`

**Files:**
- Modify: `frontend/src/features/kanban/components/KanbanCard.tsx`

**Step 1: Add `isSelected` prop**

Add to the `KanbanCardProps` interface (line ~15):
```typescript
isSelected?: boolean;
```

**Step 2: Add selection styling to card container**

In the card container div class list (line ~129), add the selection style after the highlight style:

```typescript
isSelected && 'ring-2 ring-blue-500 dark:ring-blue-400 bg-blue-50 dark:bg-blue-900/20 scale-[1.02]',
```

**Step 3: Add `onContextMenu` prop and handler**

Add to `KanbanCardProps`:
```typescript
onContextMenu?: (cardId: string, e: React.MouseEvent) => void;
```

On the outermost card div, add:
```typescript
onContextMenu={(e) => {
  if (onContextMenu) {
    e.preventDefault();
    onContextMenu(card.id, e);
  }
}}
```

**Step 4: Build check**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: No errors.

**Step 5: Commit**

```bash
git add frontend/src/features/kanban/components/KanbanCard.tsx
git commit -m "feat: add isSelected styling and onContextMenu to KanbanCard"
```

---

## Task 8: Wire `KanbanColumn` to pass new props through

**Files:**
- Modify: `frontend/src/features/kanban/components/KanbanColumn.tsx`

**Step 1: Add new props to `KanbanColumnProps` interface (line ~12)**

```typescript
selectedCardIds?: Set<string>;
onCardContextMenu?: (cardId: string, e: React.MouseEvent) => void;
```

**Step 2: Pass props to `KanbanCard` in the card rendering loop (line ~236)**

Add to each `<KanbanCard>`:
```typescript
isSelected={selectedCardIds?.has(card.id)}
onContextMenu={onCardContextMenu}
```

**Step 3: Build check**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: No errors.

**Step 4: Commit**

```bash
git add frontend/src/features/kanban/components/KanbanColumn.tsx
git commit -m "feat: pass selection and context menu props through KanbanColumn"
```

---

## Task 9: Integrate everything into `KanbanBoardPage`

**Files:**
- Modify: `frontend/src/features/kanban/KanbanBoardPage.tsx`

This is the largest task. Wire up the marquee hook, context menu, bulk move menu, and all handlers.

**Step 1: Add imports**

At the top of the file, add:
```typescript
import { useMarqueeSelection } from './hooks/useMarqueeSelection';
import CardContextMenu from './components/CardContextMenu';
import BulkMoveMenu from './components/BulkMoveMenu';
import NoteLinkPicker from './components/NoteLinkPicker';
```

**Step 2: Add ref for the board scroll container**

Add a ref for the desktop board container (the `div.flex-1.overflow-x-auto` at line ~801):
```typescript
const boardContainerRef = useRef<HTMLDivElement>(null);
```

Attach it:
```tsx
<div ref={boardContainerRef} className="flex-1 overflow-x-auto overflow-y-hidden">
```

**Step 3: Add marquee hook**

After the board ref, add:
```typescript
const marquee = useMarqueeSelection({
  containerRef: boardContainerRef,
  enabled: !readOnly,
});
```

**Step 4: Add context menu state**

```typescript
const [contextMenu, setContextMenu] = useState<{ card: KanbanCard; columnId: string; position: { x: number; y: number } } | null>(null);
const [noteLinkCardId, setNoteLinkCardId] = useState<string | null>(null);
```

**Step 5: Add context menu handler**

```typescript
const handleCardContextMenu = useCallback((cardId: string, e: React.MouseEvent) => {
  if (readOnly) return;
  const card = board?.columns.flatMap(c => c.cards).find(c => c.id === cardId);
  const col = board?.columns.find(c => c.cards.some(ca => ca.id === cardId));
  if (!card || !col) return;
  setContextMenu({ card, columnId: col.id, position: { x: e.clientX, y: e.clientY } });
}, [board, readOnly]);
```

**Step 6: Add context menu action handlers**

```typescript
const handleContextAssign = useCallback((cardId: string, assigneeId: string | null) => {
  mutations.updateCard.mutate({ cardId, assigneeId });
}, [mutations]);

const handleContextPriority = useCallback((cardId: string, priority: string | null) => {
  mutations.updateCard.mutate({ cardId, priority });
}, [mutations]);

const handleContextDueDate = useCallback((cardId: string, dueDate: string | null) => {
  mutations.updateCard.mutate({ cardId, dueDate });
}, [mutations]);

const handleContextLinkNote = useCallback((cardId: string) => {
  setNoteLinkCardId(cardId);
}, []);

const handleContextDuplicate = useCallback((cardId: string) => {
  mutations.duplicateCard.mutate(cardId);
}, [mutations]);

const handleContextDelete = useCallback((cardId: string) => {
  mutations.deleteCard.mutate(cardId);
}, [mutations]);
```

**Step 7: Add bulk move handler**

```typescript
const handleBulkMove = useCallback(async (targetColumnId: string) => {
  const cardsToMove = [...marquee.selectedCardIds].filter(cardId => {
    const col = board?.columns.find(c => c.cards.some(ca => ca.id === cardId));
    return col && col.id !== targetColumnId;
  });

  // Move cards sequentially to avoid position race conditions
  for (const cardId of cardsToMove) {
    await mutations.moveCard.mutateAsync({ cardId, toColumnId: targetColumnId, position: 999 });
  }

  marquee.clearSelection();
}, [marquee, board, mutations]);
```

**Step 8: Pass new props to `KanbanColumn` in the desktop render (line ~812)**

Add to each `<KanbanColumn>`:
```typescript
selectedCardIds={marquee.selectedCardIds}
onCardContextMenu={handleCardContextMenu}
```

**Step 9: Add marquee overlay rectangle and menus after the DndContext (before the closing `</div>` of the board container)**

```tsx
{/* Marquee selection rectangle */}
{marquee.marqueeRect && (
  <div
    className="fixed pointer-events-none border border-blue-500/50 bg-blue-500/10 rounded-sm z-50"
    style={{
      left: marquee.marqueeRect.x,
      top: marquee.marqueeRect.y,
      width: marquee.marqueeRect.width,
      height: marquee.marqueeRect.height,
    }}
  />
)}

{/* Bulk move menu after selection */}
{marquee.menuPosition && marquee.selectedCardIds.size > 0 && board && (
  <BulkMoveMenu
    selectedCount={marquee.selectedCardIds.size}
    position={marquee.menuPosition}
    columns={board.columns}
    onMove={handleBulkMove}
    onCancel={marquee.clearSelection}
  />
)}

{/* Card context menu */}
{contextMenu && board && (
  <CardContextMenu
    card={contextMenu.card}
    position={contextMenu.position}
    board={board}
    currentColumnId={contextMenu.columnId}
    onClose={() => setContextMenu(null)}
    onMoveToColumn={dnd.handleMoveCardToColumn}
    onAssign={handleContextAssign}
    onSetPriority={handleContextPriority}
    onSetDueDate={handleContextDueDate}
    onLinkNote={handleContextLinkNote}
    onDuplicate={handleContextDuplicate}
    onDelete={handleContextDelete}
  />
)}

{/* NoteLinkPicker for context menu "Link note" */}
{noteLinkCardId && (
  <NoteLinkPicker
    isOpen={!!noteLinkCardId}
    onClose={() => setNoteLinkCardId(null)}
    onSelect={(note) => {
      mutations.linkNote.mutate({ cardId: noteLinkCardId, noteId: note.id });
      setNoteLinkCardId(null);
    }}
  />
)}
```

**Step 10: Build check**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: No errors. Fix any type mismatches.

**Step 11: Commit**

```bash
git add frontend/src/features/kanban/KanbanBoardPage.tsx
git commit -m "feat: integrate marquee selection, context menu, and bulk move into KanbanBoardPage"
```

---

## Task 10: Backend — `?silent=true` on move card + bulk-move-notify endpoint

**Files:**
- Modify: `backend/src/routes/kanban.ts`
- Modify: `backend/src/services/kanban/card.service.ts`
- Modify: `backend/src/services/kanban/notifications.ts`

**Step 1: Add `silent` query param support to move route in `kanban.ts` (line ~458)**

Change the move card route to pass `silent` flag:
```typescript
fastify.put('/cards/:id/move', async (request) => {
  const { id } = request.params as { id: string };
  await getCardWithAccess(id, request.user.id, 'WRITE');
  const { toColumnId, position } = moveCardSchema.parse(request.body);
  const silent = (request.query as { silent?: string }).silent === 'true';
  await kanbanService.moveCard(id, toColumnId, position, request.user.id, silent);
  return { success: true };
});
```

**Step 2: Add `skipNotification` param to `moveCard` in card.service.ts (line ~175)**

Change the function signature:
```typescript
export async function moveCard(
  cardId: string,
  toColumnId: string,
  newPosition: number,
  actorId?: string,
  skipNotification: boolean = false
) {
```

Wrap the notification section (around lines 271-310) with:
```typescript
if (!skipNotification && actorId && card.columnId !== toColumnId) {
  // ... existing notification logic ...
}
```

Keep the activity log, auto-assign, task sync, and reminder completion OUTSIDE the `skipNotification` guard — those should always fire.

**Step 3: Add `bulk-move-notify` endpoint to `kanban.ts`**

After the move card route, add:

```typescript
const bulkMoveNotifySchema = z.object({
  moves: z.array(z.object({
    cardId: z.string(),
    fromColumnId: z.string(),
    toColumnId: z.string(),
  })),
});

fastify.post('/boards/:boardId/bulk-move-notify', async (request) => {
  const { boardId } = request.params as { boardId: string };
  const { moves } = bulkMoveNotifySchema.parse(request.body);

  // Verify user has access to board
  await kanbanService.getBoardWithAccess(boardId, request.user.id, 'WRITE');

  await kanbanService.bulkMoveNotify(boardId, moves, request.user.id);
  return { success: true };
});
```

**Step 4: Add `bulkMoveNotify` function to card.service.ts**

At the end of the file, add:

```typescript
export async function bulkMoveNotify(
  boardId: string,
  moves: { cardId: string; fromColumnId: string; toColumnId: string }[],
  actorId: string,
) {
  if (moves.length === 0) return;

  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: { title: true, columns: { select: { id: true, title: true } } },
  });
  if (!board) return;

  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { name: true, email: true },
  });
  const actorName = actor?.name || actor?.email || 'Unknown';

  const columnMap = new Map(board.columns.map(c => [c.id, c.title]));

  // Group moves by fromColumn -> toColumn
  const groups = new Map<string, number>();
  for (const move of moves) {
    const from = columnMap.get(move.fromColumnId) || '?';
    const to = columnMap.get(move.toColumnId) || '?';
    const key = `${from} → ${to}`;
    groups.set(key, (groups.get(key) || 0) + 1);
  }

  const summary = Array.from(groups.entries())
    .map(([key, count]) => `${count} × ${key}`)
    .join(', ');

  const totalCount = moves.length;

  await notifyBoardUsersTiered(
    actorId,
    boardId,
    'KANBAN_CARD_MOVED',
    'Cards Moved',
    `${actorName} moved ${totalCount} cards on ${board.title}: ${summary}`,
    {
      boardId,
      actorName,
      count: totalCount,
      summary,
      boardTitle: board.title,
      localizationKey: 'notifications.kanbanBulkMove',
      localizationArgs: {
        actorName,
        count: String(totalCount),
        boardTitle: board.title,
        summary,
      },
    },
    {
      type: 'KANBAN_CARD_MOVED',
      data: (_email, locale) => ({
        actorName,
        count: String(totalCount),
        summary,
        boardTitle: board.title,
        locale,
      }),
    }
  );
}
```

**Step 5: Add `getBoardWithAccess` export if not already exported**

Check if `getBoardWithAccess` exists in `board.service.ts`. If it doesn't, it may be local to `kanban.ts` routes. Use the existing access check pattern from the routes file. The `getCardWithAccess` function is defined in `kanban.ts` itself — follow the same pattern for board access.

**Step 6: Build check**

Run: `cd backend && npx tsc --noEmit`
Expected: No errors.

**Step 7: Commit**

```bash
git add backend/src/routes/kanban.ts backend/src/services/kanban/card.service.ts
git commit -m "feat: add silent move flag and bulk-move-notify endpoint for grouped kanban notifications"
```

---

## Task 11: Frontend — call `?silent=true` and `bulk-move-notify` from bulk move

**Files:**
- Modify: `frontend/src/features/kanban/kanbanService.ts`
- Modify: `frontend/src/features/kanban/KanbanBoardPage.tsx`

**Step 1: Add `moveCardSilent` and `bulkMoveNotify` to kanbanService.ts**

After the existing `moveCard` function:

```typescript
export async function moveCardSilent(cardId: string, toColumnId: string, position: number): Promise<void> {
  const userId = getUserId();
  const now = new Date().toISOString();

  await db.kanbanCards.update(cardId, { columnId: toColumnId, position, updatedAt: now, syncStatus: 'updated' });
  await db.syncQueue.add({
    type: 'UPDATE',
    entity: 'KANBAN_CARD',
    entityId: cardId,
    userId,
    data: { columnId: toColumnId, position, _silent: true },
    createdAt: Date.now(),
  });
}

export async function bulkMoveNotify(
  boardId: string,
  moves: { cardId: string; fromColumnId: string; toColumnId: string }[]
): Promise<void> {
  await api.post(`/kanban/boards/${boardId}/bulk-move-notify`, { moves });
}
```

**Step 2: Update the bulk move handler in KanbanBoardPage.tsx**

Replace the `handleBulkMove` callback with:

```typescript
const handleBulkMove = useCallback(async (targetColumnId: string) => {
  if (!board) return;

  const moves: { cardId: string; fromColumnId: string; toColumnId: string }[] = [];

  for (const cardId of marquee.selectedCardIds) {
    const col = board.columns.find(c => c.cards.some(ca => ca.id === cardId));
    if (col && col.id !== targetColumnId) {
      moves.push({ cardId, fromColumnId: col.id, toColumnId: targetColumnId });
    }
  }

  if (moves.length === 0) {
    marquee.clearSelection();
    return;
  }

  // Move cards sequentially (silent — no individual notifications)
  for (const move of moves) {
    await mutations.moveCard.mutateAsync({ cardId: move.cardId, toColumnId: move.toColumnId, position: 999 });
  }

  // Send grouped notification
  kanbanService.bulkMoveNotify(board.id, moves).catch(() => {});

  marquee.clearSelection();
}, [marquee, board, mutations]);
```

Add `import * as kanbanService from './kanbanService';` if not already present (it likely isn't since mutations abstract it).

**Step 3: Handle `_silent` flag in syncPush**

Check `frontend/src/features/sync/syncService.ts` for how `KANBAN_CARD` UPDATE is sent. The `data._silent` flag needs to be forwarded as `?silent=true` query param on the `PUT /kanban/cards/:id/move` call. Find the sync push handler for KANBAN_CARD updates and add the silent query param when `data._silent` is true.

Alternatively, simpler approach: just use regular `moveCard` (not silent) in the Dexie/sync path, and call the backend `bulk-move-notify` endpoint directly via API (not through sync queue). The sync push will trigger individual notifications on the backend, which we want to suppress.

**Better approach:** Instead of threading `_silent` through the sync queue, have the bulk move handler call the REST API directly for each move (bypassing Dexie sync queue), then call `bulk-move-notify`:

```typescript
const handleBulkMove = useCallback(async (targetColumnId: string) => {
  if (!board) return;

  const moves: { cardId: string; fromColumnId: string; toColumnId: string }[] = [];

  for (const cardId of marquee.selectedCardIds) {
    const col = board.columns.find(c => c.cards.some(ca => ca.id === cardId));
    if (col && col.id !== targetColumnId) {
      moves.push({ cardId, fromColumnId: col.id, toColumnId: targetColumnId });
    }
  }

  if (moves.length === 0) {
    marquee.clearSelection();
    return;
  }

  // Optimistic UI: move cards in local state immediately
  for (const move of moves) {
    dnd.handleMoveCardToColumn(move.cardId, move.toColumnId);
  }

  // Send silent moves to backend directly (bypass sync queue notifications)
  for (const move of moves) {
    api.put(`/kanban/cards/${move.cardId}/move?silent=true`, {
      toColumnId: move.toColumnId,
      position: 999,
    }).catch(() => {});
  }

  // Send grouped notification
  api.post(`/kanban/boards/${board.id}/bulk-move-notify`, { moves }).catch(() => {});

  marquee.clearSelection();
}, [marquee, board, dnd]);
```

Import `api` from `../../lib/api` at the top.

This avoids modifying the sync queue entirely — uses optimistic UI via `dnd.handleMoveCardToColumn` (existing function) and direct REST calls with `?silent=true`.

**Step 4: Build check**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: No errors.

**Step 5: Commit**

```bash
git add frontend/src/features/kanban/kanbanService.ts frontend/src/features/kanban/KanbanBoardPage.tsx
git commit -m "feat: wire bulk move with silent REST calls and grouped notification"
```

---

## Task 12: Full build + manual verification

**Step 1: Build both frontend and backend**

```bash
cd backend && npx tsc --noEmit && cd ../frontend && npx tsc -b --noEmit
```

Expected: No errors.

**Step 2: Run frontend lint**

```bash
cd frontend && npm run lint
```

Fix any lint warnings.

**Step 3: Manual test checklist**

1. Hover over kanban card on desktop — three-dot menu appears
2. Right-click on card — context menu appears with 7 actions
3. Context menu: click "Move to" → submenu shows other columns → click column → card moves
4. Context menu: click "Assign to" → submenu shows board members → click member → card assigned
5. Context menu: click "Priority" → submenu shows levels → click level → priority changes
6. Context menu: click "Set due date" → date picker opens → select date → due date set
7. Context menu: click "Duplicate" → new card appears below with "Copy of" prefix
8. Context menu: click "Delete" → confirm dialog → card deleted
9. Click and drag from board background → blue rectangle appears
10. Drag rectangle over cards → cards highlight with blue ring
11. Release mouse → BulkMoveMenu appears with column options
12. Select column → click "Move" → all selected cards move to that column
13. Escape or click outside → selection clears
14. Cross-column marquee: drag rectangle spanning multiple columns → cards from different columns selected

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: kanban context menu, marquee selection, and bulk move with grouped notifications"
```
