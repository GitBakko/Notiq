import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers';

test.describe('Encryption', () => {
  test.beforeEach(async ({ page }) => {
    // Stale register-page flow replaced: invitation-based auth + email verification
    // block direct /register → /notes. The shared helper provisions a verified user via API.
    await registerAndLogin(page, { name: 'Encryption User' });
  });

  test('should insert, lock, and unlock an encrypted block', async ({ page }) => {
    // PBKDF2 (100k iterations) runs twice in-browser — slow under parallel CPU contention
    test.slow();

    // Capture browser logs and errors
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', err => console.log('BROWSER ERROR:', err));

    // 1. Create a new note
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible({ timeout: 10000 });
    const newNoteBtn = page.getByRole('button', { name: 'New Note', exact: true });
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
    await expect(page.locator('textarea')).toHaveValue('This is a secret message.');

    // 10. Re-lock
    const lockBtn = page.getByRole('button', { name: 'Lock', exact: true });
    await lockBtn.click();
    await expect(page.getByText('Encrypted Content')).toBeVisible();

    // 11. Reload and Verify Persistence
    // Offline-first: Dexie write is immediate (debounced ~1s); no "Saved" indicator exists.
    await page.waitForTimeout(3000);
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
