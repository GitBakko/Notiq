# Phase 3: Testing Foundation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bring test coverage from ~27% to ~60% on backend services by adding ~150 test cases across 19 new files, with shared factory helpers, E2E helpers, and coverage thresholds.

**Architecture:** Bottom-up approach — infrastructure first (factories, setup extension, E2E helpers, coverage thresholds), then backend unit tests service-by-service, then frontend sync engine tests, then new E2E specs. Each task creates one file and is independently committable.

**Tech Stack:** Vitest 4.x (unit tests), Playwright 1.58 (E2E), @testing-library/react (frontend components), Dexie.js mocks (sync engine), Prisma mocks (backend services)

---

## Conventions

**Backend test pattern** (all service tests follow this):
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import prisma from '../../plugins/prisma';  // Auto-mocked by setup.ts

// Mock sibling services used by the service under test
vi.mock('../email.service', () => ({ sendSomeEmail: vi.fn() }));

// Import the service AFTER mocks are set up
import { functionToTest } from '../path/to/service';
import { makeUser, makeBoard } from '../../__tests__/factories';

describe('serviceName', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('functionToTest', () => {
    it('should do X when Y', async () => {
      const user = makeUser();
      vi.mocked(prisma.model.findUnique).mockResolvedValue(user);
      const result = await functionToTest(user.id);
      expect(result).toEqual(expect.objectContaining({ id: user.id }));
    });

    it('should throw NotFoundError when not found', async () => {
      vi.mocked(prisma.model.findUnique).mockResolvedValue(null);
      await expect(functionToTest('nonexistent')).rejects.toThrow('errors.model.notFound');
    });
  });
});
```

**Error assertions:** All backend services now throw typed errors with i18n keys (Phase 2.5 + 2.6). Tests assert on the i18n key string: `.rejects.toThrow('errors.domain.key')`.

**Factory pattern:** `makeEntity(overrides?)` returns a complete object with sensible defaults. Override any field: `makeUser({ role: 'SUPERADMIN' })`.

**Run commands:**
- Backend tests: `cd backend && npx vitest run`
- Backend single file: `cd backend && npx vitest run src/services/kanban/__tests__/board.service.test.ts`
- Frontend tests: `cd frontend && npx vitest run`
- Frontend single file: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts`
- E2E tests: `cd frontend && npx playwright test e2e/collaboration.spec.ts`
- Coverage: `cd backend && npx vitest run --coverage` / `cd frontend && npx vitest run --coverage`

---

### Task 1: Backend Factory Helpers

**Why:** Every subsequent backend test task depends on these factories. Must be done first.

**Files:**
- Create: `backend/src/__tests__/factories.ts`

**Step 1: Create factories.ts**

Create factory functions for all entity types. Each returns a complete object with defaults that can be overridden. Use `crypto.randomUUID()` for IDs, realistic dates, and sensible field values.

Required factories (map to Prisma model shapes):
- `makeUser(overrides?)` — id, email, name, surname, role: 'USER', color: '#10b981', tokenVersion: 0, locale: 'en', invitesAvailable: 3, avatarUrl: null, gender: null, dateOfBirth: null, placeOfBirth: null, mobile: null, emailVerified: true, createdAt, updatedAt, lastActiveAt
- `makeNote(overrides?)` — id, title: 'Test Note', content: '{}', userId, notebookId, type: 'NOTE', isTrashed: false, isPublic: false, isVault: false, isEncrypted: false, isPinned: false, createdAt, updatedAt
- `makeNotebook(overrides?)` — id, name: 'Test Notebook', userId, createdAt, updatedAt
- `makeTag(overrides?)` — id, name: 'test-tag', userId, isVault: false
- `makeKanbanBoard(overrides?)` — id, title: 'Test Board', description: null, coverImage: null, avatarUrl: null, userId, noteId: null, noteLinkedById: null, taskListId: null, taskListLinkedById: null, createdAt, updatedAt
- `makeKanbanColumn(overrides?)` — id, title: 'To Do', boardId, position: 0, isCompleted: false, createdAt, updatedAt
- `makeKanbanCard(overrides?)` — id, title: 'Test Card', description: null, columnId, boardId, position: 0, assigneeId: null, dueDate: null, priority: null, noteId: null, noteLinkedById: null, isArchived: false, archivedAt: null, createdAt, updatedAt
- `makeKanbanComment(overrides?)` — id, content: 'Test comment', cardId, authorId, createdAt
- `makeKanbanReminder(overrides?)` — id, cardId, userId, boardId, reminderAt: future date, isDone: false, createdAt
- `makeGroup(overrides?)` — id, name: 'Test Group', description: null, ownerId, avatarUrl: null, createdAt, updatedAt
- `makeGroupMember(overrides?)` — id, groupId, userId, createdAt
- `makeTaskList(overrides?)` — id, title: 'Test Task List', userId, isTrashed: false, createdAt, updatedAt
- `makeTaskItem(overrides?)` — id, text: 'Test item', taskListId, isChecked: false, checkedById: null, priority: 'MEDIUM', dueDate: null, position: 0, createdAt, updatedAt
- `makeSharedNote(overrides?)` — id, noteId, userId (target), sharedById (owner), permission: 'READ', status: 'PENDING', createdAt, updatedAt
- `makeSharedNotebook(overrides?)` — id, notebookId, userId, sharedById, permission: 'READ', status: 'PENDING', createdAt, updatedAt
- `makeSharedTaskList(overrides?)` — id, taskListId, userId, sharedById, permission: 'READ', status: 'PENDING', createdAt, updatedAt
- `makeSharedKanbanBoard(overrides?)` — id, boardId, userId, sharedById, permission: 'READ', status: 'PENDING', createdAt, updatedAt
- `makeAttachment(overrides?)` — id, filename: 'test.png', mimeType: 'image/png', url: '/uploads/test.png', size: 1024, noteId, userId, createdAt
- `makeInvitation(overrides?)` — id, code: randomUUID(), creatorId, usedById: null, status: 'PENDING', createdAt
- `makeKanbanCardActivity(overrides?)` — id, cardId, userId, action: 'CREATED', details: null, createdAt

