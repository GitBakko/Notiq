# Sync Surfacing (M2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sync failures visible and bounded — persist retry state on syncQueue items, stop retrying after MAX_RETRIES, surface pending/failed counts in a UI banner with a retry action, and toast only on meaningful transitions.

**Architecture:** Dexie v15 adds `attempts`/`status`/`lastError` to `syncQueue` (additive — versions 1–14 untouched). `syncService.ts` persists failure metadata per item and marks items `failed` (terminal) at MAX_RETRIES; a new exported `retryFailedSyncItems()` re-enables them. A new `SyncStatusIndicator` banner component (mounted in `AppLayout` next to `NetworkStatusIndicator`) reads the queue via `useLiveQuery` and shows amber (pending >15s) or red (failed, with Retry button) strips. Toast (react-hot-toast, already installed) fires only on the FIRST transition to failed, or once when items pend >60s.

**Tech Stack:** Dexie v4 + dexie-react-hooks `useLiveQuery`, react-hot-toast, react-i18next, TailwindCSS (dark: variants), Vitest + @testing-library/react (jsdom configured in `frontend/vitest.config.ts`).

**TIER 1 WARNING:** `frontend/src/lib/db.ts` and `frontend/src/features/sync/syncService.ts` are TIER 1 files. The exact diffs are embedded below and were approved by the owner before execution. Do NOT deviate from them without flagging.

**Verified facts about the current code (do not re-derive):**
- `db.ts` is at Dexie version 14. `syncQueue` schema since v9: `'++id, type, entity, userId, createdAt'`. `SyncQueueItem` interface at `frontend/src/lib/db.ts:151-159`.
- `syncService.ts` has module-level `failureCounts: Map<number, {count, nextRetryAt}>`, `MAX_RETRIES = 5`, `shouldRetry()`, `recordFailure()`, `clearFailure()` at lines ~494-517. Push loop at ~537. Catch block at ~744-755.
- Owned-notes pull has a zombie-resurrection guard (pending DELETE check) at ~line 84. The shared-notes pull (~line 132-181) does NOT — that's a gap to close.
- The shared-kanban-board skip path in syncPush (~line 600-604) deletes the queue item but does NOT call `clearFailure` — map leak to fix.
- Tests in `frontend/src/features/sync/__tests__/syncService.test.ts` use `vi.hoisted()` mocks of db/api/authStore. **The in-memory `failureCounts` map is module state shared across tests — every new test MUST use unique queue item `id` numbers (use 900+) to avoid backoff interference between tests.**
- Toaster already mounted in `App.tsx` (react-hot-toast).
- i18n: `network.*` keys exist at `en.json:1136`; plurals use the simple `{{count}}` style (no `_one`/`_other` suffixes in this codebase).

---

## File map

| # | File | Action | Task |
|---|------|--------|------|
| 1 | `frontend/src/lib/db.ts` | Modify (TIER 1): extend `SyncQueueItem`, add `version(15)` | 1 |
| 2 | `frontend/src/features/sync/syncService.ts` | Modify (TIER 1): persist failures, terminal `failed` state, jitter, `retryFailedSyncItems`, shared-notes zombie guard, kanban clearFailure | 2, 3 |
| 3 | `frontend/src/features/sync/__tests__/syncService.test.ts` | Modify: new describe blocks | 2, 3 |
| 4 | `frontend/src/locales/en.json` + `frontend/src/locales/it.json` | Modify: `sync.*` keys | 4 |
| 5 | `frontend/src/components/layout/SyncStatusIndicator.tsx` | Create | 5 |
| 6 | `frontend/src/components/layout/__tests__/SyncStatusIndicator.test.tsx` | Create | 5 |
| 7 | `frontend/src/components/layout/AppLayout.tsx` | Modify: mount indicator | 5 |

---

### Task 1: Dexie v15 — syncQueue surfacing fields

