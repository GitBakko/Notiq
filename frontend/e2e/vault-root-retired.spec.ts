import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers';
import {
  apiFor, assertE2eBackend, assertTestRootKey, confirmKitUi, E2E_ROOT_KEY_ID, expectAllCurrent, expectUnlocked, keyringOf, kitDialog, openRecoveryOf, PIN,
  setupVaultUi, unlockUi,
} from './vault-helpers';

// Chiave root ritirata (1.15.1): l'hook E2E porta il keyring a `rk_68a265761e7e37c7` (id di produzione ritirato). Richiede backend con
// NODE_ENV=test + VAULT_E2E=1 e Vite con VITE_VAULT_E2E=1 (gli assert iniziali lo verificano).

const RETIRED_ID = 'rk_68a265761e7e37c7';

test('chiave root ritirata: recupero bloccato senza POST, foglio Kit obbligatorio, dopo il ri-sigillo il recupero parte', async ({ page }) => {
  test.setTimeout(300000);
  const user = await registerAndLogin(page, { name: 'Vault Retired Root User' });
  const api = await apiFor(page);
  await assertE2eBackend(api);
  await setupVaultUi(page, user);
  await assertTestRootKey(api);
  const epochBefore = (await keyringOf(api)).epoch as number;

  // ---- hook: il keyring passa alla chiave ritirata ----
  const hook = await api.post('/api/vault/__e2e/retire-root-key');
  expect(hook.ok(), `retire-root-key ${hook.status()}`).toBe(true);
  const retired = await keyringOf(api);
  expect(retired.rootKeyId).toBe(RETIRED_ID);
  expect(retired.rootKeyRetired).toBe(true);

  // ---- vault bloccato (ricarica): "PIN dimenticato" -> recupero col Kit mostra il messaggio e NON fa POST ----
  const posts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/vault\/recovery/.test(r.url())) posts.push(r.url()); });
  await page.goto('/vault');
  await expect(page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Forgot PIN?' }).click();
  await page.getByRole('button', { name: 'Recover with the Recovery Kit' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Recovery is not available for this vault. Unlock it with your PIN and generate a new Kit.' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('button', { name: 'I have the Kit, start the recovery' })).toHaveCount(0);
  await page.waitForTimeout(1000);
  expect(posts, 'nessuna POST /api/vault/recovery attesa').toEqual([]);
  expect(await openRecoveryOf(api)).toBeNull();
  await page.getByRole('button', { name: 'Close', exact: true }).first().click();

  // ---- sblocco col PIN: foglio obbligatorio col testo "ritirata", non chiudibile ----
  await expect(page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 30000 });
  await unlockUi(page, PIN);
  const sheet = page.getByRole('dialog', { name: 'Replace your Recovery Kit' });
  await expect(sheet).toBeVisible({ timeout: 60000 });
  await expect(sheet.getByRole('alert')).toContainText('The recovery key that protected your Recovery Kit has been replaced');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  await page.waitForTimeout(1000);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Close' })).toHaveCount(0);

  // ---- rigenerazione: ri-sigillo con la chiave attiva, VK ruotata ----
  await sheet.getByLabel('PIN to confirm').fill(PIN);
  await sheet.getByRole('button', { name: 'Generate new Kit' }).click();
  await confirmKitUi(page);
  await expect(sheet).toBeHidden({ timeout: 30000 });
  await expect(kitDialog(page)).toBeHidden();
  const after = await keyringOf(api);
  expect(after.rootKeyId).toBe(E2E_ROOT_KEY_ID);
  expect(after.rootKeyRetired).toBe(false);
  expect(after.epoch).toBe(epochBefore + 1);
  await expectAllCurrent(api);
  await expectUnlocked(page);

  // ---- dopo il ri-sigillo il recupero si avvia e si annulla ----
  await page.getByRole('button', { name: 'Lock Vault' }).click();
  await expect(page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Forgot PIN?' }).click();
  await page.getByRole('button', { name: 'Recover with the Recovery Kit' }).click();
  await page.getByRole('button', { name: 'I have the Kit, start the recovery' }).click();
  await expect(page.getByText('Waiting for an administrator to approve it.')).toBeVisible({ timeout: 30000 });
  expect((await openRecoveryOf(api))?.status).toBe('PENDING_APPROVAL');
  await page.getByRole('button', { name: 'Cancel request' }).click();
  await page.getByRole('dialog', { name: 'Cancel the recovery?' }).getByRole('button', { name: 'Cancel recovery' }).click();
  await expect.poll(() => openRecoveryOf(api), { timeout: 30000 }).toBeNull();
});
