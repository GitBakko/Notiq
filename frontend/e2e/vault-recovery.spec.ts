import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { registerAndLogin, type TestUser } from './helpers';
import {
  advanceRecovery, apiFor, assertE2eBackend, assertTestRootKey, codeBOf, confirmKitUi, createSecureNoteUi, createSuperadminViaApi, deviceStoreKeys,
  E2E_ROOT_PASSPHRASE, expectUnlocked, keyringOf, kitDialog, loginInBrowser, lockUi, newDevice, NEW_PIN, openRecoveryOf, PIN, readKit, setupVaultUi,
  unlockUi, userIdOf,
} from './vault-helpers';

// Recupero del vault con il Kit (P4 Fase 4): richiedente A, altro dispositivo B, superadmin ADM. Richiede backend con NODE_ENV=test + VAULT_E2E=1
// e Vite con VITE_VAULT_E2E=1 (lo fa playwright.config.ts): gli assert iniziali falliscono con un messaggio chiaro se manca uno dei due.

// Controllo visivo (non fa parte del test): con E2E_SHOTS=<cartella> ogni schermata chiave si salva a 375x812 e 1280x800, chiaro e scuro.
const SHOTS = process.env.E2E_SHOTS;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const orig = page.viewportSize();
  for (const [w, h, tag] of [[375, 812, 'm'], [1280, 800, 'd']] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(SHOTS, `${name}-${tag}-${scheme}.png`) });
    }
  }
  await page.emulateMedia({ colorScheme: null });
  if (orig) await page.setViewportSize(orig);
}

const NOTE = { title: 'Nota del recupero', body: 'contenuto segreto di A' };

interface Rig {
  user: TestUser; api: APIRequestContext; b: { ctx: BrowserContext; page: Page }; adm: { ctx: BrowserContext; page: Page; user: TestUser };
  requestId: string; fp: string; kit: string; escrowBefore: string; codeB: string;
}

const openUnlockRecovery = async (page: Page) => {
  await page.getByRole('button', { name: 'Forgot PIN?' }).click();
  await page.getByRole('button', { name: 'Recover with the Recovery Kit' }).click();
};

