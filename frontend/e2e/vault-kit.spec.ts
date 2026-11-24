import { randomBytes, randomUUID } from 'crypto';
import { test, expect, type Page } from '@playwright/test';
import { registerAndLogin } from './helpers';
import {
  allVaultItems, apiFor, confirmKitUi, createCredentialUi, createSecureNoteUi, dexieNotesOf, expectAllCurrent, expectUnlocked, keyringOf, kitDialog, lockUi,
  loginInBrowser, newDevice, PIN, readKit, rotateUi, serverNote, setupVaultUi, submitSetup, unlockUi, vaultItems,
} from './vault-helpers';

// Accettazione 5 (Kit solo dopo il 201, una volta, 2 gruppi da riscrivere, PDF) e 6 (rigenerazione solo da sbloccato, escrow nuovo).

test('setup: il Kit compare solo dopo il 201; Fine resta disabilitato finche i 2 gruppi non sono corretti; PDF', async ({ page }) => {
  test.setTimeout(180000);
  const user = await registerAndLogin(page, { name: 'Vault Kit One' });
  const api = await apiFor(page);

  await page.goto('/vault');
  await expect(page.getByRole('heading', { name: 'Set up your Vault' })).toBeVisible({ timeout: 30000 });

  // 1) La creazione fallisce lato rete: nessun Kit, nessun keyring sul server.
  await page.route('**/api/vault/keyring', (route) => (route.request().method() === 'POST' ? route.abort('failed') : route.fallback()));
  await submitSetup(page, user);
  await expect(page.getByRole('alert').filter({ hasText: /./ }).first()).toBeVisible({ timeout: 30000 });
  await expect(kitDialog(page)).toHaveCount(0);
  expect((await keyringOf(api)).status).toBe('NONE');
  await page.unroute('**/api/vault/keyring');

  // 2) Riprovo: 201 -> compare il Kit e il keyring e' READY sul server
  await page.getByPlaceholder('Account password').fill(user.password); // il modulo svuota la password dopo il tentativo
  // La POST resta trattenuta: finche la risposta e' pendente il Kit NON deve comparire
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let held = false;
  await page.route('**/api/vault/keyring', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    held = true;
    await gate;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Create Vault' }).click();
  await expect.poll(() => held, { timeout: 30000 }).toBe(true);
  await page.waitForTimeout(1500);
  await expect(kitDialog(page)).toHaveCount(0);
  expect((await keyringOf(api)).status).toBe('NONE');
  release();
  const { kit, groups, asked } = await readKit(page);
  await page.unroute('**/api/vault/keyring');
  expect((await keyringOf(api)).status).toBe('READY');
  expect(groups).toHaveLength(8);
  groups.forEach((g) => expect(g).toMatch(/^[0-9A-Z]{4}$/));
  expect(asked).toHaveLength(2);

  const dlg = kitDialog(page);
  const done = dlg.getByRole('button', { name: 'Done' });
  await expect(done).toBeDisabled();

  // 3) Non si chiude con Esc ne con click sullo sfondo
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  await expect(dlg).toBeVisible();

  // 4) PDF
  const [download] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: 'Download PDF' }).click()]);
  expect(download.suggestedFilename()).toBe('notiq-vault-recovery-kit.pdf');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const pdf = Buffer.concat(chunks);
  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(pdf.length).toBeGreaterThan(300);

  // 5) Gruppo sbagliato -> Fine resta disabilitato, anche con uno solo giusto
  const [a, b] = asked;
  await a.input.fill(groups[a.n - 1]);
  await b.input.fill(groups[a.n - 1] === 'ZZZZ' ? 'YYYY' : 'ZZZZ');
  await expect(done).toBeDisabled();
  // 6) Gruppo giusto con battitura "morbida" (minuscole): accettato
  await b.input.fill(groups[b.n - 1].toLowerCase());
  await expect(done).toBeEnabled();
  await done.click();
  await expect(dlg).toBeHidden({ timeout: 20000 });
  await expectUnlocked(page);

  // 7) Una volta sola: il Kit non e' piu' recuperabile dalla pagina
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText(kit.split(/\s+/)[0])).toHaveCount(0);
  await expect(kitDialog(page)).toHaveCount(0);
  await api.dispose();
});

