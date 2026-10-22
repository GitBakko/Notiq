// Vault v3 (T17): VaultPage come macchina a stati. Figli, rete, codec e Dexie finti; si verifica quale schermata esce e cosa si scrive.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any -- mock Vitest */
const h = vi.hoisted(() => ({
  rows: [] as any[],
  queue: [] as any[],
  getKeyring: vi.fn(),
  reconcile: vi.fn(),
  hydrate: vi.fn(),
  checkPending: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  rootKey: { v: { id: 'rk', ecdhSpki: new Uint8Array([1]) } as any },
  notebooks: [{ id: 'nb1' }] as any[],
  migrateProps: [] as any[],
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-hot-toast', () => {
  const toast: any = vi.fn();
  toast.success = vi.fn();
  toast.error = vi.fn();
  return { default: toast };
});
vi.mock('dexie-react-hooks', async () => {
  const { useEffect, useState } = await import('react');
  return {
    useLiveQuery: (fn: () => Promise<unknown>, deps: unknown[] = []) => {
      const [v, setV] = useState<unknown>(undefined);
      // eslint-disable-next-line react-hooks/exhaustive-deps
      useEffect(() => { let c = false; fn().then((r) => { if (!c) setV(r); }); return () => { c = true; }; }, deps);
      return v;
    },
  };
});
vi.mock('../../../lib/db', () => ({
  db: {
    notes: {
      toArray: async () => [...h.rows],
      get: async (id: string) => h.rows.find((r) => r.id === id),
      add: async (r: any) => { h.rows.push(r); },
    },
    syncQueue: { add: async (i: any) => { h.queue.push(i); } },
    transaction: async (_m: string, _a: unknown, _b: unknown, fn: () => Promise<unknown>) => fn(),
  },
}));
vi.mock('../../../lib/vaultApi', () => ({ getKeyring: (...a: unknown[]) => h.getKeyring(...a) }));
vi.mock('../../../lib/vaultReconcile', () => ({
  vaultReconcile: (...a: unknown[]) => h.reconcile(...a),
  hydrateVaultNote: (...a: unknown[]) => h.hydrate(...a),
}));
vi.mock('../../../lib/vaultSession', () => ({ checkPendingOnStart: (...a: unknown[]) => h.checkPending(...a) }));
vi.mock('../../../lib/vaultCodec', () => ({
  encryptItem: (...a: unknown[]) => h.encrypt(...a),
  decryptItem: (...a: unknown[]) => h.decrypt(...a),
}));
vi.mock('../../../utils/vaultRootKeys', () => ({ getActiveRootKey: () => h.rootKey.v }));
vi.mock('../../../store/authStore', () => ({
  useAuthStore: Object.assign((sel: (s: unknown) => unknown) => sel({ user: { id: 'u1' } }), { getState: () => ({ user: { id: 'u1' } }) }),
}));
vi.mock('../../../store/uiStore', () => ({
  useUIStore: () => ({
    toggleSidebar: vi.fn(), notesSortField: 'updatedAt', notesSortOrder: 'desc', setNotesSort: vi.fn(),
    isListCollapsed: false, toggleListCollapsed: vi.fn(), collapseAll: vi.fn(),
  }),
}));
vi.mock('../../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../../hooks/useNotebooks', () => ({ useNotebooks: () => ({ notebooks: h.notebooks }) }));
vi.mock('../../../components/ui/SortDropdown', () => ({ default: () => null }));
vi.mock('../../tags/TagList', () => ({ default: () => null }));
vi.mock('../VaultSetup', () => ({
  default: (p: any) => (
    <div data-testid="setup">
      <button onClick={p.onDone}>setup-done</button>
      <button onClick={p.onAlreadySetup}>setup-already</button>
    </div>
  ),
}));
vi.mock('../VaultUnlock', () => ({
  default: (p: any) => <div data-testid="unlock" data-notice={p.notice ?? ''}><button onClick={p.onUnlocked}>unlocked</button></div>,
}));
vi.mock('../VaultMigrate', () => ({ default: (p: any) => { h.migrateProps.push(p); return <div data-testid="migrate" />; } }));
vi.mock('../VaultSettingsSheet', () => ({ default: (p: any) => (p.isOpen ? <div data-testid="settings" /> : null) }));
vi.mock('../VaultNoteEditor', () => ({ default: (p: any) => <div data-testid="note-editor">{p.note.id}<button onClick={p.onBack}>note-back</button></div> }));
vi.mock('../CredentialForm', () => ({ default: (p: any) => <div data-testid="cred-form">{p.note.id}</div> }));
vi.mock('../CredentialCard', () => ({ default: (p: any) => <button onClick={p.onClick}>{`card:${p.note.id}`}</button> }));
vi.mock('../RecoveryKitSheet', () => ({ default: () => <div data-testid="kit" /> }));

import { useVaultStore } from '../../../store/vaultStore';
import VaultPage from '../VaultPage';

const ENV = (n: string) => `nv3.1.${'A'.repeat(16)}.${n.padEnd(22, 'B')}`;
const apiErr = (status: number, key: string) => Object.assign(new Error(key), { name: 'VaultApiError', status, key });
const lockVault = vi.fn(async () => {});

const mount = () => {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><VaultPage /></MemoryRouter>
    </QueryClientProvider>,
  );
};
const createFromMenu = async (label: string) => {
  fireEvent.click(await screen.findByLabelText('vault.createSecureNote'));
  fireEvent.click(within(document.querySelector('[data-create-menu]') as HTMLElement).getByText(label));
};
const unlock = () => useVaultStore.setState({ unlockedUserId: 'u1', keys: {} as any, epoch: 1, lockVault });

