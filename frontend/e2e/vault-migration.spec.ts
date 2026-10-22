import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import CryptoJS from 'crypto-js';
import { v4 as uuidv4 } from 'uuid';
import { encryptContent } from '../src/utils/crypto';
import { API, confirmKitUi, createUserViaApi, ENVELOPE, expectUnlocked, keyringOf, loginInBrowser, PIN, vaultItems } from './vault-helpers';

// Accettazione 1 (DB: solo nv3. piu credenziali legacy bloccate, title=''), 2 (dopo finalize nessuna versione in chiaro) e 13 (utente legacy migrato con valori identici).
// Il vault legacy e' creato via API PRIMA del keyring, con contenuto nel formato P1 (utils/crypto.ts: v2 PBKDF2 e passphrase CryptoJS).

const OLD_PIN_V2 = 'oldPin1';
const OLD_PIN_PASSPHRASE = 'passPhrase9';
const OLD_PIN_UNKNOWN = 'unknown77';

// >= 150 caratteri: sotto MIN_SNAPSHOT_LEN il server non archivia la versione precedente
const doc = (text: string) => JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: text + ' ' + 'x'.repeat(200) }] }] });
const cred = (o: Partial<Record<'siteUrl' | 'username' | 'password' | 'notes', string>>) =>
  JSON.stringify({ siteUrl: '', username: '', password: '', notes: '', ...o });

interface Seed {
  id: string;
  noteType: 'NOTE' | 'CREDENTIAL';
  title: string;
  original: string; // contenuto legacy inviato
  expectedPlain?: string; // cosa deve decifrarsi (note: il documento; credenziali: il JSON)
  locked?: boolean;
}

