import { test, expect } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';

test.describe('Tags', () => {
  test.beforeEach(async ({ page }) => {
    const email = `tags-${uuidv4()}@example.com`;
    const password = 'password123';

    await page.goto('/register');
    await page.fill('input[type="text"]', 'Tag User');
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/notes/, { timeout: 10000 });
  });

  test('should create a tag from sidebar', async ({ page }) => {
    // Wait for sidebar
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();

    // Hover over Tags section
    const tagsGroup = page.locator('.group').filter({ hasText: 'Tags' }).first();
    await tagsGroup.hover();

    // Click Add Tag button
    const addTagBtn = page.getByTitle('Add Tag');
    await expect(addTagBtn).toBeVisible({ timeout: 5000 });
    await addTagBtn.click();

    // Fill input (placeholder="New tag...")
    const input = page.getByPlaceholder('New tag...');
    await expect(input).toBeVisible({ timeout: 5000 });
    await input.fill('My Tag');
    await input.press('Enter');

    // Verify
    await expect(page.getByText('My Tag')).toBeVisible({ timeout: 10000 });
  });

  test('should add a tag to a note', async ({ page }) => {
    // Wait for sidebar
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();

    // Create note first using the specific button
    const newNoteBtn = page.locator('button.rounded-full.bg-emerald-600').filter({ hasText: 'New Note' });
    await expect(newNoteBtn).toBeVisible();
    await newNoteBtn.click();
    await expect(page).toHaveURL(/.*noteId=.*/, { timeout: 10000 });

    // Wait for the note editor to load
    await expect(page.locator('input[placeholder="Note Title"]')).toBeVisible({ timeout: 10000 });

    // Add tag
    // The button with text "Add Tag" - use the one in the editor (not sidebar)
    // The editor Add Tag button has specific classes and is inside the editor area
    await page.getByText('Add Tag', { exact: true }).click();

    // Search input placeholder="Search or create tag..."
    const input = page.getByPlaceholder('Search or create tag...');
    await expect(input).toBeVisible({ timeout: 5000 });
    await input.fill('Note Tag');

    // Click create option
    // The option text is: Create tag "Note Tag"
    // Use regex to be safe about quotes
    const createOption = page.getByText(/Create tag.*Note Tag/);
    await expect(createOption).toBeVisible({ timeout: 5000 });
    await createOption.click();

    // Verify tag is added (it appears as a badge)
    // The badge usually has the tag name.
    // In NoteEditor/TagSelector, it renders badges.
    // TagSelector renders:
    // {noteTags.map(... => <span ...>{t.tag.name}</span>)}
    await expect(page.getByText('#Note Tag')).toBeVisible({ timeout: 10000 });
  });
});
