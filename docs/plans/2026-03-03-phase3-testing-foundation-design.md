# Phase 3: Testing Foundation — Design Document

**Date:** 2026-03-03
**Scope:** Backend unit tests, frontend sync tests, E2E tests, test infrastructure
**Prerequisite:** Phase 2.6 (i18n error keys) complete

## Goal

Bring test coverage from ~27% to ~60% on backend services, add sync engine tests, create shared test infrastructure (factories + E2E helpers), add 3 new E2E specs, and enforce coverage thresholds.

## Current State

| Layer | Files | Lines | Coverage |
|-------|-------|-------|----------|
| Backend unit | 16 | ~4,200 | auth, notes, sharing, notifications, chat, notebooks, attachments, hocuspocus, extractText |
| Frontend unit | 5 | ~590 | authStore, vaultStore, crypto, format, noteService |
| E2E (Playwright) | 13 | ~980 | auth, notes, kanban, tasks, tags, sharing, search, tables, encryption, notebooks, profile |

**Major gaps:** Sync engine (0 tests), kanban services (0 tests), group service (0 tests), AI/import services (0 tests), E2E collaboration/groups/import (missing).

## Approach

**Bottom-up:** Infrastructure first (factories, helpers, coverage config), then backend unit tests service-by-service, then E2E tests last. Each block is independently committable.

## Design

### 1. Infrastructure

#### 1a. Backend factory helpers

**New file:** `backend/src/__tests__/factories.ts`

Builder functions with sensible defaults and optional overrides:

- `makeUser(overrides?)` — id, email, name, surname, role, color, tokenVersion, locale, createdAt
- `makeNote(overrides?)` — id, title, content (TipTap JSON), userId, notebookId, type, isPublic
- `makeNotebook(overrides?)` — id, name, userId
- `makeKanbanBoard(overrides?)` — id, title, description, userId, createdAt
- `makeKanbanColumn(overrides?)` — id, title, boardId, order
- `makeKanbanCard(overrides?)` — id, title, description, columnId, boardId, order, assigneeId, dueDate
- `makeKanbanComment(overrides?)` — id, content, cardId, userId
- `makeKanbanReminder(overrides?)` — id, cardId, userId, reminderAt
- `makeGroup(overrides?)` — id, name, ownerId
- `makeGroupMember(overrides?)` — id, groupId, userId
- `makeTaskList(overrides?)` — id, title, userId
- `makeTaskItem(overrides?)` — id, content, taskListId, isChecked, checkedById
- `makeSharedNote(overrides?)`, `makeSharedNotebook(overrides?)`, `makeSharedTaskList(overrides?)`, `makeSharedKanbanBoard(overrides?)`
- `makeAttachment(overrides?)` — id, filename, mimeType, noteId, userId
- `makeInvite(overrides?)` — id, code, creatorId, status

#### 1b. Backend setup.ts extension

Add Prisma mock models for: KanbanBoard, KanbanColumn, KanbanCard, KanbanComment, KanbanCardActivity, KanbanReminder, KanbanBoardChat, SharedKanbanBoard, Group, GroupMember, PendingGroupInvite, TaskList, TaskItem, SharedTaskList.

Each model gets: findUnique, findFirst, findMany, create, update, delete, count (all `vi.fn()`).

#### 1c. E2E helpers

**New file:** `frontend/e2e/helpers.ts`

- `registerAndLogin(page, options?)` — register UUID user, login, wait for /notes, return `{ email, password }`
- `createNote(page, title, content?)` — create note, wait for save
- `createNotebook(page, name)` — create notebook via sidebar
- `createBoard(page, title)` — create kanban board
- `createTaskList(page, title)` — create task list
- `waitForSave(page)` — wait for "Saved" indicator

#### 1d. Coverage thresholds

**Backend** (`vitest.config.ts`):
```
thresholds: { statements: 60, branches: 50, functions: 60, lines: 60 }
```

**Frontend** (`vitest.config.ts`):
```
thresholds: { statements: 40, branches: 30, functions: 40, lines: 40 }
```

Conservative starting thresholds, raiseable in future phases.

### 2. Backend Unit Tests — Kanban Services

5 new test files in `backend/src/services/kanban/__tests__/`:

