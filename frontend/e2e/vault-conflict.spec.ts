import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers';
import {
  apiFor, createCredentialUi, createSecureNoteUi, ENVELOPE, userIdOf, expectUnlocked, loginInBrowser, newDevice, PIN, setupVaultUi, syncQueueOf, unlockUi,
  vaultItems, waitForServerEdit,
} from './vault-helpers';

// Accettazione 12 (edit concorrente reale da due contesti -> 1 copia in conflitto, nessuna perdita) e
// 11 (3 edit offline con riferimento in coda -> 0 conflitti falsi).
// "Offline" del dispositivo A = ctx.setOffline (la SPA resta viva, scrive in Dexie/coda; al ritorno scatta l'evento online come per un utente reale).

test('edit concorrente reale (A offline, B online): 1 copia in conflitto e nessuna perdita', async ({ page, browser }) => {
  test.setTimeout(360000);
  const user = await registerAndLogin(page, { name: 'Vault Conflict Real' });
  const api = await apiFor(page);
  await setupVaultUi(page, user);
  const id = await createCredentialUi(page, api, { title: 'Shared Cred', username: 'u@example.com', password: 'pw-zero-0' });

  // B: dispositivo pulito, sblocca e vede la credenziale
  const b = await newDevice(browser);
  await loginInBrowser(b.page, user);
  await b.page.goto('/vault');
  await unlockUi(b.page, PIN);
  await expectUnlocked(b.page);
  await expect(b.page.getByText('Shared Cred')).toBeVisible({ timeout: 45000 });
  // B apre la credenziale (idratazione) e la lascia aperta: sara' lei a vincere sul server
  await b.page.getByText('Shared Cred').click();
  await expect(b.page.getByPlaceholder('Enter password')).toHaveValue('pw-zero-0', { timeout: 45000 });

  // A: perde la rete e modifica
  await page.context().setOffline(true);
  await page.getByText('Shared Cred').first().click();
  await expect(page.getByPlaceholder('Enter password')).toHaveValue('pw-zero-0', { timeout: 30000 });
  await page.getByPlaceholder('Enter password').fill('pw-A-offline');
  await expect.poll(async () => (await syncQueueOf(page)).length, { timeout: 30000 }).toBeGreaterThan(0);

  // B: modifica online -> il server avanza
  const before = (await (await api.get(`/api/notes/${id}`)).json()).content as string;
  await b.page.getByPlaceholder('Enter password').fill('pw-B-online');
  const afterB = await waitForServerEdit(api, id, before);

  // A torna online: il push trova il server avanzato -> una copia in conflitto
  await page.context().setOffline(false);
  // Editor di A ancora aperto (lock condiviso sulla nota): il push fallisce con vault:conflict, il server di B NON viene sovrascritto
  await expect.poll(async () => (await syncQueueOf(page)).join(' '), { timeout: 60000 }).toContain('vault:conflict');
  expect((await vaultItems(api)).items).toHaveLength(1);
  expect((await (await api.get(`/api/notes/${id}`)).json()).content).toBe(afterB);
  // A scrive ancora (editor aperto) a conflitto in corso: il server resta sul valore di B finche' non compare la copia
  await page.getByPlaceholder('Enter password').fill('pw-A-offline-2');
  await page.waitForTimeout(4000);
  expect((await vaultItems(api)).items).toHaveLength(1);
  expect((await (await api.get(`/api/notes/${id}`)).json()).content).toBe(afterB);
  // Chiusura dell'editor: scatta il reconcile e nasce la copia
  await page.getByRole('button', { name: 'Back' }).click();
  await expect.poll(async () => (await vaultItems(api)).items.length, { timeout: 90000 }).toBe(2);
  await expect(page.getByText(/\(conflict copy\)/)).toHaveCount(1, { timeout: 60000 });
  await expect.poll(async () => (await syncQueueOf(page)).length, { timeout: 60000 }).toBe(0);

  // L'originale sul server e' ancora B (byte identici): la copia ha preso A, nessuno ha sovrascritto B
  expect((await (await api.get(`/api/notes/${id}`)).json()).content, 'originale = B').toBe(afterB);
  // Ancora esattamente 2 elementi (nessun secondo conflitto) e nessuna perdita: A e B sopravvivono, uno nella copia
  await page.waitForTimeout(5000);
  const listing = await vaultItems(api);
  expect(listing.items).toHaveLength(2);

  const seen: string[] = [];
  for (const title of ['Shared Cred (conflict copy)', 'Shared Cred']) {
    await page.getByText(title, { exact: true }).click();
    const pw = page.getByPlaceholder('Enter password');
    await expect(pw).not.toHaveValue('', { timeout: 30000 });
    seen.push(await pw.inputValue());
    await page.getByRole('button', { name: 'Back' }).click();
  }
  expect(seen.sort()).toEqual(['pw-A-offline-2', 'pw-B-online']);
  await b.ctx.close();
  await api.dispose();
});

