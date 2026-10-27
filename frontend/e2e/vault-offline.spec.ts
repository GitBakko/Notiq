import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers';
import {
  apiFor, blockApi, createCredentialUi, createSecureNoteUi, deviceShareOf, dumpDeviceStorage, expectUnlocked, loginInBrowser, lockUi, newDevice, noteIdOf, PIN, serverNote, setupVaultUi,
  syncQueueOf, unblockApi, unlockUi, userIdOf, vaultCacheOf, waitForServerEdit,
} from './vault-helpers';

async function dexieNoteOf(page: import('@playwright/test').Page, id: string): Promise<{ isVault?: boolean; content?: string } | undefined> {
  return page.evaluate((noteId) => new Promise((resolve, reject) => {
    const open = indexedDB.open('NotiqDB');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const r = db.transaction('notes', 'readonly').objectStore('notes').get(noteId);
      r.onsuccess = () => { db.close(); resolve(r.result); };
      r.onerror = () => reject(r.error);
    };
  }), id);
}

async function seedOfflineEdit(page: import('@playwright/test').Page, id: string, content: string): Promise<void> {
  await page.evaluate(({ noteId, value }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('NotiqDB');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['notes', 'syncQueue'], 'readwrite');
      const r = tx.objectStore('notes').get(noteId);
      r.onsuccess = () => {
        tx.objectStore('notes').put({ ...r.result, content: value, syncStatus: 'updated' });
        tx.objectStore('syncQueue').add({
          type: 'UPDATE', entity: 'NOTE', entityId: noteId, userId: r.result.userId,
          data: { content: value }, createdAt: Date.now(),
        });
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), { noteId: id, value: content });
}

// Accettazione 7 (interruttore OFF: niente wrappedVkPin/share, avviso offline) e 9 (offline: sblocco con cache, avviso senza, mai il setup).
// "Offline" = (a) navigator.onLine=false con la SPA gia' caricata (ctx.setOffline) e (b) server irraggiungibile con reload
// (le /api abortite, Vite servito: in dev il Service Worker non e' attivo e un reload davvero offline non carica gli asset).

test('interruttore ON: sblocco offline con la cache (SPA offline e reload con server irraggiungibile) e edit in coda', async ({ page }) => {
  test.setTimeout(300000);
  const user = await registerAndLogin(page, { name: 'Vault Offline On' });
  const api = await apiFor(page);
  const ctx = page.context();
  const uid = await userIdOf(page);

  await setupVaultUi(page, user, { offlineUnlock: true });
  const credId = await createCredentialUi(page, api, { title: 'Cred Offline', username: 'bob@example.com', password: 'pw-uno-1' });
  expect(await deviceShareOf(page, uid)).not.toBeNull();
  expect(await vaultCacheOf(page, uid)).toMatchObject({ offlineUnlock: true, status: 'READY' });
  expect((await vaultCacheOf(page, uid))!.wrappedVkPin).toBeTruthy();

  // (a) navigator offline, SPA gia' caricata: blocca e sblocca senza rete
  await ctx.setOffline(true);
  await lockUi(page);
  await unlockUi(page, PIN);
  await expectUnlocked(page);
  await lockUi(page);
  await ctx.setOffline(false);

  // (b) reload con server irraggiungibile: sblocco dalla cache locale
  await blockApi(ctx);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('heading', { name: 'Set up your Vault' })).toHaveCount(0);
  await unlockUi(page, PIN);
  await expectUnlocked(page);

  // edit offline -> in coda (solo envelope), il server non cambia
  const before = (await serverNote(api, credId)).content as string;
  await page.getByText('Cred Offline').click();
  await expect(page.getByPlaceholder('Enter password')).toHaveValue('pw-uno-1', { timeout: 30000 });
  await page.getByPlaceholder('Enter password').fill('pw-due-offline-2');
  await expect.poll(async () => (await syncQueueOf(page)).length, { timeout: 30000 }).toBeGreaterThan(0);
  const queue = (await syncQueueOf(page)).join('\n');
  expect(queue).not.toContain('pw-due-offline-2');
  expect(queue).not.toContain('Cred Offline');
  expect(queue).not.toContain('bob@example.com');
  expect(queue).toMatch(/nv3\./);
  expect((await serverNote(api, credId)).content).toBe(before);
  const noPlain = async (when: string) => {
    const dump = await dumpDeviceStorage(page);
    expect(dump, 'il dump non e vuoto').toContain('nv3.');
    for (const needle of ['pw-due-offline-2', 'Cred Offline', 'bob@example.com']) expect(dump.includes(needle), `${needle} in storage ${when}`).toBe(false);
  };
  await noPlain('dopo l edit offline');

  // di nuovo online: la coda parte e il server riceve un envelope nuovo
  await unblockApi(ctx);
  await waitForServerEdit(api, credId, before);
  await expect.poll(async () => (await syncQueueOf(page)).length, { timeout: 45000 }).toBe(0);
  await noPlain('dopo il reconcile');
  await api.dispose();
});

