# Transform Selection to Kanban/Task List — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to select list items in the TipTap editor, right-click, and transform them into Kanban board cards or Task List items via wizard modals.

**Architecture:** Extend the existing `EditorContextMenu` with two new "Transform to..." options that appear when list items are selected. Two new modal components handle the wizard flows. No backend changes needed — uses existing Kanban REST API and Task List Dexie service.

**Tech Stack:** React 19, TipTap v2, TanStack Query v5, Dexie.js, react-hot-toast, i18next, TailwindCSS

**Design doc:** `docs/plans/2026-02-23-transform-selection-design.md`

---

## Dependency Graph

```
Task 1 (i18n) ──┐
                 ├──> Task 3 (Kanban Modal) ──┐
Task 2 (extract ├──> Task 4 (TaskList Modal) ─┼──> Task 5 (TypeScript verify)
  + context menu)│                             │
                 └─────────────────────────────┘
```

Tasks 1 and 2 can run in parallel. Tasks 3 and 4 can run in parallel (both depend on 1+2). Task 5 depends on all.

---

## Task 1: i18n Keys

**Files:**
- Modify: `frontend/src/locales/en.json` (add `editor.transform.*` section)
- Modify: `frontend/src/locales/it.json` (add `editor.transform.*` section)

**Step 1: Add English keys**

In `frontend/src/locales/en.json`, add the following keys inside the `"editor"` section (after the existing editor keys like `editor.pasteAsPlainText`):

```json
"transform": {
  "toKanban": "Transform to Kanban Board",
  "toTaskList": "Transform to Task List",
  "selectBoard": "Select a board",
  "newBoard": "New board",
  "existingBoard": "Existing board",
  "selectColumn": "Select a column",
  "selectList": "Select a task list",
  "newList": "New list",
  "existingList": "Existing list",
  "itemsSelected": "{{count}} items selected",
  "preview": "Preview",
  "confirm": "Transform",
  "removeFromNote": "Remove items from note?",
  "keepItems": "No, keep them",
  "removeItems": "Yes, remove",
  "kanbanSuccess": "{{count}} cards created in {{board}}",
  "taskListSuccess": "{{count}} items added to {{list}}",
  "boardTitle": "Board title",
  "listTitle": "List title"
}
```

**Step 2: Add Italian keys**

In `frontend/src/locales/it.json`, add the same structure inside `"editor"`:

```json
"transform": {
  "toKanban": "Trasforma in Kanban Board",
  "toTaskList": "Trasforma in Task List",
  "selectBoard": "Seleziona una board",
  "newBoard": "Nuova board",
  "existingBoard": "Board esistente",
  "selectColumn": "Seleziona una colonna",
  "selectList": "Seleziona una task list",
  "newList": "Nuova lista",
  "existingList": "Lista esistente",
  "itemsSelected": "{{count}} elementi selezionati",
  "preview": "Anteprima",
  "confirm": "Trasforma",
  "removeFromNote": "Rimuovere i punti dalla nota?",
  "keepItems": "No, mantieni",
  "removeItems": "Si, rimuovi",
  "kanbanSuccess": "{{count}} card create in {{board}}",
  "taskListSuccess": "{{count}} elementi aggiunti a {{list}}",
  "boardTitle": "Titolo board",
  "listTitle": "Titolo lista"
}
```

---

## Task 2: extractListItems Utility + EditorContextMenu Transform Options

**Files:**
- Modify: `frontend/src/components/editor/EditorContextMenu.tsx`

**Context:** The EditorContextMenu currently has Cut/Copy/Paste/PasteAsPlainText. We add two new menu items ("Transform to Kanban Board" and "Transform to Task List") that appear ONLY when list items are selected. The component already receives `editor: Editor` as a prop.

### Step 1: Add extractListItems utility function

Add this function at the top of `EditorContextMenu.tsx`, before the component:

```typescript
interface ListItemInfo {
  text: string;
  from: number;
  to: number;
}

/**
 * Walk the current selection and extract list item texts with positions.
 * Supports bulletList/orderedList listItem and taskItem nodes.
 */
function extractListItems(editor: Editor): ListItemInfo[] {
  const { state } = editor;
  const { from, to } = state.selection;
  const items: ListItemInfo[] = [];

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'listItem' || node.type.name === 'taskItem') {
      items.push({
        text: node.textContent.trim(),
        from: pos,
        to: pos + node.nodeSize,
      });
      return false; // Don't descend into the listItem children
    }
    return true;
  });

  // Filter out empty items
  return items.filter(item => item.text.length > 0);
}
```