beforeEach(() => {
  vi.clearAllMocks();
  h.rows.length = 0;
  h.queue.length = 0;
  h.migrateProps.length = 0;
  h.rootKey.v = { id: 'rk', ecdhSpki: new Uint8Array([1]) };
  h.notebooks = [{ id: 'nb1' }];
  h.reconcile.mockResolvedValue({ legacyLeft: 0 });
  h.checkPending.mockResolvedValue('none');
  h.hydrate.mockResolvedValue(false);
  h.encrypt.mockImplementation(async (id: string) => ENV(id.replace(/-/g, '')));
  h.decrypt.mockImplementation(async (_id: string, _t: string, env: string) => ({ t: `T:${env.slice(-8)}`, c: '{}' }));
  useVaultStore.setState({ unlockedUserId: null, keys: null, epoch: null, byUser: {}, lockVault });
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});
afterEach(() => { vi.useRealTimers(); });

describe('VaultPage: macchina a stati da bloccato', () => {
  it('UNKNOWN: GET fallita e nessuna copia locale -> VaultOfflineNotice, MAI il setup', async () => {
    h.getKeyring.mockRejectedValue(apiErr(0, 'errors.common.networkError'));
    mount();
    await screen.findByText('vault.offline.title');
    expect(screen.queryByTestId('setup')).toBeNull();
    expect(screen.queryByTestId('unlock')).toBeNull();
  });

  it('UNKNOWN: 404 e 5xx valgono come rete assente', async () => {
    h.getKeyring.mockRejectedValue(apiErr(404, 'errors.common.unknownError'));
    mount();
    await screen.findByText('vault.offline.title');
    expect(screen.queryByTestId('setup')).toBeNull();
  });

  it('503 errors.vault.unavailable (nessuna copia locale) -> messaggio dedicato con "Riprova", non la schermata offline', async () => {
    h.getKeyring.mockRejectedValueOnce(apiErr(503, 'errors.vault.unavailable')).mockResolvedValue({ status: 'READY', legacyCount: 0 });
    mount();
    await screen.findByText('errors.vault.unavailable');
    expect(screen.queryByText('vault.offline.title')).toBeNull();
    expect(screen.queryByTestId('setup')).toBeNull();
    fireEvent.click(screen.getByText('vault.offline.retry'));
    await screen.findByTestId('unlock');
  });

  it('setupDisabled: "Riprova" rilegge il keyring (il flag puo cambiare senza remount)', async () => {
    h.getKeyring.mockResolvedValueOnce({ status: 'NONE', legacyCount: 0, setupAllowed: false }).mockResolvedValue({ status: 'READY', legacyCount: 0 });
    mount();
    await screen.findByText('errors.vault.setupDisabled');
    fireEvent.click(screen.getByText('vault.offline.retry'));
    await screen.findByTestId('unlock');
    expect(h.getKeyring).toHaveBeenCalledTimes(2);
  });

  it('UNKNOWN: "Riprova" rilegge il keyring e passa a READY', async () => {
    h.getKeyring.mockRejectedValueOnce(apiErr(0, 'errors.common.networkError')).mockResolvedValue({ status: 'READY', legacyCount: 0 });
    mount();
    fireEvent.click(await screen.findByText('vault.offline.retry'));
    await screen.findByTestId('unlock');
    expect(h.getKeyring).toHaveBeenCalledTimes(2);
  });

  it('GET fallita ma keyring in cache READY -> VaultUnlock (sblocco offline)', async () => {
    h.getKeyring.mockRejectedValue(apiErr(0, 'errors.common.networkError'));
    useVaultStore.setState({ byUser: { u1: { status: 'READY', epoch: 1 } as any } });
    mount();
    await screen.findByTestId('unlock');
  });

  it('NONE senza legacy -> VaultSetup', async () => {
    h.getKeyring.mockResolvedValue({ status: 'NONE', legacyCount: 0 });
    mount();
    await screen.findByTestId('setup');
    expect(screen.queryByTestId('migrate')).toBeNull();
  });

  it('NONE con 2 legacy -> wizard VaultMigrate (non resume), non il setup', async () => {
    h.getKeyring.mockResolvedValue({ status: 'NONE', legacyCount: 2 });
    mount();
    await screen.findByTestId('migrate');
    expect(screen.queryByTestId('setup')).toBeNull();
    expect(h.migrateProps[0]).toMatchObject({ userId: 'u1', rootKey: h.rootKey.v });
    expect(h.migrateProps[0].resume).toBeFalsy();
  });

  it('NONE con legacy ma senza chiave root attiva -> testo "non accessibile", niente wizard', async () => {
    h.rootKey.v = null;
    h.getKeyring.mockResolvedValue({ status: 'NONE', legacyCount: 2 });
    mount();
    await screen.findByText('errors.vault.setupDisabled');
    expect(screen.queryByTestId('migrate')).toBeNull();
  });

  it('READY -> VaultUnlock', async () => {
    h.getKeyring.mockResolvedValue({ status: 'READY', legacyCount: 0 });
    mount();
    await screen.findByTestId('unlock');
  });

  it('NONE + setupAllowed false (senza legacy) -> testo "non accessibile", ne\' setup ne\' wizard ne\' offline', async () => {
    h.getKeyring.mockResolvedValue({ status: 'NONE', legacyCount: 0, setupAllowed: false });
    mount();
    await screen.findByText('errors.vault.setupDisabled');
    expect(screen.queryByTestId('setup')).toBeNull();
    expect(screen.queryByTestId('migrate')).toBeNull();
    expect(screen.queryByText('vault.offline.title')).toBeNull();
  });

  it('NONE + setupAllowed false con legacy -> stesso testo, niente wizard di migrazione', async () => {
    h.getKeyring.mockResolvedValue({ status: 'NONE', legacyCount: 2, setupAllowed: false });
    mount();
    await screen.findByText('errors.vault.setupDisabled');
    expect(screen.queryByTestId('setup')).toBeNull();
    expect(screen.queryByTestId('migrate')).toBeNull();
  });

  it('NONE + setupAllowed true -> setup (il flag non blocca)', async () => {
    h.getKeyring.mockResolvedValue({ status: 'NONE', legacyCount: 0, setupAllowed: true });
    mount();
    await screen.findByTestId('setup');
  });

  it('READY normale -> VaultUnlock senza notice', async () => {
    h.getKeyring.mockResolvedValue({ status: 'READY', legacyCount: 0 });
    mount();
    expect((await screen.findByTestId('unlock')).getAttribute('data-notice')).toBe('');
  });

  it('setup: alreadySetup (keyring creato altrove) -> VaultUnlock con notice="alreadySetup"', async () => {
    h.getKeyring.mockResolvedValue({ status: 'NONE', legacyCount: 0 });
    mount();
    fireEvent.click(await screen.findByText('setup-already'));
    expect((await screen.findByTestId('unlock')).getAttribute('data-notice')).toBe('alreadySetup');
  });

  it('il notice alreadySetup sparisce dopo lo sblocco', async () => {
    h.getKeyring.mockResolvedValue({ status: 'NONE', legacyCount: 0 });
    mount();
    fireEvent.click(await screen.findByText('setup-already'));
    fireEvent.click(await screen.findByText('unlocked'));
    h.getKeyring.mockResolvedValue({ status: 'READY', legacyCount: 0 });
    act(() => { unlock(); });
    act(() => { useVaultStore.setState({ unlockedUserId: null, keys: null }); }); // auto-lock
    await waitFor(() => expect(screen.getByTestId('unlock').getAttribute('data-notice')).toBe(''));
  });

  it('UNKNOWN: l\'evento "online" rilegge il keyring e passa a READY', async () => {
    h.getKeyring.mockRejectedValueOnce(apiErr(0, 'errors.common.networkError')).mockResolvedValue({ status: 'READY', legacyCount: 0 });
    mount();
    await screen.findByText('vault.offline.title');
    act(() => { window.dispatchEvent(new Event('online')); });
    await screen.findByTestId('unlock');
    expect(h.getKeyring).toHaveBeenCalledTimes(2);
  });

  it('RESET_PENDING -> "vault non disponibile", nessun form', async () => {
    h.getKeyring.mockResolvedValue({ status: 'RESET_PENDING', legacyCount: 0 });
    mount();
    await screen.findByText('vault.resetPending');
    expect(screen.queryByTestId('unlock')).toBeNull();
  });

  it('durante il caricamento non c\'e\' mai il setup', async () => {
    h.getKeyring.mockReturnValue(new Promise(() => {}));
    mount();
    expect(await screen.findByText('common.loading')).toBeTruthy();
    expect(screen.queryByTestId('setup')).toBeNull();
  });

  it('setup: lo sblocco a meta\' cerimonia non smonta il wizard; onDone mostra il vault', async () => {
    h.getKeyring.mockResolvedValue({ status: 'NONE', legacyCount: 0 });
    mount();
    await screen.findByTestId('setup');
    act(() => { unlock(); });
    expect(screen.getByTestId('setup')).toBeTruthy();
    expect(h.reconcile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('setup-done'));
    await waitFor(() => expect(screen.queryByTestId('setup')).toBeNull());
    await waitFor(() => expect(h.reconcile).toHaveBeenCalled());
  });
});