test('rigenerazione del Kit dallo sheet: solo da sbloccato, escrow nuovo, Kit nuovo', async ({ page }) => {
  test.setTimeout(180000);
  const user = await registerAndLogin(page, { name: 'Vault Kit Two' });
  const api = await apiFor(page);
  const kit1 = await setupVaultUi(page, user);
  const escrow1 = (await keyringOf(api)).escrowHash;
  expect(escrow1).toMatch(/^[0-9a-f]{64}$/);
  const e0 = (await keyringOf(api)).epoch as number;
  await createSecureNoteUi(page, api, { title: 'Regen Nota', body: 'corpo della nota di rigenerazione' }); // almeno un item da riscrivere: expectAllCurrent non e' vacuo
  await page.getByRole('button', { name: 'Back' }).click();

  // PIN sbagliato: il Kit non cambia
  await page.getByRole('button', { name: 'Vault settings' }).click();
  const sheet = page.getByRole('dialog', { name: 'Vault settings' });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel('PIN to confirm').fill('K7rQ2X');
  await sheet.getByRole('button', { name: 'Generate new Kit' }).click();
  await expect(sheet.getByRole('alert').filter({ hasText: 'Incorrect PIN' })).toBeVisible({ timeout: 30000 });
  await expect(kitDialog(page)).toHaveCount(0);
  expect((await keyringOf(api)).escrowHash).toBe(escrow1);
  expect((await keyringOf(api)).epoch).toBe(e0);

  // PIN giusto: Kit nuovo, mostrato dopo la risposta, poi conferma
  await sheet.getByLabel('PIN to confirm').fill(PIN);
  await sheet.getByRole('button', { name: 'Generate new Kit' }).click();
  const kit2 = await confirmKitUi(page);
  expect(kit2).not.toBe(kit1);
  const escrow2 = (await keyringOf(api)).escrowHash;
  expect(escrow2).toMatch(/^[0-9a-f]{64}$/);
  expect(escrow2).not.toBe(escrow1);
  expect((await keyringOf(api)).epoch).toBe(e0 + 1); // il Kit nuovo ruota anche la VK
  expect(await expectAllCurrent(api, 1)).toBe(e0 + 1);

  // Da bloccato l'azione non c'e'
  await page.keyboard.press('Escape');
  const close = page.getByRole('dialog', { name: 'Vault settings' }).getByRole('button', { name: 'Close' });
  if (await close.count()) await close.click();
  await page.getByRole('button', { name: 'Lock Vault' }).click();
  await expect(page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Vault settings' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Generate new Kit' })).toHaveCount(0);
  await api.dispose();
});

// Le tre voci della rotazione interrotta si aprono con i valori di prima
async function openAll(page: Page) {
  await expect(page.getByText('Rot Nota 1')).toBeVisible({ timeout: 45000 });
  await page.getByText('Rot Nota 1').click();
  await expect(page.getByPlaceholder('Note Title')).toHaveValue('Rot Nota 1', { timeout: 30000 });
  await expect(page.locator('.ProseMirror')).toContainText('corpo della prima nota', { timeout: 30000 });
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByText('Rot Nota 2')).toBeVisible({ timeout: 45000 });
  await page.getByText('Rot Nota 2').click();
  await expect(page.getByPlaceholder('Note Title')).toHaveValue('Rot Nota 2', { timeout: 30000 });
  await expect(page.locator('.ProseMirror')).toContainText('corpo della seconda nota', { timeout: 30000 });
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByText('Rot Cred').click();
  await expect(page.getByPlaceholder('Enter username or email')).toHaveValue('rot@example.com', { timeout: 30000 });
  await expect(page.getByPlaceholder('Enter password')).toHaveValue('rot-pw-1');
  await page.getByRole('button', { name: 'Back' }).click();
}