test('interruttore OFF: nessun share sul dispositivo, avviso offline; acceso dalle impostazioni vale dal prossimo sblocco online', async ({ page }) => {
  test.setTimeout(300000);
  const user = await registerAndLogin(page, { name: 'Vault Offline Off' });
  const api = await apiFor(page);
  const ctx = page.context();
  const uid = await userIdOf(page);

  await setupVaultUi(page, user); // offlineUnlock OFF (default)
  expect(await deviceShareOf(page, uid)).toBeNull();
  const cache = await vaultCacheOf(page, uid);
  expect(cache).toMatchObject({ offlineUnlock: false, status: 'READY' });
  expect(cache!.wrappedVkPin).toBeFalsy();

  // SPA gia' caricata e navigator offline (senza reload): messaggio dedicato, resta bloccato
  await lockUi(page);
  await page.context().setOffline(true);
  await unlockUi(page, PIN);
  await expect(page.getByRole('alert').filter({ hasText: 'Offline unlock is not available on this device. Connect to the internet and try again.' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('button', { name: 'Vault settings' })).toHaveCount(0);
  await page.context().setOffline(false);

  // Reload con server irraggiungibile: nessuno sblocco offline, avviso, resta bloccato
  await blockApi(ctx);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 30000 });
  await unlockUi(page, PIN);
  await expect(page.getByRole('alert').filter({ hasText: /Network error|not available on this device/ })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('button', { name: 'Vault settings' })).toHaveCount(0);
  await unblockApi(ctx);

  // Impostazioni: lo switch e' visibile anche da bloccato; ON non scrive nulla finche non si sblocca online
  await page.goto('/settings');
  const sw = page.getByRole('switch', { name: 'Offline unlock' });
  await expect(sw).toHaveAttribute('aria-checked', 'false', { timeout: 30000 });
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  // finestra di ~2 s: share assente e nessun wrappedVkPin finche non si sblocca online
  const t0 = Date.now();
  await expect.poll(async () => {
    const stable = (await deviceShareOf(page, uid)) === null && !(await vaultCacheOf(page, uid))?.wrappedVkPin;
    if (!stable) return 'violato';
    return Date.now() - t0 >= 2000 ? 'stabile' : 'attesa';
  }, { timeout: 8000, intervals: [250] }).not.toBe('attesa');
  expect(await deviceShareOf(page, uid)).toBeNull();
  expect((await vaultCacheOf(page, uid))?.wrappedVkPin).toBeFalsy();

  await page.goto('/vault');
  await unlockUi(page, PIN);
  await expectUnlocked(page);
  await expect.poll(() => deviceShareOf(page, uid), { timeout: 30000 }).not.toBeNull();
  expect((await vaultCacheOf(page, uid))!.wrappedVkPin).toBeTruthy();

  // ... e adesso lo sblocco offline funziona
  await lockUi(page);
  await blockApi(ctx);
  await page.reload();
  await unlockUi(page, PIN);
  await expectUnlocked(page);
  await unblockApi(ctx);

  // Spegnerlo toglie share e wrappedVkPin dal dispositivo
  await page.goto('/settings');
  const sw2 = page.getByRole('switch', { name: 'Offline unlock' });
  await expect(sw2).toHaveAttribute('aria-checked', 'true', { timeout: 30000 });
  await sw2.click();
  await expect(sw2).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => deviceShareOf(page, uid), { timeout: 15000 }).toBeNull();
  expect((await vaultCacheOf(page, uid))!.wrappedVkPin).toBeFalsy();
  await api.dispose();
});

