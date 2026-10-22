import { expect, request as pwRequest, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { TestUser } from './helpers';

// Helper condivisi dagli spec vault (P2). Nessun test qui.

export const API = 'http://localhost:3001';
// 6 caratteri, lettere e cifre, case-sensitive; passa la policy (niente date, sequenze, parole comuni, nome utente).
export const PIN = 'x9Kp4M';
export const WRONG_PIN = 'K7rQ2X';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CURRENT_VERSION: string = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8')).version;

export async function tokenOf(page: Page): Promise<string> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('auth-storage') || '{}').state?.token as string);
}

export async function apiFor(page: Page): Promise<APIRequestContext> {
  const token = await tokenOf(page);
  return pwRequest.newContext({ baseURL: API, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
}

/** Crea un utente verificato SOLO via API (nessun login nel browser): serve a seminare un vault legacy prima del keyring. */
export async function createUserViaApi(name: string): Promise<TestUser & { token: string; id: string }> {
  const { v4 } = await import('uuid');
  const user = { name, email: `test-${v4()}@example.com`, password: 'password123' };
  const api = await pwRequest.newContext({ baseURL: API });
  const sa = await (await api.post('/api/auth/login', { data: { email: 'superadmin@notiq.ai', password: 'superadmin' } })).json();
  const adminH = { Authorization: `Bearer ${sa.token}` };
  const { code } = await (await api.post('/api/invites', { headers: adminH })).json();
  await api.post('/api/auth/register', { data: { email: user.email, password: user.password, name: user.name, invitationCode: code } });
  const { users } = await (await api.get(`/api/admin/users?search=${encodeURIComponent(user.email)}`, { headers: adminH })).json();
  const id = users?.[0]?.id as string;
  if (!id) throw new Error('createUserViaApi: user not created');
  await api.put(`/api/admin/users/${id}`, { headers: adminH, data: { isVerified: true } });
  const login = await (await api.post('/api/auth/login', { data: { email: user.email, password: user.password } })).json();
  await api.dispose();
  return { ...user, token: login.token, id };
}

/** Login nel browser di un utente esistente (contesto pulito: IndexedDB vuota). */
export async function loginInBrowser(page: Page, user: TestUser): Promise<void> {
  await page.goto('/login');
  await page.evaluate((v) => localStorage.setItem('lastSeenVersion', v), CURRENT_VERSION);
  await page.fill('input[type="email"]', user.email);
  await page.fill('input[type="password"]', user.password);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/notes/, { timeout: 15000 });
  await expect(page.getByTestId('sidebar-item-notes')).toBeVisible({ timeout: 30000 });
}

/** Nuovo contesto browser pulito (= dispositivo B). */
export async function newDevice(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ locale: 'en' });
  await ctx.addInitScript((v) => { try { localStorage.setItem('lastSeenVersion', v); } catch { /* ignore */ } }, CURRENT_VERSION);
  return { ctx, page: await ctx.newPage() };
}

/** Il foglio del Kit: dialogo "Recovery Kit". */
export const kitDialog = (page: Page) => page.getByRole('dialog', { name: 'Recovery Kit' });

/** Legge il Kit mostrato e i due gruppi richiesti (indice 0-based, ordine crescente). */
export async function readKit(page: Page): Promise<{ kit: string; groups: string[]; asked: { n: number; input: ReturnType<Page['locator']> }[] }> {
  const dlg = kitDialog(page);
  await expect(dlg).toBeVisible({ timeout: 30000 });
  const kit = (await dlg.getByLabel('Recovery Kit code', { exact: true }).first().innerText()).trim();
  const groups = kit.split(/\s+/)[0].split('-');
  const labels = dlg.locator('label').filter({ hasText: /^Group \d+$/ });
  const asked: { n: number; input: ReturnType<Page['locator']> }[] = [];
  for (const l of await labels.all()) {
    const n = Number(/(\d+)/.exec((await l.innerText()).trim())![1]);
    asked.push({ n, input: l.locator('input') });
  }
  return { kit, groups, asked };
}