**Step 2: Verify factories compile**

Run: `cd backend && npx tsc --noEmit`
Expected: 0 errors

**Step 3: Commit**

```bash
git add backend/src/__tests__/factories.ts
git commit -m "test: add shared factory helpers for backend tests"
```

---

### Task 2: Extend Backend setup.ts — Add Missing Prisma Model Mocks

**Why:** Existing setup.ts only mocks 16 models. Kanban, Group, TaskList models are missing. Tests importing these services will fail without mocks.

**Files:**
- Modify: `backend/src/__tests__/setup.ts`

**Step 1: Add missing model mocks to the mockPrisma object**

Add these models to the existing `vi.mock('../plugins/prisma', ...)` call, each with standard CRUD methods (`findUnique, findFirst, findMany, create, update, delete, count` — all `vi.fn()`):

- `kanbanBoard` — add also: `updateMany`
- `kanbanColumn` — standard CRUD
- `kanbanCard` — add also: `updateMany`
- `kanbanComment` — standard CRUD
- `kanbanCardActivity` — `findMany, create`
- `kanbanReminder` — add also: `deleteMany, updateMany`
- `kanbanBoardChat` — `findMany, create, count`
- `sharedKanbanBoard` — add also: `deleteMany, upsert`
- `group` — standard CRUD
- `groupMember` — add also: `deleteMany`
- `pendingGroupInvite` — standard CRUD + `deleteMany`
- `taskList` — standard CRUD
- `taskItem` — add also: `updateMany, deleteMany, createMany`
- `sharedTaskList` — add also: `deleteMany, upsert`

**Step 2: Verify existing tests still pass**

Run: `cd backend && npx vitest run`
Expected: All existing tests pass (no regressions)

**Step 3: Commit**

```bash
git add backend/src/__tests__/setup.ts
git commit -m "test: extend Prisma mocks with kanban, group, tasklist models"
```

---

### Task 3: E2E Helpers

**Why:** Current E2E specs repeat registration/login boilerplate. Helpers reduce duplication for new and existing specs.

**Files:**
- Create: `frontend/e2e/helpers.ts`

**Step 1: Create helpers.ts**

```typescript
import { Page, expect } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';

export interface TestUser {
  name: string;
  email: string;
  password: string;
}

/**
 * Register a new user with a UUID-based email and navigate to /notes.
 * Returns the credentials for later use (e.g., sharing with a second user).
 */
export async function registerAndLogin(
  page: Page,
  options?: { name?: string; password?: string }
): Promise<TestUser> {
  const user: TestUser = {
    name: options?.name ?? 'Test User',
    email: `test-${uuidv4()}@example.com`,
    password: options?.password ?? 'password123',
  };

  await page.goto('/register');
  await page.fill('input[type="text"]', user.name);
  await page.fill('input[type="email"]', user.email);
  await page.fill('input[type="password"]', user.password);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/notes/, { timeout: 15000 });
  await expect(page.getByTestId('sidebar-item-notes')).toBeVisible({ timeout: 30000 });

  return user;
}

/**
 * Create a new note with the given title and optional content.
 * Assumes user is already on /notes with sidebar visible.
 */
export async function createNote(
  page: Page,
  title: string,
  content?: string
): Promise<void> {
  const newNoteBtn = page.getByRole('button', { name: 'New Note', exact: true });
  await expect(newNoteBtn).toBeVisible();
  await newNoteBtn.click();

  const titleInput = page.locator('input[placeholder="Note Title"]');
  await expect(titleInput).toBeVisible({ timeout: 10000 });
  await titleInput.fill(title);

  if (content) {
    const editor = page.locator('.ProseMirror');
    await expect(editor).toBeVisible();
    await editor.fill(content);
  }

  await waitForSave(page);
}

/**
 * Create a new notebook via the sidebar.
 */
export async function createNotebook(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New Notebook' }).click();
  const input = page.locator('input[placeholder]').last();
  await input.fill(name);
  await input.press('Enter');
  await expect(page.getByText(name)).toBeVisible({ timeout: 5000 });
}

/**
 * Create a new kanban board.
 */
export async function createBoard(page: Page, title: string): Promise<void> {
  await page.goto('/kanban');
  await page.getByRole('button', { name: 'New Board' }).click();
  await page.fill('input[placeholder="Board title"]', title);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText(title)).toBeVisible({ timeout: 5000 });
}

/**
 * Create a new task list.
 */
export async function createTaskList(page: Page, title: string): Promise<void> {
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'New List' }).click();
  await page.fill('input[placeholder]', title);
  await page.locator('input[placeholder]').press('Enter');
  await expect(page.getByText(title)).toBeVisible({ timeout: 5000 });
}

/**
 * Wait for the "Saved" indicator to appear after an edit.
 */
export async function waitForSave(page: Page): Promise<void> {
  await expect(page.getByText('Saved')).toBeVisible({ timeout: 10000 });
}
```