### Step 2: Add state, imports, and transform menu items

Update imports at the top of the file:

```typescript
import { Editor } from '@tiptap/react';
import { createPortal } from 'react-dom';
import { Scissors, Copy, ClipboardPaste, ClipboardType, LayoutDashboard, ListChecks } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useLayoutEffect, useState, useMemo } from 'react';
```

Add a `onTransformToKanban` and `onTransformToTaskList` callback props to the interface:

```typescript
interface EditorContextMenuProps {
  editor: Editor;
  position: { x: number; y: number };
  onClose: () => void;
  onTransformToKanban?: (items: ListItemInfo[]) => void;
  onTransformToTaskList?: (items: ListItemInfo[]) => void;
}
```

Update the component signature and add the list items computation:

```typescript
export default function EditorContextMenu({ editor, position, onClose, onTransformToKanban, onTransformToTaskList }: EditorContextMenuProps) {
```

Inside the component, compute the list items:

```typescript
const listItems = useMemo(() => extractListItems(editor), [editor, position]);
```

Note: `position` is in the dependency array because the context menu re-opens on each right-click, and we want to re-compute list items each time.

### Step 3: Add transform menu items to the JSX

After the PasteAsPlainText button and before the closing `</div>`, add:

```tsx
{listItems.length > 0 && (
  <>
    <div className={separatorClass} />
    <div className="px-3 py-1">
      <span className="text-xs text-gray-400 dark:text-gray-500">
        {t('editor.transform.itemsSelected', { count: listItems.length })}
      </span>
    </div>
    <button
      className={menuItemClass}
      onClick={() => {
        onTransformToKanban?.(listItems);
        onClose();
      }}
    >
      <span className="flex items-center gap-3">
        <LayoutDashboard size={16} className="text-gray-500 dark:text-gray-400 flex-shrink-0" />
        <span>{t('editor.transform.toKanban')}</span>
      </span>
    </button>
    <button
      className={menuItemClass}
      onClick={() => {
        onTransformToTaskList?.(listItems);
        onClose();
      }}
    >
      <span className="flex items-center gap-3">
        <ListChecks size={16} className="text-gray-500 dark:text-gray-400 flex-shrink-0" />
        <span>{t('editor.transform.toTaskList')}</span>
      </span>
    </button>
  </>
)}
```

### Step 4: Export the ListItemInfo type

Add `export` to the interface so modals can import it:

```typescript
export interface ListItemInfo {
  text: string;
  from: number;
  to: number;
}
```

---

## Task 3: TransformToKanbanModal

**Files:**
- Create: `frontend/src/components/editor/TransformToKanbanModal.tsx`
- Modify: `frontend/src/components/editor/Editor.tsx` (TIER 2 — add state + render modal + pass callbacks to EditorContextMenu)

**Context:** This is a multi-step wizard modal:
- Step 1: Choose existing board OR create new (title input)
- Step 2: Choose column from selected board
- Step 3: Confirm — creates cards, shows toast, asks whether to remove items from note

### Step 1: Create TransformToKanbanModal.tsx