test('vault legacy -> wizard -> note migrate (titoli compresi), finalize, nessuna versione in chiaro', async ({ page }) => {
  test.setTimeout(420000);
  const user = await createUserViaApi('Vault Migration User');
  const api = await pwRequest.newContext({ baseURL: API, extraHTTPHeaders: { Authorization: `Bearer ${user.token}` } });
  const notebooks = await (await api.get('/api/notebooks')).json();
  const notebookId = (Array.isArray(notebooks) ? notebooks : notebooks.notebooks)[0].id as string;

  async function post(body: Record<string, unknown>) {
    const res = await api.post('/api/notes', { data: { notebookId, ...body } });
    expect(res.ok(), await res.text()).toBeTruthy();
  }

  const seeds: Seed[] = [];
  const addVault = async (s: Omit<Seed, 'id'>, isEncrypted = false) => {
    const id = uuidv4();
    seeds.push({ id, ...s });
    await post({ id, title: s.title, content: s.original, isVault: true, isEncrypted, noteType: s.noteType });
    return id;
  };

  // La nota piu vecchia viene creata per prima: le 60 note filler (normali) la spingono oltre la prima pagina (50) del listing /notes
  const oldNote = await addVault({ noteType: 'NOTE', title: 'Nota Vecchia Vault', original: doc('corpo della nota vecchia'), expectedPlain: 'corpo della nota vecchia' });
  // PUT subito: crea la versione in chiaro e fissa updatedAt PRIMA dei filler, cosi la nota resta fuori dalla prima pagina
  {
    const r = await api.put(`/api/notes/${oldNote}`, { data: { content: doc('corpo della nota vecchia (modificata)') } });
    expect(r.ok(), await r.text()).toBeTruthy();
  }
  for (let i = 0; i < 60; i++) await post({ title: `filler ${i}`, content: doc(`filler ${i}`) });
  await addVault({ noteType: 'NOTE', title: 'Nota Recente Vault', original: doc('corpo della nota recente'), expectedPlain: 'corpo della nota recente' });

  const credV2 = cred({ siteUrl: 'https://v2.example.com', username: 'user-v2', password: 'pass-v2-Aa1', notes: 'cred v2' });
  const credPass = cred({ siteUrl: 'https://pass.example.com', username: 'user-pass', password: 'pass-pass-Bb2', notes: 'cred passphrase' });
  const credLocked = cred({ username: 'user-locked', password: 'pass-locked-Cc3' });
  await addVault({ noteType: 'CREDENTIAL', title: 'Cred V2', original: encryptContent(credV2, OLD_PIN_V2), expectedPlain: credV2 }, true);
  await addVault({ noteType: 'CREDENTIAL', title: 'Cred Passphrase', original: CryptoJS.AES.encrypt(credPass, OLD_PIN_PASSPHRASE).toString(), expectedPlain: credPass }, true);
  await addVault({ noteType: 'CREDENTIAL', title: 'Cred Bloccata', original: encryptContent(credLocked, OLD_PIN_UNKNOWN), locked: true }, true);
  await addVault({ noteType: 'CREDENTIAL', title: 'Cred Vuota', original: '' }, true);

  // Versioni in chiaro: una modifica per ogni nota normale del vault crea una versione dello stato precedente
  for (const s of seeds.filter((x) => x.noteType === 'NOTE' && x.id !== oldNote)) {
    const r = await api.put(`/api/notes/${s.id}`, { data: { content: doc(s.expectedPlain + ' (modificata)') } });
    expect(r.ok(), await r.text()).toBeTruthy();
  }
  const page1 = await (await api.get('/api/notes?page=1&limit=50')).json();
  const page1Notes: { id: string }[] = Array.isArray(page1) ? page1 : (page1.notes ?? []);
  expect(page1Notes.length).toBeLessThanOrEqual(50);
  expect(page1Notes.some((n) => n.id === oldNote), 'la nota vecchia deve stare oltre la prima pagina').toBe(false);
  const versionsBefore = await (await api.get(`/api/notes/${oldNote}/versions`)).json();
  expect(Array.isArray(versionsBefore) ? versionsBefore.length : (versionsBefore.versions?.length ?? 0)).toBeGreaterThan(0);

  const before = await keyringOf(api);
  expect(before.status).toBe('NONE');
  expect(before.legacyCount).toBe(seeds.length);

  // ---- Wizard ----
  await loginInBrowser(page, user);
  await page.goto('/vault');
  await expect(page.getByRole('heading', { name: 'Upgrade your vault' })).toBeVisible({ timeout: 30000 });
  await page.getByLabel('New PIN', { exact: true }).fill(PIN);
  await page.getByLabel('Confirm PIN').fill(PIN);
  await page.getByLabel('Account password').fill(user.password);
  await page.getByRole('textbox', { name: 'Previous PIN 1' }).fill(OLD_PIN_V2);
  await page.getByRole('button', { name: 'Add another PIN' }).click();
  await page.getByRole('textbox', { name: 'Previous PIN 2' }).fill(OLD_PIN_PASSPHRASE);
  await page.getByLabel(/I understand that without the PIN and the Kit/).check();
  await page.getByRole('button', { name: 'Start upgrade' }).click();

  await confirmKitUi(page); // il Kit compare dopo il 201 del keyring, poi parte la migrazione
  const migrated = seeds.filter((s) => !s.locked).length;
  await expect(page.getByText(`${migrated} items upgraded and verified.`)).toBeVisible({ timeout: 240000 });
  await expect(page.getByText(/1 credentials are locked with a previous PIN/)).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expectUnlocked(page);

  // ---- Verifica via API ----
  const kr = await keyringOf(api);
  expect(kr.status).toBe('READY');
  expect(kr.legacyCount).toBe(1); // solo la credenziale bloccata resta legacy
  const listing = await vaultItems(api, seeds.map((s) => s.id));
  expect(listing.items).toHaveLength(seeds.length);
  for (const s of seeds) {
    const item = listing.items.find((i: { id: string }) => i.id === s.id);
    expect(item, s.title).toBeTruthy();
    if (s.locked) {
      expect(item.content, `${s.title} resta legacy`).toBe(s.original); // byte-identico
      expect(item.title).toBe(s.title);
    } else {
      expect(item.content, s.title).toMatch(ENVELOPE);
      expect(item.title, `${s.title}: title svuotato`).toBe('');
      expect(item.hasPlaintextVersions, `${s.title}: nessuna versione in chiaro`).toBe(false);
    }
  }
  for (const s of seeds.filter((x) => x.noteType === 'NOTE')) {
    const v = await (await api.get(`/api/notes/${s.id}/versions`)).json();
    expect(Array.isArray(v) ? v.length : (v.versions?.length ?? 0), `${s.title}: versioni`).toBe(0);
    const n = await (await api.get(`/api/notes/${s.id}`)).json();
    expect(n.title).toBe('');
    expect(n.content).toMatch(ENVELOPE);
  }

  // ---- Valori identici, titoli compresi (decifrati nel browser) ----
  await expect(page.getByText('Nota Vecchia Vault')).toBeVisible({ timeout: 30000 });
  await expect(page.getByText('Nota Recente Vault')).toBeVisible();
  await expect(page.getByText('Cred V2')).toBeVisible();
  await expect(page.getByText('Cred Passphrase')).toBeVisible();
  await expect(page.getByText('Cred Vuota')).toBeVisible();

  await page.getByText('Nota Vecchia Vault').click();
  await expect(page.getByPlaceholder('Note Title')).toHaveValue('Nota Vecchia Vault', { timeout: 30000 });
  await expect(page.locator('.ProseMirror')).toContainText('corpo della nota vecchia', { timeout: 30000 });
  await page.getByRole('button', { name: 'Back' }).click();

  await page.getByText('Cred V2').click();
  await expect(page.getByPlaceholder('Enter username or email')).toHaveValue('user-v2', { timeout: 30000 });
  await expect(page.getByPlaceholder('Enter password')).toHaveValue('pass-v2-Aa1');
  await expect(page.getByPlaceholder('Additional notes...')).toHaveValue('cred v2');
  await page.getByRole('button', { name: 'Back' }).click();

  await page.getByText('Cred Passphrase').click();
  await expect(page.getByPlaceholder('Enter username or email')).toHaveValue('user-pass', { timeout: 30000 });
  await expect(page.getByPlaceholder('Enter password')).toHaveValue('pass-pass-Bb2');

  await api.dispose();
});
