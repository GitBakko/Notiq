import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers';

test.describe('Kanban Boards', () => {
  test.beforeEach(async ({ page }) => {
    // Stale register-page flow replaced: invitation-based auth + email verification
    // block direct /register → /notes. The shared helper provisions a verified user via API.
    await registerAndLogin(page, { name: 'Kanban User' });
  });

  test('should navigate to kanban page', async ({ page }) => {
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();

    await page.click('a[href="/kanban"]');
    await expect(page).toHaveURL(/\/kanban/);
    await expect(page.getByText('Kanban Boards')).toBeVisible();
  });

  test('should create a new board', async ({ page }) => {
    test.setTimeout(30000);

    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();
    await page.click('a[href="/kanban"]');
    await expect(page).toHaveURL(/\/kanban/);

    // Click New Board button (use first() — both the header button and empty-state button exist)
    await page.getByRole('button', { name: 'New Board' }).first().click();

    // Fill in the title
    await page.fill('input[placeholder="Board title"]', 'Test Board');
    await page.fill('textarea[placeholder="Description (optional)"]', 'A test board');

    // Submit
    // Scope to the modal dialog to avoid matching the "Create Notebook" sidebar button
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();

    // Board should appear in the list
    await expect(page.getByText('Test Board')).toBeVisible({ timeout: 5000 });
  });

  test('should open a board and see default columns', async ({ page }) => {
    test.setTimeout(30000);

    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();
    await page.click('a[href="/kanban"]');
    await expect(page).toHaveURL(/\/kanban/);

    // Create a board first
    await page.getByRole('button', { name: 'New Board' }).first().click();
    await page.fill('input[placeholder="Board title"]', 'Column Board');
    // Scope to the modal dialog to avoid matching the "Create Notebook" sidebar button
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('Column Board')).toBeVisible({ timeout: 5000 });

    // Click the board to open it
    await page.getByText('Column Board').click();

    // Should see the board page with default columns (To Do, In Progress, Done)
    await expect(page.getByText('To Do')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('In Progress')).toBeVisible();
    await expect(page.getByText('Done')).toBeVisible();
  });

  test('should add a card to a column', async ({ page }) => {
    test.setTimeout(45000);

    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();
    await page.click('a[href="/kanban"]');

    // Create board
    await page.getByRole('button', { name: 'New Board' }).first().click();
    await page.fill('input[placeholder="Board title"]', 'Card Board');
    // Scope to the modal dialog to avoid matching the "Create Notebook" sidebar button
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('Card Board')).toBeVisible({ timeout: 5000 });

    // Open board
    await page.getByText('Card Board').click();
    await expect(page.getByText('To Do')).toBeVisible({ timeout: 5000 });

    // Click "Add card" in the first column (To Do)
    const addCardButtons = page.getByRole('button', { name: 'Add card' });
    await addCardButtons.first().click();

    // Fill card title and submit with Enter
    const cardInput = page.locator('input[placeholder="Card title"]');
    await expect(cardInput).toBeVisible({ timeout: 3000 });
    await cardInput.fill('My First Card');
    await cardInput.press('Enter');

    // Card should appear in the column
    await expect(page.getByText('My First Card')).toBeVisible({ timeout: 5000 });
  });

  test('should add a new column', async ({ page }) => {
    test.setTimeout(45000);

    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();
    await page.click('a[href="/kanban"]');

    // Create board
    await page.getByRole('button', { name: 'New Board' }).first().click();
    await page.fill('input[placeholder="Board title"]', 'Extra Column Board');
    // Scope to the modal dialog to avoid matching the "Create Notebook" sidebar button
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('Extra Column Board')).toBeVisible({ timeout: 5000 });

    // Open board
    await page.getByText('Extra Column Board').click();
    await expect(page.getByText('To Do')).toBeVisible({ timeout: 5000 });

    // Click "Add column"
    await page.getByRole('button', { name: 'Add column' }).click();

    // Fill column title and submit
    const columnInput = page.locator('input[placeholder="Column title"]');
    await expect(columnInput).toBeVisible({ timeout: 3000 });
    await columnInput.fill('Review');
    await columnInput.press('Enter');

    // New column should appear
    await expect(page.getByText('Review')).toBeVisible({ timeout: 5000 });
  });

  test('should delete a board', async ({ page }) => {
    test.setTimeout(30000);

    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();
    await page.click('a[href="/kanban"]');

    // Create board
    await page.getByRole('button', { name: 'New Board' }).first().click();
    await page.fill('input[placeholder="Board title"]', 'Delete Me Board');
    // Scope to the modal dialog to avoid matching the "Create Notebook" sidebar button
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('Delete Me Board')).toBeVisible({ timeout: 5000 });

    // Find the board card and trigger the context menu (3-dot/MoreVertical button, opacity-0 by default)
    const boardCard = page.locator('[class*="rounded"]').filter({ hasText: 'Delete Me Board' }).first();
    await boardCard.hover();

    // Force-click the MoreVertical button (it is opacity-0 until hover, use force to bypass)
    const menuBtn = boardCard.locator('button').first();
    await menuBtn.click({ force: true });

    // The dropdown menu appears — wait for "Delete" button to be visible (it's in a dropdown inside the board card)
    const dropdownDeleteBtn = boardCard.getByRole('button', { name: 'Delete' });
    await expect(dropdownDeleteBtn).toBeVisible({ timeout: 3000 });
    await dropdownDeleteBtn.click();

    // App uses ConfirmDialog (never window.confirm) — confirm deletion in the "Delete board" dialog
    const deleteBoardDialog = page.getByRole('dialog', { name: 'Delete board' });
    await expect(deleteBoardDialog).toBeVisible({ timeout: 3000 });
    await deleteBoardDialog.getByRole('button', { name: 'Delete' }).click();

    // Board should be gone
    await expect(page.getByText('Delete Me Board')).not.toBeVisible({ timeout: 5000 });
  });
});
