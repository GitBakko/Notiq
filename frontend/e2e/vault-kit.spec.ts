import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers';
import { apiFor, confirmKitUi, expectUnlocked, keyringOf, kitDialog, PIN, readKit, setupVaultUi, submitSetup } from './vault-helpers';

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

  // PIN sbagliato: il Kit non cambia
  await page.getByRole('button', { name: 'Vault settings' }).click();
  const sheet = page.getByRole('dialog', { name: 'Vault settings' });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel('PIN to confirm').fill('K7rQ2X');
  await sheet.getByRole('button', { name: 'Generate new Kit' }).click();
  await expect(sheet.getByRole('alert').filter({ hasText: 'Incorrect PIN' })).toBeVisible({ timeout: 30000 });
  await expect(kitDialog(page)).toHaveCount(0);
  expect((await keyringOf(api)).escrowHash).toBe(escrow1);

  // PIN giusto: Kit nuovo, mostrato dopo la risposta, poi conferma
  await sheet.getByLabel('PIN to confirm').fill(PIN);
  await sheet.getByRole('button', { name: 'Generate new Kit' }).click();
  const kit2 = await confirmKitUi(page);
  expect(kit2).not.toBe(kit1);
  const escrow2 = (await keyringOf(api)).escrowHash;
  expect(escrow2).toMatch(/^[0-9a-f]{64}$/);
  expect(escrow2).not.toBe(escrow1);

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
