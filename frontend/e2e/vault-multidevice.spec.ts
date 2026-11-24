import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers';
import {
  allVaultItems, apiFor, createCredentialUi, createSecureNoteUi, dumpDeviceStorage, expectAllCurrent, expectUnlocked, keyringOf, loginInBrowser, logoutUi, newDevice, PIN, rotateUi,
  setupVaultUi, syncQueueOf, unlockUi, WRONG_PIN,
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

test('rotazione da A con edit offline su B: A2 e B si bloccano, la coda di B si svuota, la modifica di B sopravvive', async ({ page, browser }) => {
  test.setTimeout(420000);
  const user = await registerAndLogin(page, { name: 'Vault Rotation Multi' });
  const api = await apiFor(page);
  await setupVaultUi(page, user);
  await createCredentialUi(page, api, { title: 'MD Cred', username: 'md@example.com', password: 'pw-0' });
  await page.getByRole('button', { name: 'Back' }).click();
  const e0 = (await keyringOf(api)).epoch as number;

  // A2: seconda scheda dello stesso contesto (stesso localStorage), sbloccata
  const a2 = await page.context().newPage();
  await a2.goto('/vault');
  await unlockUi(a2);
  await expectUnlocked(a2);

  // B: dispositivo nuovo, sbloccato, apre la credenziale
  const b = await newDevice(browser);
  await loginInBrowser(b.page, user);
  await b.page.goto('/vault');
  await expect(b.page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 30000 });
  await unlockUi(b.page);
  await expectUnlocked(b.page);
  await b.page.getByText('MD Cred', { exact: true }).click();
  await expect(b.page.getByPlaceholder('Enter password')).toHaveValue('pw-0', { timeout: 30000 });

  // B offline: modifica e chiude l'editor (libera il lock shared); la modifica resta in coda
  await b.ctx.setOffline(true);
  await b.page.getByPlaceholder('Enter password').fill('pw-B-offline');
  await expect.poll(async () => (await syncQueueOf(b.page)).length, { timeout: 30000 }).toBeGreaterThan(0); // debounce scaduto: la modifica e' in coda
  await b.page.getByRole('button', { name: 'Back' }).click();
  // B offline con coda piena: sul disco c'e' solo l'envelope, mai la password in chiaro
  expect(await dumpDeviceStorage(b.page)).not.toContain('pw-B-offline');

  // A ruota la VK: A2 si blocca (evento storage)
  await rotateUi(page);
  await expect(a2.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 30000 });
  await unlockUi(a2);
  await expectUnlocked(a2);

  // B torna online: il keyring cambiato lo blocca; dopo lo sblocco la coda si svuota (push accettata o riconciliata)
  await b.ctx.setOffline(false);
  await expect(b.page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 60000 });
  expect(await dumpDeviceStorage(b.page)).not.toContain('pw-B-offline'); // subito dopo il blocco
  await unlockUi(b.page);
  await expectUnlocked(b.page);
  await expect.poll(async () => (await syncQueueOf(b.page)).length, { timeout: 90000 }).toBe(0);

  // Nessuna perdita: tra la credenziale e l'eventuale copia di conflitto c'e' la password di B; tutto all'epoch nuovo
  expect(await expectAllCurrent(api, 1)).toBe(e0 + 1);
  await page.reload();
  await unlockUi(page);
  await expectUnlocked(page);
  await expect(page.getByText('MD Cred', { exact: true })).toBeVisible({ timeout: 45000 });
  const credRows = page.getByRole('heading', { level: 3, name: /^MD Cred( \(conflict copy\))?$/ });
  const serverCreds = async () => (await allVaultItems(api)).filter((i) => i.noteType === 'CREDENTIAL').length;
  // La lista locale mostra tante righe quante sono le credenziali sul server (la copia di conflitto puo' arrivare dopo)
  await expect.poll(async () => (await credRows.count()) === (await serverCreds()), { timeout: 90000 }).toBe(true);
  const collectPasswords = async () => {
    const out: string[] = [];
    const n = await credRows.count();
    for (let i = 0; i < n; i++) {
      await credRows.nth(i).click();
      const pw = page.getByPlaceholder('Enter password');
      await expect(pw).not.toHaveValue('', { timeout: 30000 });
      out.push(await pw.inputValue());
      await page.getByRole('button', { name: 'Back' }).click();
    }
    return out;
  };
  await expect.poll(collectPasswords, { timeout: 60000 }).toContain('pw-B-offline');
  expect(await dumpDeviceStorage(b.page)).not.toContain('pw-B-offline');
  await b.ctx.close();
  await api.dispose();
});