test('senza cache locale: avviso "sei offline", mai il setup (ne con il vault esistente ne senza)', async ({ page, browser }) => {
  test.setTimeout(240000);
  const user = await registerAndLogin(page, { name: 'Vault Offline NoCache' });
  await setupVaultUi(page, user);

  // Dispositivo B pulito che non ha mai visto il keyring: server irraggiungibile -> UNKNOWN, non il setup, non lo sblocco
  const b = await newDevice(browser);
  await loginInBrowser(b.page, user);
  await blockApi(b.ctx);
  await b.page.goto('/vault');
  await expect(b.page.getByText("You're offline")).toBeVisible({ timeout: 30000 });
  await expect(b.page.getByText(/no copy of your vault on this device/)).toBeVisible();
  await expect(b.page.getByRole('heading', { name: 'Set up your Vault' })).toHaveCount(0);
  await expect(b.page.getByRole('button', { name: 'Create Vault' })).toHaveCount(0);
  // Ritorna la rete: "Try again" porta allo sblocco
  await unblockApi(b.ctx);
  await b.page.getByRole('button', { name: 'Try again' }).click();
  await expect(b.page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 30000 });
  await b.ctx.close();

  // Utente senza vault: neppure lui vede il setup con il server irraggiungibile
  const c = await newDevice(browser);
  const user2 = await registerAndLogin(c.page, { name: 'Vault Offline NoVault' });
  await blockApi(c.ctx);
  await c.page.goto('/vault');
  await expect(c.page.getByText("You're offline")).toBeVisible({ timeout: 30000 });
  await expect(c.page.getByRole('heading', { name: 'Set up your Vault' })).toHaveCount(0);
  await unblockApi(c.ctx);

  // Setup gia' aperto e poi rete assente: il pulsante resta disabilitato e compare l'avviso
  await c.page.goto('/vault');
  await expect(c.page.getByRole('heading', { name: 'Set up your Vault' })).toBeVisible({ timeout: 30000 });
  await c.ctx.setOffline(true);
  await expect(c.page.getByText('You are offline. Creating the vault requires a connection.')).toBeVisible({ timeout: 10000 });
  await c.page.getByPlaceholder('Enter PIN').fill(PIN);
  await c.page.getByPlaceholder('Confirm PIN').fill(PIN);
  await c.page.getByPlaceholder('Account password').fill(user2.password);
  await c.page.getByLabel(/I understand that without the PIN and the Kit/).check();
  await expect(c.page.getByRole('button', { name: 'Create Vault' })).toBeDisabled();
  await c.ctx.setOffline(false);
  await c.ctx.close();
});