/** Riscrive i due gruppi richiesti e preme Done. */
export async function confirmKitUi(page: Page): Promise<string> {
  const { kit, groups, asked } = await readKit(page);
  expect(asked).toHaveLength(2);
  for (const a of asked) await a.input.fill(groups[a.n - 1]);
  const done = kitDialog(page).getByRole('button', { name: 'Done' });
  await expect(done).toBeEnabled();
  await done.click();
  await expect(kitDialog(page)).toBeHidden({ timeout: 20000 });
  return kit;
}

export async function submitSetup(page: Page, user: TestUser, opts: { pin?: string; offlineUnlock?: boolean } = {}) {
  await page.getByPlaceholder('Enter PIN').fill(opts.pin ?? PIN);
  await page.getByPlaceholder('Confirm PIN').fill(opts.pin ?? PIN);
  await page.getByPlaceholder('Account password').fill(user.password);
  if (opts.offlineUnlock) await page.getByLabel('Allow offline unlock on this device').check();
  await page.getByLabel(/I understand that without the PIN and the Kit/).check();
  await page.getByRole('button', { name: 'Create Vault' }).click();
}

/** Setup completo dal browser: /vault -> modulo -> Kit -> conferma. Ritorna il Kit. */
export async function setupVaultUi(page: Page, user: TestUser, opts: { pin?: string; offlineUnlock?: boolean } = {}): Promise<string> {
  await page.goto('/vault');
  await expect(page.getByRole('heading', { name: 'Set up your Vault' })).toBeVisible({ timeout: 30000 });
  await submitSetup(page, user, opts);
  const kit = await confirmKitUi(page);
  await expectUnlocked(page);
  return kit;
}

export async function expectUnlocked(page: Page) {
  await expect(page.getByRole('button', { name: 'Vault settings' })).toBeVisible({ timeout: 30000 });
}

export async function unlockUi(page: Page, pin: string = PIN) {
  await page.getByPlaceholder('Enter PIN').fill(pin);
  await page.getByRole('button', { name: 'Unlock Vault' }).click();
}

export async function keyringOf(api: APIRequestContext) {
  return (await api.get('/api/vault/keyring')).json();
}

/** Contenuto grezzo di una nota letto dal server (riga Note). */
export async function serverNote(api: APIRequestContext, id: string) {
  const r = await api.get(`/api/notes/${id}`);
  return r.json();
}

export async function vaultItems(api: APIRequestContext, ids?: string[]) {
  const r = await api.post('/api/vault/items', { data: ids ? { ids } : {} });
  return r.json();
}

/** Svuota la cache dei dati sensibili non serve: ogni test usa un utente nuovo. */
export const ENVELOPE = /^nv3\.\d+\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/;

// ---------------------------------------------------------------------------------------------------------------------
// UI del vault sbloccato
// ---------------------------------------------------------------------------------------------------------------------

export function noteIdOf(page: Page): string {
  return new URL(page.url()).searchParams.get('noteId')!;
}

async function openCreateMenu(page: Page) {
  await page.locator('[data-create-menu] > button').click();
}

/** Contenuto del server per l'id; '' se la nota non c'e' ancora. */
async function contentOnServer(api: APIRequestContext, id: string): Promise<string> {
  const r = await api.get(`/api/notes/${id}`);
  return r.ok() ? ((await r.json()).content as string) : '';
}

/** Aspetta che la nota raggiunga il server (envelope) e ritorna il contenuto. */
export async function waitForEnvelopeOnServer(api: APIRequestContext, id: string): Promise<string> {
  await expect.poll(() => contentOnServer(api, id), { timeout: 45000 }).toMatch(ENVELOPE);
  return contentOnServer(api, id);
}

/** Dopo una modifica: aspetta che il contenuto del server cambi rispetto a `before` e si stabilizzi (push debounced). */
export async function waitForServerEdit(api: APIRequestContext, id: string, before: string): Promise<string> {
  await expect.poll(() => contentOnServer(api, id), { timeout: 45000 }).not.toBe(before);
  let last = await contentOnServer(api, id);
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const now = await contentOnServer(api, id);
    if (now === last) return now;
    last = now;
  }
  return last;
}

