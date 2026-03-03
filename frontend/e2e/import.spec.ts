import { test, expect, Page } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';

/**
 * Create a verified user directly in PostgreSQL and login via the UI.
 * This bypasses the registration flow which requires SMTP for email verification.
 * Password: 'password123' hashed with bcrypt (10 rounds).
 */
async function createUserAndLogin(
  page: Page,
  options?: { name?: string }
): Promise<{ email: string; password: string }> {
  const email = `test-${uuidv4()}@example.com`;
  const password = 'password123';
  const name = options?.name ?? 'Test User';
  const userId = uuidv4();
  const notebookId = uuidv4();

  // bcrypt hash of 'password123' with 10 rounds
  const bcryptHash = String.raw`$2b$10$e0GXtGXk8iAe861m.diEuuUBOXKMxjjgVlxEoIpUxM1LtV4JbIDN.`;

  // Create user + notebook directly in DB via a temp SQL file (avoids shell escaping issues with bcrypt $ signs)
  const tmpSqlPath = path.join(os.tmpdir(), `seed-${userId}.sql`);
  const sql = [
    `INSERT INTO "User" (id, email, password, name, role, "isVerified", "tokenVersion", "createdAt")`,
    `VALUES ('${userId}', '${email}', '${bcryptHash}', '${name}', 'USER', true, 0, NOW());`,
    `INSERT INTO "Notebook" (id, name, "userId", "createdAt", "updatedAt")`,
    `VALUES ('${notebookId}', 'First Notebook', '${userId}', NOW(), NOW());`,
  ].join('\n');
  fs.writeFileSync(tmpSqlPath, sql, 'utf-8');

  const containerSqlPath = `/tmp/seed-${userId}.sql`;
  try {
    // Copy SQL file into the Docker container and execute it (unique file name avoids parallel test conflicts)
    execSync(`docker cp "${tmpSqlPath}" notiq-db:${containerSqlPath}`, { timeout: 10000 });
    execSync(`docker exec notiq-db psql -U user -d evernote_clone -f ${containerSqlPath}`, { timeout: 10000 });
  } finally {
    if (fs.existsSync(tmpSqlPath)) fs.unlinkSync(tmpSqlPath);
    try { execSync(`docker exec notiq-db rm -f ${containerSqlPath}`, { timeout: 5000 }); } catch { /* ignore */ }
  }

  // Suppress "What's New" modal and force English locale
  await page.addInitScript(() => {
    localStorage.setItem('lastSeenVersion', '99.99.99');
    localStorage.setItem('i18nextLng', 'en');
  });

  // Login via UI
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/notes/, { timeout: 15000 });
  await expect(page.getByTestId('sidebar-item-notes')).toBeVisible({ timeout: 30000 });

  return { email, password };
}

/**
 * Dismiss any overlay modals that might block interaction.
 */
async function dismissModals(page: Page): Promise<void> {
  // Dismiss "What's New" modal
  const gotItBtn = page.getByRole('button', { name: 'Got it' });
  if (await gotItBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await gotItBtn.click();
    await page.waitForTimeout(300);
  }
}

