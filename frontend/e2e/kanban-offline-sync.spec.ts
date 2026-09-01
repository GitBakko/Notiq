import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { registerAndLogin } from './helpers';

// Suppress the "What's New" modal on the fresh verify context the same way
// registerAndLogin's own browser login does for the primary page.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CURRENT_VERSION: string = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8')).version;

// Regression coverage for task 3.2 (fix round 1): a card created offline in a
// board also created offline used to vanish silently. The board CREATE's
// reconciliation rewrites Dexie's column ids to the server's once it round-
// trips, but never rewrote the card CREATE's already-queued payload — so the
// card's POST went to the board's dead local column id, 404'd, and syncPush's
// 404 handler silently deleted the queue item (console.warn only, no user-
// facing signal). The unit tests in syncService.test.ts pin the exact push-
// time resolution and its queue-order-inversion guard against a mocked Dexie;
// what they cannot prove is the real round trip through an actual backend —
// the real board CREATE response, the real reconciliation, and the real card
// CREATE that depends on it. That is what this test is for.
//
// "Offline" here is modeled the same way kanban-account-scope.spec.ts's own
// offline section does it: aborting the kanban write requests via page.route,
// NOT page.context().setOffline(true). setOffline flips navigator.onLine to
// false, and TanStack Query's default mutation networkMode is 'online' — with
// no override anywhere in queryClient.ts, EVERY useMutation in the app
// (including this Dexie-only, no-network createBoard/createCard) is paused
// and its mutationFn never runs at all while navigator.onLine is false, no
// matter how offline-first the underlying service function is. That is a
// real, separate characteristic of the app worth its own look (see the task
// report), but it is not what task 3.2 is about, so this test does not
// exercise it — route-aborting the write endpoints reproduces "queued
// locally, can't reach the server yet" without also tripping that gate.
test.describe('Kanban offline sync — board + card created while offline', () => {
  test('a card added offline to a board created offline survives the round-trip to the server', async ({ page, browser }) => {
    test.setTimeout(90000);

    const user = await registerAndLogin(page, { name: 'Offline Kanban User' });

    // Block every kanban write while "offline": both the board CREATE and the
    // card CREATE queue locally and fail to push — exactly the sequence that
    // used to lose the card, since the reconciliation that rewrites the
    // column id only happens once the board CREATE round-trips.
    await page.route('**/api/kanban/**', async (route) => {
      if (route.request().method() === 'POST') { await route.abort(); return; }
      await route.continue();
    });

    await page.click('a[href="/kanban"]');
    await page.getByRole('button', { name: 'New Board' }).first().click();
    await page.fill('input[placeholder="Board title"]', 'Offline Board');
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    // The Dexie write (and the create push firing and failing) has already
    // happened by the time this resolves — the assertion IS the wait.
    await expect(page.getByText('Offline Board')).toBeVisible({ timeout: 5000 });

    // NOT opening the board through the UI here on purpose: useKanbanBoard()
    // (hooks/useKanbanBoard.ts) fetches the board detail page purely via
    // GET /kanban/boards/:id with retry:false — no Dexie fallback — and
    // KanbanBoardPage navigates straight back to /kanban on any error,
    // treating "doesn't exist yet on the server" the same as "was deleted".
    // A board that only exists locally therefore currently bounces back to
    // the list the moment you click it, offline or not — a real, separate
    // bug this test ran into but that task 3.2 does not touch (see the task
    // report). Adding the card straight to Dexie + the sync queue below
    // exercises exactly the same production code this test is actually
    // about — kanbanService.createCard()'s write shape and syncPush()'s real
    // push against the real backend — without depending on that other bug.
    const cardTitle = 'Offline Card';
    await page.evaluate(async (title) => {
      const openReq = indexedDB.open('NotiqDB');
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        openReq.onsuccess = () => resolve(openReq.result);
        openReq.onerror = () => reject(openReq.error);
      });
      const readTx = db.transaction(['kanbanColumns', 'syncQueue'], 'readonly');
      const columns = await new Promise<{ id: string; boardId: string; title: string }[]>((resolve, reject) => {
        const req = readTx.objectStore('kanbanColumns').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const queueItems = await new Promise<{ userId: string; entity: string }[]>((resolve, reject) => {
        const req = readTx.objectStore('syncQueue').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const todoColumn = columns.find((c) => c.title === 'To Do');
      const userId = queueItems.find((i) => i.entity === 'KANBAN_BOARD')?.userId;
      if (!todoColumn || !userId) throw new Error(`offline probe: missing column or userId — cols=${JSON.stringify(columns)} queue=${JSON.stringify(queueItems)}`);

      const cardId = crypto.randomUUID();
      const now = new Date().toISOString();
      // Mirrors kanbanService.createCard()'s LocalKanbanCard + queue-item shape exactly.
      const card = {
        id: cardId, title, description: null, position: 0,
        columnId: todoColumn.id, boardId: todoColumn.boardId,
        assigneeId: null, assignee: null, dueDate: null, priority: null,
        noteId: null, noteLinkedById: null, note: null, commentCount: 0,
        createdAt: now, updatedAt: now, syncStatus: 'created',
      };
      const queueItem = {
        type: 'CREATE', entity: 'KANBAN_CARD', entityId: cardId, userId,
        data: { id: cardId, columnId: todoColumn.id, title, description: undefined },
        createdAt: Date.now(),
      };
      const writeTx = db.transaction(['kanbanCards', 'syncQueue'], 'readwrite');
      writeTx.objectStore('kanbanCards').add(card);
      writeTx.objectStore('syncQueue').add(queueItem);
      await new Promise<void>((resolve, reject) => {
        writeTx.oncomplete = () => resolve();
        writeTx.onerror = () => reject(writeTx.error);
      });
      db.close();
    }, cardTitle);

    // Back "online": unblock the writes and reload. useSync's queue-count-
    // triggered push effect only re-fires on a Dexie count CHANGE, not on
    // unrouting, so a reload is what actually re-triggers the push (its
    // mount-time runSync(), same path as useSync.ts's own 30s periodic retry
    // — a reload just doesn't wait).
    await page.unroute('**/api/kanban/**');
    await page.reload();
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible({ timeout: 15000 });

    // Let the queued board CREATE + card CREATE pushes flush before checking
    // the server directly (same fixed-wait tolerance as helpers.ts waitForSave).
    await page.waitForTimeout(4000);

    // Fresh browser context, same user, empty IndexedDB: this can only show
    // the card if syncPush actually created it server-side. Pre-fix, the
    // card's CREATE 404'd against the board's dead local column id and
    // syncPush's 404 handler silently dropped the queue item — this
    // assertion is exactly what "the card vanished with no signal" fails.
    const verifyContext = await browser.newContext();
    const verifyPage = await verifyContext.newPage();
    await verifyPage.goto('/login');
    await verifyPage.evaluate((ver) => localStorage.setItem('lastSeenVersion', ver), CURRENT_VERSION);
    await verifyPage.fill('input[type="email"]', user.email);
    await verifyPage.fill('input[type="password"]', user.password);
    await verifyPage.click('button[type="submit"]');
    await expect(verifyPage).toHaveURL(/\/notes/, { timeout: 15000 });
    await expect(verifyPage.getByTestId('sidebar-item-notes')).toBeVisible({ timeout: 30000 });

    await verifyPage.goto('/kanban');
    await expect(verifyPage.getByText('Offline Board')).toBeVisible({ timeout: 15000 });
    await verifyPage.getByText('Offline Board').click();
    await expect(verifyPage.getByText('Offline Card')).toBeVisible({ timeout: 10000 });

    await verifyContext.close();
  });
});
