import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { registerAndLogin } from './helpers';

// Suppress the "What's New" modal on the fresh verify context, the same way
// registerAndLogin's own browser login does for the primary page.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CURRENT_VERSION: string = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8')).version;

// Regression coverage for the LOCAL_FIRST fix (offline-first mutations plan).
//
// Every other "offline" test in this repo (kanban-account-scope.spec.ts,
// kanban-offline-sync.spec.ts) simulates offline with page.route(...).abort(),
// which leaves navigator.onLine === true. TanStack Query's onlineManager
// follows the browser's online/offline EVENTS, not request outcomes, so route
// interception never pauses a mutation — the bug this test guards against was
// invisible to that style of test, and survived a large code audit as a
// result. It only shows up with a REAL context.setOffline(true): TanStack
// Query v5 defaults every mutation to networkMode: 'online', so with no
// override a useMutation whose body only writes to Dexie (no network call at
// all — Notiq's whole offline-first design) sat paused and never ran while
// navigator.onLine was false. The app did nothing. LOCAL_FIRST
// (frontend/src/lib/networkMode.ts) opts specific mutations/queries out of
// that pause; this test is what stops it from regressing.
//
// Opens the command palette via the sidebar's "Search" button (same trigger
// search.spec.ts uses) and clicks one of its static action items by name.
// Used here purely for CLIENT-SIDE navigation: react-router's navigate()
// doesn't touch the network for a route whose lazy chunk is already loaded,
// unlike page.goto(), which is a real browser navigation and would try (and,
// offline, fail) to re-fetch the document and its scripts.
async function selectSearchOption(page: Page, optionName: string): Promise<void> {
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
}