test('3 edit offline con riferimento in coda: 0 conflitti falsi, vince l ultimo stato', async ({ page }) => {
  test.setTimeout(360000);
  const user = await registerAndLogin(page, { name: 'Vault Conflict Offline3' });
  const api = await apiFor(page);
  await setupVaultUi(page, user);
  const id = await createCredentialUi(page, api, { title: 'Triple Edit', username: 'u3@example.com', password: 'pw-start' });
  const before = (await (await api.get(`/api/notes/${id}`)).json()).content as string;

  await page.context().setOffline(true);

  for (const pw of ['pw-edit-1', 'pw-edit-2', 'pw-edit-3']) {
    await page.getByPlaceholder('Enter password').fill(pw);
    await page.waitForTimeout(2500); // oltre il debounce di salvataggio: una voce in coda per edit (poi coalescenza)
  }
  const queued = (await syncQueueOf(page)).map((x) => JSON.parse(x));
  expect(queued.filter((q) => q.type === 'UPDATE' && q.entityId === id).length, 'almeno 3 UPDATE in coda').toBeGreaterThanOrEqual(3);
  // il server non ha visto nulla
  expect((await (await api.get(`/api/notes/${id}`)).json()).content).toBe(before);

  await page.context().setOffline(false);
  await waitForServerEdit(api, id, before);
  await expect.poll(async () => (await syncQueueOf(page)).length, { timeout: 60000 }).toBe(0);
  await page.waitForTimeout(5000);

  // Nessuna copia in conflitto, un solo elemento
  expect((await vaultItems(api)).items).toHaveLength(1);
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByText(/\(conflict copy\)/)).toHaveCount(0);

  // Il server ha l'ultimo stato: ricarico, sblocco e leggo
  await page.reload();
  await unlockUi(page, PIN);
  await expectUnlocked(page);
  await page.getByText('Triple Edit').click();
  await expect(page.getByPlaceholder('Enter password')).toHaveValue('pw-edit-3', { timeout: 30000 });
  await expect(page.getByText(/\(conflict copy\)/)).toHaveCount(0);
  await api.dispose();
});

test('edit concorrente con l editor di A gia chiuso: al ritorno online il reconcile crea la copia senza altre azioni', async ({ page, browser }) => {
  test.setTimeout(360000);
  const user = await registerAndLogin(page, { name: 'Vault Conflict Closed' });
  const api = await apiFor(page);
  await setupVaultUi(page, user);
  const id = await createCredentialUi(page, api, { title: 'Closed Cred', username: 'u@example.com', password: 'pw-zero-0' });

  const b = await newDevice(browser);
  await loginInBrowser(b.page, user);
  await b.page.goto('/vault');
  await unlockUi(b.page, PIN);
  await expectUnlocked(b.page);
  await b.page.getByText('Closed Cred').click();
  await expect(b.page.getByPlaceholder('Enter password')).toHaveValue('pw-zero-0', { timeout: 45000 });

  await page.context().setOffline(true);
  await page.getByPlaceholder('Enter password').fill('pw-A-offline');
  await expect.poll(async () => (await syncQueueOf(page)).length, { timeout: 30000 }).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Back' }).click(); // editor chiuso mentre e offline

  const before = (await (await api.get(`/api/notes/${id}`)).json()).content as string;
  await b.page.getByPlaceholder('Enter password').fill('pw-B-online');
  await waitForServerEdit(api, id, before);

  await page.context().setOffline(false);
  await expect.poll(async () => (await vaultItems(api)).items.length, { timeout: 90000 }).toBe(2);
  await expect(page.getByText(/\(conflict copy\)/)).toHaveCount(1, { timeout: 60000 });
  await expect.poll(async () => (await syncQueueOf(page)).length, { timeout: 60000 }).toBe(0);
  await page.waitForTimeout(4000);
  const listing = await vaultItems(api);
  expect(listing.items).toHaveLength(2);
  await expect(page.getByText(/(conflict copy)/)).toHaveCount(1);
  const seen: string[] = [];
  for (const title of ['Closed Cred (conflict copy)', 'Closed Cred']) {
    await page.getByText(title, { exact: true }).click();
    const pw = page.getByPlaceholder('Enter password');
    await expect(pw).not.toHaveValue('', { timeout: 30000 });
    seen.push(await pw.inputValue());
    await page.getByRole('button', { name: 'Back' }).click();
  }
  expect(seen.sort()).toEqual(['pw-A-offline', 'pw-B-online']);
  await b.ctx.close();
  await api.dispose();
});