/** ADM: tab "Vault recovery", riga dell'utente, scheda di dettaglio aperta. */
async function openAdminDetail(adm: Page, email: string) {
  await adm.goto('/admin');
  await adm.getByRole('button', { name: 'Vault recovery' }).click();
  await adm.getByRole('button', { name: new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
  const dlg = adm.getByRole('dialog', { name: 'Recovery request' });
  await expect(dlg).toBeVisible({ timeout: 30000 });
  return dlg;
}

/** Dal setup fino alla richiesta RELEASED (A resta bloccato). */
async function runToReleased(page: Page, browser: Browser): Promise<Rig> {
  const user = await registerAndLogin(page, { name: 'Vault Recovery User' });
  const api = await apiFor(page);
  await assertE2eBackend(api);

  // ---- A: setup, nota sicura, blocco ----
  const kit = await setupVaultUi(page, user);
  await assertTestRootKey(api);
  await createSecureNoteUi(page, api, NOTE);
  const escrowBefore = (await keyringOf(api)).escrowHash as string;
  await lockUi(page);

  // ---- A: "PIN dimenticato" -> avvio del recupero ----
  await openUnlockRecovery(page);
  await expect(page.getByRole('heading', { name: 'Recover access with your Recovery Kit' })).toBeVisible();
  await shot(page, '01-intro');
  await page.getByRole('button', { name: 'I have the Kit, start the recovery' }).click();
  await expect(page.getByText('Waiting for an administrator to approve it.')).toBeVisible({ timeout: 30000 });
  const fp = /Request code: (\S+)/.exec(await page.getByText(/Request code:/).innerText())![1];
  const open = await openRecoveryOf(api);
  expect(open?.status).toBe('PENDING_APPROVAL');
  expect(open?.fingerprint).toBe(fp);
  const requestId = open!.id;
  await shot(page, '02-pending-approval');

  // ---- B: stesso utente, altro dispositivo: banner con lo stesso FP e schermata "foreign" ----
  const b = await newDevice(browser);
  await loginInBrowser(b.page, user);
  const bannerB = b.page.getByRole('status').filter({ hasText: 'Vault recovery requested' });
  await expect(bannerB).toBeVisible({ timeout: 30000 });
  await expect(bannerB).toContainText(fp);
  await shot(b.page, '03-banner-B');
  await b.page.goto('/vault?recovery=1');
  await expect(b.page.getByRole('heading', { name: 'A recovery is open elsewhere' })).toBeVisible({ timeout: 30000 });
  await shot(b.page, '04-foreign-B');

  // ---- ADM: superadmin nuovo, approva ----
  const admUser = await createSuperadminViaApi('Vault Recovery Admin');
  const adm = { ...(await newDevice(browser)), user: admUser };
  await loginInBrowser(adm.page, admUser);
  const dlg = await openAdminDetail(adm.page, user.email);
  await expect(dlg).toContainText(user.email);
  await expect(dlg).toContainText(fp);
  await shot(adm.page, '05-admin-detail-approve');
  await dlg.getByRole('button', { name: 'Approve' }).click();
  await expect(dlg.getByText('Awaiting codes')).toBeVisible({ timeout: 30000 });
  await dlg.getByRole('button', { name: 'Close' }).first().click();

  // ---- A: metà A precompilata; B: nessun codice nel DOM ----
  await page.goto('/vault?recovery=1');
  await expect(page.getByRole('heading', { name: 'Enter the recovery code' })).toBeVisible({ timeout: 30000 });
  const halfA = page.getByLabel('Half A', { exact: true });
  const codeA = (await halfA.inputValue()).replace(/[^0-9A-Z]/g, '');
  expect(codeA).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  const codeB = await codeBOf(api, requestId);
  await shot(page, '06-code-form-A');

  await b.page.goto('/vault?recovery=1');
  await expect(b.page.getByRole('heading', { name: 'A recovery is open elsewhere' })).toBeVisible({ timeout: 30000 });
  const bodyB = await b.page.locator('body').innerText();
  expect(bodyB).not.toContain(codeA);
  expect(bodyB).not.toContain(codeB);
  expect(await b.page.getByRole('textbox').count()).toBe(0);

  // ---- A: metà B errata (tentativi 5 -> 4), poi giusta ----
  const inputB = page.getByLabel('Half B (from the email)');
  await inputB.fill('ABCDEFGH');
  await page.getByRole('button', { name: 'Confirm the code' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'The codes are not correct' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText('Attempts left: 4')).toBeVisible();
  await expect(inputB).toHaveValue('');
  await inputB.fill(codeB);
  await page.getByRole('button', { name: 'Confirm the code' }).click();
  await expect(page.getByText(/The waiting period ends on/)).toBeVisible({ timeout: 30000 });
  await shot(page, '07-waiting');

  // ---- fine dell'attesa, rilascio da ADM ----
  await advanceRecovery(api, requestId);
  await page.goto('/vault?recovery=1');
  await expect(page.getByText('The waiting period is over.')).toBeVisible({ timeout: 30000 });

  const dlg2 = await openAdminDetail(adm.page, user.email);
  const pass = dlg2.getByLabel('Root key passphrase');
  await expect(pass).toBeVisible({ timeout: 30000 });
  await shot(adm.page, '08-admin-release-form');
  const confirmRelease = async () => adm.page.getByRole('dialog', { name: 'Release this recovery?' }).getByRole('button', { name: 'Release', exact: true }).click();
  await pass.fill('wrong-passphrase');
  await dlg2.getByRole('button', { name: 'Release', exact: true }).click();
  await confirmRelease();
  await expect(dlg2.getByRole('alert').filter({ hasText: 'The passphrase is not valid.' })).toBeVisible({ timeout: 60000 });
  await expect(dlg2.getByLabel('Root key passphrase')).toHaveValue('');
  await dlg2.getByLabel('Root key passphrase').fill(E2E_ROOT_PASSPHRASE);
  await dlg2.getByRole('button', { name: 'Release', exact: true }).click();
  await confirmRelease();
  await expect(dlg2.getByText('Released', { exact: true })).toBeVisible({ timeout: 60000 });
  await expect(dlg2.getByLabel('Root key passphrase')).toHaveCount(0); // la passphrase non resta nel DOM: il campo sparisce con lo stato RELEASED
  await shot(adm.page, '09-admin-released');

  return { user, api, b, adm, requestId, fp, kit, escrowBefore, codeB };
}

test('recupero completo: richiesta, approvazione, codici, attesa, rilascio, Kit nuovo, PIN nuovo', async ({ page, browser }) => {
  test.setTimeout(600000);
  const r = await runToReleased(page, browser);
  const { api, requestId, kit } = r;
  const userId = await userIdOf(page);

  // ---- A: form di completamento: Kit vecchio + PIN nuovo due volte ----
  await page.goto('/vault?recovery=1');
  await expect(page.getByRole('heading', { name: 'Complete the recovery' })).toBeVisible({ timeout: 30000 });
  await shot(page, '10-complete-form');
  await page.getByLabel('Recovery Kit', { exact: true }).fill(kit);
  await page.getByLabel('New PIN', { exact: true }).fill(NEW_PIN);
  await page.getByLabel('Confirm PIN', { exact: true }).fill(NEW_PIN);
  await page.getByRole('button', { name: 'Recover access' }).click();

  // Foglio del Kit nuovo: finche e' aperto non compare il banner "Kit non confermato"
  const { groups } = await readKit(page);
  expect(groups).toHaveLength(8);
  await expect(page.getByText('The Recovery Kit was not confirmed')).toHaveCount(0);
  await shot(page, '11-kit-sheet');
  const newKit = await confirmKitUi(page);
  expect(newKit).not.toBe(kit);
  await expect(page.getByText('The Recovery Kit was not confirmed')).toHaveCount(0);
  await expectUnlocked(page);

  // La nota sicura e' leggibile con il vault sbloccato dal recupero
  await page.getByText(NOTE.title).click();
  await expect(page.getByPlaceholder('Note Title')).toHaveValue(NOTE.title, { timeout: 30000 });
  await expect(page.locator('.ProseMirror')).toContainText(NOTE.body, { timeout: 30000 });

  // Stato locale: nessun marker di recupero ne di Kit non confermato
  const keys = await deviceStoreKeys(page);
  expect(keys.deviceKeys.filter((k) => k === `recovery:${userId}`)).toEqual([]);
  expect(keys.pending.filter((k) => k.startsWith(`${userId}:kit`))).toEqual([]);

  // Server: richiesta COMPLETED, escrow cambiato
  const rec = await (await api.get(`/api/vault/recovery/${requestId}`)).json();
  expect(rec.status).toBe('COMPLETED');
  expect((await keyringOf(api)).escrowHash).not.toBe(r.escrowBefore);
  expect((await keyringOf(api)).openRecovery).toBeNull();

  // PIN: il vecchio e' rifiutato, il nuovo sblocca
  await page.goto('/vault');
  await expect(page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 30000 });
  await unlockUi(page, PIN);
  const wrong = page.getByRole('alert').filter({ hasText: 'Incorrect PIN' });
  await expect(wrong).toBeVisible({ timeout: 60000 });
  await expect.poll(async () => (await wrong.count()) === 0 || (await page.getByPlaceholder('Enter PIN').inputValue()) === '', { timeout: 15000 }).toBe(true);
  await unlockUi(page, NEW_PIN);
  await expectUnlocked(page);
  await expect(page.getByText(NOTE.title)).toBeVisible({ timeout: 45000 });

  await Promise.all([r.b.ctx.close(), r.adm.ctx.close()]);
});

test('rotazione del Kit: rilascio annullato da B, foglio obbligatorio al primo sblocco di A', async ({ page, browser }) => {
  test.setTimeout(600000);
  const r = await runToReleased(page, browser);
  const { api, b } = r;

  // A: dal form di completamento, "Annulla" avverte che la richiesta era gia' rilasciata; si rinuncia
  await page.goto('/vault?recovery=1');
  await expect(page.getByRole('heading', { name: 'Complete the recovery' })).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Cancel request' }).click();
  const warn = page.getByRole('dialog', { name: 'Cancel the recovery?' });
  await expect(warn).toContainText(/already.*released/);
  await warn.getByRole('button', { name: 'Keep it' }).click();
  await expect(warn).toBeHidden();

  // B: banner "rilasciata", annulla dal banner
  await b.page.goto('/notes');
  const banner = b.page.getByRole('status').filter({ hasText: 'Vault recovery released' });
  await expect(banner).toBeVisible({ timeout: 30000 });
  await shot(b.page, '12-banner-released-B');
  await banner.getByRole('button', { name: 'Cancel recovery' }).click();
  await b.page.getByRole('dialog', { name: 'Cancel the recovery?' }).getByRole('button', { name: 'Cancel recovery' }).click();
  await expect(banner).toBeHidden({ timeout: 30000 });
  await expect.poll(() => openRecoveryOf(api), { timeout: 30000 }).toBeNull();
  expect((await keyringOf(api)).kitRotationRequired).toBe(true);

  // A: sblocco con il PIN di sempre -> foglio di rotazione obbligatorio e non chiudibile
  await page.goto('/vault');
  await expect(page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 30000 });
  await unlockUi(page, PIN);
  const sheet = page.getByRole('dialog', { name: 'Replace your Recovery Kit' });
  await expect(sheet).toBeVisible({ timeout: 60000 });
  await expect(sheet.getByRole('alert')).toContainText('no longer safe');
  await expect(sheet).toContainText('destroy every copy of the previous one');
  await shot(page, '13-rotation-sheet');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  // La transizione di uscita non e' istantanea: dopo l'assestamento il foglio deve essere ancora li', non solo subito.
  await page.waitForTimeout(1000);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Close' })).toHaveCount(0);

  // Rigenera e conferma: il foglio sparisce e il segnale si spegne
  await sheet.getByLabel('PIN to confirm').fill(PIN);
  await sheet.getByRole('button', { name: 'Generate new Kit' }).click();
  expect((await readKit(page)).groups).toHaveLength(8);
  await confirmKitUi(page);
  await expect(sheet).toBeHidden({ timeout: 30000 });
  await expect(kitDialog(page)).toBeHidden();
  expect((await keyringOf(api)).kitRotationRequired).toBe(false);
  expect((await keyringOf(api)).escrowHash).not.toBe(r.escrowBefore);

  await Promise.all([r.b.ctx.close(), r.adm.ctx.close()]);
});