**Step 2: Verify helpers compile**

Run: `cd frontend && npx tsc --noEmit`
Expected: 0 errors (helpers use only Playwright types)

**Step 3: Commit**

```bash
git add frontend/e2e/helpers.ts
git commit -m "test: add shared E2E helpers (registerAndLogin, createNote, etc.)"
```

---

### Task 4: Coverage Thresholds

**Why:** Enforce minimum coverage so it doesn't regress. Conservative thresholds to start.

**Files:**
- Modify: `backend/vitest.config.ts`
- Modify: `frontend/vitest.config.ts`

**Step 1: Add thresholds to backend config**

In `backend/vitest.config.ts`, add `thresholds` inside the existing `coverage` block:

```typescript
coverage: {
  provider: 'v8',
  include: ['src/services/**', 'src/routes/**', 'src/utils/**'],
  thresholds: {
    statements: 60,
    branches: 50,
    functions: 60,
    lines: 60,
  },
},
```

**Step 2: Add thresholds to frontend config**

In `frontend/vitest.config.ts`, add `thresholds` inside the existing `coverage` block:

```typescript
coverage: {
  provider: 'v8',
  include: ['src/utils/**', 'src/store/**', 'src/features/**', 'src/hooks/**'],
  thresholds: {
    statements: 40,
    branches: 30,
    functions: 40,
    lines: 40,
  },
},
```

**Note:** Do NOT run coverage checks yet — thresholds will fail until enough tests are added. These will be verified in the final task.

**Step 3: Commit**

```bash
git add backend/vitest.config.ts frontend/vitest.config.ts
git commit -m "test: add coverage thresholds (backend 60%, frontend 40%)"
```

---

### Task 5: Kanban Board Service Tests

**Files:**
- Create: `backend/src/services/kanban/__tests__/board.service.test.ts`

**Dependencies:** Task 1 (factories), Task 2 (setup.ts extension)

**Mocks needed:**
- `vi.mock('../../kanbanPermissions')` — assertBoardAccess
- `vi.mock('../../notification.service')` — createNotification (for shared board events)
- `vi.mock('../../email.service')` — sendEmail

**Service functions to test:** `listBoards`, `createBoard`, `getBoard`, `updateBoard`, `deleteBoard`, `createBoardFromTaskList`

**Test cases (~12):**

| Function | Test Case | Setup | Assert |
|----------|-----------|-------|--------|
| `listBoards` | returns owned boards | `prisma.kanbanBoard.findMany` returns 2 boards | result.length === 2 |
| `listBoards` | includes shared boards | mock shared query | result includes shared boards |
| `createBoard` | creates with title + description | mock `prisma.kanbanBoard.create` | called with correct data, returns board |
| `createBoard` | creates default columns (To Do, In Progress, Done) | mock create + column creates | 3 columns created |
| `getBoard` | returns board with columns and cards | mock findUnique with includes | result has columns array |
| `getBoard` | throws NotFoundError when not found | `findUnique` returns null | rejects with `'errors.kanban.boardNotFound'` |
| `updateBoard` | updates title | mock update | called with `{ title: 'New Title' }` |
| `deleteBoard` | deletes board as owner | mock board with userId match | `prisma.kanbanBoard.delete` called |
| `deleteBoard` | throws ForbiddenError when not owner | mock board with different userId | rejects with `'errors.kanban.onlyOwnerCanDelete'` |
| `deleteBoard` | throws NotFoundError when not found | `findUnique` returns null | rejects with `'errors.kanban.boardNotFound'` |
| `createBoardFromTaskList` | converts task list to board | mock taskList with items | board created with cards matching items |
| `createBoardFromTaskList` | throws NotFoundError for missing task list | `findUnique` returns null | rejects |

**Step 1:** Create the test file with all cases.

**Step 2:** Run: `cd backend && npx vitest run src/services/kanban/__tests__/board.service.test.ts`
Expected: All pass

**Step 3:** Commit: `git commit -m "test: add kanban board service tests"`

---

### Task 6: Kanban Card Service Tests

**Files:**
- Create: `backend/src/services/kanban/__tests__/card.service.test.ts`

**Mocks needed:**
- `vi.mock('../../kanbanPermissions')` — getColumnWithAccess, getCardWithAccess
- `vi.mock('../../notification.service')`
- `vi.mock('../../kanbanReminder.service')` — createRemindersForCard, updateRemindersForCard, deleteRemindersForCard

**Service functions to test:** `createCard`, `updateCard`, `moveCard`, `deleteCard`, `getCardActivities`, `archiveCompletedCards`, `getArchivedCards`, `unarchiveCard`

**Test cases (~15):**

| Function | Test Case |
|----------|-----------|
| `createCard` | creates card in column with correct position |
| `createCard` | logs CREATED activity |
| `updateCard` | updates title and description |
| `updateCard` | assigns user and logs ASSIGNED activity |
| `updateCard` | unassigns user and logs UNASSIGNED activity |
| `updateCard` | sets due date and creates reminders |
| `updateCard` | removes due date and deletes reminders |
| `moveCard` | moves card to different column, updates positions |
| `moveCard` | logs MOVED activity with column names |
| `deleteCard` | deletes card and logs DELETED activity |
| `deleteCard` | throws NotFoundError when card missing |
| `getCardActivities` | returns paginated activities with user info |
| `archiveCompletedCards` | archives cards in completed column older than ARCHIVE_AFTER_DAYS |
| `getArchivedCards` | returns archived cards for board |
| `unarchiveCard` | unarchives card, throws if not archived |