```typescript
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LayoutDashboard, Plus, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import Modal from '../ui/Modal';
import { useKanbanBoards } from '../../features/kanban/hooks/useKanbanBoards';
import { useKanbanBoard } from '../../features/kanban/hooks/useKanbanBoard';
import { useKanbanMutations } from '../../features/kanban/hooks/useKanbanMutations';
import type { ListItemInfo } from './EditorContextMenu';
import type { Editor } from '@tiptap/react';

interface TransformToKanbanModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: ListItemInfo[];
  editor: Editor;
}

type Step = 'board' | 'column' | 'confirm-remove';

export default function TransformToKanbanModal({ isOpen, onClose, items, editor }: TransformToKanbanModalProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('board');
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [selectedBoardId, setSelectedBoardId] = useState<string>('');
  const [newBoardTitle, setNewBoardTitle] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const { data: boards, isLoading: boardsLoading } = useKanbanBoards();
  const { data: boardDetail } = useKanbanBoard(selectedBoardId || undefined);
  const { createBoard, createCard } = useKanbanMutations(selectedBoardId || undefined);

  function handleClose() {
    setStep('board');
    setMode('existing');
    setSelectedBoardId('');
    setNewBoardTitle('');
    setIsCreating(false);
    onClose();
  }

  async function handleSelectColumn(columnId: string) {
    setIsCreating(true);
    try {
      let boardId = selectedBoardId;
      let boardTitle = boardDetail?.title || newBoardTitle;

      // If new board, create it first
      if (mode === 'new') {
        const board = await createBoard.mutateAsync({ title: newBoardTitle });
        boardId = board.id;
        boardTitle = board.title;
        // For a new board, the columns are the default ones; we need to fetch them
        // The createBoard returns the board with columns
        const cols = board.columns || [];
        const col = cols.find(c => c.id === columnId) || cols[0];
        if (col) {
          columnId = col.id;
        }
      }

      // Create cards in the selected column
      for (const item of items) {
        await createCard.mutateAsync({ columnId, title: item.text });
      }

      toast.success(t('editor.transform.kanbanSuccess', { count: items.length, board: boardTitle }));
      setStep('confirm-remove');
    } catch {
      toast.error(t('common.somethingWentWrong'));
    } finally {
      setIsCreating(false);
    }
  }

  async function handleNewBoardConfirm() {
    if (!newBoardTitle.trim()) return;
    setIsCreating(true);
    try {
      const board = await createBoard.mutateAsync({ title: newBoardTitle.trim() });
      setSelectedBoardId(board.id);
      // New board has default columns (TODO, IN_PROGRESS, DONE)
      // Go to column selection
      setMode('existing'); // Switch back so column step uses the board detail
      setStep('column');
    } catch {
      toast.error(t('common.somethingWentWrong'));
    } finally {
      setIsCreating(false);
    }
  }

  function handleRemoveItems() {
    // Delete in reverse order to preserve positions
    const sorted = [...items].sort((a, b) => b.from - a.from);
    const chain = editor.chain();
    for (const item of sorted) {
      chain.deleteRange({ from: item.from, to: item.to });
    }
    chain.run();
    handleClose();
  }

  function handleKeepItems() {
    handleClose();
  }

  const title = step === 'board'
    ? t('editor.transform.toKanban')
    : step === 'column'
    ? t('editor.transform.selectColumn')
    : t('editor.transform.removeFromNote');

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={title} size="md">
      {/* Items preview */}
      {step !== 'confirm-remove' && (
        <div className="mb-4 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg max-h-32 overflow-y-auto">
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            {t('editor.transform.itemsSelected', { count: items.length })}
          </p>
          <ul className="space-y-1">
            {items.map((item, i) => (
              <li key={i} className="text-sm text-gray-700 dark:text-gray-300 truncate">
                • {item.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Step: Board Selection */}
      {step === 'board' && (
        <div className="space-y-3">
          {/* Toggle: Existing / New */}
          <div className="flex gap-2">
            <button
              onClick={() => setMode('existing')}
              className={`flex-1 py-2 px-3 text-sm rounded-lg border transition-colors ${
                mode === 'existing'
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              {t('editor.transform.existingBoard')}
            </button>
            <button
              onClick={() => setMode('new')}
              className={`flex-1 py-2 px-3 text-sm rounded-lg border transition-colors ${
                mode === 'new'
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              <span className="flex items-center justify-center gap-1">
                <Plus size={14} />
                {t('editor.transform.newBoard')}
              </span>
            </button>
          </div>

          {mode === 'existing' ? (
            <div className="space-y-2">
              {boardsLoading ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</p>
              ) : boards && boards.length > 0 ? (
                boards.map(board => (
                  <button
                    key={board.id}
                    onClick={() => {
                      setSelectedBoardId(board.id);
                      setStep('column');
                    }}
                    className="w-full flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors text-left"
                  >
                    <span className="flex items-center gap-2">
                      <LayoutDashboard size={16} className="text-gray-400" />
                      <span className="text-sm text-gray-900 dark:text-white">{board.title}</span>
                    </span>
                    <ChevronRight size={16} className="text-gray-400" />
                  </button>
                ))
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
                  {t('common.noResults', { query: '' })}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <input
                type="text"
                value={newBoardTitle}
                onChange={e => setNewBoardTitle(e.target.value)}
                placeholder={t('editor.transform.boardTitle')}
                className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter') handleNewBoardConfirm();
                }}
              />
              <button
                onClick={handleNewBoardConfirm}
                disabled={!newBoardTitle.trim() || isCreating}
                className="w-full py-2 px-4 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                {isCreating ? t('common.loading') : t('editor.transform.confirm')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Step: Column Selection */}
      {step === 'column' && (
        <div className="space-y-2">
          {boardDetail?.columns.map(col => (
            <button
              key={col.id}
              onClick={() => handleSelectColumn(col.id)}
              disabled={isCreating}
              className="w-full flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors text-left disabled:opacity-50"
            >
              <span className="text-sm text-gray-900 dark:text-white">
                {t(`kanban.column.${col.title === 'TODO' ? 'todo' : col.title === 'IN_PROGRESS' ? 'inProgress' : col.title === 'DONE' ? 'done' : 'custom'}`, { defaultValue: col.title })}
              </span>
              <span className="text-xs text-gray-400">{col.cards.length} cards</span>
            </button>
          ))}
          <button
            onClick={() => setStep('board')}
            className="w-full py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          >
            {t('common.back')}
          </button>
        </div>
      )}

      {/* Step: Confirm Remove */}
      {step === 'confirm-remove' && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t('editor.transform.removeFromNote')}
          </p>
          <div className="flex gap-3">
            <button
              onClick={handleKeepItems}
              className="flex-1 py-2 px-4 text-sm border border-gray-200 dark:border-gray-700 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              {t('editor.transform.keepItems')}
            </button>
            <button
              onClick={handleRemoveItems}
              className="flex-1 py-2 px-4 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
            >
              {t('editor.transform.removeItems')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
```

### Step 2: Wire up in Editor.tsx (TIER 2 — minimal change)

In `frontend/src/components/editor/Editor.tsx`:

1. Add import at the top:
```typescript
import TransformToKanbanModal from './TransformToKanbanModal';
import TransformToTaskListModal from './TransformToTaskListModal';
import type { ListItemInfo } from './EditorContextMenu';
```

2. Add state for transform modals (near the existing context menu state):
```typescript
const [kanbanTransformItems, setKanbanTransformItems] = useState<ListItemInfo[] | null>(null);
const [taskListTransformItems, setTaskListTransformItems] = useState<ListItemInfo[] | null>(null);
```

3. Pass callbacks to both EditorContextMenu instances:
```tsx
<EditorContextMenu
  editor={editor}
  position={editorContextMenu}
  onClose={() => setEditorContextMenu(null)}
  onTransformToKanban={(items) => setKanbanTransformItems(items)}
  onTransformToTaskList={(items) => setTaskListTransformItems(items)}
/>
```

4. Render modals at the end of the component, inside the outermost div:
```tsx
{editor && kanbanTransformItems && (
  <TransformToKanbanModal
    isOpen={true}
    onClose={() => setKanbanTransformItems(null)}
    items={kanbanTransformItems}
    editor={editor}
  />
)}
{editor && taskListTransformItems && (
  <TransformToTaskListModal
    isOpen={true}
    onClose={() => setTaskListTransformItems(null)}
    items={taskListTransformItems}
    editor={editor}
  />
)}
```

---

## Task 4: TransformToTaskListModal

**Files:**
- Create: `frontend/src/components/editor/TransformToTaskListModal.tsx`

**Context:** This is a 2-step wizard modal:
- Step 1: Choose existing task list OR create new (title input)
- Step 2: Confirm — adds items at the end with MEDIUM priority, shows toast, asks whether to remove from note

Task lists are Dexie-based (offline-first). Use `createTaskList(title)` and `addTaskItem(listId, text, 'MEDIUM')` from `taskListService.ts`. Use `useTaskLists()` hook for listing.

### Step 1: Create TransformToTaskListModal.tsx

```typescript
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListChecks, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import Modal from '../ui/Modal';
import { useTaskLists } from '../../hooks/useTaskLists';
import { createTaskList, addTaskItem } from '../../features/tasks/taskListService';
import type { ListItemInfo } from './EditorContextMenu';
import type { Editor } from '@tiptap/react';

interface TransformToTaskListModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: ListItemInfo[];
  editor: Editor;
}

type Step = 'list' | 'confirm-remove';

export default function TransformToTaskListModal({ isOpen, onClose, items, editor }: TransformToTaskListModalProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('list');
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [newListTitle, setNewListTitle] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const taskLists = useTaskLists();

  function handleClose() {
    setStep('list');
    setMode('existing');
    setNewListTitle('');
    setIsCreating(false);
    onClose();
  }

  async function handleSelectList(listId: string, listTitle: string) {
    setIsCreating(true);
    try {
      for (const item of items) {
        await addTaskItem(listId, item.text, 'MEDIUM');
      }
      toast.success(t('editor.transform.taskListSuccess', { count: items.length, list: listTitle }));
      setStep('confirm-remove');
    } catch {
      toast.error(t('common.somethingWentWrong'));
    } finally {
      setIsCreating(false);
    }
  }

  async function handleNewListConfirm() {
    if (!newListTitle.trim()) return;
    setIsCreating(true);
    try {
      const list = await createTaskList(newListTitle.trim());
      for (const item of items) {
        await addTaskItem(list.id, item.text, 'MEDIUM');
      }
      toast.success(t('editor.transform.taskListSuccess', { count: items.length, list: newListTitle.trim() }));
      setStep('confirm-remove');
    } catch {
      toast.error(t('common.somethingWentWrong'));
    } finally {
      setIsCreating(false);
    }
  }

  function handleRemoveItems() {
    const sorted = [...items].sort((a, b) => b.from - a.from);
    const chain = editor.chain();
    for (const item of sorted) {
      chain.deleteRange({ from: item.from, to: item.to });
    }
    chain.run();
    handleClose();
  }

  function handleKeepItems() {
    handleClose();
  }

  const title = step === 'list'
    ? t('editor.transform.toTaskList')
    : t('editor.transform.removeFromNote');

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={title} size="md">
      {/* Items preview */}
      {step !== 'confirm-remove' && (
        <div className="mb-4 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg max-h-32 overflow-y-auto">
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            {t('editor.transform.itemsSelected', { count: items.length })}
          </p>
          <ul className="space-y-1">
            {items.map((item, i) => (
              <li key={i} className="text-sm text-gray-700 dark:text-gray-300 truncate">
                • {item.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Step: List Selection */}
      {step === 'list' && (
        <div className="space-y-3">
          {/* Toggle: Existing / New */}
          <div className="flex gap-2">
            <button
              onClick={() => setMode('existing')}
              className={`flex-1 py-2 px-3 text-sm rounded-lg border transition-colors ${
                mode === 'existing'
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              {t('editor.transform.existingList')}
            </button>
            <button
              onClick={() => setMode('new')}
              className={`flex-1 py-2 px-3 text-sm rounded-lg border transition-colors ${
                mode === 'new'
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              <span className="flex items-center justify-center gap-1">
                <Plus size={14} />
                {t('editor.transform.newList')}
              </span>
            </button>
          </div>

          {mode === 'existing' ? (
            <div className="space-y-2">
              {!taskLists ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</p>
              ) : taskLists.length > 0 ? (
                taskLists.map(list => (
                  <button
                    key={list.id}
                    onClick={() => handleSelectList(list.id, list.title)}
                    disabled={isCreating}
                    className="w-full flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors text-left disabled:opacity-50"
                  >
                    <span className="flex items-center gap-2">
                      <ListChecks size={16} className="text-gray-400" />
                      <span className="text-sm text-gray-900 dark:text-white">{list.title}</span>
                    </span>
                    <span className="text-xs text-gray-400">{list.items.length} items</span>
                  </button>
                ))
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
                  {t('common.noResults', { query: '' })}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <input
                type="text"
                value={newListTitle}
                onChange={e => setNewListTitle(e.target.value)}
                placeholder={t('editor.transform.listTitle')}
                className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter') handleNewListConfirm();
                }}
              />
              <button
                onClick={handleNewListConfirm}
                disabled={!newListTitle.trim() || isCreating}
                className="w-full py-2 px-4 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                {isCreating ? t('common.loading') : t('editor.transform.confirm')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Step: Confirm Remove */}
      {step === 'confirm-remove' && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t('editor.transform.removeFromNote')}
          </p>
          <div className="flex gap-3">
            <button
              onClick={handleKeepItems}
              className="flex-1 py-2 px-4 text-sm border border-gray-200 dark:border-gray-700 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              {t('editor.transform.keepItems')}
            </button>
            <button
              onClick={handleRemoveItems}
              className="flex-1 py-2 px-4 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
            >
              {t('editor.transform.removeItems')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
```

---

## Task 5: TypeScript Verification & Final Review

**Step 1: Run TypeScript check**

```bash
cd frontend && npx tsc --noEmit
```

Expected: 0 errors

**Step 2: Visual review checklist**

- [ ] EditorContextMenu shows "Transform to..." items only when list items are selected
- [ ] Items preview shows correct list items with count
- [ ] Kanban modal: board selection → column selection → cards created → remove dialog
- [ ] Task list modal: list selection → items added → remove dialog
- [ ] New board/list creation flows work
- [ ] "Remove from note" correctly deletes the selected list items
- [ ] "Keep items" leaves the note unchanged
- [ ] Toast messages show correct counts and names
- [ ] Dark mode styling is consistent
- [ ] i18n works for both EN and IT