test.describe('Offline-first mutations — real network outage', () => {
  test('a note and a notebook created while genuinely offline reach the server on reconnect', async ({ page, context, browser }) => {
    test.setTimeout(90000);

    const user = await registerAndLogin(page, { name: 'Offline First User' });

    // Warm the /notebooks route's lazy chunk WHILE STILL ONLINE. It's behind
    // React.lazy() (App.tsx) — a dynamic import() the browser has never
    // fetched needs the network the first time. Once the module is in the
    // browser's module registry, a later navigation to the same URL resolves
    // from that registry with no request at all — which is what lets the
    // offline section below reach /notebooks again after going offline.
    await selectSearchOption(page, 'Create Notebook');
    await expect(page.getByRole('heading', { name: 'Notebooks', level: 1 })).toBeVisible({ timeout: 15000 });

    // --- Go REALLY offline ---
    await context.setOffline(true);

    // --- Create a notebook while offline: NotebooksPage's own createMutation
    // (LOCAL_FIRST) — NOT the sidebar's create shortcut, which calls
    // createNotebook() directly with no useMutation wrapper at all and so
    // never went through this bug in the first place. ---
    // The sidebar also renders a "Create Notebook" icon button (aria-label)
    // that stays mounted on every route, before the routed page content in
    // the DOM — `.last()` is reliably this page's own button.
    await page.getByRole('button', { name: 'Create Notebook', exact: true }).last().click();
    const notebookNameInput = page.locator('input[placeholder="Notebook name"]');
    await expect(notebookNameInput).toBeVisible({ timeout: 5000 });
    const notebookName = `Offline Notebook ${Date.now()}`;
    await notebookNameInput.fill(notebookName);
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    // The Dexie write + syncQueue enqueue already happened by the time this
    // resolves — LOCAL_FIRST's entire point is that the mutationFn ran at all
    // despite navigator.onLine === false. The assertion IS the wait.
    // Scoped to the card heading: the sidebar's own live-reactive notebook
    // list (useLiveQuery on Dexie, unrelated to this mutation/LOCAL_FIRST)
    // picks up the same write and renders the name too, so a plain
    // getByText(notebookName) matches both and is ambiguous.
    await expect(page.getByRole('heading', { name: notebookName })).toBeVisible({ timeout: 5000 });

    // --- Reconnect briefly, JUST to move to /notes. Vite dev (unlike
    // production) has no service worker precaching the app shell, and
    // NotesPage.tsx is a separate React.lazy() chunk — if it (or one of its
    // own transitive imports) hasn't 100% finished fetching yet, navigating
    // to it while genuinely offline can fail outright ("Failed to fetch
    // dynamically imported module"), which is a real Vite-dev-only artifact,
    // not the bug this test is guarding. Moving between routes isn't part of
    // what LOCAL_FIRST is about — only the mutation trigger itself needs to
    // fire while offline, so that's what stays bracketed by setOffline. ---
    await context.setOffline(false);

    // Click the sidebar's own link for the notebook just created — lands on
    // /notes?notebookId=<id>, which makes handleCreateNote's notebook choice
    // (NotesPage.tsx) deterministic instead of depending on how many
    // notebooks useLiveQuery already has for this fresh NotesPage mount
    // (registerAndLogin's user also gets a server-seeded "First Notebook",
    // backend/src/services/auth.service.ts — with no notebookId in the URL,
    // whether that pull has landed changes whether a picker shows at all).
    await page.getByRole('link', { name: notebookName }).click();
    await expect(page).toHaveURL(/notebookId=/);
    // NOT the sidebar's prominent "New Note" button, which — like its
    // "Create Notebook" shortcut above — calls createNote() directly with no
    // useMutation wrapper (Sidebar.tsx's own handleCreateNote) and so never
    // went through this bug either. The ONLY UI path that reaches NotesPage's
    // own createMutation is the "Create New Note" button in its empty state
    // (no note selected) — wait for it before going back offline, so the
    // click below lands on a fully-settled page, not a mid-navigation one.
    const createNewNoteButton = page.getByRole('button', { name: 'Create New Note', exact: true });
    await expect(createNewNoteButton).toBeVisible({ timeout: 10000 });

    // --- Create a note while offline: NotesPage's own createMutation
    // (LOCAL_FIRST). ---
    await context.setOffline(true);
    await createNewNoteButton.click();

    const titleInput = page.locator('input[placeholder="Note Title"]');
    await expect(titleInput).toBeVisible({ timeout: 10000 });
    // Default title from the create mutation itself (NotesPage.tsx passes
    // t('notes.untitled')) — visible here only because the mutationFn
    // actually ran instead of sitting paused behind TanStack's offline gate.
    await expect(titleInput).toHaveValue('Untitled Note');

    // --- Reconnect for real. useSync (frontend/src/hooks/useSync.ts) pushes on a 30s
    // interval and whenever the syncQueue's COUNT changes — the count already
    // changed (twice) while offline, so flipping navigator.onLine back on
    // doesn't by itself trigger anything further; the next push otherwise
    // wouldn't fire for up to ~30s. A reload re-runs useSync's mount-time
    // runSync() immediately — the same code path the periodic tick takes,
    // just without waiting for it — the same trick kanban-offline-sync.spec.ts
    // uses for the same reason. Waiting on the actual push requests (not a
    // fixed sleep) is what lets this work regardless of which tick catches it. ---
    await context.setOffline(false);
    const notebookPush = page.waitForResponse(
      (res) => res.request().method() === 'POST' && res.url().endsWith('/api/notebooks'),
      { timeout: 25000 }
    );
    const notePush = page.waitForResponse(
      (res) => res.request().method() === 'POST' && res.url().endsWith('/api/notes'),
      { timeout: 25000 }
    );
    await page.reload();
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible({ timeout: 15000 });
    const [notebookRes, noteRes] = await Promise.all([notebookPush, notePush]);
    expect(notebookRes.ok()).toBe(true);
    expect(noteRes.ok()).toBe(true);

    // --- Prove the writes actually reached the server: a fresh browser
    // context with empty IndexedDB logs in as the same user and pulls from
    // the API. Re-asserting visibility in THIS context would prove nothing —
    // the note/notebook are in Dexie whether or not the push ever left the
    // device. Same pattern as kanban-offline-sync.spec.ts's verifyContext. ---
    const verifyContext = await browser.newContext();
    const verifyPage = await verifyContext.newPage();
    await verifyPage.goto('/login');
    await verifyPage.evaluate((ver) => localStorage.setItem('lastSeenVersion', ver), CURRENT_VERSION);
    await verifyPage.fill('input[type="email"]', user.email);
    await verifyPage.fill('input[type="password"]', user.password);
    await verifyPage.click('button[type="submit"]');
    await expect(verifyPage).toHaveURL(/\/notes/, { timeout: 15000 });
    await expect(verifyPage.getByTestId('sidebar-item-notes')).toBeVisible({ timeout: 30000 });

    await expect(verifyPage.getByText('Untitled Note')).toBeVisible({ timeout: 15000 });
    await verifyPage.goto('/notebooks');
    // Same ambiguity as the offline-creation assertion above: scope to the
    // card heading, since the sidebar's own notebook list also renders the name.
    await expect(verifyPage.getByRole('heading', { name: notebookName })).toBeVisible({ timeout: 15000 });

    await verifyContext.close();
  });
});
