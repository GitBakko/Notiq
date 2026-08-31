import { test, expect, request as pwRequest } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { registerAndLogin } from './helpers';

// Regression coverage for task 3.1: useKanbanBoards used to do a bare
// `db.kanbanBoards.toArray()` with no user scope — Dexie is one IndexedDB per
// browser profile and is not cleared on logout, so a previous account's boards
// rendered in the next account's session. A unit test can't catch this: `db` is
// mocked wholesale there, so a refactor of `.filter(...)` into different
// selection logic would pass the mocks and fail only in a real browser.

const API_BASE = 'http://localhost:3001';
const SUPERADMIN_EMAIL = 'superadmin@notiq.ai';
const SUPERADMIN_PASSWORD = 'superadmin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CURRENT_VERSION: string = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8')).version;

interface TestUser {
  name: string;
  email: string;
  password: string;
}

/** Register + verify a user via API only — no browser session. Mirrors the
 *  provisioning half of helpers.ts `registerAndLogin`. */
async function provisionUser(name: string): Promise<TestUser> {
  const user: TestUser = { name, email: `e2e-scope-${uuidv4()}@example.com`, password: 'password123' };
  const api = await pwRequest.newContext({ baseURL: API_BASE });

  const loginRes = await api.post('/api/auth/login', {
    data: { email: SUPERADMIN_EMAIL, password: SUPERADMIN_PASSWORD },
  });
  const { token: saToken } = await loginRes.json();

  const inviteRes = await api.post('/api/invites', { headers: { Authorization: `Bearer ${saToken}` } });
  const { code: inviteCode } = await inviteRes.json();

  await api.post('/api/auth/register', {
    data: { email: user.email, password: user.password, name: user.name, invitationCode: inviteCode },
  });

  const usersRes = await api.get(`/api/admin/users?search=${encodeURIComponent(user.email)}`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  const { users } = await usersRes.json();
  const userId = users?.[0]?.id;
  if (!userId) throw new Error(`provisionUser: ${user.email} was not created in DB`);

  await api.put(`/api/admin/users/${userId}`, {
    headers: { Authorization: `Bearer ${saToken}` },
    data: { isVerified: true },
  });

  await api.dispose();
  return user;
}

/** Bearer token for an already-provisioned user, via a plain API login. */
async function tokenFor(user: TestUser): Promise<string> {
  const api = await pwRequest.newContext({ baseURL: API_BASE });
  const res = await api.post('/api/auth/login', { data: { email: user.email, password: user.password } });
  const { token } = await res.json();
  await api.dispose();
  return token;
}

/** Drives the actual browser login form for an already-provisioned user. */
async function browserLogin(page: import('@playwright/test').Page, user: TestUser): Promise<void> {
  await page.goto('/login');
  await page.evaluate((ver) => localStorage.setItem('lastSeenVersion', ver), CURRENT_VERSION);
  await page.fill('input[type="email"]', user.email);
  await page.fill('input[type="password"]', user.password);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/notes/, { timeout: 15000 });
  await expect(page.getByTestId('sidebar-item-notes')).toBeVisible({ timeout: 30000 });
}

test.describe('Kanban board list — cross-account scoping', () => {
  test('does not leak a previous account\'s board on this browser', async ({ page }) => {
    test.setTimeout(60000);

    // --- User A creates a board in the browser ---
    await registerAndLogin(page, { name: 'Scope User A' });
    await page.goto('/kanban');
    await page.getByRole('button', { name: 'New Board' }).first().click();
    await page.fill('input[placeholder="Board title"]', 'A-Only-Board');
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('A-Only-Board')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(1500);

    // --- Logout does NOT clear Dexie by design — that's the leak this guards against ---
    await page.click('button[title="Logout"]');
    await expect(page).toHaveURL('/login', { timeout: 10000 });

    // --- User B logs in on the SAME browser/IndexedDB ---
    await registerAndLogin(page, { name: 'Scope User B' });
    await page.goto('/kanban');
    await page.waitForTimeout(1500);

    // B must not see A's board.
    await expect(page.getByText('A-Only-Board')).not.toBeVisible();

    // B creates their own board — scoping isn't over-tightened either.
    await page.getByRole('button', { name: 'New Board' }).first().click();
    await page.fill('input[placeholder="Board title"]', 'B-Only-Board');
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('B-Only-Board')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('A-Only-Board')).not.toBeVisible();

    // --- "Offline reload" as B: API unreachable (syncPull can't run), so this
    // exercises Dexie alone. A full network-dead reload also kills Vite dev's own
    // asset requests (ERR_INTERNET_DISCONNECTED) for reasons unrelated to this
    // fix — production's service worker would serve the cached shell instead.
    await page.route('**/api/**', route => route.abort());
    await page.reload();
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible({ timeout: 15000 });
    await page.goto('/kanban');
    await expect(page.getByText('B-Only-Board')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('A-Only-Board')).not.toBeVisible();
    await page.unroute('**/api/**');
  });

  test('a shared board stays hidden until the first successful pull stamps it', async ({ page }) => {
    test.setTimeout(60000);

    // --- Provision A (owner) and B (recipient) via API only ---
    const userA = await provisionUser('Share Owner');
    const userB = await provisionUser('Share Recipient');
    const tokenA = await tokenFor(userA);
    const tokenB = await tokenFor(userB);

    // A creates a board and shares it with B; B accepts. All via API — this test
    // is about the PULL's fail-closed window, not the sharing UI.
    const api = await pwRequest.newContext({ baseURL: API_BASE });
    const boardRes = await api.post('/api/kanban/boards', {
      headers: { Authorization: `Bearer ${tokenA}` },
      data: { title: 'Shared-With-B' },
    });
    const board = await boardRes.json();

    await api.post(`/api/share/kanbans/${board.id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
      data: { email: userB.email, permission: 'READ' },
    });
    await api.post('/api/share/respond-id', {
      headers: { Authorization: `Bearer ${tokenB}` },
      data: { itemId: board.id, type: 'KANBAN', action: 'accept' },
    });
    await api.dispose();

    // --- B logs in with the kanban/share pull endpoints unreachable: the first
    // pull can't run, so the accepted board has never been stamped with B's
    // viewerId in this fresh browser profile. It must not appear. ---
    await page.route('**/api/kanban/**', route => route.abort());
    await page.route('**/api/share/**', route => route.abort());
    await browserLogin(page, userB);
    await page.goto('/kanban');
    await page.waitForTimeout(1500);
    await expect(page.getByRole('heading', { name: 'Shared-With-B' })).not.toBeVisible();

    // --- Endpoints reachable again + reload triggers useSync's initial pull ---
    await page.unroute('**/api/kanban/**');
    await page.unroute('**/api/share/**');
    await page.reload();
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible({ timeout: 15000 });
    await page.goto('/kanban');
    await expect(page.getByRole('heading', { name: 'Shared-With-B' })).toBeVisible({ timeout: 15000 });
  });
});
