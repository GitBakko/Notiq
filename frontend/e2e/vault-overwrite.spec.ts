import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers';
import {
  apiFor, createCredentialUi, expectUnlocked, loginInBrowser, newDevice, PIN, serverNote, setupVaultUi, unlockUi,
} from './vault-helpers';

// Vault P0 (adattato al vault v3): a device whose IndexedDB never received the content of a vault item (row content '')
// must never mount an editable form, or the form would save its default (empty) state over the server's real, encrypted content.
//
// Device A: setup v3 (PIN + Kit) and a real credential. Device B is a clean browser context for the same user: it logs in
// (the pull creates the row with content ''), unlocks with the SAME PIN (the vault already exists: unlock, never setup),
// and the content download (POST /api/vault/items) is held back so the row stays clean.

const TITLE = 'Server Credential';
const USERNAME = 'alice@example.com';
const PASSWORD = 'S3cret-Pass-42';
const NOTES = 'do not lose this';
const NOT_LOADED = /has not been loaded on this device yet/;

test('clean device never overwrites the server credential (placeholder, typing, hydration after the content arrives)', async ({ page, browser }) => {
  test.setTimeout(240000);

  // ---- Device A: create a real encrypted credential and let it sync ----
  const user = await registerAndLogin(page, { name: 'Vault Overwrite User' });
  const api = await apiFor(page);
  await setupVaultUi(page, user);
  const noteId = await createCredentialUi(page, api, { title: TITLE, username: USERNAME, password: PASSWORD, notes: NOTES });
  await page.waitForTimeout(3000); // let the last debounced save settle
  const before = (await serverNote(api, noteId)).content as string;
  expect(before).toMatch(/^nv3\./);
  const serverContent = async () => ((await serverNote(api, noteId)).content as string);

  // ---- Device B: clean IndexedDB, same account, same PIN ----
  const b = await newDevice(browser);
  await loginInBrowser(b.page, user);
  // the pull created the row with an empty content (title only)
  await expect
    .poll(
      () =>
        b.page.evaluate(
          () =>
            new Promise<number>((resolve) => {
              const open = indexedDB.open('NotiqDB');
              open.onsuccess = () => {
                const db = open.result;
                const r = db.transaction('notes', 'readonly').objectStore('notes').getAll();
                r.onsuccess = () => {
                  db.close();
                  const v = (r.result as { isVault?: boolean; content?: string }[]).filter((n) => n.isVault);
                  resolve(v.length === 1 ? (v[0].content ?? '').length : -1);
                };
              };
            }),
        ),
      { timeout: 30000 },
    )
    .toBe(0);

  // hold the content download back: the row stays clean after the unlock
  await b.ctx.route('**/api/vault/items', (route) => route.abort('failed'));
  await b.page.goto('/vault');
  await expect(b.page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 30000 }); // unlock, not setup
  await unlockUi(b.page, PIN);
  await expectUnlocked(b.page);

  const fields = b.page.locator(
    'input[placeholder="Untitled Credential"], input[placeholder="Enter username or email"], input[placeholder="Enter password"], textarea',
  );

  // The placeholder assertions below are SOFT on purpose: on pre-fix code the form is editable, the typing attempts
  // below really change it, and the hard byte-identical check then fails with the actual overwrite instead of
  // stopping earlier at the missing placeholder.
  const typeIntoAnyField = async () => {
    for (const f of await fields.all()) await f.fill('overwrite-attempt').catch(() => {});
    await b.page.keyboard.type('overwrite-attempt');
  };
  const card = () => b.page.getByText('Credential', { exact: true }).first(); // title is still empty: the card shows the type badge

  // (ii) clean row, content not available: the placeholder, strictly, and nothing editable
  await card().click();
  await expect.soft(b.page.getByText(NOT_LOADED)).toBeVisible({ timeout: 15000 });
  await expect.soft(fields).toHaveCount(0);

  // (iii) try to type wherever possible
  await typeIntoAnyField();
  await b.page.locator('body').press('Tab');
  await typeIntoAnyField();
  await expect.soft(fields).toHaveCount(0);

  // Navigate away, wait past the 1s save debounce, come back to the item
  await b.page.getByRole('button', { name: 'Back' }).first().click();
  await b.page.waitForTimeout(2500);
  await card().click();
  await expect.soft(b.page.getByText(NOT_LOADED)).toBeVisible();
  expect(await serverContent()).toBe(before);

  // The content becomes reachable again + sync push time: the server content must be byte-identical (the real overwrite check)
  await b.ctx.unroute('**/api/vault/items');
  await b.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await b.page.waitForTimeout(8000);
  expect(await serverContent()).toBe(before);

  // (i) hydration re-ran by itself and shows the server's data (decrypted with the PIN)
  await expect(b.page.getByPlaceholder('Enter username or email')).toHaveValue(USERNAME, { timeout: 30000 });
  await expect(b.page.getByPlaceholder('Enter password')).toHaveValue(PASSWORD);
  await expect(b.page.getByPlaceholder('Additional notes...')).toHaveValue(NOTES);
  expect(await serverContent()).toBe(before);

  await b.ctx.close();
  await api.dispose();
});
