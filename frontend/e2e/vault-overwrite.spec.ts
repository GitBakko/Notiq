import { test, expect, request as pwRequest, type Page } from '@playwright/test';
import { registerAndLogin } from './helpers';
import { decryptCredential } from '../src/features/vault/credentialTypes';

// Vault P0: a device whose IndexedDB never received the content of a vault item (row content '')
// must never mount an editable form, or the form would save its default (empty) state over the
// server's real, encrypted content.
//
// Context A creates a real credential with the app's own flow (vault PIN, encrypted values).
// Context B is a clean browser (empty IndexedDB) for the same user with the same PIN.

const API = 'http://localhost:3001';
const PIN = '1234';
const TITLE = 'Server Credential';
const USERNAME = 'alice@example.com';
const PASSWORD = 'S3cret-Pass-42';
const NOTES = 'do not lose this';
const NOT_LOADED = /has not been loaded on this device yet/;

async function tokenOf(page: Page): Promise<string> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('auth-storage') || '{}').state?.token as string);
}

async function setupVault(page: Page) {
  await page.goto('/vault');
  await page.getByPlaceholder('Enter PIN').fill(PIN);
  await page.getByPlaceholder('Confirm PIN').fill(PIN);
  await page.locator('input[type="checkbox"]').check();
  await page.getByRole('button', { name: 'Create Vault' }).click();
  await expect(page.getByRole('button', { name: 'New Credential' })).toBeVisible({ timeout: 15000 });
}

test('clean device never overwrites the server credential (offline placeholder, typing, reconnect)', async ({ page, browser }) => {
  test.setTimeout(180000);

  // ---- Context A: create a real encrypted credential and let it sync ----
  const user = await registerAndLogin(page, { name: 'Vault Overwrite User' });
  const token = await tokenOf(page);
  const seenVersion = await page.evaluate(() => localStorage.getItem('lastSeenVersion'));
  const api = await pwRequest.newContext({ baseURL: API, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  const serverContent = async (id: string): Promise<string> => (await (await api.get(`/api/notes/${id}`)).json()).content;

  await setupVault(page);
  await page.getByRole('button', { name: 'New Credential' }).click();
  await expect(page).toHaveURL(/noteId=/, { timeout: 15000 });
  const noteId = new URL(page.url()).searchParams.get('noteId')!;

  // Wait for the (empty) credential to reach the server, then fill it in
  await expect.poll(() => serverContent(noteId), { timeout: 30000 }).toBeTruthy();
  await page.getByPlaceholder('Untitled Credential').fill(TITLE);
  await page.getByPlaceholder('Enter username or email').fill(USERNAME);
  await page.getByPlaceholder('Enter password').fill(PASSWORD);
  await page.getByPlaceholder('Additional notes...').fill(NOTES);
  // The values reach the server through the debounced sync push: wait until they decrypt to what we typed
  await expect
    .poll(async () => decryptCredential(await serverContent(noteId), PIN)?.password, { timeout: 45000 })
    .toBe(PASSWORD);
  await page.waitForTimeout(3000); // let the last debounced save settle
  const before = await serverContent(noteId);
  expect(decryptCredential(before, PIN)).toMatchObject({ username: USERNAME, password: PASSWORD, notes: NOTES });

  // ---- Context B: clean IndexedDB, same account, same PIN ----
  const ctxB = await browser.newContext({ locale: 'en' });
  await ctxB.addInitScript((v) => { if (v) localStorage.setItem('lastSeenVersion', v); }, seenVersion);
  const b = await ctxB.newPage();
  await b.goto('/login');
  await b.fill('input[type="email"]', user.email);
  await b.fill('input[type="password"]', user.password);
  await b.click('button[type="submit"]');
  await expect(b).toHaveURL(/\/notes/, { timeout: 15000 });
  await setupVault(b);
  await expect(b.getByText(TITLE)).toBeVisible({ timeout: 30000 }); // pulled: title only, content still ''

  const fields = b.locator(
    'input[placeholder="Untitled Credential"], input[placeholder="Enter username or email"], input[placeholder="Enter password"], textarea',
  );

  // The placeholder assertions below are SOFT on purpose: on pre-fix code the form is editable, the
  // typing attempts below really change it, and the hard byte-identical check after the reconnect
  // then fails with the actual overwrite instead of stopping earlier at the missing placeholder.
  const typeIntoAnyField = async () => {
    for (const f of await fields.all()) await f.fill('overwrite-attempt').catch(() => {});
    await b.keyboard.type('overwrite-attempt');
  };

  // (ii) Offline on a clean row: the placeholder, strictly, and nothing editable
  await ctxB.setOffline(true);
  await b.getByText(TITLE).click();
  await expect.soft(b.getByText(NOT_LOADED)).toBeVisible({ timeout: 10000 });
  await expect.soft(fields).toHaveCount(0);

  // (iii) Try to type wherever possible
  await typeIntoAnyField();
  await b.locator('body').press('Tab');
  await typeIntoAnyField();
  await expect.soft(fields).toHaveCount(0);

  // Navigate away, wait past the 1s save debounce, come back to the item, still offline
  await b.getByRole('button', { name: 'Back' }).click();
  await b.waitForTimeout(2500);
  await b.getByText(TITLE).click();
  await expect.soft(b.getByText(NOT_LOADED)).toBeVisible();
  expect(await serverContent(noteId)).toBe(before);

  // Back online + sync push time: the server content must be byte-identical (the real overwrite check)
  await ctxB.setOffline(false);
  await b.waitForTimeout(8000);
  expect(await serverContent(noteId)).toBe(before);

  // (i) Hydration re-ran by itself and shows the server's data (decrypted with the PIN)
  await expect(b.getByPlaceholder('Enter username or email')).toHaveValue(USERNAME, { timeout: 20000 });
  await expect(b.getByPlaceholder('Enter password')).toHaveValue(PASSWORD);
  await expect(b.getByPlaceholder('Additional notes...')).toHaveValue(NOTES);

  await ctxB.close();
  await api.dispose();
});