**Step 1:** Create the test file.
**Step 2:** Run: `cd backend && npx vitest run src/services/kanban/__tests__/card.service.test.ts`
**Step 3:** Commit: `git commit -m "test: add kanban card service tests"`

---

### Task 7: Kanban Column Service Tests

**Files:**
- Create: `backend/src/services/kanban/__tests__/column.service.test.ts`

**Mocks needed:**
- `vi.mock('../../kanbanPermissions')` — assertBoardAccess

**Service functions to test:** `createColumn`, `updateColumn`, `reorderColumns`, `deleteColumn`

**Test cases (~8):**

| Function | Test Case |
|----------|-----------|
| `createColumn` | creates column with auto-incremented position |
| `createColumn` | sets correct boardId |
| `updateColumn` | updates title |
| `updateColumn` | toggles isCompleted |
| `reorderColumns` | reorders columns by position array |
| `deleteColumn` | deletes empty column |
| `deleteColumn` | throws BadRequestError when column has cards |
| `deleteColumn` | throws NotFoundError when column missing |

**Step 1:** Create the test file.
**Step 2:** Run: `cd backend && npx vitest run src/services/kanban/__tests__/column.service.test.ts`
**Step 3:** Commit: `git commit -m "test: add kanban column service tests"`

---

### Task 8: Kanban Linking Service Tests

**Files:**
- Create: `backend/src/services/kanban/__tests__/linking.service.test.ts`

**Mocks needed:**
- `vi.mock('../../kanbanPermissions')`
- `vi.mock('../../sharing.service')` — for auto-share on link
- `vi.mock('../../notification.service')`

**Service functions to test:** `linkNoteToCard`, `unlinkNoteFromCard`, `linkNoteToBoard`, `unlinkNoteFromBoard`, `linkTaskListToBoard`, `unlinkTaskListFromBoard`, `searchUserNotes`, `searchUserTaskLists`, `getLinkedBoardsForNote`, `checkNoteSharingForBoard`

**Test cases (~15):**

| Function | Test Case |
|----------|-----------|
| `linkNoteToCard` | links note and logs NOTE_LINKED activity |
| `linkNoteToCard` | throws ConflictError if card already linked |
| `linkNoteToCard` | throws ForbiddenError if user not note owner |
| `unlinkNoteFromCard` | unlinks note and logs NOTE_UNLINKED activity |
| `unlinkNoteFromCard` | throws ForbiddenError if user is not the linker |
| `unlinkNoteFromCard` | throws BadRequestError if card has no linked note |
| `linkNoteToBoard` | links note to board (board-level) |
| `linkNoteToBoard` | throws ConflictError if board already has linked note |
| `unlinkNoteFromBoard` | unlinks note from board |
| `unlinkNoteFromBoard` | throws ForbiddenError if user is not the linker |
| `linkTaskListToBoard` | links task list to board |
| `linkTaskListToBoard` | throws ConflictError if board already has linked task list |
| `unlinkTaskListFromBoard` | unlinks task list from board |
| `searchUserNotes` | returns matching notes for query |
| `searchUserTaskLists` | returns matching task lists for query |

**Step 1:** Create the test file.
**Step 2:** Run: `cd backend && npx vitest run src/services/kanban/__tests__/linking.service.test.ts`
**Step 3:** Commit: `git commit -m "test: add kanban linking service tests"`

---

### Task 9: Kanban Comments & Chat Service Tests

**Files:**
- Create: `backend/src/services/kanban/__tests__/comments-chat.service.test.ts`

**Mocks needed:**
- `vi.mock('../../notification.service')`
- `vi.mock('../../email.service')`

**Service functions to test:** `getComments`, `createComment`, `deleteComment`, `getBoardChat`, `createBoardChatMessage`

**Test cases (~10):**

| Function | Test Case |
|----------|-----------|
| `getComments` | returns paginated comments with author info |
| `getComments` | returns empty array for no comments |
| `createComment` | creates comment and returns it with author |
| `createComment` | sends notification to card assignee |
| `deleteComment` | deletes own comment |
| `deleteComment` | throws ForbiddenError for other user's comment |
| `deleteComment` | throws NotFoundError for missing comment |
| `getBoardChat` | returns paginated chat messages |
| `createBoardChatMessage` | creates chat message |
| `createBoardChatMessage` | sends notification to board participants |

**Step 1:** Create the test file.
**Step 2:** Run: `cd backend && npx vitest run src/services/kanban/__tests__/comments-chat.service.test.ts`
**Step 3:** Commit: `git commit -m "test: add kanban comments and chat service tests"`

---

### Task 10: Group Service Tests

**Files:**
- Create: `backend/src/services/__tests__/group.service.test.ts`

**Mocks needed:**
- `vi.mock('../email.service')`
- `vi.mock('../notification.service')`

**Service functions to test:** `createGroup`, `getMyGroups`, `getGroup`, `updateGroup`, `deleteGroup`, `addMember`, `removeMember`, `hasPendingGroupInvite`, `removePendingInvite`, `processPendingGroupInvites`

**Test cases (~16):**

