import { test, expect } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';

test.describe('Encryption', () => {
  test.beforeEach(async ({ page }) => {
    // Register and login with unique email
    const email = `encryption-${uuidv4()}@example.com`;
    const password = 'password123';

    await page.goto('/register');
    await page.fill('input[type="text"]', 'Encryption User');
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/notes/, { timeout: 10000 });
  });

  test('should insert, lock, and unlock an encrypted block', async ({ page }) => {
    // Capture browser logs and errors
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', err => console.log('BROWSER ERROR:', err));

    // 1. Create a new note
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible({ timeout: 10000 });
    const newNoteBtn = page.locator('button.rounded-full.bg-emerald-600').filter({ hasText: 'New Note' });
    await expect(newNoteBtn).toBeVisible();
    await newNoteBtn.click();
    await expect(page).toHaveURL(/.*noteId=.*/, { timeout: 10000 });

    // Wait for editor to load
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 10000 });

    const titleInput = page.locator('input[placeholder="Note Title"]');
    await expect(titleInput).toBeVisible({ timeout: 10000 });
    await titleInput.fill('Secret Note');

    // 2. Insert Encrypted Block
    // The button has title "Insert Encrypted Block"
    const insertEncryptedBlockBtn = page.locator('button[title="Insert Encrypted Block"]');
    await expect(insertEncryptedBlockBtn).toBeVisible();
    await insertEncryptedBlockBtn.click();

    // 3. Verify Setup State
    await expect(page.getByText('New Encrypted Block')).toBeVisible();
    await expect(page.getByText('Set Encryption PIN')).toBeVisible();

    // 4. Enter Content and PIN
    const contentArea = page.locator('textarea[placeholder="Enter confidential content here..."]');
    await contentArea.fill('This is a secret message.');

    const pinInputs = page.locator('input[placeholder="PIN"]');
    await expect(pinInputs).toHaveCount(1);
    await pinInputs.fill('1234');

    // 5. Encrypt
    const encryptBtn = page.getByRole('button', { name: 'Encrypt', exact: true });
    await encryptBtn.click();

    // 6. Verify Locked State
    await expect(page.getByText('Encrypted Content')).toBeVisible();
    await expect(page.getByText('This is a secret message.')).not.toBeVisible();

    // 7. Try Incorrect PIN
    // Click unlock button to open modal
    await page.locator('button[title="Unlock"]').click();

    // Now verify modal is open
    await expect(page.getByText('Enter PIN to view content', { exact: false })).toBeVisible();

    const unlockPinInput = page.locator('input[placeholder="PIN"]');
    await unlockPinInput.fill('0000');
    // Scope to dialog to avoid matching the icon button
    const unlockBtn = page.getByRole('dialog').getByRole('button', { name: 'Unlock', exact: true });
    await unlockBtn.click();
    await expect(page.getByText('Incorrect PIN')).toBeVisible();

    // 8. Unlock with Correct PIN
    await unlockPinInput.fill('1234');
    await unlockBtn.click();

    // 9. Verify Unlocked State
    // 9. Verify Unlocked State
    await expect(page.locator('textarea')).toHaveValue('This is a secret message.');

    // 10. Re-lock
    const lockBtn = page.getByRole('button', { name: 'Lock', exact: true });
    await lockBtn.click();
    await expect(page.getByText('Encrypted Content')).toBeVisible();

    // 11. Reload and Verify Persistence
    // Wait for debounce (1s) and save to complete
    await page.waitForTimeout(2000);
    await page.reload();
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 10000 });

    // Debug: Log editor content
    const editorContent = await page.locator('.ProseMirror').innerHTML();
    console.log('Editor HTML after reload:', editorContent);
    const editorText = await page.locator('.ProseMirror').innerText();
    console.log('Editor Text after reload:', editorText);

    await expect(page.getByText('Encrypted Content')).toBeVisible(); // Should be locked by default on load

    // Click unlock button to open modal
    await page.locator('button[title="Unlock"]').click();

    await unlockPinInput.fill('1234');
    await unlockBtn.click();
    await expect(page.locator('textarea')).toHaveValue('This is a secret message.');
  });
});