| File | Service | Key Test Cases |
|------|---------|----------------|
| `board.service.test.ts` | board.service | create, update, delete (owner-only), getBoards, getBoard, updateAvatar |
| `card.service.test.ts` | card.service | create, update, delete, move (cross-column), archive/unarchive, assign/unassign, due date, activity logging |
| `column.service.test.ts` | column.service | create, update, delete (empty/with-cards error), reorder |
| `linking.service.test.ts` | linking.service | linkNote/unlinkNote (board+card level), linkTaskList/unlinkTaskList, only-linker-can-unlink, only-owner-can-link, already-linked errors |
| `comments-chat.service.test.ts` | comments-chat.service | addComment, deleteComment (not-your-comment guard), getComments, board chat CRUD |

**Estimated:** ~60 test cases

### 3. Backend Unit Tests — Group, Permissions, Reminders

3 new test files:

| File | Key Test Cases |
|------|----------------|
| `group.service.test.ts` | createGroup, updateGroup, deleteGroup, addMember, removeMember, getGroups, getGroupMembers, cannot-add-self, already-member, cannot-remove-owner |
| `kanbanPermissions.test.ts` | checkBoardAccess (direct-share, group-share, not-shared), checkBoardWriteAccess, requireBoardOwner |
| `kanbanReminder.service.test.ts` | createReminder, deleteReminder, getReminders |

**Estimated:** ~30 test cases

### 4. Frontend Unit Tests — Sync Engine

**New file:** `frontend/src/features/sync/__tests__/syncService.test.ts`

Mocks: `lib/db` (Dexie tables), `lib/api` (Axios), `store/authStore`

Test cases:
- **syncPull:** fetches from API, writes to Dexie, handles deletes, zombie prevention for all entity types (NOTE, KANBAN_BOARD, TASK_LIST, TASK_ITEM, KANBAN_COLUMN, KANBAN_CARD)
- **syncPush:** reads dirty items from Dexie SyncQueue, pushes to API, marks synced
- **Error recovery:** network failure during push, graceful degradation
- **Edge cases:** empty responses, concurrent sync guard

**Estimated:** ~15 test cases

### 5. Backend Unit Tests — Extra Services

5 new test files:

| File | Key Test Cases |
|------|----------------|
| `ai.service.test.ts` | isAiEnabled, streamAiResponse (mock LLM provider), getConversationHistory, clearConversation, encrypted note rejection |
| `import.service.test.ts` | importMarkdown, importEnex, format validation, size limit |
| `onenote-import.service.test.ts` | parseMhtml, importOnenoteArchive, invalid format |
| `tasklist-sharing.service.test.ts` | shareTaskList, acceptShare, declineShare, revokeShare, getShares, permission checks |
| `provider.factory.test.ts` | createProvider for openai/anthropic/ollama, unsupported provider error |

**Estimated:** ~35 test cases

### 6. New E2E Tests

3 new Playwright specs in `frontend/e2e/`:

| Spec | Scenario |
|------|----------|
| `collaboration.spec.ts` | 2 users: User A shares note with User B via email, User B accepts, both see the shared note. REST-based (no Yjs real-time). |
| `groups.spec.ts` | Create group, add member, share note to group, member sees note in Shared With Me. |
| `import.spec.ts` | Upload .md file via import, verify note created with correct title/content. |

Uses `registerAndLogin()` from helpers.ts. Collaboration spec registers 2 users in separate browser contexts.

**Estimated:** ~10 test cases

## Summary

| Area | New Files | Est. Test Cases |
|------|-----------|-----------------|
| Infrastructure | 2 (factories + e2e helpers) + 2 config edits | — |
| Kanban services | 5 | ~60 |
| Group + permissions + reminders | 3 | ~30 |
| Sync engine | 1 | ~15 |
| Extra services | 5 | ~35 |
| E2E | 3 | ~10 |
| **Total** | **19 new files** | **~150 test cases** |

## Verification

1. `cd backend && npm test` — all pass
2. `cd frontend && npm test` — all pass
3. `cd backend && npm run test:coverage` — meets 60/50/60/60 thresholds
4. `cd frontend && npm run test:coverage` — meets 40/30/40/40 thresholds
5. `cd frontend && npx playwright test collaboration.spec.ts groups.spec.ts import.spec.ts` — all pass