| Function | Test Case |
|----------|-----------|
| `createGroup` | creates group with owner as first member |
| `createGroup` | returns group with member count |
| `getMyGroups` | returns groups where user is owner |
| `getMyGroups` | includes groups where user is member (not owner) |
| `getGroup` | returns group with members for owner |
| `getGroup` | returns group with members for member |
| `getGroup` | throws NotFoundError for non-member |
| `updateGroup` | updates name and description |
| `updateGroup` | throws ForbiddenError for non-owner |
| `deleteGroup` | deletes group as owner |
| `deleteGroup` | throws ForbiddenError for non-owner |
| `addMember` | adds member by email |
| `addMember` | throws BadRequestError for self-add |
| `addMember` | throws ConflictError if already a member |
| `removeMember` | removes member |
| `removeMember` | throws ForbiddenError when removing self as owner |

**Step 1:** Create the test file.
**Step 2:** Run: `cd backend && npx vitest run src/services/__tests__/group.service.test.ts`
**Step 3:** Commit: `git commit -m "test: add group service tests"`

---

### Task 11: Kanban Permissions Tests

**Files:**
- Create: `backend/src/services/__tests__/kanbanPermissions.test.ts`

**No sibling mocks needed** — this service only uses Prisma directly.

**Service functions to test:** `assertBoardAccess`, `getColumnWithAccess`, `getCardWithAccess`

**Test cases (~12):**

| Function | Test Case |
|----------|-----------|
| `assertBoardAccess` | allows owner (READ) |
| `assertBoardAccess` | allows owner (WRITE) |
| `assertBoardAccess` | allows direct share with READ permission |
| `assertBoardAccess` | allows direct share with WRITE permission |
| `assertBoardAccess` | allows group share with matching permission |
| `assertBoardAccess` | throws ForbiddenError for WRITE when user has READ-only share |
| `assertBoardAccess` | throws NotFoundError when board doesn't exist |
| `assertBoardAccess` | throws ForbiddenError when no access at all |
| `getColumnWithAccess` | returns boardId + isOwner for accessible column |
| `getColumnWithAccess` | throws NotFoundError for missing column |
| `getCardWithAccess` | returns boardId + columnId + isOwner for accessible card |
| `getCardWithAccess` | throws NotFoundError for missing card |

**Step 1:** Create the test file.
**Step 2:** Run: `cd backend && npx vitest run src/services/__tests__/kanbanPermissions.test.ts`
**Step 3:** Commit: `git commit -m "test: add kanban permissions tests"`

---

### Task 12: Kanban Reminder Service Tests

**Files:**
- Create: `backend/src/services/__tests__/kanbanReminder.service.test.ts`

**Mocks needed:**
- `vi.mock('../notification.service')`

**Service functions to test:** `createRemindersForCard`, `updateRemindersForCard`, `deleteRemindersForCard`, `deleteRemindersForUserOnBoard`, `createRemindersForNewBoardUser`, `getUserKanbanReminders`, `toggleReminderDone`

**Test cases (~10):**

| Function | Test Case |
|----------|-----------|
| `createRemindersForCard` | creates reminders for all board participants |
| `createRemindersForCard` | sets reminderAt to 24h before dueDate |
| `updateRemindersForCard` | updates reminderAt for all existing reminders |
| `deleteRemindersForCard` | deletes all reminders for card |
| `deleteRemindersForUserOnBoard` | deletes user's reminders on specific board |
| `createRemindersForNewBoardUser` | creates reminders for cards with due dates |
| `getUserKanbanReminders` | returns reminders with card/column/board info |
| `getUserKanbanReminders` | only returns user's own reminders |
| `toggleReminderDone` | marks reminder as done |
| `toggleReminderDone` | throws NotFoundError for missing reminder |

**Step 1:** Create the test file.
**Step 2:** Run: `cd backend && npx vitest run src/services/__tests__/kanbanReminder.service.test.ts`
**Step 3:** Commit: `git commit -m "test: add kanban reminder service tests"`

---

### Task 13: Sync Engine Tests — syncPull

**Files:**
- Create: `frontend/src/features/sync/__tests__/syncService.test.ts`

**This is the most complex test file.** The sync engine is frontend code (ESM, jsdom environment) that interacts with Dexie (IndexedDB), Axios (API), and Zustand (auth store).

**Mocks needed:**
```typescript
// Mock Dexie database
vi.mock('../../../lib/db', () => {
  const createTable = () => ({
    where: vi.fn().mockReturnThis(),
    equals: vi.fn().mockReturnThis(),
    notEqual: vi.fn().mockReturnThis(),
    and: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue([]),
    bulkPut: vi.fn().mockResolvedValue(undefined),
    bulkDelete: vi.fn().mockResolvedValue(undefined),
    bulkGet: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    filter: vi.fn().mockReturnThis(),
    count: vi.fn().mockResolvedValue(0),
    delete: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(1),
    orderBy: vi.fn().mockReturnThis(),
  });
  return {
    db: {
      notes: createTable(),
      notebooks: createTable(),
      tags: createTable(),
      taskLists: createTable(),
      taskItems: createTable(),
      kanbanBoards: createTable(),
      kanbanColumns: createTable(),
      kanbanCards: createTable(),
      syncQueue: createTable(),
      transaction: vi.fn((mode, tables, fn) => fn()),
    }
  };
});

// Mock API client
vi.mock('../../../lib/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  }
}));

// Mock auth store
vi.mock('../../../store/authStore', () => ({
  useAuthStore: {
    getState: vi.fn(() => ({ user: { id: 'user-1' } })),
  }
}));
```

