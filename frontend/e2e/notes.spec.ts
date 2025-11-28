import { test, expect } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';

test.describe('Notes', () => {
  test.beforeEach(async ({ page }) => {
    // Register and login with unique email
    const email = `notes-${uuidv4()}@example.com`;
    const password = 'password123';

    await page.goto('/register');
    await page.fill('input[type="text"]', 'Notes User');
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/notes/, { timeout: 10000 });
    // Already logged in
  });

  test('should create a new note', async ({ page }) => {
    test.setTimeout(60000);
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));

    // Force English locale
    await page.addInitScript(() => {
      localStorage.setItem('i18nextLng', 'en');
    });

    const navLang = await page.evaluate(() => navigator.language);
    console.log('Navigator Language:', navLang);

    console.log('Current URL:', page.url());
    console.log('Waiting for sidebar...');
    // Wait for sidebar to be ready
    try {
      await expect(page.getByTestId('sidebar-item-notes')).toBeVisible({ timeout: 30000 });
    } catch (e) {
      console.log('Sidebar check failed. Page content:', await page.content());
      throw e;
    }

    console.log('Clicking New Note button...');
    // Click New Note button in sidebar
    // Use specific selector to avoid ambiguity with "Create New Note" in empty state
    // The sidebar button has 'rounded-full' and 'bg-emerald-600'
    const newNoteBtn = page.getByRole('button', { name: 'New Note', exact: true });
    await expect(newNoteBtn).toBeVisible();
    await newNoteBtn.click();

    console.log('Waiting for navigation...');
    // Should navigate to new note (URL contains noteId)
    await expect(page).toHaveURL(/.*noteId=.*/, { timeout: 10000 });

    console.log('Waiting for title input...');
    // Wait for editor to load
    const titleInput = page.locator('input[placeholder="Note Title"]');
    await expect(titleInput).toBeVisible({ timeout: 10000 });

    console.log('Filling title...');
    // Edit title
    await titleInput.fill('My First Note');

    console.log('Filling content...');
    // Edit content (Tiptap editor)
    // The editor usually has a contenteditable div
    const editor = page.locator('.ProseMirror');
    await expect(editor).toBeVisible();
    await editor.fill('This is the content of my first note.');

    console.log('Waiting for auto-save...');
    // Wait for auto-save (debounced 1000ms)
    await page.waitForTimeout(3000);
    // Wait for "Saved" indicator just to be sure
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10000 });

    console.log('Clicking on notebook in sidebar to see note list...');
    // The notebook in the sidebar should contain our note
    // First Notebook is created by default when creating a note without a notebook
    const notebookLink = page.locator('a[href^="/notes?notebookId="]').first();
    await expect(notebookLink).toBeVisible({ timeout: 5000 });
    await notebookLink.click();

    console.log('Checking list for updated title...');
    await expect(page.getByRole('heading', { name: 'My First Note' })).toBeVisible({ timeout: 10000 });

    console.log('Navigating back to note...');
    await page.getByRole('heading', { name: 'My First Note' }).click();

    await expect(page.locator('input[placeholder="Note Title"]')).toHaveValue('My First Note', { timeout: 10000 });
    await expect(page.locator('.ProseMirror')).toHaveText('This is the content of my first note.');
  });

  test('should delete a note', async ({ page }) => {
    console.log('Waiting for sidebar...');
    console.log('Waiting for sidebar...');
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible({ timeout: 30000 });

    console.log('Creating note to delete...');
    // Create a note first
    const newNoteBtn = page.getByRole('button', { name: 'New Note', exact: true });
    try {
      await expect(newNoteBtn).toBeVisible({ timeout: 5000 });
    } catch (e) {
      console.log('New Note button not found. Page content:', await page.content());
      throw e;
    }
    await newNoteBtn.click();
    await expect(page).toHaveURL(/.*noteId=.*/, { timeout: 10000 });

    const titleInput = page.locator('input[placeholder="Note Title"]');
    await expect(titleInput).toBeVisible({ timeout: 10000 });
    await titleInput.fill('Note to Delete');

    // Wait for auto-save
    await page.waitForTimeout(3000);
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10000 });

    // Handle confirm dialog
    page.on('dialog', dialog => {
      console.log('Dialog appeared:', dialog.message());
      dialog.accept();
    });

    console.log('Clicking Delete button...');
    // Click Delete button in toolbar (rounded-full version in NoteEditor toolbar)
    await page.locator('button.rounded-full[title="Delete"]').click();

    console.log('Verifying deletion...');
    // Navigate to notes list explicitly to verify note is deleted
    await page.goto('/notes');
    await expect(page.getByText('Note to Delete')).not.toBeVisible({ timeout: 5000 });
  });
});
