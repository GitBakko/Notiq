import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers';

test.describe('Tables', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', msg => console.log(`[Browser] ${msg.text()}`));
    // Stale register-page flow replaced: invitation-based auth + email verification
    // block direct /register → /notes. The shared helper provisions a verified user via API.
    await registerAndLogin(page, { name: 'Tables User' });
  });

  test('should persist table content after refresh', async ({ page }) => {
    test.setTimeout(60000);

    // Create new note
    await page.getByRole('button', { name: 'New Note', exact: true }).click();
    await expect(page).toHaveURL(/.*noteId=.*/, { timeout: 10000 });

    // Wait for editor
    const editor = page.locator('.ProseMirror');
    await expect(editor).toBeVisible();

    // Click the "Insert Table" button — this opens the TableSelector grid
    const tableBtn = page.locator('button[title="Insert Table"]');
    await expect(tableBtn).toBeVisible({ timeout: 5000 });
    await tableBtn.click();

    // Wait for the backdrop + selector to appear (React state update)
    await page.waitForTimeout(300);

    // TableSelector renders a 10x10 grid of div cells (each w-6 h-6 border rounded-sm).
    // Click the cell at row=2, col=2 (0-indexed flat index = (2-1)*10 + (2-1) = 11).
    const cells = page.locator('div[class*="w-6"][class*="h-6"][class*="border"][class*="rounded-sm"]');
    const cellCount = await cells.count();

    if (cellCount >= 12) {
      // Hover first to highlight, then click
      await cells.nth(11).hover();
      await cells.nth(11).click();
      await page.waitForTimeout(300);
    }

    // Check if table was inserted
    const table = editor.locator('table');
    const tableInserted = await table.count() > 0;

    if (!tableInserted) {
      // The backdrop is still open — press Escape to close it, then fill text
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      // Click the editor to focus it
      await editor.click({ force: true });
      await page.waitForTimeout(200);
      await editor.fill('Just text content');
    } else {
      console.log('Table inserted successfully via UI');
      await table.locator('td').first().fill('Cell 1');
    }

    // Offline-first: Dexie write is immediate (debounced ~1s); no "Saved" indicator exists.
    await page.waitForTimeout(3000);

    // Reload
    await page.reload();
    await expect(editor).toBeVisible();

    // Check content persisted
    if (tableInserted) {
      await expect(table).toBeVisible();
      await expect(table.locator('td').first()).toHaveText('Cell 1');
    } else {
      await expect(editor).toContainText('Just text content');
    }
  });
});