**Test cases for syncPull (~10):**

| Test Case | What it verifies |
|-----------|-----------------|
| pulls notebooks from server and stores in Dexie | `api.get('/notebooks')` called, `db.notebooks.bulkPut` called with synced data |
| preserves dirty notebooks during pull | dirty notebooks (syncStatus !== 'synced') excluded from bulkPut |
| deletes synced notebooks missing from server | local synced notebooks not in server response get bulkDeleted |
| pulls notes and preserves local content | content field preserved from local Dexie when server doesn't return it |
| prevents zombie resurrection for deleted notes | notes with pending DELETE in syncQueue are filtered out |
| pulls shared notes with ownership='shared' | `/share/notes/accepted` data stored with ownership='shared' |
| pulls task lists with zombie prevention | pending TASK_LIST deletes in syncQueue are filtered |
| pulls task items with zombie prevention | pending TASK_ITEM deletes in syncQueue are filtered |
| pulls kanban boards with column and card sync | boards fetched, then each board's details fetched |
| prevents zombie resurrection for kanban columns and cards | pending KANBAN_COLUMN and KANBAN_CARD deletes filtered |

**Step 1:** Create the test file with syncPull tests.
**Step 2:** Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts`
**Step 3:** Do NOT commit yet — Task 14 adds syncPush tests to the same file.

---

### Task 14: Sync Engine Tests — syncPush

**Files:**
- Modify: `frontend/src/features/sync/__tests__/syncService.test.ts` (add syncPush describe block)

**Test cases for syncPush (~8):**

| Test Case | What it verifies |
|-----------|-----------------|
| pushes CREATE note to API | `api.post('/notes', data)` called for CREATE queue items |
| pushes UPDATE note to API | `api.put('/notes/:id', data)` called for UPDATE queue items |
| pushes DELETE note to API | `api.delete('/notes/:id')` called for DELETE queue items |
| skips shared notes (ownership='shared') | shared notes in queue are deleted from queue without API call |
| removes queue item after successful push | `db.syncQueue.delete(item.id)` called |
| handles 404/410 gracefully — removes from queue | on 404 error, item removed from queue (server-side delete) |
| guards against concurrent sync | second `syncPush()` call returns immediately if first is running |
| updates syncStatus to 'synced' after push | `db.notes.update(id, { syncStatus: 'synced' })` called when no pending items remain |

**Step 1:** Add syncPush test cases to the existing file.
**Step 2:** Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts`
**Step 3:** Commit:

```bash
git add frontend/src/features/sync/__tests__/syncService.test.ts
git commit -m "test: add sync engine tests (syncPull + syncPush)"
```

---

### Task 15: AI Service Tests

**Files:**
- Create: `backend/src/services/__tests__/ai.service.test.ts`

**Mocks needed:**
- `vi.mock('../llm/provider.factory')` — getLLMProvider
- `vi.mock('../settings.service')` — getStringSetting
- `vi.mock('../note.service')` — getNoteById or findUnique

**Service functions to test:** `isAiEnabled`, `streamAiResponse`, `getConversationHistory`, `clearConversation`

**Test cases (~8):**

| Function | Test Case |
|----------|-----------|
| `isAiEnabled` | returns true when API key is configured |
| `isAiEnabled` | returns false when no API key |
| `streamAiResponse` | calls LLM provider with correct system prompt for 'ask' operation |
| `streamAiResponse` | calls LLM provider with translate prompt including target language |
| `streamAiResponse` | throws BadRequestError for encrypted notes |
| `streamAiResponse` | stores conversation history after response |
| `getConversationHistory` | returns history for user+note pair |
| `clearConversation` | deletes all history for user+note pair |

**Step 1:** Create the test file.
**Step 2:** Run: `cd backend && npx vitest run src/services/__tests__/ai.service.test.ts`
**Step 3:** Commit: `git commit -m "test: add AI service tests"`

---

### Task 16: Import Service Tests

**Files:**
- Create: `backend/src/services/__tests__/import.service.test.ts`

**Mocks needed:**
- `vi.mock('../../plugins/prisma')` — already global
- `vi.mock('../attachment.service')` — for resource/attachment handling
- `vi.mock('fast-xml-parser')` — for ENEX XML parsing

**Service functions to test:** `importFromEnex`, `processEnexNote`, `formatEnexDate`

**Test cases (~8):**

| Function | Test Case |
|----------|-----------|
| `importFromEnex` | parses valid ENEX and creates notes |
| `importFromEnex` | throws BadRequestError for invalid XML |
| `importFromEnex` | throws BadRequestError when buffer exceeds MAX_IMPORT_SIZE |
| `importFromEnex` | assigns to target notebook when provided |
| `importFromEnex` | creates default notebook when no target |
| `processEnexNote` | converts ENEX note to Prisma note with tags |
| `processEnexNote` | handles notes with inline resources (images) |
| `formatEnexDate` | converts ENEX date format to JS Date |

**Step 1:** Create the test file.
**Step 2:** Run: `cd backend && npx vitest run src/services/__tests__/import.service.test.ts`
**Step 3:** Commit: `git commit -m "test: add ENEX import service tests"`

---

### Task 17: OneNote Import Service Tests

**Files:**
- Create: `backend/src/services/__tests__/onenote-import.service.test.ts`

**Mocks needed:**
- `vi.mock('../attachment.service')`