describe('VaultPage: sbloccato', () => {
  it('non legge il keyring e avvia il reconcile', async () => {
    unlock();
    mount();
    await waitFor(() => expect(h.reconcile).toHaveBeenCalledTimes(1));
    expect(h.getKeyring).not.toHaveBeenCalled();
  });

  it('il reconcile riparte al ritorno online', async () => {
    unlock();
    mount();
    await waitFor(() => expect(h.reconcile).toHaveBeenCalledTimes(1));
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });

  it('chiusura di una nota aperta -> reconcile (+1); offline no', async () => {
    unlock();
    h.rows.push({ id: 'a', userId: 'u1', title: '', content: ENV('alpha'), isVault: true, noteType: 'NOTE', updatedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' });
    const open = () => render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/?noteId=a']}><VaultPage /></MemoryRouter>
      </QueryClientProvider>,
    );
    const { unmount } = open();
    await waitFor(() => expect(h.reconcile).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByText('note-back'));
    await waitFor(() => expect(h.reconcile).toHaveBeenCalledTimes(2));
    unmount();

    h.reconcile.mockClear();
    open();
    await waitFor(() => expect(h.reconcile).toHaveBeenCalledTimes(1));
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    fireEvent.click(await screen.findByText('note-back'));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it('il lock all\'unmount resta', () => {
    unlock();
    const { unmount } = mount();
    expect(lockVault).not.toHaveBeenCalled();
    unmount();
    expect(lockVault).toHaveBeenCalled();
  });

  it('creazione nota: envelope con l\'id definitivo, title vuoto in Dexie e nella CREATE, isEncrypted', async () => {
    unlock();
    mount();
    await createFromMenu('vault.createSecureNote');
    await waitFor(() => expect(h.rows).toHaveLength(1));
    const row = h.rows[0];
    expect(h.encrypt).toHaveBeenCalledTimes(1);
    const [id, type, item] = h.encrypt.mock.calls[0];
    expect(id).toBe(row.id);
    expect(type).toBe('NOTE');
    expect(item.t).toBe('notes.untitled');
    expect(JSON.parse(item.c).type).toBe('doc');
    expect(row).toMatchObject({ title: '', isVault: true, isEncrypted: true, noteType: 'NOTE', syncStatus: 'created', userId: 'u1' });
    expect(row.content).toMatch(/^nv3\./);
    expect(h.queue).toHaveLength(1);
    expect(h.queue[0]).toMatchObject({ type: 'CREATE', entityId: row.id });
    expect(h.queue[0].data).toMatchObject({ id: row.id, title: '', content: row.content, isVault: true, isEncrypted: true });
    await screen.findByTestId('note-editor');
  });

  it('creazione credenziale: noteType CREDENTIAL e dati vuoti cifrati', async () => {
    unlock();
    mount();
    await createFromMenu('vault.createCredential');
    await waitFor(() => expect(h.rows).toHaveLength(1));
    expect(h.encrypt.mock.calls[0][1]).toBe('CREDENTIAL');
    expect(h.encrypt.mock.calls[0][2].t).toBe('vault.credential.untitled');
    expect(h.rows[0]).toMatchObject({ title: '', noteType: 'CREDENTIAL' });
    await screen.findByTestId('cred-form');
  });

  it('envelope oltre 2 MiB: nessuna scrittura', async () => {
    unlock();
    h.encrypt.mockResolvedValue(`nv3.1.${'A'.repeat(16)}.${'B'.repeat(2 * 1024 * 1024)}`);
    mount();
    await createFromMenu('vault.createCredential');
    await waitFor(() => expect(h.encrypt).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(h.rows).toHaveLength(0);
    expect(h.queue).toHaveLength(0);
  });

  it('la ricerca usa i titoli decifrati in memoria (title in Dexie e\' \'\')', async () => {
    unlock();
    h.rows.push(
      { id: 'a', userId: 'u1', title: '', content: ENV('alpha'), isVault: true, noteType: 'NOTE', updatedAt: '2026-01-02T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'b', userId: 'u1', title: '', content: ENV('bravo'), isVault: true, noteType: 'NOTE', updatedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' },
    );
    h.decrypt.mockImplementation(async (id: string) => ({ t: id === 'a' ? 'Banca' : 'Medico', c: '{}' }));
    mount();
    await screen.findByText('Banca');
    await screen.findByText('Medico');
    fireEvent.change(screen.getByLabelText('common.search'), { target: { value: 'med' } });
    await waitFor(() => expect(screen.queryByText('Banca')).toBeNull());
    expect(screen.getByText('Medico')).toBeTruthy();
  });

  it('la lista mostra solo le righe vault dell\'utente corrente', async () => {
    unlock();
    h.rows.push(
      { id: 'a', userId: 'u1', title: '', content: ENV('alpha'), isVault: true, noteType: 'NOTE', updatedAt: '2026-01-02T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'x', userId: 'u2', title: '', content: ENV('xray'), isVault: true, noteType: 'NOTE', updatedAt: '2026-01-02T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' },
    );
    h.decrypt.mockImplementation(async (id: string) => ({ t: id === 'a' ? 'Mia' : 'Altrui', c: '{}' }));
    mount();
    await screen.findByText('Mia');
    expect(screen.queryByText('Altrui')).toBeNull();
    expect(h.decrypt).not.toHaveBeenCalledWith('x', expect.anything(), expect.anything());
  });

  it('envelope invariato: un nuovo giro della lista non ridecifra', async () => {
    unlock();
    h.rows.push({ id: 'a', userId: 'u1', title: '', content: ENV('alpha'), isVault: true, noteType: 'NOTE', updatedAt: '2026-01-02T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' });
    h.decrypt.mockImplementation(async () => ({ t: 'Mia', c: '{}' }));
    mount();
    await screen.findByText('Mia');
    expect(h.decrypt).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('vault.filterNote')); // nuova live query, stessa riga
    await screen.findByText('Mia');
    await new Promise((r) => setTimeout(r, 20));
    expect(h.decrypt).toHaveBeenCalledTimes(1);
  });

  it('la ricerca sulle credenziali trova anche sito e utente decifrati', async () => {
    unlock();
    h.rows.push({ id: 'c', userId: 'u1', title: '', content: ENV('cred'), isVault: true, noteType: 'CREDENTIAL', updatedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' });
    h.decrypt.mockResolvedValue({ t: 'Tizio', c: JSON.stringify({ siteUrl: 'https://example.org', username: 'mario' }) });
    mount();
    await screen.findByText('card:c');
    fireEvent.change(screen.getByLabelText('common.search'), { target: { value: 'mario' } });
    await waitFor(() => expect(screen.getByText('card:c')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('common.search'), { target: { value: 'zzz' } });
    await waitFor(() => expect(screen.queryByText('card:c')).toBeNull());
  });

  it('banner "N elementi da aggiornare" -> wizard in modalita\' resume', async () => {
    unlock();
    h.reconcile.mockResolvedValue({ legacyLeft: 3 });
    mount();
    fireEvent.click(await screen.findByText('vault.settings.legacyLeftAction'));
    await screen.findByTestId('migrate');
    expect(h.migrateProps.at(-1)).toMatchObject({ resume: true, userId: 'u1' });
  });

  it('Kit non confermato al riavvio -> banner che apre lo sheet delle impostazioni', async () => {
    unlock();
    h.checkPending.mockResolvedValue('kitUnconfirmed');
    mount();
    fireEvent.click(await screen.findByText('vault.kitUnconfirmedAction'));
    await screen.findByTestId('settings');
  });

  it('il pulsante impostazioni apre lo sheet', async () => {
    unlock();
    mount();
    fireEvent.click(await screen.findByLabelText('vault.settings.title'));
    await screen.findByTestId('settings');
  });

  it('credenziale con content vuoto: si idrata prima di aprirla', async () => {
    unlock();
    h.rows.push({ id: 'c', userId: 'u1', title: '', content: '', isVault: true, noteType: 'CREDENTIAL', updatedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' });
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/?noteId=c']}><VaultPage /></MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(h.hydrate).toHaveBeenCalledWith('c'));
  });
});

describe('VaultPage: sorgente', () => {
  it('nessun importFile e nessun useVaultHydration', () => {
    const src = readFileSync(resolve(__dirname, '../VaultPage.tsx'), 'utf8');
    expect(src).not.toMatch(/importFile/);
    expect(src).not.toMatch(/useVaultHydration/);
  });
});
