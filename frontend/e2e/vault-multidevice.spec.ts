import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers';
import {
  apiFor, createCredentialUi, createSecureNoteUi, expectUnlocked, loginInBrowser, logoutUi, newDevice, PIN, setupVaultUi, unlockUi, WRONG_PIN,
} from './vault-helpers';

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