**Service functions to test:** `importFromOneNote`

**Test cases (~6):**

| Function | Test Case |
|----------|-----------|
| `importFromOneNote` | parses MHT file and creates notes |
| `importFromOneNote` | throws BadRequestError for invalid format |
| `importFromOneNote` | throws BadRequestError when exceeding MAX_IMPORT_SIZE (50MB) |
| `importFromOneNote` | handles ZIP archive with multiple HTML files |
| `importFromOneNote` | assigns to target notebook |
| `importFromOneNote` | converts HTML content to TipTap JSON |

**Step 1:** Create the test file.
**Step 2:** Run: `cd backend && npx vitest run src/services/__tests__/onenote-import.service.test.ts`
**Step 3:** Commit: `git commit -m "test: add OneNote import service tests"`

---

### Task 18: TaskList Sharing Service Tests

**Files:**
- Create: `backend/src/services/__tests__/tasklist-sharing.service.test.ts`

**Mocks needed:**
- `vi.mock('../email.service')`
- `vi.mock('../notification.service')`

**Service functions to test:** `shareTaskList`, `revokeTaskListShare`, `getSharedTaskLists`, `respondToTaskListShareById`

**Test cases (~10):**

| Function | Test Case |
|----------|-----------|
| `shareTaskList` | creates share with PENDING status |
| `shareTaskList` | sends email notification to target |
| `shareTaskList` | throws ForbiddenError when not owner |
| `shareTaskList` | throws BadRequestError for self-share |
| `shareTaskList` | throws NotFoundError when task list not found |
| `revokeTaskListShare` | deletes the share record |
| `revokeTaskListShare` | throws ForbiddenError when not owner |
| `getSharedTaskLists` | returns task lists shared with user (ACCEPTED) |
| `respondToTaskListShareById` | accepts share and updates status |
| `respondToTaskListShareById` | declines share and updates status |

**Step 1:** Create the test file.
**Step 2:** Run: `cd backend && npx vitest run src/services/__tests__/tasklist-sharing.service.test.ts`
**Step 3:** Commit: `git commit -m "test: add task list sharing service tests"`

---

### Task 19: LLM Provider Factory Tests

**Files:**
- Create: `backend/src/services/llm/__tests__/provider.factory.test.ts`

**Mocks needed:**
- `vi.mock('../../settings.service')` — getStringSetting (for AI_PROVIDER and API_KEY settings)

**Service functions to test:** `getLLMProvider`, `clearProviderCache`

**Test cases (~6):**

| Function | Test Case |
|----------|-----------|
| `getLLMProvider` | returns OpenAI provider when configured |
| `getLLMProvider` | returns Anthropic provider when configured |
| `getLLMProvider` | returns Ollama provider when configured |
| `getLLMProvider` | throws BadRequestError for unsupported provider |
| `getLLMProvider` | throws BadRequestError when API key not configured |
| `getLLMProvider` | caches provider and returns same instance on second call |
| `clearProviderCache` | clears cache so next call creates new provider |

**Step 1:** Create the test file.
**Step 2:** Run: `cd backend && npx vitest run src/services/llm/__tests__/provider.factory.test.ts`
**Step 3:** Commit: `git commit -m "test: add LLM provider factory tests"`

---

### Task 20: E2E — Collaboration Spec

**Files:**
- Create: `frontend/e2e/collaboration.spec.ts`

**Requires:** Task 3 (E2E helpers), running dev server (`npm run dev` in both frontend and backend)

**Pattern:** This test uses TWO browser contexts (two separate users). Playwright supports this via `browser.newContext()`.

**Test cases (~3):**

```typescript
import { test, expect, Browser } from '@playwright/test';
import { registerAndLogin, createNote, waitForSave } from './helpers';

test.describe('Collaboration', () => {
  test('User A shares a note with User B, who sees it in Shared With Me', async ({ browser }) => {
    // 1. Create two browser contexts (two independent sessions)
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    // 2. Register both users
    const userA = await registerAndLogin(pageA, { name: 'User A' });
    const userB = await registerAndLogin(pageB, { name: 'User B' });

    // 3. User A creates a note
    await createNote(pageA, 'Shared Note', 'Content from User A');

    // 4. User A opens share modal and shares with User B
    await pageA.click('button[title="Share"]');
    await pageA.fill('input[placeholder="Enter email address"]', userB.email);
    await pageA.locator('button').filter({ hasText: /share/i }).last().click();

    // Wait for share to appear
    await expect(pageA.getByText(userB.email)).toBeVisible({ timeout: 10000 });

    // 5. User B navigates to Shared With Me
    await pageB.goto('/shared');
    await expect(pageB.getByText('Shared Note')).toBeVisible({ timeout: 15000 });

    // Cleanup
    await contextA.close();
    await contextB.close();
  });

  test('Shared note shows correct permission level', async ({ browser }) => {
    // Similar setup, verify READ/WRITE badge visible
    // ...
  });
});
```

**Step 1:** Create the spec file using helpers.
**Step 2:** Run: `cd frontend && npx playwright test e2e/collaboration.spec.ts --headed` (headed to debug if needed)
**Step 3:** Commit: `git commit -m "test: add E2E collaboration spec"`

---

### Task 21: E2E — Groups Spec

**Files:**
- Create: `frontend/e2e/groups.spec.ts`

**Test cases (~4):**