**Files:**
- Modify: `frontend/src/lib/db.ts` (TIER 1 — apply EXACTLY this diff)

No unit test for the schema itself (schema declarations are exercised only against a real IndexedDB; the project's Dexie is fully mocked in tests). Verification = typecheck + full existing suite stays green.

- [ ] **Step 1: Extend the `SyncQueueItem` interface**

In `frontend/src/lib/db.ts`, replace the existing interface (lines 151-159):

```ts
export interface SyncQueueItem {
  id?: number; // Auto-increment
  type: 'CREATE' | 'UPDATE' | 'DELETE';
  entity: 'NOTE' | 'NOTEBOOK' | 'TAG' | 'TASK_LIST' | 'TASK_ITEM' | 'KANBAN_BOARD' | 'KANBAN_COLUMN' | 'KANBAN_CARD';
  entityId: string;
  userId: string; // Added for data isolation
  data?: Record<string, unknown>;
  createdAt: number;
  // v15 sync surfacing — optional so the many existing enqueue call-sites need no changes.
  // undefined attempts/status ≡ pending item with 0 attempts.
  attempts?: number;
  status?: 'pending' | 'failed';
  lastError?: string;
}
```

- [ ] **Step 2: Add version 15 (ADDITIVE — do not touch versions 1–14)**

Immediately after the `version(14)` block (line 247-251), add:

```ts
    // v15: Sync surfacing — status/attempts/lastError on syncQueue (status indexed for failed-count queries)
    this.version(15).stores({
      syncQueue: '++id, type, entity, userId, createdAt, status'
    }).upgrade(tx => {
      return tx.table('syncQueue').toCollection().modify(item => {
        item.attempts = item.attempts ?? 0;
        item.status = item.status ?? 'pending';
      });
    });
```

- [ ] **Step 3: Typecheck + existing tests**

Run: `cd frontend && npx tsc -b --noEmit && npm test`
Expected: typecheck clean; all existing tests PASS (schema change is additive, nothing reads new fields yet).

Note: `tsc -b` may not accept `--noEmit` with project references — if it errors, run `npm run build` instead (build includes `tsc -b`).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/db.ts
git commit -m "feat(sync): Dexie v15 — add attempts/status/lastError to syncQueue

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: syncService — persist failures, terminal failed state, jitter

**Files:**
- Modify: `frontend/src/features/sync/syncService.ts` (TIER 1 — apply EXACTLY these diffs)
- Test: `frontend/src/features/sync/__tests__/syncService.test.ts`

- [ ] **Step 1: Write the failing tests**

Append this describe block inside the existing `describe('syncPush', ...)` block (after the `'user isolation'` describe, before the closing `});`):

```ts
  // -----------------------------------------------------------------
  // Failure persistence (M2 sync surfacing)
  // -----------------------------------------------------------------
  describe('failure persistence', () => {
    it('persists attempts and lastError on push failure', async () => {
      const queueItem = {
        id: 901, type: 'UPDATE' as const, entity: 'NOTE' as const, entityId: 'note-f1',
        userId: 'user-1', data: { title: 'X' }, createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockDb.notes.get.mockResolvedValue({ id: 'note-f1', ownership: 'owned' });
      mockApi.put.mockRejectedValue(new Error('Network Error'));

      await syncPush();

      expect(mockDb.syncQueue.update).toHaveBeenCalledWith(901, expect.objectContaining({
        attempts: 1,
        status: 'pending',
        lastError: 'Network Error',
      }));
      // Item must stay in the queue
      expect(mockDb.syncQueue.delete).not.toHaveBeenCalledWith(901);
    });

    it('marks item failed (terminal) when persisted attempts reach MAX_RETRIES', async () => {
      // attempts: 4 persisted → this failure is the 5th → terminal
      const queueItem = {
        id: 902, type: 'UPDATE' as const, entity: 'NOTE' as const, entityId: 'note-f2',
        userId: 'user-1', data: { title: 'X' }, createdAt: Date.now(),
        attempts: 4,
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockDb.notes.get.mockResolvedValue({ id: 'note-f2', ownership: 'owned' });
      mockApi.put.mockRejectedValue(new Error('Still down'));

      await syncPush();

      expect(mockDb.syncQueue.update).toHaveBeenCalledWith(902, expect.objectContaining({
        attempts: 5,
        status: 'failed',
        lastError: 'Still down',
      }));
    });

    it('skips items with status=failed entirely (no API call)', async () => {
      const queueItem = {
        id: 903, type: 'UPDATE' as const, entity: 'NOTE' as const, entityId: 'note-f3',
        userId: 'user-1', data: { title: 'X' }, createdAt: Date.now(),
        attempts: 5, status: 'failed' as const,
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);

      await syncPush();

      expect(mockApi.put).not.toHaveBeenCalled();
      expect(mockApi.post).not.toHaveBeenCalled();
      expect(mockApi.delete).not.toHaveBeenCalled();
      expect(mockDb.syncQueue.delete).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts`
Expected: the 3 new tests FAIL (no `syncQueue.update` with failure metadata; failed item still pushed); all pre-existing tests PASS.

- [ ] **Step 3: Implement in `syncService.ts`**

3a. Replace `recordFailure` (currently ~lines 506-513) with:

```ts
// [BACKUP] 2026-06-11 — old recordFailure was in-memory only (sync surfacing M2 adds persistence):
// function recordFailure(itemId: number | undefined): void {
//   if (!itemId) return;
//   const info = failureCounts.get(itemId) || { count: 0, nextRetryAt: 0 };
//   info.count += 1;
//   // Exponential backoff: 5s, 15s, 45s, 135s, 405s
//   info.nextRetryAt = Date.now() + Math.min(5000 * Math.pow(3, info.count - 1), 5 * 60 * 1000);
//   failureCounts.set(itemId, info);
// }
async function recordFailure(item: SyncQueueItem, error: unknown): Promise<void> {
  if (!item.id) return;
  // Seed from persisted attempts so bounded retries survive page reloads
  const info = failureCounts.get(item.id) || { count: item.attempts ?? 0, nextRetryAt: 0 };
  info.count += 1;
  // Exponential backoff: 5s, 15s, 45s, 135s, 405s — ±20% jitter avoids synchronized retry storms
  const base = Math.min(5000 * Math.pow(3, info.count - 1), 5 * 60 * 1000);
  info.nextRetryAt = Date.now() + base + Math.round(base * 0.2 * (Math.random() * 2 - 1));
  failureCounts.set(item.id, info);

  const lastError = error instanceof Error ? error.message : String(error);
  try {
    if (info.count >= MAX_RETRIES) {
      await db.syncQueue.update(item.id, { attempts: info.count, status: 'failed' as const, lastError });
      // Terminal state — prune the in-memory map; only an explicit user retry re-enables the item
      failureCounts.delete(item.id);
    } else {
      await db.syncQueue.update(item.id, { attempts: info.count, status: 'pending' as const, lastError });
    }
  } catch (e) {
    console.error('Sync Push: failed to persist failure metadata', e);
  }
}
```

3b. Add the `SyncQueueItem` type import. Change line 6 from:

```ts
import type { LocalTaskList, LocalTaskItem, LocalKanbanBoard, LocalKanbanColumn, LocalKanbanCard } from '../../lib/db';
```

to:

```ts
import type { LocalTaskList, LocalTaskItem, LocalKanbanBoard, LocalKanbanColumn, LocalKanbanCard, SyncQueueItem } from '../../lib/db';
```

3c. In the push loop (~line 537), change:

```ts
    for (const item of queue) {
      // Skip items in backoff period
      if (!shouldRetry(item.id)) continue;
```

to:

```ts
    for (const item of queue) {
      // Failed items are terminal — only an explicit user retry (retryFailedSyncItems) re-enables them
      if (item.status === 'failed') continue;
      // Skip items in backoff period
      if (!shouldRetry(item.id)) continue;
```

3d. In the catch block (~line 752), change `recordFailure(item.id);` to `await recordFailure(item, error);`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts`
Expected: ALL tests PASS (new 3 + all pre-existing — watch for regressions in the `error handling` describe which relies on recordFailure behavior).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/sync/syncService.ts frontend/src/features/sync/__tests__/syncService.test.ts
git commit -m "feat(sync): persist failure metadata, terminal failed state at MAX_RETRIES, backoff jitter

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: syncService — retryFailedSyncItems, shared-notes zombie guard, kanban clearFailure

**Files:**
- Modify: `frontend/src/features/sync/syncService.ts` (TIER 1 — apply EXACTLY these diffs)
- Test: `frontend/src/features/sync/__tests__/syncService.test.ts`

- [ ] **Step 1: Write the failing tests**

1a. Append inside `describe('syncPush', ...)`:

```ts
  // -----------------------------------------------------------------
  // retryFailedSyncItems (M2 sync surfacing)
  // -----------------------------------------------------------------
  describe('retryFailedSyncItems', () => {
    it('resets failed items of the current user to pending and triggers a push', async () => {
      const failedItem = {
        id: 904, type: 'UPDATE' as const, entity: 'NOTE' as const, entityId: 'note-f4',
        userId: 'user-1', data: { title: 'X' }, createdAt: Date.now(),
        attempts: 5, status: 'failed' as const, lastError: 'boom',
      };

      // where('status').equals('failed').filter(...).toArray()
      mockDb.syncQueue.toArray.mockResolvedValue([failedItem]);

      await retryFailedSyncItems();

      expect(mockDb.syncQueue.update).toHaveBeenCalledWith(904, expect.objectContaining({
        status: 'pending',
        attempts: 0,
      }));
    });

    it('does nothing when there are no failed items', async () => {
      mockDb.syncQueue.toArray.mockResolvedValue([]);

      await retryFailedSyncItems();

      expect(mockDb.syncQueue.update).not.toHaveBeenCalled();
    });
  });
```

1b. Append inside `describe('syncPull', ...)`'s `describe('shared notes', ...)`:

```ts
    it('prevents zombie resurrection for shared notes with pending DELETE', async () => {
      // Pending DELETE for shared-z1 in the queue
      const pendingDelete = {
        id: 905, type: 'DELETE' as const, entity: 'NOTE' as const, entityId: 'shared-z1',
        userId: 'user-1', data: {}, createdAt: Date.now(),
      };
      mockDb.syncQueue.toArray.mockResolvedValue([pendingDelete]);

      mockApi.get.mockImplementation((url: string) => {
        if (url === '/share/notes/accepted') {
          return Promise.resolve({
            data: [
              { id: 'shared-z1', title: 'Zombie', _sharedPermission: 'WRITE', user: null },
              { id: 'shared-ok', title: 'Fine', _sharedPermission: 'READ', user: null },
            ],
          });
        }
        return Promise.resolve({ data: [] });
      });

      await syncPull();

      // bulkPut on notes must never include the pending-delete shared note
      const allBulkPuts = mockDb.notes.bulkPut.mock.calls.flatMap((c: unknown[][]) => c[0]);
      const putIds = (allBulkPuts as { id: string }[]).map(n => n.id);
      expect(putIds).not.toContain('shared-z1');
      expect(putIds).toContain('shared-ok');
    });
```

(Model the surrounding mock setup on the existing `'pulls shared notes with ownership="shared"'` test at line ~350 — reuse its `beforeEach` reset; only override what's listed above.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts`
Expected: `retryFailedSyncItems` tests fail at import time (`retryFailedSyncItems` is not exported); zombie test FAILS (shared-z1 IS in bulkPut). Update the import line at the top of the test file to:

```ts
import { syncPull, syncPush, retryFailedSyncItems } from '../syncService';
```

- [ ] **Step 3: Implement in `syncService.ts`**

3a. Add after `clearFailure` (so it can see `failureCounts`) — new exported function:

```ts
/**
 * Re-enable all failed queue items for the current user and trigger a push.
 * Called from the SyncStatusIndicator retry action.
 */
export const retryFailedSyncItems = async (): Promise<void> => {
  const currentUserId = useAuthStore.getState().user?.id;
  if (!currentUserId) return;
  const failed = await db.syncQueue.where('status').equals('failed')
    .filter(item => item.userId === currentUserId).toArray();
  for (const item of failed) {
    if (!item.id) continue;
    failureCounts.delete(item.id);
    await db.syncQueue.update(item.id, { status: 'pending' as const, attempts: 0 });
  }
  // The liveQuery count doesn't change on status updates, so useSync won't re-fire — push explicitly
  if (failed.length > 0) void syncPush();
};
```

NOTE: `retryFailedSyncItems` references `syncPush` which is defined later in the file — that's fine (const hoisting works because the call happens at runtime, after module init). Place `retryFailedSyncItems` AFTER the `syncPush` definition at the end of the file to keep lint happy (`no-use-before-define`).

3b. Shared-notes zombie guard. In the shared-notes pull block (~line 138), change:

```ts
      await db.transaction('rw', db.notes, async () => {
        const localShared = await db.notes.where('ownership').equals('shared').toArray();
        const localSharedMap = new Map(localShared.map(n => [n.id, n]));

        const serverShared = sharedRes.data.map(n => {
```

to:

```ts
      await db.transaction('rw', db.notes, db.syncQueue, async () => {
        // Zombie prevention (mirrors the owned-notes pull): a locally-deleted shared note with a
        // pending DELETE in the queue must not be resurrected by the server response.
        const pendingSharedDeletes = await db.syncQueue
          .where('entity').equals('NOTE')
          .and(item => item.type === 'DELETE')
          .toArray();
        const pendingSharedDeleteIds = new Set(pendingSharedDeletes.map(i => i.entityId));

        const localShared = await db.notes.where('ownership').equals('shared').toArray();
        const localSharedMap = new Map(localShared.map(n => [n.id, n]));

        const serverShared = sharedRes.data.filter(n => !pendingSharedDeleteIds.has(n.id)).map(n => {
```

(Everything inside the `.map(...)` body stays unchanged.)

3c. Kanban map-leak fix. In the shared-kanban-board skip path (~line 600-604), change:

```ts
          const localBoard = await db.kanbanBoards.get(item.entityId);
          if (localBoard?.ownership === 'shared') {
            if (item.id) await db.syncQueue.delete(item.id);
            continue;
          }
```

to:

```ts
          const localBoard = await db.kanbanBoards.get(item.entityId);
          if (localBoard?.ownership === 'shared') {
            if (item.id) await db.syncQueue.delete(item.id);
            clearFailure(item.id);
            continue;
          }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts`
Expected: ALL tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/sync/syncService.ts frontend/src/features/sync/__tests__/syncService.test.ts
git commit -m "feat(sync): retryFailedSyncItems + shared-notes zombie guard + kanban clearFailure prune

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: i18n keys (both locales)

**Files:**
- Modify: `frontend/src/locales/en.json` (after the `"network"` block at ~line 1136-1140)
- Modify: `frontend/src/locales/it.json` (same position — find the `"network"` block)

- [ ] **Step 1: Add to `en.json`** (after the closing `}` of `"network"`, keeping valid JSON commas):

```json
  "sync": {
    "pending": "{{count}} change(s) waiting to sync",
    "failed": "{{count}} change(s) failed to sync",
    "retry": "Retry",
    "failedToast": "Some changes could not be synced. Use Retry in the sync bar.",
    "pendingToast": "Changes are taking longer than usual to sync"
  },
```

- [ ] **Step 2: Add to `it.json`** (same position relative to `"network"`):

```json
  "sync": {
    "pending": "{{count}} modifiche in attesa di sincronizzazione",
    "failed": "{{count}} modifiche non sincronizzate",
    "retry": "Riprova",
    "failedToast": "Alcune modifiche non sono state sincronizzate. Usa Riprova nella barra di sincronizzazione.",
    "pendingToast": "La sincronizzazione sta richiedendo più tempo del solito"
  },
```

- [ ] **Step 3: Validate JSON**

Run: `cd frontend && node -e "JSON.parse(require('fs').readFileSync('src/locales/en.json','utf8')); JSON.parse(require('fs').readFileSync('src/locales/it.json','utf8')); console.log('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add frontend/src/locales/en.json frontend/src/locales/it.json
git commit -m "feat(sync): i18n keys for sync status indicator (EN + IT)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: SyncStatusIndicator component + AppLayout mount

**Files:**
- Create: `frontend/src/components/layout/SyncStatusIndicator.tsx`
- Create: `frontend/src/components/layout/__tests__/SyncStatusIndicator.test.tsx`
- Modify: `frontend/src/components/layout/AppLayout.tsx`

- [ ] **Step 1: Write the failing component tests**

Create `frontend/src/components/layout/__tests__/SyncStatusIndicator.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { mockUseLiveQuery, mockRetry, mockToast } = vi.hoisted(() => ({
  mockUseLiveQuery: vi.fn(),
  mockRetry: vi.fn().mockResolvedValue(undefined),
  mockToast: Object.assign(vi.fn(), { error: vi.fn() }),
}));

vi.mock('dexie-react-hooks', () => ({ useLiveQuery: mockUseLiveQuery }));
vi.mock('../../../features/sync/syncService', () => ({ retryFailedSyncItems: mockRetry }));
vi.mock('react-hot-toast', () => ({ default: mockToast }));
vi.mock('../../../lib/db', () => ({ db: { syncQueue: {} } }));
vi.mock('../../../store/authStore', () => ({
  useAuthStore: (selector?: (s: { user: { id: string } }) => unknown) => {
    const state = { user: { id: 'user-1' } };
    return selector ? selector(state) : state;
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count !== undefined ? `${key}:${opts.count}` : key,
  }),
}));