test('rotazione interrotta dopo il primo item: allo sblocco riprende e porta tutto all epoch nuovo', async ({ page, browser }) => {
  test.setTimeout(360000);
  const user = await registerAndLogin(page, { name: 'Vault Rotation Resume' });
  const api = await apiFor(page);
  await setupVaultUi(page, user);
  const e0 = (await keyringOf(api)).epoch as number;
  await createSecureNoteUi(page, api, { title: 'Rot Nota 1', body: 'corpo della prima nota ' + 'x'.repeat(160) });
  await page.getByRole('button', { name: 'Back' }).click();
  await createSecureNoteUi(page, api, { title: 'Rot Nota 2', body: 'corpo della seconda nota' });
  await page.getByRole('button', { name: 'Back' }).click();
  await createCredentialUi(page, api, { title: 'Rot Cred', username: 'rot@example.com', password: 'rot-pw-1' });
  await page.getByRole('button', { name: 'Back' }).click();

  // La prima POST /migrate inoltra UN solo item e poi cade (il client vede un errore di rete); le successive cadono senza inoltro
  let calls = 0;
  await page.route('**/api/vault/migrate', async (route) => {
    calls++;
    if (calls > 1) return route.abort('failed');
    const data = route.request().postDataJSON() as { items: unknown[] };
    await route.fetch({ postData: JSON.stringify({ ...data, items: data.items.slice(0, 1) }) });
    return route.abort('failed');
  });
  await rotateUi(page);

  await expect.poll(async () => (await keyringOf(api)).staleCount, { timeout: 90000 }).toBe(2);
  // La POST e' partita ed e' stata bloccata: la rotazione e' ferma per davvero, non solo lenta
  await expect.poll(() => calls, { timeout: 90000 }).toBeGreaterThanOrEqual(1); // il client non ritenta da solo: la ripresa e' allo sblocco (piano §3)
  await page.waitForTimeout(2000);
  expect((await keyringOf(api)).staleCount).toBe(2);
  expect((await keyringOf(api)).epoch).toBe(e0 + 1);
  const mid = (await vaultItems(api)).items as { content: string; hasPlaintextVersions: boolean }[];
  const migrated = mid.filter((i) => i.content.startsWith(`nv3.${e0 + 1}.`));
  expect(migrated).toHaveLength(1);
  expect(migrated[0].hasPlaintextVersions).toBe(true); // snapshot dell'envelope e-1 creato da /migrate

  // Riavvio: la ripresa deve avvenire allo sblocco. Si toglie la route SOLO a pagina bloccata (nessun client in grado di riprendere prima)
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 30000 });
  await page.unroute('**/api/vault/migrate');
  expect((await keyringOf(api)).staleCount).toBe(2); // ancora ferma: il blocco non ha ripreso nulla
  await unlockUi(page);
  await expectUnlocked(page);

  expect(await expectAllCurrent(api, 3)).toBe(e0 + 1);
  const all = await allVaultItems(api);
  expect(all).toHaveLength(3);
  expect(all.filter((i) => i.content.startsWith(`nv3.${e0}.`))).toEqual([]);

  // Dexie di A: le tre righe locali sono gia' all'epoch nuovo (la ripresa ha riallineato anche il locale)
  const ids = all.map((i) => i.id);
  await expect.poll(async () => (await dexieNotesOf(page, ids)).filter((n) => n.content.startsWith(`nv3.${e0 + 1}.`)).length, { timeout: 60000 }).toBe(3);

  // Lettura SOLO dai byte del server: dispositivo nuovo (Dexie vuoto), sblocco, apertura delle tre voci
  const dev = await newDevice(browser);
  await loginInBrowser(dev.page, user);
  await dev.page.goto('/vault');
  await expect(dev.page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 30000 });
  await unlockUi(dev.page);
  await expectUnlocked(dev.page);
  await openAll(dev.page);
  await dev.ctx.close();

  // Blocca e sblocca su A: decifratura con le chiavi nuove, non dalla cache
  await lockUi(page);
  await unlockUi(page);
  await expectUnlocked(page);
  await openAll(page);
  await api.dispose();
});