// Accettazione 16, variante "bundle vecchio": riga con content in chiaro + item in coda con chiaro/titolo, keyring v3 attivo.
test('bundle vecchio: riga e coda in chiaro -> 1 copia cifrata, il server non riceve chiaro, nessuna perdita', async ({ page }) => {
  test.setTimeout(360000);
  const user = await registerAndLogin(page, { name: 'Vault Legacy Bundle' });
  const api = await apiFor(page);
  await setupVaultUi(page, user);
  const id = await createSecureNoteUi(page, api, { title: 'Legacy Bundle Note', body: 'server-side-body' });
  await page.getByRole('button', { name: 'Back' }).click();
  const uid = await userIdOf(page);
  const serverBefore = (await (await api.get(`/api/notes/${id}`)).json()).content as string;
  expect(serverBefore).toMatch(ENVELOPE);

  // Tutto il traffico di scrittura verso le note: nessun content non-envelope deve mai partire
  const leaked: string[] = [];
  await page.route('**/api/notes/**', async (route) => {
    const req = route.request();
    if (req.method() !== 'GET') {
      try {
        const c = (req.postDataJSON() as { content?: unknown } | null)?.content;
        if (typeof c === 'string' && !ENVELOPE.test(c)) leaked.push(c);
      } catch { /* body non JSON */ }
    }
    await route.continue();
  });

  const plainRow = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'legacy-row-plain' }] }] });
  const plainItem = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'legacy-item-plain' }] }] });
  // Seminare Dexie come lo lascerebbe un bundle pre-v3 (IndexedDB grezzo: nessuna versione di schema toccata)
  await page.evaluate(
    ({ id, uid, plainRow, plainItem }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('NotiqDB');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['notes', 'syncQueue'], 'readwrite');
          const notes = tx.objectStore('notes');
          const g = notes.get(id);
          g.onsuccess = () => {
            notes.put({ ...g.result, content: plainRow, title: '', syncStatus: 'updated', updatedAt: Date.now() });
            const q = tx.objectStore('syncQueue');
            q.add({ type: 'UPDATE', entity: 'NOTE', entityId: id, userId: uid, data: { content: plainItem }, createdAt: Date.now() - 2000, attempts: 3, status: 'failed', lastError: 'validation' });
            q.add({ type: 'UPDATE', entity: 'NOTE', entityId: id, userId: uid, data: { title: 'x' }, createdAt: Date.now() - 1000, attempts: 0, status: 'pending' });
          };
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { id, uid, plainRow, plainItem },
  );

  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText(/\(conflict copy\)/)).toHaveCount(1, { timeout: 90000 });
  await expect.poll(async () => (await vaultItems(api)).items.length, { timeout: 60000 }).toBe(2);
  await page.waitForTimeout(6000);
  expect((await vaultItems(api)).items).toHaveLength(2);
  expect(leaked, 'nessun content in chiaro verso il server').toEqual([]);
  for (const it of (await vaultItems(api)).items) expect(it.content).toMatch(ENVELOPE);

  // Nessuna perdita: il valore del server (envelope originale) e quello locale in chiaro (nella copia) sopravvivono
  expect((await (await api.get(`/api/notes/${id}`)).json()).content).toMatch(ENVELOPE);
  const texts: string[] = [];
  for (const title of ['Legacy Bundle Note', 'x (conflict copy)']) {
    const loc = page.getByText(title, { exact: false }).first();
    if (!(await loc.count())) continue;
    await loc.click();
    await expect(page.locator('.ProseMirror')).not.toHaveText('', { timeout: 30000 });
    texts.push(await page.locator('.ProseMirror').innerText());
    await page.getByRole('button', { name: 'Back' }).click();
  }
  expect(texts.join('|')).toContain('server-side-body');
  expect(texts.join('|')).toMatch(/legacy-(row|item)-plain/);
  await api.dispose();
});