import SyncStatusIndicator from '../SyncStatusIndicator';

describe('SyncStatusIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when the queue is empty', () => {
    mockUseLiveQuery.mockReturnValue([]);
    const { container } = render(<SyncStatusIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for fresh pending items (normal debounce window)', () => {
    mockUseLiveQuery.mockReturnValue([
      { id: 1, createdAt: Date.now() - 1000, userId: 'user-1' },
    ]);
    const { container } = render(<SyncStatusIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the pending banner when the oldest pending item is older than 15s', () => {
    mockUseLiveQuery.mockReturnValue([
      { id: 1, createdAt: Date.now() - 20_000, userId: 'user-1' },
      { id: 2, createdAt: Date.now() - 18_000, userId: 'user-1' },
    ]);
    render(<SyncStatusIndicator />);
    expect(screen.getByText('sync.pending:2')).toBeTruthy();
  });

  it('shows the failed banner with a retry button; clicking calls retryFailedSyncItems', () => {
    mockUseLiveQuery.mockReturnValue([
      { id: 1, status: 'failed', createdAt: Date.now() - 1000, userId: 'user-1' },
    ]);
    render(<SyncStatusIndicator />);
    expect(screen.getByText('sync.failed:1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(mockRetry).toHaveBeenCalledOnce();
  });

  it('failed banner takes precedence over pending banner', () => {
    mockUseLiveQuery.mockReturnValue([
      { id: 1, status: 'failed', createdAt: Date.now() - 90_000, userId: 'user-1' },
      { id: 2, createdAt: Date.now() - 90_000, userId: 'user-1' },
    ]);
    render(<SyncStatusIndicator />);
    expect(screen.getByText('sync.failed:1')).toBeTruthy();
    expect(screen.queryByText('sync.pending:1')).toBeNull();
  });

  it('fires the error toast only on the FIRST transition to failed', () => {
    mockUseLiveQuery.mockReturnValue([
      { id: 1, status: 'failed', createdAt: Date.now(), userId: 'user-1' },
    ]);
    const { rerender } = render(<SyncStatusIndicator />);
    expect(mockToast.error).toHaveBeenCalledTimes(1);
    rerender(<SyncStatusIndicator />);
    expect(mockToast.error).toHaveBeenCalledTimes(1); // still exactly once
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/layout/__tests__/SyncStatusIndicator.test.tsx`
Expected: FAIL — module `../SyncStatusIndicator` not found.

- [ ] **Step 3: Create the component**

Create `frontend/src/components/layout/SyncStatusIndicator.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import { CloudOff, CloudUpload, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { db } from '../../lib/db';
import { retryFailedSyncItems } from '../../features/sync/syncService';
import { useAuthStore } from '../../store/authStore';

// Don't flash the banner during the normal debounced-sync window
const PENDING_VISIBLE_AFTER_MS = 15_000;
// One informational toast if items stay pending this long (re-armed when the queue drains)
const PENDING_TOAST_AFTER_MS = 60_000;

export default function SyncStatusIndicator() {
  const { t } = useTranslation();
  const userId = useAuthStore((s) => s.user?.id);
  const [isRetrying, setIsRetrying] = useState(false);
  const [, setTick] = useState(0);

  const items = useLiveQuery(
    () => (userId ? db.syncQueue.where('userId').equals(userId).toArray() : Promise.resolve([])),
    [userId]
  );

  const failedCount = items?.filter((i) => i.status === 'failed').length ?? 0;
  const pendingItems = items?.filter((i) => i.status !== 'failed') ?? [];
  const oldestPendingAt = pendingItems.length > 0 ? Math.min(...pendingItems.map((i) => i.createdAt)) : null;
  const pendingAge = oldestPendingAt ? Date.now() - oldestPendingAt : 0;
  const showPending = pendingItems.length > 0 && pendingAge >= PENDING_VISIBLE_AFTER_MS;

  // liveQuery doesn't re-fire as time passes — tick every 5s while items are pending
  useEffect(() => {
    if (pendingItems.length === 0) return;
    const id = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, [pendingItems.length]);

  // Toast only on the FIRST transition to failed
  const prevFailedRef = useRef(0);
  useEffect(() => {
    if (failedCount > 0 && prevFailedRef.current === 0) {
      toast.error(t('sync.failedToast'));
    }
    prevFailedRef.current = failedCount;
  }, [failedCount, t]);

  // One toast when items stay pending >60s; re-arm when the queue drains
  const pendingToastShownRef = useRef(false);
  useEffect(() => {
    if (pendingItems.length === 0) {
      pendingToastShownRef.current = false;
      return;
    }
    if (!pendingToastShownRef.current && pendingAge >= PENDING_TOAST_AFTER_MS) {
      pendingToastShownRef.current = true;
      toast(t('sync.pendingToast'), { icon: '⏳' });
    }
  });

  const handleRetry = async () => {
    setIsRetrying(true);
    try {
      await retryFailedSyncItems();
    } finally {
      setIsRetrying(false);
    }
  };

  if (failedCount > 0) {
    return (
      <div className="flex items-center justify-center gap-2 px-3 bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-xs font-medium border-b border-red-200 dark:border-red-900/40">
        <CloudOff size={12} aria-hidden="true" />
        <span>{t('sync.failed', { count: failedCount })}</span>
        <button
          onClick={handleRetry}
          disabled={isRetrying}
          className="flex items-center gap-1 min-h-[44px] min-w-[44px] px-3 font-semibold hover:text-red-700 dark:hover:text-red-300 disabled:opacity-50"
        >
          <RefreshCw size={12} className={isRetrying ? 'animate-spin' : ''} aria-hidden="true" />
          {t('sync.retry')}
        </button>
      </div>
    );
  }

  if (showPending) {
    return (
      <div className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 text-xs font-medium border-b border-amber-200 dark:border-amber-900/40">
        <CloudUpload size={12} aria-hidden="true" />
        <span>{t('sync.pending', { count: pendingItems.length })}</span>
      </div>
    );
  }

  return null;
}
```

Style notes (already encoded above — keep them): dark: variants on every color; retry button ≥44px touch target; no hover-only interaction (button works on tap); banner mirrors `NetworkStatusIndicator.tsx` visual language.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/layout/__tests__/SyncStatusIndicator.test.tsx`
Expected: 6 tests PASS.

- [ ] **Step 5: Mount in AppLayout**

In `frontend/src/components/layout/AppLayout.tsx`:

Add import after the `NetworkStatusIndicator` import (line 12):

```tsx
import SyncStatusIndicator from './SyncStatusIndicator';
```

Change (line ~91):

```tsx
        <NetworkStatusIndicator />
        <AnnouncementBanner />
```

to:

```tsx
        <NetworkStatusIndicator />
        <SyncStatusIndicator />
        <AnnouncementBanner />
```

- [ ] **Step 6: Full frontend verification**

Run: `cd frontend && npm test && npm run lint && npm run build`
Expected: all tests PASS; lint 0 errors (warnings allowed — React-Compiler `set-state-in-effect` warning on the tick pattern is expected and acceptable, it's currently `warn` severity); build succeeds.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/layout/SyncStatusIndicator.tsx frontend/src/components/layout/__tests__/SyncStatusIndicator.test.tsx frontend/src/components/layout/AppLayout.tsx
git commit -m "feat(sync): SyncStatusIndicator banner — pending/failed counts + retry action

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Final verification + push + CI

- [ ] **Step 1: Full local suites**

Run: `cd frontend && npm test && npm run lint && npm run build`
Run: `cd backend && npm test && npm run lint`
Expected: frontend all green; backend 1082 tests PASS (nothing in this plan touches backend — this is a regression check only).

- [ ] **Step 2: Push and watch CI**

```bash
git push origin main
gh run watch $(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

Expected: CI green (both jobs).

- [ ] **Step 3: Report manual acceptance steps to the owner (do not attempt them yourself)**

- Kill backend mid-edit → amber pending banner within ~30s of editing; after 5 failed retries (~10 min) → red failed banner + first-failure toast.
- Restart backend → click Retry → queue drains, banner disappears.
- Suggest re-running E2E: `npx playwright test e2e/notes.spec.ts e2e/dexie.spec.ts` (needs running backend).

---

## Self-review notes

- Spec coverage vs RESUME §1: Dexie v15 additive ✓ (Task 1); attempts/status/lastError ✓; increment-on-failure + terminal failed at MAX_RETRIES ✓ (Task 2); failureCounts pruning ✓ (terminal delete in Task 2 + kanban skip path in Task 3); shared-notes pending-DELETE guard ✓ (Task 3); jitter ✓ (Task 2); badge with pending/failed via useLiveQuery + retry ✓ (Task 5); dark variants + i18n both locales ✓ (Tasks 4-5); toast only on first failed transition or >60s pending ✓ (Task 5); queue bounded test ✓ (Task 2 test 2).
- Type consistency: `SyncQueueItem.status?: 'pending' | 'failed'`; `recordFailure(item: SyncQueueItem, error: unknown)`; `retryFailedSyncItems(): Promise<void>` — names match across tasks.
- Known accepted trade-offs: in-memory backoff timing resets on reload (persisted `attempts` keeps the retry BOUND correct, which is what matters); `pending` count in the banner includes items in backoff (intended — they ARE unsynced).