test('rotazione da A con una credenziale aperta e modificata (non salvata) su A2: il blocco la salva con le chiavi catturate, nessun plaintext su disco', async ({ page }) => {
  test.setTimeout(420000);
  const user = await registerAndLogin(page, { name: 'Vault Rotation Dirty' });
  const api = await apiFor(page);
  await setupVaultUi(page, user);
  await createCredentialUi(page, api, { title: 'MD Dirty', username: 'dirty@example.com', password: 'pw-d0' });
  await page.getByRole('button', { name: 'Back' }).click();
  const e0 = (await keyringOf(api)).epoch as number;

  // A2: seconda scheda dello stesso contesto, sbloccata, credenziale aperta
  const a2 = await page.context().newPage();
  await a2.goto('/vault');
  await unlockUi(a2);
  await expectUnlocked(a2);
  await a2.getByText('MD Dirty', { exact: true }).click();
  await expect(a2.getByPlaceholder('Enter password')).toHaveValue('pw-d0', { timeout: 30000 });

  // Timer di A2 fermi: il debounce di salvataggio (1 s) non scatta, la modifica resta "sporca" fino al blocco
  await expect.poll(async () => (await syncQueueOf(a2)).length, { timeout: 30000 }).toBe(0);
  await a2.clock.install();
  await a2.clock.pauseAt(Date.now() + 1000);
  await a2.getByPlaceholder('Enter password').fill('pw-A2-dirty');
  await expect(a2.getByPlaceholder('Enter password')).toHaveValue('pw-A2-dirty');
  await a2.waitForTimeout(1500); // piu' del debounce reale: con i timer fermi non deve essere partito nessun salvataggio
  expect(await syncQueueOf(a2)).toHaveLength(0);

  // A ruota la VK: A2 si blocca (evento storage) e il flusher pre-lock salva con le chiavi catturate
  await rotateUi(page);
  await expect(a2.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 30000 });
  await a2.clock.resume();
  expect(await dumpDeviceStorage(a2)).not.toContain('pw-A2-dirty');
  await unlockUi(a2);
  await expectUnlocked(a2);

  // L'editor riaperto tiene il lock shared e blocca il reconcile finché non si chiude: difetto tracciato a parte (T12b).
  await a2.getByRole('button', { name: 'Back' }).click();
  expect(await expectAllCurrent(api, 1)).toBe(e0 + 1);
  await expect.poll(async () => (await syncQueueOf(a2)).length, { timeout: 90000 }).toBe(0);
  await expect.poll(async () => (await keyringOf(api)).staleCount, { timeout: 90000 }).toBe(0);

  // La modifica non e' persa: sta nella credenziale o in una copia di conflitto
  const rows = a2.getByRole('heading', { level: 3, name: /^MD Dirty( \(conflict copy\))?$/ });
  await expect(rows.first()).toBeVisible({ timeout: 45000 });
  const serverCreds = async () => (await allVaultItems(api)).filter((i) => i.noteType === 'CREDENTIAL').length;
  await expect.poll(async () => (await rows.count()) === (await serverCreds()), { timeout: 90000 }).toBe(true);
  const collect = async () => {
    const out: string[] = [];
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      await rows.nth(i).click();
      const pw = a2.getByPlaceholder('Enter password');
      await expect(pw).not.toHaveValue('', { timeout: 30000 });
      out.push(await pw.inputValue());
      await a2.getByRole('button', { name: 'Back' }).click();
    }
    return out;
  };
  await expect.poll(collect, { timeout: 60000 }).toContain('pw-A2-dirty');
  expect(await dumpDeviceStorage(a2)).not.toContain('pw-A2-dirty');
  expect(await dumpDeviceStorage(page)).not.toContain('pw-A2-dirty');
  await api.dispose();
});