test('D6: spazzatura piantata all epoch corrente, conferma "illeggibile", seconda rotazione 200', async ({ page }) => {
  test.setTimeout(360000);
  const user = await registerAndLogin(page, { name: 'Vault Rotation D6' });
  const api = await apiFor(page);
  await setupVaultUi(page, user);
  await createSecureNoteUi(page, api, { title: 'D6 Nota R', body: 'corpo della nota R' });
  await page.getByRole('button', { name: 'Back' }).click();
  const e = (await keyringOf(api)).epoch as number;

  // Envelope ben formato all'epoch corrente ma con AEAD che non torna: dopo la rotazione e' una nota "danneggiata" (D)
  const notebooks = await (await api.get('/api/notebooks')).json();
  const notebookId = (Array.isArray(notebooks) ? notebooks : notebooks.notebooks)[0].id as string;
  const junkId = randomUUID();
  const junk = `nv3.${e}.${randomBytes(12).toString('base64url')}.${randomBytes(48).toString('base64url')}`;
  const post = await api.post('/api/notes', { data: { id: junkId, notebookId, title: '', isVault: true, noteType: 'NOTE', content: junk } });
  expect(post.ok(), await post.text()).toBe(true);

  await rotateUi(page);
  const dlg = page.getByRole('dialog', { name: 'Some notes cannot be opened' });
  await expect(dlg).toBeVisible({ timeout: 90000 });
  await expect(dlg).toContainText('1 note is damaged and cannot be decrypted.');
  // Senza consenso il rewrap non parte: la spazzatura e' ancora intatta sul server e la rotazione e' ferma con 1 nota stale
  expect((await serverNote(api, junkId)).content).toBe(junk);
  expect((await keyringOf(api)).staleCount).toBe(1);
  await dlg.getByRole('button', { name: 'Keep as unreadable notes' }).click();

  // Stato del server: la spazzatura e' stata re-incapsulata all'epoch nuovo (non e' piu' il contenuto piantato)
  await expect.poll(async () => ((await serverNote(api, junkId)).content as string).startsWith(`nv3.${e + 1}.`), { timeout: 90000 }).toBe(true);
  expect(await expectAllCurrent(api, 2)).toBe(e + 1);

  // Il nuovo envelope e' un documento valido: avviso di "contenuto non leggibile" + envelope vecchio copiato tale e quale (piano §3, "Come si re-incapsula").
  // Il testo cifrato dentro l'envelope non e' leggibile dal server: si osserva aprendo la nota dalla UI.
  await expect(page.getByText('Untitled Note', { exact: true })).toBeVisible({ timeout: 45000 });
  await page.getByText('Untitled Note', { exact: true }).click();
  await expect(page.locator('.ProseMirror')).toContainText('This content could not be decrypted after a key change.', { timeout: 30000 });
  await expect(page.locator('.ProseMirror')).toContainText(junk, { timeout: 30000 });
  await page.getByRole('button', { name: 'Back' }).click();

  // Seconda rotazione: la PUT del keyring risponde 200 (nessun residuo stale)
  const [put] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/vault/keyring' && r.request().method() === 'PUT', { timeout: 90000 }),
    rotateUi(page),
  ]);
  expect(put.status()).toBe(200);
  expect(await expectAllCurrent(api, 2)).toBe(e + 2);
  await expect(dlg).toHaveCount(0);
  const items2 = await allVaultItems(api);
  expect(items2).toHaveLength(2);
  expect(items2.every((i) => i.content.startsWith(`nv3.${e + 2}.`))).toBe(true);
  expect(items2.map((i) => i.id)).toContain(junkId);

  // La nota R resta leggibile
  await expect(page.getByText('D6 Nota R')).toBeVisible({ timeout: 45000 });
  await page.getByText('D6 Nota R').click();
  await expect(page.getByPlaceholder('Note Title')).toHaveValue('D6 Nota R', { timeout: 30000 });
  await expect(page.locator('.ProseMirror')).toContainText('corpo della nota R', { timeout: 30000 });
  await api.dispose();
});