test('I.8/D2: dopo vault → normale B ha il corpo completo e il suo edit offline raggiunge il server', async ({ page, browser }) => {
  test.setTimeout(300000);
  const user = await registerAndLogin(page, { name: 'Vault Exit Offline Merge' });
  const api = await apiFor(page);
  const body = `MK-I8-BODY ${'x'.repeat(180)}`;
  const b = await newDevice(browser);
  try {
    await setupVaultUi(page, user);
    const id = await createSecureNoteUi(page, api, { title: 'MK-I8-NOTE', body });
    await page.getByRole('button', { name: 'Back', exact: true }).click();

    await loginInBrowser(b.page, user);
    await b.page.goto('/vault');
    await unlockUi(b.page);
    await expectUnlocked(b.page);
    await expect(b.page.getByText('MK-I8-NOTE', { exact: true })).toBeVisible({ timeout: 60000 });

    await page.getByText('MK-I8-NOTE', { exact: true }).click();
    await page.getByRole('button', { name: 'Remove from Vault', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByText('Removed from Vault', { exact: true })).toBeVisible({ timeout: 30000 });

    await expect.poll(async () => {
      const row = await dexieNoteOf(b.page, id);
      return row?.isVault === false && row.content?.includes('MK-I8-BODY');
    }, { timeout: 90000, intervals: [1000] }).toBe(true);

    await b.page.goto(`/notes?noteId=${id}`);
    await expect(b.page.locator('.ProseMirror')).toContainText('MK-I8-BODY', { timeout: 30000 });
    await b.ctx.setOffline(true);
    await b.page.locator('.ProseMirror').click();
    await b.page.locator('.ProseMirror').press('Control+End');
    await b.page.locator('.ProseMirror').pressSequentially(' MK-B-OFFLINE');
    await expect.poll(async () => (await syncQueueOf(b.page)).length, { timeout: 30000 }).toBeGreaterThan(0);
    await b.ctx.setOffline(false);

    await expect.poll(async () => (await serverNote(api, id)).content as string, { timeout: 60000, intervals: [1000] }).toContain('MK-B-OFFLINE');
    expect((await serverNote(api, id)).content).toContain('MK-I8-BODY');
    await expect(b.page.locator('.ProseMirror')).toContainText('MK-I8-BODY');
    await expect(b.page.locator('.ProseMirror')).toContainText('MK-B-OFFLINE');
  } finally {
    await b.ctx.setOffline(false).catch(() => {});
    await b.ctx.close();
    await api.dispose();
  }
});

test('I.8: il guard archivia il testo corto, avvisa e riallinea editor e Dexie', async ({ page }) => {
  test.setTimeout(180000);
  await registerAndLogin(page, { name: 'Content Guard Deferred' });
  const api = await apiFor(page);
  const original = `MK-GUARD-ORIGINAL ${'x'.repeat(180)}`;
  await page.getByRole('button', { name: 'New Note', exact: true }).click();
  await page.getByPlaceholder('Note Title').fill('MK-GUARD-NOTE');
  await page.locator('.ProseMirror').fill(original);
  const id = noteIdOf(page);
  await expect.poll(async () => (await serverNote(api, id)).content as string, { timeout: 45000 }).toContain('MK-GUARD-ORIGINAL');
  const before = (await serverNote(api, id)).content as string;

  const short = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'MK-B-OFFLINE' }] }] });
  await page.context().setOffline(true);
  await seedOfflineEdit(page, id, short);
  await expect.poll(async () => (await syncQueueOf(page)).length, { timeout: 30000 }).toBeGreaterThan(0);
  await page.context().setOffline(false);

  await expect(page.getByText("Your changes could not replace this note's current content. Any text you wrote is in its version history.", { exact: true })).toBeVisible({ timeout: 60000 });
  await expect.poll(async () => {
    const r = await api.get(`/api/notes/${id}/versions`);
    const j = await r.json();
    const versions = Array.isArray(j) ? j : (j.versions ?? []);
    return versions.some((v: { content?: string }) => v.content?.includes('MK-B-OFFLINE'));
  }, { timeout: 45000, intervals: [1000] }).toBe(true);
  expect((await serverNote(api, id)).content).toBe(before);
  await expect(page.locator('.ProseMirror')).toContainText('MK-GUARD-ORIGINAL', { timeout: 15000 });
  await expect(page.locator('.ProseMirror')).not.toContainText('MK-B-OFFLINE');
  await expect.poll(async () => (await dexieNoteOf(page, id))?.content, { timeout: 15000 }).toBe(before);
  await api.dispose();
});
