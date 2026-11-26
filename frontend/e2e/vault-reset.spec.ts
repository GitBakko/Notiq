import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { registerAndLogin, type TestUser } from './helpers';
import {
  apiFor, assertE2eBackend, confirmKitUi, createSecureNoteUi, createSuperadminViaApi, dumpDeviceStorage, expectUnlocked, keyringOf, loginInBrowser, lockUi, newDevice, NEW_PIN,
  PIN, serverNote, setupVaultUi, submitSetup, syncQueueOf, unlockUi,
} from './vault-helpers';

// Reset del vault (P3). Richiede backend con NODE_ENV=test + VAULT_E2E=1 (hook `__e2e/reset/advance`) e Vite con VITE_VAULT_E2E=1 (playwright.config.ts).

// Controllo visivo (non fa parte del test): con E2E_SHOTS=<cartella> ogni schermata chiave si salva a 375x812, chiaro e scuro.
const SHOTS = process.env.E2E_SHOTS;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const orig = page.viewportSize();
  await page.setViewportSize({ width: 375, height: 812 });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, `${name}-m-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: null });
  if (orig) await page.setViewportSize(orig);
}

const NOTE = { title: 'Nota del reset', body: 'contenuto segreto da cancellare' };

// Schermata di attesa del gate (ResetPendingScreen) e banner di AppLayout (nascosto su /vault): entrambi role=status, si distinguono dal testo.
const pendingScreen = (p: Page): Locator => p.getByRole('status').filter({ hasText: 'Until then it stays locked' });
const banner = (p: Page): Locator => p.getByRole('status').filter({ hasText: 'Vault reset scheduled: deletion on' });
const focusEvent = (p: Page) => p.evaluate(() => window.dispatchEvent(new Event('focus')));

/** Dal vault bloccato: "PIN dimenticato" -> reset -> codice + password -> conferma finale. Termina con la schermata di attesa. */
async function scheduleResetUi(page: Page, user: TestUser, shots = false) {
  await page.getByRole('button', { name: 'Forgot PIN?' }).click();
  if (shots) await shot(page, '01-forgot-panel');
  await page.getByRole('button', { name: 'I lost my PIN and my Recovery Kit' }).click();
  const dlg = page.getByRole('dialog', { name: 'Reset the vault' }); // il Modal ha il nome accessibile dal titolo
  await expect(dlg).toBeVisible();
  if (shots) await shot(page, '02-dialog-intro');
  await dlg.getByRole('button', { name: 'Continue' }).click();
  const shown = await dlg.locator('p.select-all').innerText({ timeout: 30000 });
  expect(shown.replace(/-/g, '')).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
  const submit = dlg.getByRole('button', { name: 'Reset the vault' });
  await expect(submit).toBeDisabled();
  if (shots) await shot(page, '03-dialog-code-empty');
  await dlg.getByLabel('Confirmation code').fill(shown.replace(/-/g, '').toLowerCase()); // minuscole e senza trattini: vale lo stesso
  await expect(submit).toBeDisabled(); // manca la password
  await dlg.getByLabel('Your account password').fill(user.password);
  await expect(submit).toBeEnabled();
  if (shots) await shot(page, '04-dialog-code-filled');
  await submit.click();
  const confirm = page.getByRole('dialog', { name: 'Delete the vault for good?' });
  await expect(confirm).toBeVisible();
  if (shots) await shot(page, '05-confirm-dialog');
  await confirm.getByRole('button', { name: 'Yes, reset the vault' }).click();
  await expect(pendingScreen(page)).toBeVisible({ timeout: 30000 });
}

/** A: setup, nota sicura, blocco. B: altro dispositivo, sbloccato e con la nota visibile. */
async function rig(page: Page, browser: import('@playwright/test').Browser, opts: { withB?: boolean } = {}) {
  const user = await registerAndLogin(page, { name: 'Vault Reset User' });
  const api = await apiFor(page);
  await assertE2eBackend(api);
  await setupVaultUi(page, user);
  const noteId = await createSecureNoteUi(page, api, NOTE);
  const oldEnvelope = (await serverNote(api, noteId)).content as string;
  let b: Awaited<ReturnType<typeof newDevice>> | undefined;
  if (opts.withB) {
    b = await newDevice(browser);
    await loginInBrowser(b.page, user);
    await b.page.goto('/vault');
    await expect(b.page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 30000 });
    await unlockUi(b.page);
    await expectUnlocked(b.page);
    await expect(b.page.getByText(NOTE.title)).toBeVisible({ timeout: 45000 });
  }
  await page.getByRole('button', { name: 'Back' }).click().catch(() => {});
  await lockUi(page);
  return { user, api, noteId, oldEnvelope, b };
}

/** Righe `isVault` di Dexie (id, content). */
async function vaultRowsOf(page: Page): Promise<{ id: string }[]> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('NotiqDB');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const r = db.transaction('notes', 'readonly').objectStore('notes').getAll();
      r.onsuccess = () => { db.close(); resolve((r.result as { id: string; isVault?: boolean }[]).filter((n) => n.isVault)); };
      r.onerror = () => reject(r.error);
    };
  }));
}

test('A programma il reset: B (sbloccato) si blocca e mostra il banner; A annulla, B sblocca col PIN di sempre e ha i dati', async ({ page, browser }) => {
  test.setTimeout(300000);
  const { user, api, b } = await rig(page, browser, { withB: true });
  const bp = b!.page;

  await scheduleResetUi(page, user, true);
  await expect(banner(page)).toHaveCount(0); // su /vault la schermata di attesa basta: niente banner doppio
  await shot(page, '06-pending-screen-A');
  await page.goto('/notes');
  await expect(banner(page)).toBeVisible({ timeout: 30000 });
  await shot(page, '06b-banner-on-notes-A');
  await page.goto('/vault');
  await expect(pendingScreen(page)).toBeVisible({ timeout: 30000 });
  const kr = await keyringOf(api);
  expect(kr.status).toBe('RESET_PENDING');
  expect(kr.resetScheduledAt).toBeTruthy();

  // B: al focus rilegge il keyring e si blocca (schermata di attesa, senza banner su /vault); fuori da /vault compare il banner
  await focusEvent(bp);
  await expect(pendingScreen(bp)).toBeVisible({ timeout: 30000 });
  await expect(bp.getByRole('button', { name: 'Vault settings' })).toHaveCount(0);
  await expect(banner(bp)).toHaveCount(0);
  await shot(bp, '07-pending-screen-B');
  await bp.getByTestId('sidebar-item-notes').click(); // navigazione SPA: il vault resta bloccato
  await expect(banner(bp)).toBeVisible({ timeout: 30000 });
  await shot(bp, '07b-banner-on-notes-B');
  await bp.getByRole('status').getByRole('button', { name: /Vault reset scheduled/ }).click(); // il testo del banner e' il pulsante verso /vault
  await expect(pendingScreen(bp)).toBeVisible({ timeout: 30000 });
  await expect(banner(bp)).toHaveCount(0);
  expect(await dumpDeviceStorage(bp)).not.toContain(NOTE.body); // il plaintext non e' mai su disco

  // A annulla dalla schermata di attesa
  await pendingScreen(page).getByRole('button', { name: 'Cancel reset' }).click();
  await expect(page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 30000 });
  await expect.poll(async () => (await keyringOf(api)).status, { timeout: 30000 }).toBe('READY');
  expect((await keyringOf(api)).resetScheduledAt ?? null).toBeNull();

  // B: al focus lascia la schermata di attesa SENZA ricaricare; stesso PIN e dati ancora li'
  await focusEvent(bp);
  await expect(pendingScreen(bp)).toBeHidden({ timeout: 30000 });
  await expect(bp.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 30000 });
  await unlockUi(bp, PIN);
  await expectUnlocked(bp);
  await expect(bp.getByText(NOTE.title)).toBeVisible({ timeout: 45000 });
  await bp.getByText(NOTE.title).click();
  await expect(bp.locator('.ProseMirror')).toContainText(NOTE.body, { timeout: 30000 });

  await b!.ctx.close();
});

test('reset eseguito (advance): B perde righe e coda vault e vede il setup; nuovo setup ok; push con envelope vecchio rifiutata', async ({ page, browser }) => {
  test.setTimeout(300000);
  const { user, api, noteId, oldEnvelope, b } = await rig(page, browser, { withB: true });
  const bp = b!.page;
  // B offline: modifica la nota -> elemento in coda, solo envelope su disco
  await b!.ctx.setOffline(true);
  await bp.getByText(NOTE.title).click();
  await bp.getByPlaceholder('Note Title').fill(`${NOTE.title} offline`);
  await expect.poll(async () => (await syncQueueOf(bp)).length, { timeout: 30000 }).toBeGreaterThan(0);
  await bp.getByRole('button', { name: 'Back' }).click();
  expect((await vaultRowsOf(bp)).length).toBeGreaterThan(0);

  // A programma il reset e il job lo esegue (hook)
  await scheduleResetUi(page, user);
  const adv = await api.post('/api/vault/__e2e/reset/advance');
  expect(adv.ok(), `advance ${adv.status()}`).toBe(true);
  expect((await adv.json()).completed).toBe(1);
  const after = await keyringOf(api);
  expect(after.status).toBe('NONE');
  expect(after.resetScheduledAt ?? null).toBeNull();

  // B torna online e rilegge: purge locale e schermata di setup
  await b!.ctx.setOffline(false);
  await focusEvent(bp);
  await expect.poll(async () => (await vaultRowsOf(bp)).length, { timeout: 60000 }).toBe(0);
  await expect.poll(async () => (await syncQueueOf(bp)).length, { timeout: 30000 }).toBe(0);
  expect(await dumpDeviceStorage(bp)).not.toContain(NOTE.title);
  await bp.goto('/vault');
  await expect(bp.getByRole('heading', { name: 'Set up your Vault' })).toBeVisible({ timeout: 30000 });
  await expect(bp.getByText(NOTE.title)).toHaveCount(0);

  // Il server non ha piu' la nota; una push con l'envelope vecchio e' rifiutata e la nota non risorge
  expect((await api.get(`/api/notes/${noteId}`)).ok()).toBe(false);
  const put = await api.put(`/api/notes/${noteId}`, { data: { content: oldEnvelope, title: '', isVault: true } });
  expect(put.ok(), `PUT con envelope vecchio: ${put.status()}`).toBe(false);
  const post = await api.post('/api/notes', { data: { id: noteId, content: oldEnvelope, title: '', isVault: true, noteType: 'SECURE_NOTE' } });
  expect(post.ok(), `POST con envelope vecchio: ${post.status()}`).toBe(false);
  expect((await api.get(`/api/notes/${noteId}`)).ok()).toBe(false);

  // Nuovo setup su B: va a buon fine, con un PIN nuovo
  await submitSetup(bp, user, { pin: NEW_PIN });
  await confirmKitUi(bp);
  await expectUnlocked(bp);
  const kr = await keyringOf(api);
  expect(kr.status).toBe('READY');
  expect(kr.epoch).toBeGreaterThan(0);
  expect((await api.get(`/api/notes/${noteId}`)).ok()).toBe(false);

  await b!.ctx.close();
});

test('GET /api/vault/keyring a 404 non cancella niente; con il 200 NONE il purge avviene', async ({ page, browser }) => {
  test.setTimeout(300000);
  const { user, api } = await rig(page, browser);
  await scheduleResetUi(page, user);
  const adv = await api.post('/api/vault/__e2e/reset/advance');
  expect(adv.ok(), `advance ${adv.status()}`).toBe(true);
  expect((await keyringOf(api)).status).toBe('NONE');

  const before = (await vaultRowsOf(page)).length;
  expect(before).toBeGreaterThan(0);
  const blocked = (route: import('@playwright/test').Route) =>
    route.request().method() === 'GET' ? route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"errors.common.notFound"}' }) : route.continue();
  await page.route('**/api/vault/keyring', blocked);
  // La pull normale cancella da sola le righe che il server non ha piu': qui la si ferma, cosi' il test misura solo il purge del keyring.
  await page.route('**/api/notes**', (route) => (route.request().method() === 'GET' ? route.abort('failed') : route.continue()));
  await page.goto('/vault');
  await expect(page.getByRole('heading', { name: 'Set up your Vault' })).toHaveCount(0);
  await page.waitForTimeout(3000);
  expect((await vaultRowsOf(page)).length).toBe(before);
  await focusEvent(page);
  await page.waitForTimeout(1500);
  expect((await vaultRowsOf(page)).length).toBe(before);

  // controllo positivo: senza il 404 la stessa pagina cancella
  await page.unroute('**/api/vault/keyring', blocked);
  await page.goto('/vault');
  await expect(page.getByRole('heading', { name: 'Set up your Vault' })).toBeVisible({ timeout: 30000 });
  await expect.poll(async () => (await vaultRowsOf(page)).length, { timeout: 30000 }).toBe(0);
});

test('l\'admin annulla il reset dalla tab Vault recovery', async ({ page, browser }) => {
  test.setTimeout(300000);
  const { user, api } = await rig(page, browser);
  await scheduleResetUi(page, user);
  expect((await keyringOf(api)).status).toBe('RESET_PENDING');

  const admUser = await createSuperadminViaApi('Vault Reset Admin');
  const adm = await newDevice(browser);
  await loginInBrowser(adm.page, admUser);
  await adm.page.goto('/admin');
  await adm.page.getByRole('button', { name: 'Vault recovery' }).click();
  await adm.page.getByLabel('Request type').selectOption({ label: 'Reset' });
  await adm.page.getByRole('button', { name: new RegExp(user.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
  const dlg = adm.page.getByRole('dialog').filter({ hasText: user.email });
  await expect(dlg).toBeVisible({ timeout: 30000 });
  await expect(dlg).toContainText('Vault reset in the waiting period');
  await dlg.getByRole('button', { name: 'Cancel reset' }).click();
  await adm.page.getByRole('dialog', { name: 'Cancel this vault reset?' }).getByRole('button', { name: 'Cancel reset' }).click();
  await expect.poll(async () => (await keyringOf(api)).status, { timeout: 30000 }).toBe('READY');
  expect((await keyringOf(api)).resetScheduledAt ?? null).toBeNull();

  // A: al ritorno vede il vault bloccato e normale, con i dati
  await page.goto('/vault');
  await expect(page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 30000 });
  await unlockUi(page, PIN);
  await expectUnlocked(page);
  await expect(page.getByText(NOTE.title)).toBeVisible({ timeout: 45000 });
  await adm.ctx.close();
});
