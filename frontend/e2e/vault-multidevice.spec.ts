import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers';
import {
  apiFor, createCredentialUi, createSecureNoteUi, expectUnlocked, loginInBrowser, logoutUi, newDevice, PIN, setupVaultUi, unlockUi, WRONG_PIN,
} from './vault-helpers';

async function vaultRowsOf(page: import('@playwright/test').Page): Promise<{ title?: string; content?: string; isVault?: boolean }[]> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('NotiqDB');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const r = db.transaction('notes', 'readonly').objectStore('notes').getAll();
      r.onsuccess = () => { db.close(); resolve((r.result as { isVault?: boolean }[]).filter((n) => n.isVault)); };
      r.onerror = () => reject(r.error);
    };
  }));
}

// Accettazione 3 (dispositivo B chiede il PIN e decifra) e 8 (logout -> login porta allo sblocco, non al setup).

test('dispositivo B (contesto pulito) chiede il PIN, rifiuta quello sbagliato e decifra; logout/login di A portano allo sblocco', async ({ page, browser }) => {
  test.setTimeout(240000);
  const user = await registerAndLogin(page, { name: 'Vault Multi Device' });
  const api = await apiFor(page);

  // ---- A: setup + una nota sicura e una credenziale ----
  await setupVaultUi(page, user);
  const noteTitle = 'Segreto di A';
  const noteBody = 'testo cifrato di A';
  await createSecureNoteUi(page, api, { title: noteTitle, body: noteBody });
  await createCredentialUi(page, api, { title: 'Banca di A', username: 'alice@example.com', password: 'S3cret-Pass-42', notes: 'nota cred' });

  // ---- B: dispositivo nuovo, stesso utente ----
  const b = await newDevice(browser);
  await loginInBrowser(b.page, user);
  await b.page.goto('/vault');
  // Chiede il PIN, non il setup
  await expect(b.page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 30000 });
  await expect(b.page.getByRole('heading', { name: 'Set up your Vault' })).toHaveCount(0);

  // PIN sbagliato (stessa lunghezza, maiuscole/minuscole diverse): non sblocca
  await unlockUi(b.page, WRONG_PIN);
  await expect(b.page.getByRole('alert').filter({ hasText: 'Incorrect PIN' })).toBeVisible({ timeout: 30000 });
  await expect(b.page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible();
  // Il PIN giusto con le maiuscole cambiate e' sbagliato (case-sensitive). Prima l'avviso del tentativo precedente deve sparire / l'input svuotarsi.
  const alertWrong = b.page.getByRole('alert').filter({ hasText: 'Incorrect PIN' });
  await expect.poll(async () => (await alertWrong.count()) === 0 || (await b.page.getByPlaceholder('Enter PIN').inputValue()) === '', { timeout: 15000 }).toBe(true);
  await unlockUi(b.page, PIN.toUpperCase());
  await expect(alertWrong).toBeVisible({ timeout: 30000 });
  await expect(b.page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible();

  // PIN giusto: sblocca e decifra titoli e contenuti
  await unlockUi(b.page, PIN);
  await expectUnlocked(b.page);
  await expect(b.page.getByText(noteTitle)).toBeVisible({ timeout: 45000 });
  await expect(b.page.getByText('Banca di A')).toBeVisible({ timeout: 45000 });
  await b.page.getByText(noteTitle).click();
  await expect(b.page.getByPlaceholder('Note Title')).toHaveValue(noteTitle, { timeout: 30000 });
  await expect(b.page.locator('.ProseMirror')).toContainText(noteBody, { timeout: 30000 });
  await b.page.getByRole('button', { name: 'Back' }).click();
  await b.page.getByText('Banca di A').click();
  await expect(b.page.getByPlaceholder('Enter username or email')).toHaveValue('alice@example.com', { timeout: 30000 });
  await expect(b.page.getByPlaceholder('Enter password')).toHaveValue('S3cret-Pass-42');
  await b.ctx.close();

  // ---- A: logout e login -> sblocco, non setup ----
  await logoutUi(page);
  await loginInBrowser(page, user);
  await page.goto('/vault');
  await expect(page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('heading', { name: 'Set up your Vault' })).toHaveCount(0);
  await unlockUi(page, PIN);
  await expectUnlocked(page);
  await expect(page.getByText(noteTitle)).toBeVisible({ timeout: 30000 });
  await api.dispose();
});

test('J.7/T-h: dopo Rimuovi dal dispositivo la pull successiva idrata i titoli senza Controlla ora', async ({ page }) => {
  test.setTimeout(240000);
  const user = await registerAndLogin(page, { name: 'Vault Rehydrate After Pull' });
  const api = await apiFor(page);
  await setupVaultUi(page, user);
  await createSecureNoteUi(page, api, { title: 'MK-J7-TITLE', body: 'MK-J7-BODY' });
  await page.getByRole('button', { name: 'Back', exact: true }).click();

  const holdPull = async (route: import('@playwright/test').Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/notes' && url.searchParams.get('all') === '1') return route.abort('failed');
    return route.continue();
  };
  await page.route('**/api/notes?*', holdPull);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Remove from this device', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove from this device', exact: true }).click();
  await expect(page.getByText('Vault removed from this device', { exact: true })).toBeVisible({ timeout: 15000 });

  await page.goto('/vault');
  await unlockUi(page);
  await expectUnlocked(page);
  expect(await vaultRowsOf(page)).toHaveLength(0);
  await page.unroute('**/api/notes?*', holdPull);

  await expect(page.getByRole('heading', { name: 'MK-J7-TITLE', exact: true })).toBeVisible({ timeout: 90000 });
  const rows = await vaultRowsOf(page);
  expect(rows).toHaveLength(1);
  expect(rows[0].title).toBe('');
  expect(rows[0].content).toMatch(/^nv3\./);
  await api.dispose();
});
