import { test, expect, request as pwRequest } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

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

/**
 * Register, verify and login a user via API + browser.
 * Mirrors the pattern from helpers.ts `registerAndLogin`.
 */
async function registerAndLoginInContext(
  page: import('@playwright/test').Page,
  options?: { name?: string }
): Promise<TestUser> {
  const user: TestUser = {
    name: options?.name ?? 'Test User',
    email: `e2e-${uuidv4()}@example.com`,
    password: 'password123',
  };

  const api = await pwRequest.newContext({ baseURL: API_BASE });

  // 1. Superadmin login
  const loginRes = await api.post('/api/auth/login', {
    data: { email: SUPERADMIN_EMAIL, password: SUPERADMIN_PASSWORD },
  });
  const { token: saToken } = await loginRes.json();

  // 2. Generate invitation code
  const inviteRes = await api.post('/api/invites', {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  const { code: inviteCode } = await inviteRes.json();

  // 3. Register (SMTP may fail — ignore the error, the user row is created)
  await api.post('/api/auth/register', {
    data: {
      email: user.email,
      password: user.password,
      name: user.name,
      invitationCode: inviteCode,
    },
  });

  // 4. Find the user via admin search
  const usersRes = await api.get(`/api/admin/users?search=${encodeURIComponent(user.email)}`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  const { users } = await usersRes.json();
  const userId = users?.[0]?.id;
  if (!userId) throw new Error(`User ${user.email} was not created in DB`);

  // 5. Verify the user
  await api.put(`/api/admin/users/${userId}`, {
    headers: { Authorization: `Bearer ${saToken}` },
    data: { isVerified: true },
  });

  await api.dispose();

  // Browser login (suppress What's New modal)
  await page.goto('/login');
  await page.evaluate((ver) => {
    localStorage.setItem('lastSeenVersion', ver);
  }, CURRENT_VERSION);
  await page.fill('input[type="email"]', user.email);
  await page.fill('input[type="password"]', user.password);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/notes/, { timeout: 15000 });
  await expect(page.getByTestId('sidebar-item-notes')).toBeVisible({ timeout: 30000 });

  return user;
}

/**
 * Create a note in the editor and wait for auto-save to sync to the server.
 */
async function createNoteAndWait(
  page: import('@playwright/test').Page,
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

  // Wait for auto-save debounce + sync to complete.
  // The note title should appear in the note list as confirmation.
  await expect(page.locator('.flex-1').getByText(title).first()).toBeVisible({ timeout: 15000 });
  // Extra wait for the sync push to the server
  await page.waitForTimeout(3000);
}

/**
 * Open the note's share modal (scoped to the NoteEditor header, not the sidebar).
 */
async function openNoteShareModal(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('header:has(input[placeholder="Note Title"])').locator('button[title="Share"]').click();
  await expect(page.locator('input[placeholder="Enter email address"]')).toBeVisible({ timeout: 5000 });
}

/**
 * Share the currently open note with a user email.
 */
async function shareCurrentNote(page: import('@playwright/test').Page, email: string): Promise<void> {
  await openNoteShareModal(page);

  const emailInput = page.locator('input[placeholder="Enter email address"]');
  await emailInput.fill(email);
  await emailInput.locator('..').locator('button[type="submit"]').click();

  // Wait for the success toast
  await expect(page.getByText('Invitation sent successfully')).toBeVisible({ timeout: 10000 });
}

test.describe('Collaboration', () => {
  test('User A shares a note with User B, who sees it in Sharing Center', async ({ browser }) => {
    test.setTimeout(90000);

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      // Register both users
      const userA = await registerAndLoginInContext(pageA, { name: 'Collab User A' });
      const userB = await registerAndLoginInContext(pageB, { name: 'Collab User B' });

      // User A creates a note and shares it with User B
      await createNoteAndWait(pageA, 'Shared Collab Note', 'Content from User A');
      await shareCurrentNote(pageA, userB.email);

      // User B navigates to the Sharing Center page
      await pageB.goto('/shared');
      await pageB.waitForLoadState('networkidle');

      // The shared note should appear under "Pending Invitations" in the Notes tab
      await expect(pageB.getByText('Shared Collab Note')).toBeVisible({ timeout: 15000 });

      // Verify the "INVITATION" badge is visible (pending state)
      await expect(pageB.getByText('INVITATION', { exact: true })).toBeVisible({ timeout: 5000 });

      // Verify the sharer's name is shown
      await expect(pageB.getByText('Collab User A')).toBeVisible({ timeout: 5000 });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('User B can accept a shared note invitation', async ({ browser }) => {
    test.setTimeout(90000);

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      const userA = await registerAndLoginInContext(pageA, { name: 'Accept User A' });
      const userB = await registerAndLoginInContext(pageB, { name: 'Accept User B' });

      // User A creates and shares a note
      await createNoteAndWait(pageA, 'Accept Test Note', 'Testing acceptance flow');
      await shareCurrentNote(pageA, userB.email);

      // User B goes to Sharing Center and accepts the invitation
      await pageB.goto('/shared');
      await pageB.waitForLoadState('networkidle');
      await expect(pageB.getByText('Accept Test Note')).toBeVisible({ timeout: 15000 });

      // Click the Accept button
      await pageB.getByRole('button', { name: 'Accept' }).click();

      // After accepting, the note should remain visible (now in accepted section)
      await expect(pageB.getByText('Accept Test Note')).toBeVisible({ timeout: 10000 });

      // The "INVITATION" badge should disappear as the note moves to accepted section
      await expect(pageB.getByText('INVITATION', { exact: true })).not.toBeVisible({ timeout: 10000 });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('Shared note shows correct permission level (READ)', async ({ browser }) => {
    test.setTimeout(90000);

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      const userA = await registerAndLoginInContext(pageA, { name: 'Perm User A' });
      const userB = await registerAndLoginInContext(pageB, { name: 'Perm User B' });

      await createNoteAndWait(pageA, 'Permission Test Note', 'Testing read permission');

      // Open share modal and verify the permission dropdown defaults to READ
      await openNoteShareModal(pageA);
      const emailInput = pageA.locator('input[placeholder="Enter email address"]');
      const permSelect = emailInput.locator('..').locator('select');
      await expect(permSelect).toHaveValue('READ');

      // Share with default READ permission
      await emailInput.fill(userB.email);
      await emailInput.locator('..').locator('button[type="submit"]').click();
      await expect(pageA.getByText('Invitation sent successfully')).toBeVisible({ timeout: 10000 });

      // User B checks the Sharing Center
      await pageB.goto('/shared');
      await pageB.waitForLoadState('networkidle');
      await expect(pageB.getByText('Permission Test Note')).toBeVisible({ timeout: 15000 });

      // The pending card should show the READ permission badge
      await expect(pageB.getByText('READ')).toBeVisible({ timeout: 5000 });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('User A can see sent invitation in Sharing Center', async ({ browser }) => {
    test.setTimeout(90000);

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      const userA = await registerAndLoginInContext(pageA, { name: 'Sent User A' });
      const userB = await registerAndLoginInContext(pageB, { name: 'Sent User B' });

      await createNoteAndWait(pageA, 'Sent Invite Note', 'Checking sent invitations');
      await shareCurrentNote(pageA, userB.email);

      // Close the modal (first X button is the modal close)
      await pageA.locator('button').filter({ has: pageA.locator('svg.lucide-x') }).first().click();

      // User A navigates to Sharing Center and switches to "Sent" tab
      await pageA.goto('/shared');
      await pageA.getByRole('button', { name: 'Sent' }).click();

      // The sent invitation should be visible
      await expect(pageA.getByText('Sent Invite Note')).toBeVisible({ timeout: 10000 });

      // Should show pending status
      await expect(pageA.getByText('Pending')).toBeVisible({ timeout: 5000 });

      // Should show the target user's name
      await expect(pageA.getByText('Sent User B')).toBeVisible({ timeout: 5000 });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