| Test | Steps |
|------|-------|
| Create a group | Navigate to /groups → Create → verify visible |
| Add member to group | Create group → add member by email → verify member shows |
| Share note to group | Create group + note → share note to group → verify in share modal |
| Group member sees shared note | Two users: User A creates group, adds User B, shares note to group. User B sees note in Shared With Me |

**Step 1:** Create the spec file.
**Step 2:** Run: `cd frontend && npx playwright test e2e/groups.spec.ts --headed`
**Step 3:** Commit: `git commit -m "test: add E2E groups spec"`

---

### Task 22: E2E — Import Spec

**Files:**
- Create: `frontend/e2e/import.spec.ts`

**Test cases (~3):**

| Test | Steps |
|------|-------|
| Import markdown file | Register → navigate to import → upload .md file → verify note created |
| Import shows error for unsupported format | Upload .exe file → verify error message |
| Imported note has correct content | Upload .md with known content → open note → verify content in editor |

**Note:** Playwright supports file uploads via `page.setInputFiles()`. Create a small .md test fixture inline or via a temp file.

```typescript
import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers';
import path from 'path';
import fs from 'fs';
import os from 'os';

test.describe('Import', () => {
  test('should import a markdown file as a note', async ({ page }) => {
    await registerAndLogin(page);

    // Create temp .md file
    const tmpDir = os.tmpdir();
    const mdPath = path.join(tmpDir, 'test-import.md');
    fs.writeFileSync(mdPath, '# Test Import\n\nThis is imported content.');

    // Navigate to import (via sidebar or direct URL)
    await page.goto('/import');

    // Upload file
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(mdPath);

    // Trigger import
    await page.getByRole('button', { name: /import/i }).click();

    // Verify success
    await expect(page.getByText(/imported successfully/i)).toBeVisible({ timeout: 10000 });

    // Cleanup
    fs.unlinkSync(mdPath);
  });
});
```

**Step 1:** Create the spec file.
**Step 2:** Run: `cd frontend && npx playwright test e2e/import.spec.ts --headed`
**Step 3:** Commit: `git commit -m "test: add E2E import spec"`

---

### Task 23: Final Verification — Full Test Suite + Coverage

**Why:** Verify everything works together and coverage thresholds are met.

**Step 1: Run full backend test suite**

Run: `cd backend && npx vitest run`
Expected: All tests pass (16 existing + ~95 new ≈ 111 test files worth of cases)

**Step 2: Run backend coverage**

Run: `cd backend && npx vitest run --coverage`
Expected: Meets thresholds — statements ≥ 60%, branches ≥ 50%, functions ≥ 60%, lines ≥ 60%

If thresholds fail, identify which services are under-covered and add targeted tests.

**Step 3: Run full frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: All tests pass (5 existing + sync engine ≈ 6 test files)

**Step 4: Run frontend coverage**

Run: `cd frontend && npx vitest run --coverage`
Expected: Meets thresholds — statements ≥ 40%, branches ≥ 30%, functions ≥ 40%, lines ≥ 40%

If thresholds fail, the sync engine tests should provide enough coverage for features/. If utils/ or store/ thresholds fail, add targeted tests for uncovered utilities.

**Step 5: Run all E2E tests**

Run: `cd frontend && npx playwright test`
Expected: All 16 specs pass (13 existing + 3 new)

**Step 6: Adjust thresholds if needed**

If actual coverage is significantly higher than thresholds, increase them to prevent regression:
- If backend is at 75%, raise to 70%
- If frontend is at 55%, raise to 50%

Commit any threshold adjustments.

**Step 7: Final commit**

```bash
git commit -m "test: Phase 3 complete — verify all tests pass + coverage thresholds"
```

---

## Summary

| Task | File(s) | Est. Test Cases | Commit |
|------|---------|-----------------|--------|
| T1 | factories.ts | — | `test: add shared factory helpers` |
| T2 | setup.ts | — | `test: extend Prisma mocks` |
| T3 | e2e/helpers.ts | — | `test: add E2E helpers` |
| T4 | vitest configs | — | `test: add coverage thresholds` |
| T5 | board.service.test.ts | 12 | `test: kanban board service` |
| T6 | card.service.test.ts | 15 | `test: kanban card service` |
| T7 | column.service.test.ts | 8 | `test: kanban column service` |
| T8 | linking.service.test.ts | 15 | `test: kanban linking service` |
| T9 | comments-chat.service.test.ts | 10 | `test: kanban comments/chat` |
| T10 | group.service.test.ts | 16 | `test: group service` |
| T11 | kanbanPermissions.test.ts | 12 | `test: kanban permissions` |
| T12 | kanbanReminder.service.test.ts | 10 | `test: kanban reminders` |
| T13-14 | syncService.test.ts | 18 | `test: sync engine` |
| T15 | ai.service.test.ts | 8 | `test: AI service` |
| T16 | import.service.test.ts | 8 | `test: ENEX import` |
| T17 | onenote-import.service.test.ts | 6 | `test: OneNote import` |
| T18 | tasklist-sharing.service.test.ts | 10 | `test: task list sharing` |
| T19 | provider.factory.test.ts | 6 | `test: LLM provider factory` |
| T20 | collaboration.spec.ts | 3 | `test: E2E collaboration` |
| T21 | groups.spec.ts | 4 | `test: E2E groups` |
| T22 | import.spec.ts | 3 | `test: E2E import` |
| T23 | verification | — | `test: Phase 3 complete` |
| **Total** | **19 new files** | **~154** | **23 commits** |
