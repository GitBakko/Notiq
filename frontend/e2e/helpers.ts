import { Page, expect, request as pwRequest } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const API_BASE = 'http://localhost:3001';
const SUPERADMIN_EMAIL = 'superadmin@notiq.ai';
const SUPERADMIN_PASSWORD = 'superadmin';

// Read the current version from package.json so we can suppress the "What's New" modal
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CURRENT_VERSION: string = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8')).version;

export interface TestUser {
  name: string;
  email: string;
  password: string;
}

/**
 * Create a verified user via the API and log in through the browser.
 *
 * Flow:
 *  1. Login as superadmin → get admin JWT
 *  2. Generate an invitation code
 *  3. Register the test user (SMTP may fail, but the DB row is created)
 *  4. Look up the new user via admin search to get their ID
 *  5. Mark the user as verified via admin API
 *  6. Navigate to /login in the browser, fill credentials, submit
 *  7. Wait for redirect to /notes and sidebar to appear
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

  // --- API setup (runs outside the browser) ---
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

  // 3. Register (SMTP send may throw — ignore the error, the user row is created)
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
  if (!userId) throw new Error(`registerAndLogin: user ${user.email} was not created in DB`);

  // 5. Verify the user
  await api.put(`/api/admin/users/${userId}`, {
    headers: { Authorization: `Bearer ${saToken}` },
    data: { isVerified: true },
  });

  await api.dispose();

  // --- Browser login ---
  // Suppress the "What's New" modal by marking the current version as seen
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
 * Create a new note with title and optional content.
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
 * Create a new notebook via sidebar.
 * Hovers the Notebooks group, clicks the Create Notebook button,
 * fills the name in the dialog, and submits.
 */
export async function createNotebook(page: Page, name: string): Promise<void> {
  // Hover over Notebooks section to reveal the create button
  const notebooksGroup = page.locator('.group').filter({ hasText: 'Notebooks' }).first();
  await notebooksGroup.hover();

  // Click the Create Notebook button (title attribute)
  const createBtn = page.getByTitle('Create Notebook');
  await expect(createBtn).toBeVisible({ timeout: 5000 });
  await createBtn.click({ force: true });

  // Fill the notebook name in the dialog
  const nameInput = page.locator('input[placeholder="Notebook name"]');
  await expect(nameInput).toBeVisible({ timeout: 5000 });
  await nameInput.fill(name);

  // Click Create inside the dialog
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();

  // Verify the notebook appears in the sidebar
  await expect(page.getByText(name)).toBeVisible({ timeout: 10000 });
}

/**
 * Create a new kanban board.
 * Navigates to /kanban, opens the new board modal, fills the title, and submits.
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
 * Navigates to /tasks, opens the new list modal, fills the title, and submits.
 */
export async function createTaskList(page: Page, title: string): Promise<void> {
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'New List' }).click();

  // The modal input has placeholder from i18n key taskLists.editTitle = "Edit title"
  const titleInput = page.locator('input[placeholder="Edit title"]');
  await expect(titleInput).toBeVisible({ timeout: 5000 });
  await titleInput.fill(title);

  // Submit via the Create button in the modal
  await page.getByRole('button', { name: 'Create' }).click();

  await expect(page.getByText(title)).toBeVisible({ timeout: 5000 });
}

/**
 * Wait for the "Saved" indicator to appear.
 */
export async function waitForSave(page: Page): Promise<void> {
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10000 });
}