test.describe('Import', () => {
  test('should import an Evernote .enex file as a note via Settings', async ({ page }) => {
    test.setTimeout(90000);
    await createUserAndLogin(page, { name: 'Import Evernote User' });

    // Create a minimal valid .enex file
    const tmpDir = os.tmpdir();
    const enexPath = path.join(tmpDir, `test-import-${uuidv4()}.enex`);
    const enexContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export export-date="20260303T120000Z" application="Evernote" version="10.0">
  <note>
    <title>Imported Evernote Note</title>
    <content><![CDATA[<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
<en-note>
  <p>This is imported content from Evernote.</p>
  <p>It has multiple paragraphs.</p>
</en-note>]]></content>
    <created>20260303T100000Z</created>
    <updated>20260303T110000Z</updated>
  </note>
</en-export>`;
    fs.writeFileSync(enexPath, enexContent, 'utf-8');

    try {
      // Navigate to Settings page
      await page.goto('/settings');
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 10000 });

      // Scroll down to import section
      await page.locator('text=Import Data').scrollIntoViewIfNeeded();

      // The hidden file input for Evernote import (use first() since sidebar also has one)
      const fileInput = page.locator('input[type="file"][accept=".enex"]').first();
      await fileInput.setInputFiles(enexPath);

      // Wait for success toast: "Successfully imported 1 notes!"
      await expect(page.getByText(/successfully imported/i)).toBeVisible({ timeout: 15000 });

      // Navigate to notes and verify the imported note exists
      await page.goto('/notes');
      await dismissModals(page);

      // The note should be visible in the sidebar notebook badge or in the notes list
      // Click on the notebook to see the notes list
      const notebookLink = page.locator('a[href^="/notes?notebookId="]').first();
      await expect(notebookLink).toBeVisible({ timeout: 5000 });
      await notebookLink.click();

      await expect(page.getByText('Imported Evernote Note')).toBeVisible({ timeout: 10000 });
    } finally {
      if (fs.existsSync(enexPath)) fs.unlinkSync(enexPath);
    }
  });

  test('should import a OneNote .html file as a note via Settings', async ({ page }) => {
    test.setTimeout(90000);
    await createUserAndLogin(page, { name: 'Import OneNote User' });

    // Create a minimal .html file (OneNote export format)
    const tmpDir = os.tmpdir();
    const htmlPath = path.join(tmpDir, `test-onenote-${uuidv4()}.html`);
    const htmlContent = `<!DOCTYPE html>
<html>
<head><title>Imported OneNote Page</title></head>
<body>
  <p>This is imported content from OneNote.</p>
  <p>It supports basic HTML formatting.</p>
</body>
</html>`;
    fs.writeFileSync(htmlPath, htmlContent, 'utf-8');

    try {
      // Navigate to Settings page
      await page.goto('/settings');
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 10000 });

      // Scroll down to import section
      await page.locator('text=Import Data').scrollIntoViewIfNeeded();

      // The hidden file input for OneNote import (use first() since sidebar also has one)
      const fileInput = page.locator('input[type="file"][accept=".mht,.mhtml,.html,.htm,.zip"]').first();
      await fileInput.setInputFiles(htmlPath);

      // Wait for success toast
      await expect(page.getByText(/successfully imported/i)).toBeVisible({ timeout: 15000 });

      // Navigate to notes and verify the imported note exists
      await page.goto('/notes');
      await dismissModals(page);

      const notebookLink = page.locator('a[href^="/notes?notebookId="]').first();
      await expect(notebookLink).toBeVisible({ timeout: 5000 });
      await notebookLink.click();

      await expect(page.getByText('Imported OneNote Page')).toBeVisible({ timeout: 10000 });
    } finally {
      if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath);
    }
  });

  test('should show error for invalid file format on Evernote import', async ({ page }) => {
    test.setTimeout(60000);
    await createUserAndLogin(page, { name: 'Import Error User' });

    // Navigate to Settings page
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 10000 });

    // Create a .txt file (invalid for Evernote import)
    const tmpDir = os.tmpdir();
    const txtPath = path.join(tmpDir, `invalid-import-${uuidv4()}.txt`);
    fs.writeFileSync(txtPath, 'This is not an enex file', 'utf-8');

    try {
      // Scroll down to import section
      await page.locator('text=Import Data').scrollIntoViewIfNeeded();

      // Try to upload the invalid file to the Evernote input
      const fileInput = page.locator('input[type="file"][accept=".enex"]').first();
      await fileInput.setInputFiles(txtPath);

      // The useImport hook checks the extension and shows an error toast
      await expect(page.getByText(/import failed/i)).toBeVisible({ timeout: 10000 });
    } finally {
      if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath);
    }
  });

  test('should import from Notes page when notebook is selected', async ({ page }) => {
    test.setTimeout(90000);
    await createUserAndLogin(page, { name: 'Import Notes User' });

    // Create a temp .enex file
    const tmpDir = os.tmpdir();
    const enexPath = path.join(tmpDir, `test-notes-import-${uuidv4()}.enex`);
    const enexContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export export-date="20260303T120000Z" application="Evernote" version="10.0">
  <note>
    <title>Note From NotesPage Import</title>
    <content><![CDATA[<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
<en-note>
  <p>Imported via the Notes page import button.</p>
</en-note>]]></content>
    <created>20260303T100000Z</created>
  </note>
</en-export>`;
    fs.writeFileSync(enexPath, enexContent, 'utf-8');

    try {
      // Dismiss any modals that might block interaction
      await dismissModals(page);

      // Click on the notebook in sidebar to navigate to notes with notebookId
      // The user has a "First Notebook" created during setup
      const notebookLink = page.locator('a[href^="/notes?notebookId="]').first();
      await expect(notebookLink).toBeVisible({ timeout: 5000 });
      await notebookLink.click();

      // Wait for notes page with notebook context
      await expect(page).toHaveURL(/\/notes\?notebookId=/, { timeout: 5000 });

      // The import button (FileDown icon) should be visible when a notebook is selected
      const importBtn = page.locator('button[title="Import from Evernote"]');
      await expect(importBtn).toBeVisible({ timeout: 5000 });

      // Set the file on the hidden input
      const fileInput = page.locator('input[type="file"][accept=".enex"]').first();
      await fileInput.setInputFiles(enexPath);

      // Wait for success toast
      await expect(page.getByText(/successfully imported/i)).toBeVisible({ timeout: 15000 });

      // Verify the imported note appears in the list
      await expect(page.getByText('Note From NotesPage Import')).toBeVisible({ timeout: 10000 });
    } finally {
      if (fs.existsSync(enexPath)) fs.unlinkSync(enexPath);
    }
  });
});