export async function createCredentialUi(
  page: Page,
  api: APIRequestContext,
  c: { title: string; username: string; password: string; notes?: string },
): Promise<string> {
  await openCreateMenu(page);
  await page.locator('[data-create-menu] > div button', { hasText: 'New Credential' }).click();
  await expect(page).toHaveURL(/noteId=/, { timeout: 15000 });
  const id = noteIdOf(page);
  const before = await waitForEnvelopeOnServer(api, id);
  await page.getByPlaceholder('Untitled Credential').fill(c.title);
  await page.getByPlaceholder('Enter username or email').fill(c.username);
  await page.getByPlaceholder('Enter password').fill(c.password);
  if (c.notes) await page.getByPlaceholder('Additional notes...').fill(c.notes);
  await waitForServerEdit(api, id, before);
  return id;
}

export async function createSecureNoteUi(page: Page, api: APIRequestContext, n: { title: string; body: string }): Promise<string> {
  await openCreateMenu(page);
  await page.locator('[data-create-menu] > div button', { hasText: 'New Secure Note' }).click();
  await expect(page).toHaveURL(/noteId=/, { timeout: 15000 });
  const id = noteIdOf(page);
  const before = await waitForEnvelopeOnServer(api, id);
  await page.getByPlaceholder('Note Title').fill(n.title);
  await page.locator('.ProseMirror').click();
  await page.locator('.ProseMirror').pressSequentially(n.body);
  await waitForServerEdit(api, id, before);
  return id;
}

export async function logoutUi(page: Page) {
  await page.locator('button[title="Logout"]:visible').first().click();
  await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
}

// ---------------------------------------------------------------------------------------------------------------------
// Offline e storage del dispositivo
// ---------------------------------------------------------------------------------------------------------------------

/** Server irraggiungibile ma assets (Vite) serviti: `navigator.onLine` resta true, le chiamate /api falliscono come in rete assente. */
export async function blockApi(ctx: BrowserContext) {
  await ctx.route('**/api/**', (route) => route.abort('failed'));
}
export async function unblockApi(ctx: BrowserContext) {
  await ctx.unroute('**/api/**');
}

export async function userIdOf(page: Page): Promise<string> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('auth-storage') || '{}').state?.user?.id as string);
}

/** Share cifrato del dispositivo per l'utente (store `shares` di `notiq-vault-device`), o null. */
export async function deviceShareOf(page: Page, userId: string): Promise<unknown> {
  return page.evaluate(
    (uid) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('notiq-vault-device');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('shares')) {
            db.close();
            return resolve(null);
          }
          const r = db.transaction('shares', 'readonly').objectStore('shares').get(uid);
          r.onsuccess = () => { db.close(); resolve(r.result ?? null); };
          r.onerror = () => reject(r.error);
        };
      }),
    userId,
  );
}

/** Cache locale del keyring (`vault-storage`, byUser[userId]). */
export async function vaultCacheOf(page: Page, userId: string): Promise<Record<string, unknown> | null> {
  return page.evaluate((uid) => {
    const raw = localStorage.getItem('vault-storage');
    return raw ? (JSON.parse(raw).state?.byUser?.[uid] ?? null) : null;
  }, userId);
}

/** Elementi della syncQueue di Dexie (`NotiqDB`), serializzati. */
export async function syncQueueOf(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('NotiqDB');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const r = db.transaction('syncQueue', 'readonly').objectStore('syncQueue').getAll();
          r.onsuccess = () => { db.close(); resolve((r.result as unknown[]).map((x) => JSON.stringify(x))); };
          r.onerror = () => reject(r.error);
        };
      }),
  );
}

export async function lockUi(page: Page) {
  await page.getByRole('button', { name: 'Lock Vault' }).click();
  await expect(page.getByRole('heading', { name: 'Vault Locked' })).toBeVisible({ timeout: 15000 });
}

/** Tutti gli object store di `NotiqDB` e tutto `localStorage`, serializzati in una stringa (per cercare plaintext che non deve esserci). */
export async function dumpDeviceStorage(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const open = indexedDB.open('NotiqDB');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const names = Array.from(db.objectStoreNames);
          const out: Record<string, unknown[]> = {};
          if (!names.length) { db.close(); return resolve(JSON.stringify({ ls: { ...localStorage } })); }
          const tx = db.transaction(names, 'readonly');
          for (const n of names) {
            const r = tx.objectStore(n).getAll();
            r.onsuccess = () => { out[n] = r.result; };
          }
          tx.oncomplete = () => { db.close(); resolve(JSON.stringify({ db: out, ls: { ...localStorage } })); };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
}
