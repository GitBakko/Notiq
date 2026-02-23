# Transform Selection to Kanban/Task List — Design Document

**Date:** 2026-02-23
**Status:** Approved

## Goal

Allow users to select list items in the TipTap note editor, right-click, and transform them into Kanban board cards or Task List items via a guided wizard modal.

## Scope

- **Trigger:** Right-click context menu on selected list items (bulletList, orderedList, taskItem)
- **Targets:** Kanban boards (existing or new) and Task Lists (existing or new)
- **Post-transform:** User is asked whether to remove the original list items from the note
- **Backend:** None required — uses existing Kanban and Task List APIs/services

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Selection scope | List items only | More predictable than arbitrary text; each list item maps cleanly to a card/task item |
| Post-transform behavior | Ask user | "Remove from note?" dialog avoids accidental data loss while keeping flow smooth |
| New Kanban board | Title only + default columns | Quick-create with To Do / In Progress / Done columns; user customizes after |
| Architecture | Extend EditorContextMenu | Natural UX (right-click), minimal new patterns, reuses existing menu system |

## User Flow

### Flow A: Transform to Kanban Board

1. User selects list items in editor
2. Right-click → "Transform to Kanban Board" appears in context menu
3. **Step 1 — Choose board:** Pick existing board from dropdown OR enter title for new board
4. **Step 2 — Choose column:** Select which column to insert the cards into (shows column list from selected board)
5. **Confirm:** Cards are created in the selected column. Toast: "N cards created in Board Title"
6. **Remove from note?** Dialog: "Remove items from note?" → Yes removes list items, No keeps them

### Flow B: Transform to Task List

1. User selects list items in editor
2. Right-click → "Transform to Task List" appears in context menu
3. **Step 1 — Choose list:** Pick existing task list from dropdown OR enter title for new list
4. **Confirm:** Items are added at the end of the selected list (priority: MEDIUM). Toast: "N items added to List Title"
5. **Remove from note?** Dialog: same as Kanban flow

## Architecture

### Files

| # | File | Type | Description |
|---|------|------|-------------|
| 1 | `frontend/src/components/editor/EditorContextMenu.tsx` | MOD | Add transform menu items + extractListItems logic |
| 2 | `frontend/src/components/editor/TransformToKanbanModal.tsx` | NEW | Multi-step wizard: choose board → choose column → confirm |
| 3 | `frontend/src/components/editor/TransformToTaskListModal.tsx` | NEW | Wizard: choose list → confirm |
| 4 | `frontend/src/components/editor/Editor.tsx` | MOD (TIER 2) | Pass editor instance to EditorContextMenu |
| 5 | `frontend/src/locales/en.json` | MOD | i18n keys under `editor.transform.*` |
| 6 | `frontend/src/locales/it.json` | MOD | i18n keys under `editor.transform.*` |

### Data Flow

```
EditorContextMenu
  → extractListItems(editor) → { text: string, from: number, to: number }[]
  → onClick "Transform to Kanban" → TransformToKanbanModal(items, editor)
  → onClick "Transform to Task List" → TransformToTaskListModal(items, editor)

TransformToKanbanModal
  Step 1: useKanbanBoards() → board selection (or createBoard via useKanbanMutations)
  Step 2: useKanbanBoard(id) → column selection
  Confirm: createCard(columnId, { title }) × N → toast → ask remove → editor deleteRange

TransformToTaskListModal
  Step 1: useTaskLists() (Dexie) → list selection (or createTaskList)
  Confirm: addTaskItem(listId, text) × N → toast → ask remove → editor deleteRange
```

### extractListItems(editor)

Utility function that walks nodes in the current selection range:
- Identifies `listItem`, `taskItem` nodes
- Returns array of `{ text: string, from: number, to: number }`
- `from`/`to` positions are used for deletion (in reverse order to preserve positions)

### Deletion Logic

When user confirms removal, delete list items from editor in reverse position order:
```typescript
// Reverse to maintain valid positions
const sorted = [...items].sort((a, b) => b.from - a.from);
for (const item of sorted) {
  editor.chain().deleteRange({ from: item.from, to: item.to }).run();
}
```

### Context Menu Visibility

The "Transform to..." menu items are ONLY shown when `extractListItems(editor).length > 0`. This is checked when the context menu opens, using the current editor selection state.

## i18n Keys

```
editor.transform.toKanban: "Transform to Kanban Board" / "Trasforma in Kanban Board"
editor.transform.toTaskList: "Transform to Task List" / "Trasforma in Task List"
editor.transform.selectBoard: "Select a board" / "Seleziona una board"
editor.transform.newBoard: "New board" / "Nuova board"
editor.transform.existingBoard: "Existing board" / "Board esistente"
editor.transform.selectColumn: "Select a column" / "Seleziona una colonna"
editor.transform.selectList: "Select a task list" / "Seleziona una task list"
editor.transform.newList: "New list" / "Nuova lista"
editor.transform.existingList: "Existing list" / "Lista esistente"
editor.transform.itemsSelected: "{{count}} items selected" / "{{count}} elementi selezionati"
editor.transform.preview: "Preview" / "Anteprima"
editor.transform.confirm: "Transform" / "Trasforma"
editor.transform.removeFromNote: "Remove items from note?" / "Rimuovere i punti dalla nota?"
editor.transform.keepItems: "No, keep them" / "No, mantieni"
editor.transform.removeItems: "Yes, remove" / "Si, rimuovi"
editor.transform.kanbanSuccess: "{{count}} cards created in {{board}}" / "{{count}} card create in {{board}}"
editor.transform.taskListSuccess: "{{count}} items added to {{list}}" / "{{count}} elementi aggiunti a {{list}}"
editor.transform.boardTitle: "Board title" / "Titolo board"
editor.transform.listTitle: "List title" / "Titolo lista"
```
