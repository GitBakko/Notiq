// Vault v3 (T17): VaultPage come macchina a stati. Figli, rete, codec e Dexie finti; si verifica quale schermata esce e cosa si scrive.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within, cleanup } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { RESET_CHANGED_EVENT } from '../../../lib/vaultEvents';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any -- mock Vitest */
const h = vi.hoisted(() => ({
  rows: [] as any[],
  queue: [] as any[],
  qUpdate: vi.fn(),
  lockBusy: false,
  getKeyring: vi.fn(),
  cancelReset: vi.fn(),
  reconcile: vi.fn(),
  hydrate: vi.fn(),
  checkPending: vi.fn(),
  syncCache: vi.fn(),
  refreshCache: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  rootKey: { v: { id: 'rk', ecdhSpki: new Uint8Array([1]) } as any },
  notebooks: [{ id: 'nb1' }] as any[],
  migrateProps: [] as any[],
  syncPush: vi.fn(),
  finish: vi.fn(),
  rewrap: vi.fn(),
  permDelete: vi.fn(),
  foreignPending: vi.fn(),
  liveSubs: new Set<() => void>(), // le live query si rilanciano su richiesta (notifyLive)
  editorProps: [] as any[],
  credProps: [] as any[],
  getHold: null as null | { id: string; p: Promise<void> }, // db.notes.get(id) resta pendente finche' p non si risolve
}));

// con `count` il testo porta il numero (chiave:n), cosi' i test leggono i conteggi del dialog delle note stale
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: { count?: number }) => (typeof o?.count === 'number' ? `${k}:${o.count}` : k), i18n: { language: 'en' } }) }));
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
      const [tick, setTick] = useState(0);
      useEffect(() => {
        const bump = () => setTick((n) => n + 1);
        h.liveSubs.add(bump);
        return () => { h.liveSubs.delete(bump); };
      }, []);
      // eslint-disable-next-line react-hooks/exhaustive-deps
      useEffect(() => { let c = false; fn().then((r) => { if (!c) setV(r); }); return () => { c = true; }; }, [...deps, tick]);
      return v;
    },
  };
});
vi.mock('../../../lib/db', () => ({
  db: {
    notes: {
      toArray: async () => [...h.rows],
      get: async (id: string) => { if (h.getHold?.id === id) await h.getHold.p; return h.rows.find((r) => r.id === id); },
      add: async (r: any) => { h.rows.push(r); },
    },
    syncQueue: {
      add: async (i: any) => { h.queue.push(i); },
      filter: (fn: (i: any) => boolean) => ({ toArray: async () => h.queue.filter(fn) }),
      update: (...a: unknown[]) => h.qUpdate(...a),
    },
    transaction: async (_m: string, _a: unknown, _b: unknown, fn: () => Promise<unknown>) => fn(),
  },
}));
vi.mock('../../../lib/vaultApi', () => ({ getKeyring: (...a: unknown[]) => h.getKeyring(...a), cancelReset: (...a: unknown[]) => h.cancelReset(...a) }));
vi.mock('../../../lib/vaultReconcile', () => ({
  vaultReconcile: (...a: unknown[]) => h.reconcile(...a),
  hydrateVaultNote: (...a: unknown[]) => h.hydrate(...a),
}));
vi.mock('../../../lib/vaultSession', () => ({
  checkPendingOnStart: (...a: unknown[]) => h.checkPending(...a),
  syncKeyringCache: (...a: unknown[]) => h.syncCache(...a),
  refreshKeyringCache: (...a: unknown[]) => h.refreshCache(...a),
  hasForeignEpochPending: (...a: unknown[]) => h.foreignPending(...a),
}));
vi.mock('../../../lib/vaultCodec', () => ({
  encryptItem: (...a: unknown[]) => h.encrypt(...a),
  decryptItem: (...a: unknown[]) => h.decrypt(...a),
}));
vi.mock('../../sync/syncService', () => ({ syncPush: (...a: unknown[]) => h.syncPush(...a) }));
vi.mock('../vaultMigration', () => ({
  finishRotation: (...a: unknown[]) => h.finish(...a),
  rewrapUnreadable: (...a: unknown[]) => h.rewrap(...a),
  MAX_REWRAP_LEN: 1.5 * 1024 * 1024,
}));
vi.mock('../../../lib/vaultNoteLock', () => ({ withNoteLock: async (_id: string, fn: () => unknown) => (h.lockBusy ? { status: 'busy' } : { status: 'ran', value: await fn() }) })); // jsdom non ha navigator.locks
vi.mock('../../notes/noteService', () => ({ permanentlyDeleteNote: (...a: unknown[]) => h.permDelete(...a) }));
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
  default: (p: any) => <div data-testid="unlock" data-notice={p.notice ?? ''}><button onClick={p.onUnlocked}>unlocked</button><button onClick={p.onForgot}>forgot</button></div>,
}));
vi.mock('../VaultRecovery', () => ({
  default: (p: any) => (
    <div data-testid="recovery">
      <button onClick={() => p.onClose('unlock')}>rec-unlock</button>
      <button onClick={() => p.onClose('regenerate')}>rec-regen</button>
      <button onClick={() => p.onClose('none')}>rec-none</button>
    </div>
  ),
}));
vi.mock('../VaultMigrate', () => ({ default: (p: any) => { h.migrateProps.push(p); return <div data-testid="migrate" />; } }));
// come il vero foglio: la cerimonia del Kit resta montata anche con isOpen falso (RecoveryKitSheet sta prima del guard su isOpen)
vi.mock('../VaultSettingsSheet', async () => {
  const { useState } = await import('react');
  return {
    default: function SheetMock(p: any) {
      const [kit, setKit] = useState(false);
      if (kit) return <div data-testid="kit-mock"><button onClick={() => { setKit(false); p.onKitDone(); }}>kit-done</button></div>;
      return p.isOpen ? (
        <div data-testid="settings" data-force={p.forceKit ? '1' : ''} data-reason={p.forceReason ?? ''}>
          <button onClick={p.onKitDone}>kit-done</button>
          <button onClick={p.onRotationPending}>rotation-pending</button>
          <button onClick={p.onLocalPending}>local-pending</button>
          <button onClick={() => p.onKitFailed('vault.migrate.errors.flushTimeout')}>kit-failed</button>
          <button onClick={() => p.onKitFailed('errors.vault.invalidRootKey')}>kit-failed-root</button>
          <button onClick={() => { setKit(true); p.onKitStart(); p.onClose(); }}>kit-start</button> {/* onClose: il flag e' stato azzerato, il foglio non e' piu' "aperto" ma la cerimonia resta montata */}
          <button onClick={p.onClose}>settings-close</button>
        </div>
      ) : null;
    },
  };
});
vi.mock('../VaultNoteEditor', () => ({
  default: (p: any) => {
    h.editorProps.push(p);
    return <div data-testid="note-editor">{p.note.id}<button onClick={p.onBack}>note-back</button><button onClick={p.onReleased}>note-release</button></div>;
  },
}));
vi.mock('../CredentialForm', () => ({
  default: (p: any) => {
    h.credProps.push(p);
    return <div data-testid="cred-form">{p.note.id}<button onClick={p.onLegacyPin}>cred-legacy</button><button onClick={p.onReleased}>cred-release</button></div>;
  },
}));
vi.mock('../CredentialCard', () => ({ default: (p: any) => <button onClick={p.onClick}>{`card:${p.note.id}`}</button> }));
vi.mock('../RecoveryKitSheet', () => ({ default: () => <div data-testid="kit" /> }));

import { useVaultStore } from '../../../store/vaultStore';
import VaultPage from '../VaultPage';

const ENV = (n: string) => `nv3.1.${'A'.repeat(16)}.${n.padEnd(22, 'B')}`;
const apiErr = (status: number, key: string) => Object.assign(new Error(key), { name: 'VaultApiError', status, key });
const lockVault = vi.fn(async () => {});
// risultato completo del giro: i test sovrascrivono solo i campi che contano
const res = (o: Record<string, unknown> = {}) => ({
  hydrated: 0, conflictsResolved: 0, copies: 0, legacyResolved: 0, reactivated: 0, finalized: 0, legacyLeft: 0, staleLeft: 0, unresolved: 0, later: 0, legacyPin: 0, ...o,
});
// esito completo di rewrapUnreadable: i test sovrascrivono solo i bucket che contano
const rw = (o: Record<string, unknown> = {}) => ({ rewrapped: [], tooLarge: [], readable: [], keyMissing: [], conflicts: [], unverified: [], failed: [], notFound: 0, ...o });
const notifyLive = () => act(async () => { h.liveSubs.forEach((f) => f()); await Promise.resolve(); });

function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname + l.search}</div>; }
const mount = (url = '/') => {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}><VaultPage /><Where /></MemoryRouter>
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
  h.lockBusy = false;
  h.qUpdate.mockReset();
  h.migrateProps.length = 0;
  h.editorProps.length = 0;
  h.credProps.length = 0;
  h.getHold = null;
  h.syncPush.mockResolvedValue(true);
  h.rootKey.v = { id: 'rk', ecdhSpki: new Uint8Array([1]) };
  h.notebooks = [{ id: 'nb1' }];
  h.reconcile.mockResolvedValue(res());
  h.checkPending.mockResolvedValue('none');
  h.refreshCache.mockResolvedValue(undefined);
  h.finish.mockResolvedValue({ unreadable: [] });
  h.rewrap.mockResolvedValue(rw());
  h.permDelete.mockResolvedValue(undefined);
  h.foreignPending.mockResolvedValue(false);
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

  it('NONE con legacy ma senza chiave root attiva -> testo legacy dedicato, niente wizard', async () => {
    h.rootKey.v = null;
    h.getKeyring.mockResolvedValue({ status: 'NONE', legacyCount: 2 });
    mount();
    await screen.findByText('vault.setupDisabledLegacy');
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

  it('NONE + setupAllowed false con legacy -> testo legacy dedicato, niente wizard di migrazione', async () => {
    h.getKeyring.mockResolvedValue({ status: 'NONE', legacyCount: 2, setupAllowed: false });
    mount();
    await screen.findByText('vault.setupDisabledLegacy');
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

  it('RESET_PENDING -> schermata del reset in attesa con data e "Annulla reset", nessun form, regola del reset applicata', async () => {
    const kr = { status: 'RESET_PENDING', legacyCount: 0, epoch: 1, rev: 2, resetScheduledAt: '2026-12-04T10:00:00.000Z' };
    h.getKeyring.mockResolvedValue(kr);
    mount();
    await screen.findByText('vault.reset.pending.title');
    expect(screen.getByText(/vault\.reset\.pending\.text/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'vault.reset.cancel' })).toBeTruthy();
    expect(screen.queryByTestId('unlock')).toBeNull();
    expect(h.syncCache).toHaveBeenCalledWith('u1', kr);
  });

  it('RESET_PENDING: Annulla reset -> cancelReset, poi il keyring si rilegge e si torna allo sblocco', async () => {
    h.getKeyring.mockResolvedValueOnce({ status: 'RESET_PENDING', legacyCount: 0, resetScheduledAt: '2026-12-04T10:00:00.000Z' }).mockResolvedValue({ status: 'READY', legacyCount: 0 });
    h.cancelReset.mockResolvedValue({ ok: true });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'vault.reset.cancel' }));
    await screen.findByTestId('unlock');
    expect(h.cancelReset).toHaveBeenCalledTimes(1);
  });

  it('reset annullato su un altro dispositivo: al focus (o quando la scheda torna visibile) la schermata di attesa si rilegge e lascia resetPending', async () => {
    h.getKeyring.mockResolvedValueOnce({ status: 'RESET_PENDING', legacyCount: 0, resetScheduledAt: '2026-12-04T10:00:00.000Z' }).mockResolvedValue({ status: 'READY', legacyCount: 0 });
    mount();
    await screen.findByText('vault.reset.pending.title');
    act(() => { window.dispatchEvent(new Event('focus')); });
    await screen.findByTestId('unlock');
    expect(screen.queryByText('vault.reset.pending.title')).toBeNull();
  });

  it('resetPending: la rilettura parte anche da visibilitychange; con un altro gate focus non rilegge', async () => {
    h.getKeyring.mockResolvedValue({ status: 'RESET_PENDING', legacyCount: 0, resetScheduledAt: null });
    mount();
    await screen.findByText('vault.reset.pending.title');
    h.getKeyring.mockClear();
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(h.getKeyring).toHaveBeenCalledTimes(1));
    cleanup();
    h.getKeyring.mockReset().mockResolvedValue({ status: 'READY', legacyCount: 0 });
    mount();
    await screen.findByTestId('unlock');
    h.getKeyring.mockClear();
    act(() => { window.dispatchEvent(new Event('focus')); });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.getKeyring).not.toHaveBeenCalled();
  });

  it('cerimonia di recupero aperta e reset confermato altrove: la schermata del reset in attesa (con Annulla) ha la precedenza sul wizard', async () => {
    h.getKeyring.mockResolvedValueOnce({ status: 'READY', legacyCount: 0 }).mockResolvedValue({ status: 'RESET_PENDING', legacyCount: 0, resetScheduledAt: '2026-12-04T10:00:00.000Z' });
    mount();
    fireEvent.click(await screen.findByText('forgot'));
    await screen.findByTestId('recovery');
    act(() => { window.dispatchEvent(new Event(RESET_CHANGED_EVENT)); });
    await screen.findByText('vault.reset.pending.title');
    expect(screen.queryByTestId('recovery')).toBeNull();
    expect(screen.getByRole('button', { name: 'vault.reset.cancel' })).toBeTruthy();
  });

  it('un reset programmato altrove (RESET_CHANGED_EVENT) rilegge il keyring', async () => {
    h.getKeyring.mockResolvedValueOnce({ status: 'READY', legacyCount: 0 }).mockResolvedValue({ status: 'RESET_PENDING', legacyCount: 0, resetScheduledAt: null });
    mount();
    await screen.findByTestId('unlock');
    act(() => { window.dispatchEvent(new Event(RESET_CHANGED_EVENT)); });
    await screen.findByText('vault.reset.pending.title');
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

  const NOTE_A = { id: 'a', userId: 'u1', title: '', content: ENV('alpha'), isVault: true, noteType: 'NOTE', updatedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' };
  const openNote = (id = 'a') => render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[`/?noteId=${id}`]}><VaultPage /></MemoryRouter>
    </QueryClientProvider>,
  );

  it('T-c: onReleased dell editor -> prima syncPush, poi il giro; offline nessuno dei due', async () => {
    unlock();
    h.rows.push(NOTE_A);
    const order: string[] = [];
    h.syncPush.mockImplementation(async () => { order.push('push'); return true; });
    h.reconcile.mockImplementation(async () => { order.push('reconcile'); return res(); });
    const { unmount } = openNote();
    await waitFor(() => expect(order).toEqual(['reconcile'])); // T-a
    order.length = 0;
    fireEvent.click(await screen.findByText('note-release'));
    await waitFor(() => expect(order).toEqual(['push', 'reconcile']));
    unmount();

    order.length = 0;
    openNote();
    await waitFor(() => expect(order).toEqual(['reconcile']));
    order.length = 0;
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    fireEvent.click(await screen.findByText('note-release'));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
  });

  it('T-c: se la push fallisce il giro parte lo stesso', async () => {
    unlock();
    h.rows.push(NOTE_A);
    openNote();
    await waitFor(() => expect(h.reconcile).toHaveBeenCalledTimes(1));
    h.syncPush.mockRejectedValue(new Error('rete'));
    fireEvent.click(await screen.findByText('note-release'));
    await waitFor(() => expect(h.reconcile).toHaveBeenCalledTimes(2));
  });

  it('T-c: la sola uscita dalla nota (Indietro) non e piu un trigger; entrambi gli editor ricevono onReleased', async () => {
    unlock();
    h.rows.push(NOTE_A, { ...NOTE_A, id: 'c', noteType: 'CREDENTIAL', content: ENV('cred') });
    const { unmount } = openNote();
    await waitFor(() => expect(h.reconcile).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByText('note-back'));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.editorProps.at(-1).onReleased).toBeTypeOf('function');
    unmount();
    openNote('c');
    await screen.findByTestId('cred-form');
    expect(h.credProps.at(-1).onReleased).toBeTypeOf('function');
    expect(h.credProps.at(-1).onLegacyPin).toBeTypeOf('function');
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

  it('F.23: doppio clic nello stesso tick su "nuova nota": una sola creazione', async () => {
    unlock();
    mount();
    const btn = await screen.findByText('vault.createSecureNote');
    act(() => { fireEvent.click(btn); fireEvent.click(btn); });
    await waitFor(() => expect(h.rows).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.encrypt).toHaveBeenCalledTimes(1);
    expect(h.rows).toHaveLength(1);
  });

  // Il "clic scartato con il menu aperto" non si riproduce dalla UI: a mutation in corso le voci del menu sono `disabled` (nessun onClick),
  // e nello stesso tick il primo clic chiude comunque il menu. Qui resta quello che si osserva davvero: una sola creazione.
  it('F.23: doppio clic sulla voce del menu "+" nello stesso tick: una sola creazione', async () => {
    unlock();
    mount();
    await screen.findByText('vault.createSecureNote');
    const plus = screen.getByLabelText('vault.createSecureNote');
    fireEvent.click(plus);
    expect(plus.getAttribute('aria-expanded')).toBe('true');
    const item = screen.getAllByText('vault.createSecureNote').find((el) => el.closest('[data-create-menu]'))!;
    act(() => { fireEvent.click(item); fireEvent.click(item); });
    await waitFor(() => expect(h.rows).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.encrypt).toHaveBeenCalledTimes(1);
  });

  it('J.6: keyring READY dalla GET -> syncKeyringCache(userId, kr)', async () => {
    const kr = { status: 'READY', rev: 3, epoch: 1 };
    h.getKeyring.mockResolvedValue(kr);
    mount();
    await screen.findByTestId('unlock');
    expect(h.syncCache).toHaveBeenCalledWith('u1', kr);
  });

  it('P3: la regola del reset (syncKeyringCache) gira per OGNI stato del keyring, NONE compreso', async () => {
    const kr = { status: 'NONE', legacyCount: 0, epoch: 2, rev: 0 };
    h.getKeyring.mockResolvedValue(kr);
    mount();
    await screen.findByTestId('setup');
    expect(h.syncCache).toHaveBeenCalledWith('u1', kr);
  });

  it('P3: GET fallita (offline, 404, 5xx) -> nessun syncKeyringCache: niente purge', async () => {
    h.getKeyring.mockRejectedValue(apiErr(404, 'errors.vault.notFound'));
    mount();
    await screen.findByText('vault.offline.title');
    expect(h.syncCache).not.toHaveBeenCalled();
  });

  it('J.6: da sbloccato, refreshKeyringCache subito e a ogni evento online', async () => {
    unlock();
    mount();
    await waitFor(() => expect(h.refreshCache).toHaveBeenCalledTimes(1));
    expect(h.refreshCache).toHaveBeenCalledWith('u1');
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(h.refreshCache).toHaveBeenCalledTimes(2);
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
    h.reconcile.mockResolvedValue(res({ legacyLeft: 3 }));
    mount();
    fireEvent.click(await screen.findByText('vault.settings.legacyLeftAction'));
    await screen.findByTestId('migrate');
    expect(h.migrateProps.at(-1)).toMatchObject({ resume: true, userId: 'u1' });
  });

  it('banner "N elementi da aggiornare": compare e apre il resume anche senza chiave root (il resume non fa il setup)', async () => {
    unlock();
    h.rootKey.v = null;
    h.reconcile.mockResolvedValue(res({ legacyLeft: 3 }));
    mount();
    fireEvent.click(await screen.findByText('vault.settings.legacyLeftAction'));
    await screen.findByTestId('migrate');
    expect(h.migrateProps.at(-1).resume).toBe(true);
    expect(h.migrateProps.at(-1).rootKey).toBeUndefined();
  });

  it('banner del PIN precedente: con legacyPin > 0 e legacyLeft 0 compare anche senza rootKey e apre il resume', async () => {
    unlock();
    h.rootKey.v = null;
    h.reconcile.mockResolvedValue(res({ legacyPin: 2 }));
    mount();
    await screen.findByText('vault.legacyPinLeft');
    fireEvent.click(screen.getByText('vault.legacyPinLeftAction'));
    await screen.findByTestId('migrate');
    expect(h.migrateProps.at(-1)).toMatchObject({ resume: true, userId: 'u1' });
    expect(h.migrateProps.at(-1).rootKey).toBeUndefined();
  });

  it('banner del PIN precedente: nascosto con legacyLeft > 0 o con legacyPin 0', async () => {
    unlock();
    h.reconcile.mockResolvedValue(res({ legacyPin: 2, legacyLeft: 3 }));
    mount();
    await screen.findByText('vault.settings.legacyLeftAction');
    expect(screen.queryByText('vault.legacyPinLeftAction')).toBeNull();
    cleanup();
    h.reconcile.mockResolvedValue(res());
    mount();
    await waitFor(() => expect(h.reconcile).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('vault.legacyPinLeftAction')).toBeNull();
  });

  it('credenziale legacy aperta: onLegacyPin chiude la scheda e apre il resume', async () => {
    unlock();
    h.rows.push({ id: 'c', userId: 'u1', title: '', content: 'legacy-cipher', isVault: true, noteType: 'CREDENTIAL', updatedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/?noteId=c']}><VaultPage /></MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByText('cred-legacy'));
    await screen.findByTestId('migrate');
    expect(h.migrateProps.at(-1).resume).toBe(true);
  });

  it('un file trascinato fuori dall editor: dragover e drop vengono bloccati (niente navigazione); senza file no; dopo lunmount no', () => {
    unlock();
    const { unmount } = mount();
    const fire = (type: string, dt: unknown) => {
      const ev = new Event(type, { cancelable: true, bubbles: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dt });
      window.dispatchEvent(ev);
      return ev;
    };
    expect(fire('dragover', { types: ['Files'], files: [] }).defaultPrevented).toBe(true);
    expect(fire('drop', { types: ['Files'], files: [new File(['x'], 'a.png')] }).defaultPrevented).toBe(true);
    expect(fire('dragover', { types: ['text/plain'], files: [] }).defaultPrevented).toBe(false);
    expect(fire('drop', { types: ['text/plain'], files: [] }).defaultPrevented).toBe(false);
    unmount();
    expect(fire('drop', { types: ['Files'], files: [new File(['x'], 'a.png')] }).defaultPrevented).toBe(false);
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

  it('cambio di nota con la lettura ancora pendente: la form della vecchia nota non resta montata', async () => {
    unlock();
    const cred = (id: string) => ({ id, userId: 'u1', title: '', content: ENV(id), isVault: true, noteType: 'CREDENTIAL', updatedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' });
    h.rows.push(cred('c1'), cred('c2'));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/?noteId=c1']}><VaultPage /></MemoryRouter>
      </QueryClientProvider>,
    );
    expect((await screen.findByTestId('cred-form')).textContent).toContain('c1');
    let release!: () => void;
    h.getHold = { id: 'c2', p: new Promise<void>((r) => { release = r; }) };
    fireEvent.click(await screen.findByText('card:c2'));
    // c2 e' nell'URL ma la sua riga non e' ancora arrivata: mai la form di c1
    expect(screen.queryByTestId('cred-form')).toBeNull();
    await act(async () => { release(); });
    await waitFor(() => expect(screen.getByTestId('cred-form').textContent).toContain('c2'));
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

// Addendum 2 §1 e Addendum 4: trigger del giro con fake timer (solo setTimeout: i promise restano reali)
describe('VaultPage: trigger del giro T-d, T-h, T-f, T-g', () => {
  const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const conflict = (id: number, o: Record<string, unknown> = {}) => ({ id, userId: 'u1', entity: 'NOTE', status: 'failed', lastError: 'vault:conflict', ...o });
  const mountAndSettle = async () => { const r = mount(); await tick(); return r; };

  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });

  it('T-d: un conflitto nuovo dà un giro dopo 1 s', async () => {
    unlock();
    await mountAndSettle();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    h.queue.push(conflict(1));
    await notifyLive();
    await tick();
    await tick(999);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });

  it('T-d: il primo valore della sessione non scatta (lo copre T-a); altri errori vault nemmeno', async () => {
    unlock();
    h.queue.push(conflict(1));
    await mountAndSettle();
    await tick(5000);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    h.queue.push(conflict(2, { lastError: 'vault:plaintextRejected' }), conflict(3, { status: 'pending' }), conflict(4, { userId: 'u2' }));
    await notifyLive();
    await tick();
    await tick(5000);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it('T-d (memo, R1): failed, pending, failed con lo stesso id dà un solo giro; un id nuovo ne dà un altro', async () => {
    unlock();
    await mountAndSettle();
    h.queue.push(conflict(1));
    await notifyLive();
    await tick();
    await tick(1000);
    expect(h.reconcile).toHaveBeenCalledTimes(2);
    h.queue[0].status = 'pending';
    await notifyLive();
    await tick();
    h.queue[0].status = 'failed';
    await notifyLive();
    await tick();
    await tick(3000);
    expect(h.reconcile).toHaveBeenCalledTimes(2);
    h.queue.push(conflict(2));
    await notifyLive();
    await tick();
    await tick(1000);
    expect(h.reconcile).toHaveBeenCalledTimes(3);
  });

  it('T-d: offline nessun giro', async () => {
    unlock();
    await mountAndSettle();
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    h.queue.push(conflict(1));
    await notifyLive();
    await tick();
    await tick(3000);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it('T-h: una riga vault vuota nuova dopo lo sblocco dà un giro dopo 1 s', async () => {
    unlock();
    await mountAndSettle();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    h.rows.push({ id: 'n1', userId: 'u1', isVault: true, content: '', ownership: 'owned' });
    await notifyLive();
    await tick();
    await tick(999);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });

  it('T-h (memo): la stessa riga ancora vuota non riscatta; una seconda riga vuota sì', async () => {
    unlock();
    await mountAndSettle();
    h.rows.push({ id: 'n1', userId: 'u1', isVault: true, content: '', ownership: 'owned' });
    await notifyLive();
    await tick();
    await tick(1000);
    expect(h.reconcile).toHaveBeenCalledTimes(2);
    await notifyLive();
    await tick();
    await tick(3000);
    expect(h.reconcile).toHaveBeenCalledTimes(2);
    h.rows.push({ id: 'n2', userId: 'u1', isVault: true, content: '', ownership: 'owned' });
    await notifyLive();
    await tick();
    await tick(1000);
    expect(h.reconcile).toHaveBeenCalledTimes(3);
  });

  it('T-h: primo valore, condivise, envelope, altri utenti e offline non scattano', async () => {
    unlock();
    h.rows.push(
      { id: 'shared', userId: 'u1', isVault: true, content: '', ownership: 'shared' },
      { id: 'other', userId: 'u2', isVault: true, content: '', ownership: 'owned' },
      { id: 'env', userId: 'u1', isVault: true, content: ENV('env'), ownership: 'owned' },
      { id: 'initial', userId: 'u1', isVault: true, content: '', ownership: 'owned' },
    );
    await mountAndSettle();
    await tick(5000);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    h.rows.push({ id: 'offline', userId: 'u1', isVault: true, content: '', ownership: 'owned' });
    await notifyLive();
    await tick();
    await tick(3000);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it('T-f: con later > 0 un giro a 5 s e uno a 20 s, poi nulla; un trigger esterno riazzera il contatore', async () => {
    unlock();
    h.reconcile.mockResolvedValue(res({ later: 1 }));
    await mountAndSettle();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    await tick(4999);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(h.reconcile).toHaveBeenCalledTimes(2);
    await tick(19_999);
    expect(h.reconcile).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(h.reconcile).toHaveBeenCalledTimes(3);
    await tick(120_000);
    expect(h.reconcile).toHaveBeenCalledTimes(3);
    act(() => { window.dispatchEvent(new Event('online')); }); // T-b
    await tick();
    expect(h.reconcile).toHaveBeenCalledTimes(4);
    await tick(5000);
    expect(h.reconcile).toHaveBeenCalledTimes(5);
  });

  it('T-f: un giro a later 0 ferma il recupero', async () => {
    unlock();
    h.reconcile.mockResolvedValueOnce(res({ later: 1 })).mockResolvedValue(res());
    await mountAndSettle();
    await tick(5000);
    expect(h.reconcile).toHaveBeenCalledTimes(2);
    await tick(120_000);
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });

  it('T-f: con un editor aperto nessun giro di recupero', async () => {
    unlock();
    h.rows.push({ id: 'a', userId: 'u1', title: '', content: ENV('alpha'), isVault: true, noteType: 'NOTE', updatedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' });
    h.reconcile.mockResolvedValue(res({ later: 1 }));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/?noteId=a']}><VaultPage /></MemoryRouter>
      </QueryClientProvider>,
    );
    await tick();
    await tick(120_000);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it('T-f: giro abortito o saltato -> nessun recupero', async () => {
    unlock();
    h.reconcile.mockResolvedValue(res({ later: 1, aborted: true }));
    const { unmount } = await mountAndSettle();
    await tick(120_000);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    unmount();
    h.reconcile.mockClear();
    h.reconcile.mockResolvedValue(res({ later: 1, skipped: 'busy' }));
    await mountAndSettle();
    await tick(120_000);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it('T-f: due giri in volo che si risolvono con later > 0 programmano un solo timer', async () => {
    unlock();
    const pending: Array<(v: ReturnType<typeof res>) => void> = [];
    h.reconcile.mockImplementation(() => new Promise((r) => { pending.push(r); }));
    await mountAndSettle(); // giro 1 in volo
    act(() => { window.dispatchEvent(new Event('online')); }); // T-b: giro 2 in volo
    await tick();
    expect(pending).toHaveLength(2);
    h.reconcile.mockResolvedValue(res()); // il recupero chiude subito
    await act(async () => { pending.forEach((r) => r(res({ later: 1 }))); });
    await tick(5000); // il timer del primo .then (5 s) e' stato sostituito da quello del secondo (20 s)
    expect(h.reconcile).toHaveBeenCalledTimes(2);
    await tick(15_000);
    expect(h.reconcile).toHaveBeenCalledTimes(3); // 2 giri + UN recupero
  });

  it('T-f: lo smontaggio cancella il timer', async () => {
    unlock();
    h.reconcile.mockResolvedValue(res({ later: 1 }));
    const { unmount } = await mountAndSettle();
    unmount();
    await tick(120_000);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it('T-g: dopo conflictsResolved o reactivated > 0 si chiama syncPush; con zero no', async () => {
    unlock();
    h.reconcile.mockResolvedValue(res());
    const { unmount } = await mountAndSettle();
    expect(h.syncPush).not.toHaveBeenCalled();
    unmount();
    h.reconcile.mockResolvedValue(res({ conflictsResolved: 1 }));
    const second = await mountAndSettle();
    expect(h.syncPush).toHaveBeenCalledTimes(1);
    second.unmount();
    h.reconcile.mockResolvedValue(res({ reactivated: 2 }));
    await mountAndSettle();
    expect(h.syncPush).toHaveBeenCalledTimes(2);
  });

  it('T-g: una syncPush che rifiuta non rompe il giro', async () => {
    unlock();
    h.syncPush.mockRejectedValue(new Error('rete'));
    h.reconcile.mockResolvedValue(res({ conflictsResolved: 1, legacyLeft: 2 }));
    await mountAndSettle();
    expect(screen.getByText('vault.settings.legacyLeftAction')).toBeTruthy();
  });
});

describe('VaultPage: T12b, barriera per istanza di editor', () => {
  const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const ENV2 = (n: string) => ENV(n).replace('nv3.1.', 'nv3.2.');
  const unlock2 = () => { unlock(); useVaultStore.setState({ epoch: 2 }); };
  const pushRow = (noteType: string, content = ENV('alpha'), id = 'a') =>
    h.rows.push({ id, userId: 'u1', title: '', content, isVault: true, noteType, updatedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' });
  const held = (testId: string) => {
    expect(screen.queryByTestId(testId)).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('common.loading');
  };
  // giro che non si assesta finche' il test non chiama done()
  const pendingRound = () => {
    const ctl = { done: () => {} };
    h.reconcile.mockImplementation(() => new Promise((r) => { ctl.done = () => r(res()); }));
    return ctl;
  };

  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });

  it.each([['CREDENTIAL', 'cred-form'], ['NOTE', 'note-editor']])('%s: riga e1 con epoch 2 e giro pendente -> placeholder, poi il giro (later 0) monta l\'editor', async (type, testId) => {
    unlock2();
    pushRow(type);
    const ctl = pendingRound();
    mount('/?noteId=a');
    await tick();
    held(testId);
    await act(async () => { ctl.done(); });
    await tick();
    expect(screen.getByTestId(testId)).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('nessun gate: riga a epoch corrente (nv3.2.) -> editor subito, la barriera non aggiunge giri (solo T-a)', async () => {
    unlock2();
    pushRow('CREDENTIAL', ENV2('alpha'));
    h.reconcile.mockImplementation(() => new Promise(() => {}));
    mount('/?noteId=a');
    await tick();
    expect(screen.getByTestId('cred-form')).toBeTruthy();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it('nessun gate offline: riga e1 con epoch 2 -> editor subito, nessun giro (D22)', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    unlock2();
    pushRow('CREDENTIAL');
    mount('/?noteId=a');
    await tick();
    expect(screen.getByTestId('cred-form')).toBeTruthy();
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it('editor montato a epoch corrente, poi rotazione nella stessa sessione (chiavi nuove, epoch 3), riga ancora e2 -> stesso elemento, nessun placeholder', async () => {
    unlock2();
    pushRow('CREDENTIAL', ENV2('alpha'));
    h.reconcile.mockImplementation(() => new Promise(() => {}));
    mount('/?noteId=a');
    await tick();
    const el = screen.getByTestId('cred-form');
    h.finish.mockImplementation(() => new Promise(() => {}));
    act(() => { useVaultStore.setState({ keys: {} as any, epoch: 3 }); });
    await tick();
    expect(screen.getByTestId('cred-form')).toBe(el);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('editor montato dopo un giro assestato su riga e1, rotazione (epoch 3) con reconcile/finish pendenti -> resta montato', async () => {
    unlock2();
    pushRow('CREDENTIAL');
    mount('/?noteId=a');
    await tick();
    const el = screen.getByTestId('cred-form');
    h.reconcile.mockImplementation(() => new Promise(() => {}));
    h.finish.mockImplementation(() => new Promise(() => {}));
    act(() => { useVaultStore.setState({ keys: {} as any, epoch: 3 }); });
    await tick();
    expect(screen.getByTestId('cred-form')).toBe(el);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('editor montato offline su riga e1, ritorno online -> resta montato (stesso elemento), D22', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    unlock2();
    pushRow('CREDENTIAL');
    h.reconcile.mockImplementation(() => new Promise(() => {}));
    mount('/?noteId=a');
    await tick();
    const el = screen.getByTestId('cred-form');
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    act(() => { window.dispatchEvent(new Event('online')); });
    await tick();
    expect(screen.getByTestId('cred-form')).toBe(el);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('cerimonia di recupero con noteId in URL: chiavi nuove durante il wizard, alla chiusura placeholder finche\' un giro si assesta, poi l\'editor', async () => {
    unlock2();
    h.getKeyring.mockResolvedValue({ status: 'READY', legacyCount: 0 });
    pushRow('CREDENTIAL');
    const ctl = pendingRound();
    mount('/vault?recovery=1&noteId=a');
    await tick();
    expect(screen.getByTestId('recovery')).toBeTruthy();
    act(() => { useVaultStore.setState({ keys: {} as any, epoch: 3 }); });
    await tick();
    fireEvent.click(screen.getByText('rec-none'));
    await tick();
    held('cred-form');
    await act(async () => { ctl.done(); });
    await tick();
    expect(screen.getByTestId('cred-form')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('chiavi cambiate senza un giro successivo (finish rifiutato), poi si apre un\'ALTRA nota e1: la barriera lancia un giro, assestato -> editor', async () => {
    unlock2();
    pushRow('CREDENTIAL', ENV('alpha'), 'a');
    pushRow('CREDENTIAL', ENV('beta'), 'b');
    mount('/');
    await tick(); // T-a si assesta con le chiavi iniziali
    h.finish.mockRejectedValue(new Error('rete'));
    act(() => { useVaultStore.setState({ keys: {} as any, epoch: 3 }); });
    await tick();
    const ctl = pendingRound();
    const before = h.reconcile.mock.calls.length;
    fireEvent.click(screen.getByText('card:b'));
    await tick();
    held('cred-form');
    expect(h.reconcile.mock.calls.length).toBeGreaterThan(before);
    await act(async () => { ctl.done(); });
    await tick();
    expect(screen.getByTestId('cred-form')).toBeTruthy();
  });

  it('giro che non si assesta mai: l\'editor monta dopo 30 s, non prima', async () => {
    unlock2();
    pushRow('CREDENTIAL');
    h.reconcile.mockImplementation(() => new Promise(() => {}));
    mount('/?noteId=a');
    await tick();
    await tick(29_000);
    held('cred-form');
    await tick(1_000);
    expect(screen.getByTestId('cred-form')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('later 1 e riga ancora e1: resta trattenuto, T-f ritenta (openNoteRef nullo) e la riga a e2 monta l\'editor', async () => {
    unlock2();
    pushRow('CREDENTIAL');
    h.reconcile
      .mockResolvedValueOnce(res({ later: 1 })) // T-a
      .mockResolvedValueOnce(res({ later: 1 })) // barriera
      .mockImplementationOnce(async () => { h.rows[0].content = ENV2('alpha'); return res(); }); // ritentativo T-f
    mount('/?noteId=a');
    await tick();
    held('cred-form');
    expect(h.reconcile).toHaveBeenCalledTimes(2);
    await tick(5_000);
    expect(h.reconcile).toHaveBeenCalledTimes(3);
    await notifyLive();
    await tick();
    expect(screen.getByTestId('cred-form')).toBeTruthy();
  });

  it('rinuncia: later 1 sempre, retry esauriti -> l\'editor monta con la riga ancora e1', async () => {
    unlock2();
    pushRow('CREDENTIAL');
    h.reconcile.mockResolvedValue(res({ later: 1 }));
    mount('/?noteId=a');
    await tick();
    await tick(5_000);
    held('cred-form');
    expect(h.reconcile).toHaveBeenCalledTimes(3);
    await tick(20_000);
    expect(h.reconcile).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId('cred-form')).toBeTruthy();
  });

  it('la riga arriva a nv3.2. via liveQuery prima che il giro si assesti: l\'editor monta', async () => {
    unlock2();
    pushRow('CREDENTIAL');
    pendingRound();
    mount('/?noteId=a');
    await tick();
    held('cred-form');
    h.rows[0].content = ENV2('alpha');
    await notifyLive();
    await tick();
    expect(screen.getByTestId('cred-form')).toBeTruthy();
  });

  it.each([
    ['skipped busy', () => h.reconcile.mockResolvedValue(res({ later: 1, skipped: 'busy' }))],
    ['skipped notReady', () => h.reconcile.mockResolvedValue(res({ later: 1, skipped: 'notReady' }))],
    ['aborted', () => h.reconcile.mockResolvedValue(res({ later: 1, aborted: true }))],
    ['rejection', () => h.reconcile.mockRejectedValue(new Error('rete'))],
  ])('%s: l\'editor monta', async (_n, setup) => {
    unlock2();
    pushRow('CREDENTIAL');
    setup();
    mount('/?noteId=a');
    await tick();
    expect(screen.getByTestId('cred-form')).toBeTruthy();
  });

  it('blocco poi sblocco con lo stesso noteId in URL e riga ancora e1, giro pendente -> placeholder di nuovo', async () => {
    unlock2();
    h.getKeyring.mockResolvedValue({ status: 'READY', legacyCount: 0 }); // da bloccato la pagina rilegge il keyring (le implementazioni dei mock non si azzerano tra i test)
    pushRow('CREDENTIAL');
    mount('/?noteId=a');
    await tick();
    expect(screen.getByTestId('cred-form')).toBeTruthy();
    act(() => { useVaultStore.setState({ unlockedUserId: null, keys: null, epoch: null }); });
    await tick();
    expect(screen.queryByTestId('cred-form')).toBeNull();
    h.reconcile.mockImplementation(() => new Promise(() => {}));
    act(() => { useVaultStore.setState({ unlockedUserId: 'u1', keys: {} as any, epoch: 2 }); });
    await tick();
    held('cred-form');
  });

  it('nota A e1 in attesa, passaggio alla nota B e1: B ha la sua barriera (30 s da quando si apre) e il timer di A non conta', async () => {
    unlock2();
    pushRow('CREDENTIAL', ENV('alpha'), 'a');
    pushRow('CREDENTIAL', ENV('beta'), 'b');
    h.reconcile.mockImplementation(() => new Promise(() => {}));
    mount('/?noteId=a');
    await tick();
    await tick(20_000);
    held('cred-form');
    fireEvent.click(screen.getByText('card:b'));
    await tick();
    held('cred-form');
    await tick(29_000); // 49 s dall'apertura di A: il suo timer sarebbe scaduto, quello di B no
    held('cred-form');
    await tick(1_000);
    expect(screen.getByTestId('cred-form').textContent).toContain('b');
  });

  it('riga ancora in lettura: il giro later 1 ritenta (openNoteRef nullo, MINOR 1); letta la riga, il giro della barriera si assesta e l\'editor monta (R1f)', async () => {
    unlock2();
    pushRow('CREDENTIAL');
    let release: () => void = () => {};
    h.getHold = { id: 'a', p: new Promise<void>((r) => { release = r; }) };
    h.reconcile.mockResolvedValueOnce(res({ later: 1 })).mockResolvedValueOnce(res({ later: 1 })).mockResolvedValue(res());
    mount('/?noteId=a');
    await tick();
    await tick(5_000);
    expect(h.reconcile).toHaveBeenCalledTimes(2);
    release();
    await tick();
    await tick();
    expect(screen.getByTestId('cred-form')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  describe('R1, review della barriera', () => {
    const roundCtls = () => {
      const ctls: Array<() => void> = [];
      h.reconcile.mockImplementation(() => new Promise((r) => { ctls.push(() => r(res())); }));
      return ctls;
    };

    it('R1a: riga e1 non synced con giro pendente -> placeholder; la riga arriva a nv3.2. e l\'editor monta, poi torna a nv3.1. -> stesso elemento, nessun placeholder (latch opened)', async () => {
      unlock2();
      pushRow('CREDENTIAL');
      h.reconcile.mockImplementation(() => new Promise(() => {}));
      mount('/?noteId=a');
      await tick();
      held('cred-form');
      h.rows[0].content = ENV2('alpha');
      await notifyLive();
      await tick();
      const el = screen.getByTestId('cred-form');
      h.rows[0].content = ENV('alpha');
      await notifyLive();
      await tick();
      expect(screen.getByTestId('cred-form')).toBe(el);
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('R1b: un giro partito PRIMA del mount non apre la barriera; si apre solo col giro partito dopo', async () => {
      unlock2();
      pushRow('CREDENTIAL');
      const ctls = roundCtls();
      mount('/');
      await tick();
      expect(ctls).toHaveLength(1); // T-a, in volo
      fireEvent.click(screen.getByText('card:a'));
      await tick();
      expect(ctls).toHaveLength(2); // il giro della barriera
      held('cred-form');
      await act(async () => { ctls[0](); });
      await tick();
      held('cred-form');
      await act(async () => { ctls[1](); });
      await tick();
      expect(screen.getByTestId('cred-form')).toBeTruthy();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('R1c: staleLeft 1 con finishRotation pendente -> placeholder; a rotazione finita il giro di follow-up assesta e l\'editor monta', async () => {
      unlock2();
      pushRow('CREDENTIAL');
      let finishOk: () => void = () => {};
      h.finish.mockImplementation(() => new Promise((r) => { finishOk = () => r({ unreadable: [] }); }));
      h.reconcile.mockResolvedValueOnce(res({ staleLeft: 1 })).mockResolvedValueOnce(res({ staleLeft: 1 })); // T-a, barriera; poi il follow-up (default)
      mount('/');
      await tick();
      expect(h.finish).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByText('card:a'));
      await tick();
      expect(h.reconcile).toHaveBeenCalledTimes(2);
      held('cred-form');
      await act(async () => { finishOk(); });
      await tick();
      expect(h.reconcile).toHaveBeenCalledTimes(3);
      expect(screen.getByTestId('cred-form')).toBeTruthy();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('R1c: staleLeft 1 e finishRotation rifiutato (rete) -> l\'editor monta senza aspettare i 30 s', async () => {
      unlock2();
      pushRow('CREDENTIAL');
      let finishFail: () => void = () => {};
      h.finish.mockImplementation(() => new Promise((_r, rej) => { finishFail = () => rej(new Error('rete')); }));
      h.reconcile.mockResolvedValueOnce(res()).mockResolvedValueOnce(res({ staleLeft: 1 })); // T-a, barriera
      mount('/');
      await tick();
      fireEvent.click(screen.getByText('card:a'));
      await tick();
      expect(h.finish).toHaveBeenCalledTimes(1);
      held('cred-form');
      await act(async () => { finishFail(); });
      await tick(); // niente avanzamento del tempo: la barriera si assesta sul fallimento
      expect(screen.getByTestId('cred-form')).toBeTruthy();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('R1c: staleLeft 1 con rotatedFor === keys (seconda volta nella sessione) -> rotateStale non parte e la barriera si assesta subito', async () => {
      unlock2();
      pushRow('CREDENTIAL');
      h.reconcile.mockResolvedValueOnce(res({ staleLeft: 1 })).mockResolvedValueOnce(res()).mockResolvedValueOnce(res({ staleLeft: 1 })); // T-a, follow-up, barriera
      mount('/');
      await tick();
      expect(h.finish).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByText('card:a'));
      await tick();
      expect(h.finish).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('cred-form')).toBeTruthy();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('R1d: riga e1 gia\' synced -> editor subito, nessun giro in piu\'', async () => {
      unlock2();
      pushRow('CREDENTIAL');
      h.rows[0].syncStatus = 'synced';
      h.reconcile.mockImplementation(() => new Promise(() => {}));
      mount('/?noteId=a');
      await tick();
      expect(screen.getByTestId('cred-form')).toBeTruthy();
      expect(h.reconcile).toHaveBeenCalledTimes(1);
    });

    it('R1e: barriera in attesa con il timer T-f armato, si apre il recupero -> nessun nuovo giro con le chiavi pre-recupero', async () => {
      unlock2();
      h.getKeyring.mockResolvedValue({ status: 'READY', legacyCount: 0 });
      pushRow('CREDENTIAL');
      h.reconcile.mockResolvedValue(res({ later: 1 }));
      function Go() { const n = useNavigate(); return <button onClick={() => n('/?noteId=a&recovery=1')}>go-recovery</button>; }
      render(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter initialEntries={['/?noteId=a']}><VaultPage /><Go /></MemoryRouter>
        </QueryClientProvider>,
      );
      await tick();
      held('cred-form');
      const before = h.reconcile.mock.calls.length;
      fireEvent.click(screen.getByText('go-recovery'));
      await tick();
      expect(screen.getByTestId('recovery')).toBeTruthy();
      await tick(25_000);
      expect(h.reconcile.mock.calls.length).toBe(before);
    });
  });

  describe('R2, review della barriera', () => {
    it('R2a: riga e1 synced con rotazione pendente (staleCount > 0, finishRotation in corso) -> placeholder; a rotazione finita il giro di follow-up assesta e l\'editor monta', async () => {
      unlock2();
      pushRow('CREDENTIAL');
      h.rows[0].syncStatus = 'synced';
      h.refreshCache.mockResolvedValue({ staleCount: 2 });
      let finishOk: () => void = () => {};
      h.finish.mockImplementation(() => new Promise((r) => { finishOk = () => r({ unreadable: [] }); }));
      h.reconcile.mockResolvedValueOnce(res({ staleLeft: 1 })).mockResolvedValueOnce(res({ staleLeft: 1 })); // T-a, barriera; poi il follow-up (default)
      mount('/?noteId=a');
      await tick();
      expect(h.finish).toHaveBeenCalledTimes(1);
      held('cred-form');
      await act(async () => { finishOk(); });
      await tick();
      expect(screen.getByTestId('cred-form')).toBeTruthy();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('R2a: riga e1 synced senza rotazione pendente -> editor subito, nessun giro in piu\' (R1d)', async () => {
      unlock2();
      pushRow('CREDENTIAL');
      h.rows[0].syncStatus = 'synced';
      h.reconcile.mockImplementation(() => new Promise(() => {}));
      mount('/?noteId=a');
      await tick();
      expect(screen.getByTestId('cred-form')).toBeTruthy();
      expect(h.reconcile).toHaveBeenCalledTimes(1);
    });

    it('R2b: il catch di rotateStale assesta solo i giri rimandati: un giro B ancora in volo tiene la barriera chiusa finche\' non si risolve', async () => {
      unlock2();
      pushRow('CREDENTIAL');
      let finishFail: () => void = () => {};
      h.finish.mockImplementation(() => new Promise((_r, rej) => { finishFail = () => rej(new Error('rete')); }));
      const ctls: Array<() => void> = [];
      h.reconcile
        .mockResolvedValueOnce(res({ staleLeft: 1 })) // T-a (A): soppresso dalla rotazione in corso
        .mockImplementationOnce(() => new Promise((r) => { ctls.push(() => r(res())); })); // barriera (B), in volo
      mount('/');
      await tick();
      expect(h.finish).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByText('card:a'));
      await tick();
      expect(ctls).toHaveLength(1);
      held('cred-form');
      await act(async () => { finishFail(); });
      await tick();
      held('cred-form'); // B non e' ancora risolto
      await act(async () => { ctls[0](); });
      await tick();
      expect(screen.getByTestId('cred-form')).toBeTruthy();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('R2c: giro in volo con later 1 quando si apre il recupero -> nessun retry T-f armato alla sua risoluzione', async () => {
      unlock2();
      h.getKeyring.mockResolvedValue({ status: 'READY', legacyCount: 0 });
      let done: () => void = () => {};
      h.reconcile.mockImplementation(() => new Promise((r) => { done = () => r(res({ later: 1 })); }));
      function Go() { const n = useNavigate(); return <button onClick={() => n('/?recovery=1')}>go-recovery</button>; }
      render(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter initialEntries={['/']}><VaultPage /><Go /></MemoryRouter>
        </QueryClientProvider>,
      );
      await tick();
      expect(h.reconcile).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByText('go-recovery'));
      await tick();
      expect(screen.getByTestId('recovery')).toBeTruthy();
      await act(async () => { done(); });
      await tick(5_000);
      await tick(20_000);
      expect(h.reconcile).toHaveBeenCalledTimes(1);
    });

    it('R2c: il giro in volo che si risolve a reconcile spento (later 1) non arma il timer T-f: alla riaccensione (offline, niente T-a) nessun retry', async () => {
      unlock2();
      h.getKeyring.mockResolvedValue({ status: 'READY', legacyCount: 0 });
      let done: () => void = () => {};
      h.reconcile.mockImplementation(() => new Promise((r) => { done = () => r(res({ later: 1 })); }));
      function Go() { const n = useNavigate(); return <button onClick={() => n('/?recovery=1')}>go-recovery</button>; }
      render(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter initialEntries={['/']}><VaultPage /><Go /></MemoryRouter>
        </QueryClientProvider>,
      );
      await tick();
      fireEvent.click(screen.getByText('go-recovery'));
      await tick();
      expect(screen.getByTestId('recovery')).toBeTruthy();
      await act(async () => { done(); });
      await tick();
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true }); // la riaccensione non lancia T-a, che azzererebbe un timer stantio
      fireEvent.click(screen.getByText('rec-unlock'));
      await tick();
      expect(screen.queryByTestId('recovery')).toBeNull();
      const before = h.reconcile.mock.calls.length;
      await tick(5_000);
      await tick(20_000);
      expect(h.reconcile.mock.calls.length).toBe(before);
    });

    it('R2a: dopo una finishRotation riuscita la rotazione non e\' piu\' pendente (keyringStale azzerato): riga e1 synced aperta dopo -> editor subito, nessun giro dalla barriera', async () => {
      unlock2();
      pushRow('CREDENTIAL');
      h.rows[0].syncStatus = 'synced';
      h.refreshCache.mockResolvedValue({ staleCount: 2 });
      h.finish.mockResolvedValue({ unreadable: [] });
      h.reconcile.mockImplementation(() => new Promise(() => {}));
      mount('/');
      await tick();
      expect(h.finish).toHaveBeenCalledTimes(1);
      const before = h.reconcile.mock.calls.length;
      fireEvent.click(screen.getByText('card:a'));
      await tick();
      expect(screen.getByTestId('cred-form')).toBeTruthy();
      expect(screen.queryByRole('status')).toBeNull();
      expect(h.reconcile.mock.calls.length).toBe(before);
    });
  });
});

describe('VaultPage: rotazione della VK, note stale (Fase 5, T10)', () => {
  const ctxNow = () => ({ ctx: { keys: useVaultStore.getState().keys, userId: 'u1', epoch: 1 } });
  const HUGE = 2 * 1024 * 1024; // oltre MAX_REWRAP_LEN (1,5 MiB)
  const item = (id: string, reason: 'damaged' | 'keyMissing' | 'unverifiable', size = 10) => ({ id, noteType: 'NOTE', size, reason });
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

  it('stale dal reconcile: finishRotation UNA volta, poi un altro giro (senza loop se restano stale)', async () => {
    unlock();
    const order: string[] = [];
    h.reconcile.mockImplementation(async () => { order.push('reconcile'); return res({ staleLeft: 2 }); });
    h.finish.mockImplementation(async () => { order.push('finish'); return { unreadable: [] }; });
    mount();
    await waitFor(() => expect(order).toEqual(['reconcile', 'finish', 'reconcile']));
    await settle();
    expect(order).toEqual(['reconcile', 'finish', 'reconcile']);
    expect(h.finish).toHaveBeenCalledWith(ctxNow());
  });

  it('staleCount > 0 nel keyring riletto da sbloccato: finishRotation; con reconcile staleLeft insieme sempre una volta sola', async () => {
    unlock();
    h.refreshCache.mockResolvedValue({ staleCount: 3 });
    h.reconcile.mockResolvedValue(res({ staleLeft: 3 }));
    mount();
    await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(1));
    await settle();
    expect(h.finish).toHaveBeenCalledTimes(1);
  });

  it('nessuna stale: niente finishRotation', async () => {
    unlock();
    h.refreshCache.mockResolvedValue({ staleCount: 0 });
    mount();
    await waitFor(() => expect(h.reconcile).toHaveBeenCalled());
    await settle();
    expect(h.finish).not.toHaveBeenCalled();
  });

  it('sblocco offline: niente finishRotation (ne\' reconcile)', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    unlock();
    h.reconcile.mockResolvedValue(res({ staleLeft: 2 }));
    mount();
    await settle();
    expect(h.finish).not.toHaveBeenCalled();
  });

  it('ritorno online dopo uno sblocco offline: parte, una volta', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    unlock();
    h.reconcile.mockResolvedValue(res({ staleLeft: 2 }));
    mount();
    await settle();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    act(() => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(1));
  });

  it('il banner legacy non compare per le note stale (staleLeft non e\' legacyLeft)', async () => {
    unlock();
    h.reconcile.mockResolvedValue(res({ staleLeft: 3, legacyLeft: 0 }));
    mount();
    await waitFor(() => expect(h.finish).toHaveBeenCalled());
    await settle();
    expect(screen.queryByText(/vault\.settings\.legacyLeft/)).toBeNull();
  });

  it('errori: epochChanged -> toast errors.vault.epochChanged; busy -> silenzio (riprova al prossimo sblocco); altri -> toast non bloccante', async () => {
    const toast = (await import('react-hot-toast')).default as unknown as { error: ReturnType<typeof vi.fn> };
    unlock();
    h.reconcile.mockResolvedValue(res({ staleLeft: 2 }));
    h.finish.mockRejectedValue(Object.assign(new Error('x'), { name: 'MigrationError', code: 'busy' }));
    const { unmount } = mount();
    await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(1));
    await settle();
    expect(toast.error).not.toHaveBeenCalled();
    unmount();

    useVaultStore.setState({ unlockedUserId: null, keys: null, epoch: null, lockVault });
    unlock();
    h.finish.mockReset();
    h.finish.mockRejectedValue(Object.assign(new Error('x'), { name: 'MigrationError', code: 'epochChanged' }));
    const m2 = mount();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('errors.vault.epochChanged'));
    m2.unmount();

    useVaultStore.setState({ unlockedUserId: null, keys: null, epoch: null, lockVault });
    unlock();
    h.finish.mockReset();
    h.finish.mockRejectedValue(new Error('boom'));
    mount();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('vault.rotation.finishFailed'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  describe('dialog delle note illeggibili', () => {
    const mountWithUnreadable = async (items: unknown[]) => {
      unlock();
      h.reconcile.mockResolvedValue(res({ staleLeft: items.length }));
      h.finish.mockResolvedValueOnce({ unreadable: items }).mockResolvedValue({ unreadable: [] });
      mount();
      return screen.findByRole('dialog');
    };

    it('D e K: un solo dialog con entrambi i conteggi e l\'avviso K; conferma -> rewrap con gli id K, poi finishRotation, poi reconcile', async () => {
      const dlg = await mountWithUnreadable([item('a', 'damaged'), item('b', 'keyMissing'), item('c', 'keyMissing')]);
      expect(dlg.getAttribute('aria-modal')).toBe('true');
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      expect(within(dlg).getByText('vault.rotation.damaged:1')).toBeTruthy();
      expect(within(dlg).getByText('vault.rotation.keyMissingWarning:2')).toBeTruthy();
      expect(h.rewrap).not.toHaveBeenCalled();
      const order: string[] = [];
      h.rewrap.mockImplementation(async () => { order.push('rewrap'); return rw({ rewrapped: ['a', 'b', 'c'] }); });
      h.finish.mockImplementation(async () => { order.push('finish'); return { unreadable: [] }; });
      h.reconcile.mockImplementation(async () => { order.push('reconcile'); return res(); });
      fireEvent.click(within(dlg).getByText('vault.rotation.confirmRewrap'));
      await waitFor(() => expect(order).toEqual(['rewrap', 'finish', 'reconcile']));
      expect(h.rewrap).toHaveBeenCalledWith(['a', 'b', 'c'], ctxNow().ctx, { allowKeyMissingIds: ['b', 'c'] });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('solo D: allowKeyMissingIds vuoto e nessun avviso K', async () => {
      const dlg = await mountWithUnreadable([item('a', 'damaged'), item('b', 'damaged')]);
      expect(within(dlg).getByText('vault.rotation.damaged:2')).toBeTruthy();
      expect(within(dlg).queryByText(/keyMissingWarning/)).toBeNull();
      fireEvent.click(within(dlg).getByText('vault.rotation.confirmRewrap'));
      await waitFor(() => expect(h.rewrap).toHaveBeenCalledWith(['a', 'b'], ctxNow().ctx, { allowKeyMissingIds: [] }));
    });

    it('annulla: nessuna chiamata di rewrap, il dialog si chiude, il vault resta usabile', async () => {
      const dlg = await mountWithUnreadable([item('a', 'keyMissing')]);
      fireEvent.click(within(dlg).getByText('common.cancel'));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(h.rewrap).not.toHaveBeenCalled();
      expect(screen.getByLabelText('vault.createSecureNote')).toBeTruthy();
    });

    it("annulla: resta un banner non bloccante col conteggio; l'azione riapre il dialog con le stesse note", async () => {
      const dlg = await mountWithUnreadable([item('a', 'damaged'), item('b', 'keyMissing')]);
      expect(screen.queryByText('vault.rotation.banner:2')).toBeNull();
      fireEvent.click(within(dlg).getByText('common.cancel'));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.getByText('vault.rotation.banner:2')).toBeTruthy();
      fireEvent.click(screen.getByText('vault.rotation.bannerAction'));
      const again = await screen.findByRole('dialog');
      expect(within(again).getByText('vault.rotation.damaged:1')).toBeTruthy();
      expect(screen.queryByText('vault.rotation.banner:2')).toBeNull(); // col dialog aperto il banner non serve
    });

    it('esito dopo la conferma: tutto riuscito -> dialog e banner spariti, niente residuo', async () => {
      const dlg = await mountWithUnreadable([item('a', 'damaged')]);
      h.rewrap.mockResolvedValue(rw({ rewrapped: ['a'] }));
      fireEvent.click(within(dlg).getByText('vault.rotation.confirmRewrap'));
      await waitFor(() => expect(h.rewrap).toHaveBeenCalled());
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.queryByText(/vault\.rotation\.banner/)).toBeNull();
    });

    it('il residuo e\' fin.unreadable (conflitti, failed, unverified restano stale sul server): il dialog si riapre con quello e col numero di note re-incapsulate', async () => {
      const dlg = await mountWithUnreadable([item('a', 'damaged'), item('b', 'damaged'), item('c', 'damaged'), item('d', 'keyMissing'), item('e', 'damaged')]);
      h.rewrap.mockResolvedValue(rw({ rewrapped: ['e'], conflicts: ['a'], failed: ['b'], unverified: ['c'], keyMissing: ['d'] }));
      h.finish.mockReset();
      h.finish.mockResolvedValue({ unreadable: [item('a', 'damaged'), item('b', 'damaged'), item('c', 'damaged'), item('d', 'keyMissing')] });
      fireEvent.click(within(dlg).getByText('vault.rotation.confirmRewrap'));
      const again = await waitFor(() => { const d = screen.getByRole('dialog'); expect(within(d).getByText('vault.rotation.residue')).toBeTruthy(); return d; });
      expect(within(again).getByText('vault.rotation.rewrapDone:1')).toBeTruthy(); // e
      expect(within(again).getByText('vault.rotation.damaged:3')).toBeTruthy(); // a, b, c
      expect(within(again).getByText('vault.rotation.keyMissingWarning:1')).toBeTruthy(); // d
    });

    it('(h) rewrap riuscito con fin.unreadable vuoto: toast rewrapDone col numero, ne\' dialog ne\' banner', async () => {
      const toast = (await import('react-hot-toast')).default as unknown as { success: ReturnType<typeof vi.fn> };
      const dlg = await mountWithUnreadable([item('a', 'damaged'), item('b', 'damaged')]);
      h.rewrap.mockResolvedValue(rw({ rewrapped: ['a', 'b'] }));
      fireEvent.click(within(dlg).getByText('vault.rotation.confirmRewrap'));
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('vault.rotation.rewrapDone:2'));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByText(/vault\.rotation\.banner/)).toBeNull();
    });

    it('unreadable del secondo finishRotation: dialog di nuovo, con quelle note', async () => {
      const dlg = await mountWithUnreadable([item('a', 'damaged')]);
      h.rewrap.mockResolvedValue(rw({ rewrapped: ['a'] }));
      h.finish.mockReset();
      h.finish.mockResolvedValue({ unreadable: [item('z', 'damaged'), item('y', 'keyMissing')] });
      fireEvent.click(within(dlg).getByText('vault.rotation.confirmRewrap'));
      const again = await waitFor(() => { const d = screen.getByRole('dialog'); expect(within(d).getByText('vault.rotation.keyMissingWarning:1')).toBeTruthy(); return d; });
      expect(within(again).getByText('vault.rotation.damaged:1')).toBeTruthy();
    });

    it('errore del rewrap: toast, dialog chiuso, ma il banner resta per riprovare', async () => {
      const toast = (await import('react-hot-toast')).default as unknown as { error: ReturnType<typeof vi.fn> };
      const dlg = await mountWithUnreadable([item('a', 'damaged')]);
      h.rewrap.mockRejectedValue(new Error('rete'));
      fireEvent.click(within(dlg).getByText('vault.rotation.confirmRewrap'));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('vault.rotation.finishFailed'));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.getByText('vault.rotation.banner:1')).toBeTruthy();
    });

    describe('note troppo grandi (D7, D16): solo le D si cancellano a mano', () => {
      // al ricontrollo (rewrapUnreadable) i due id tornano tooLarge: sono gli unici che l'eliminazione puo' toccare
      const big = async () => {
        const dlg = await mountWithUnreadable([item('a', 'damaged'), item('big1', 'damaged', HUGE), item('big2', 'damaged', HUGE)]);
        h.rewrap.mockResolvedValue(rw({ tooLarge: ['big1', 'big2'] }));
        return dlg;
      };

      it('il dialog mostra subito il loro numero e "Elimina queste N note"; il rewrap riguarda solo le entro-limite', async () => {
        const dlg = await big();
        expect(within(dlg).getByText('vault.rotation.tooLarge:2')).toBeTruthy();
        expect(within(dlg).getByText('vault.rotation.damaged:1')).toBeTruthy();
        expect(within(dlg).getByText('vault.rotation.deleteTooLarge:2')).toBeTruthy();
        h.rewrap.mockResolvedValue(rw({ rewrapped: ['a'] }));
        h.finish.mockResolvedValue({ unreadable: [item('big1', 'damaged', HUGE), item('big2', 'damaged', HUGE)] });
        fireEvent.click(within(dlg).getByText('vault.rotation.confirmRewrap'));
        await waitFor(() => expect(h.rewrap).toHaveBeenCalledWith(['a'], ctxNow().ctx, { allowKeyMissingIds: [] }));
        const again = await waitFor(() => { const d = screen.getByRole('dialog'); expect(within(d).getByText('vault.rotation.rewrapDone:1')).toBeTruthy(); return d; });
        expect(within(again).queryByText('vault.rotation.confirmRewrap')).toBeNull(); // niente da re-incapsulare
        expect(h.permDelete).not.toHaveBeenCalled();
      });

      it('un id che il rewrap rifiuta come troppo grande (tooLarge) e che resta stale diventa da eliminare anche se piccolo', async () => {
        const dlg = await mountWithUnreadable([item('a', 'damaged'), item('edge', 'damaged')]);
        h.rewrap.mockResolvedValue(rw({ rewrapped: ['a'], tooLarge: ['edge'] }));
        h.finish.mockResolvedValue({ unreadable: [item('edge', 'damaged')] });
        fireEvent.click(within(dlg).getByText('vault.rotation.confirmRewrap'));
        const again = await waitFor(() => { const d = screen.getByRole('dialog'); expect(within(d).getByText('vault.rotation.tooLarge:1')).toBeTruthy(); return d; });
        expect(within(again).getByText('vault.rotation.deleteTooLarge:1')).toBeTruthy();
      });

      it("l'azione apre un ConfirmDialog che avvisa dei dati illeggibili; annulla non elimina", async () => {
        const dlg = await big();
        fireEvent.click(within(dlg).getByText('vault.rotation.deleteTooLarge:2'));
        expect(await screen.findByText('vault.rotation.deleteTooLargeConfirm:2')).toBeTruthy();
        fireEvent.click(screen.getByText('common.cancel'));
        expect(h.permDelete).not.toHaveBeenCalled();
        expect(screen.getByText('vault.rotation.tooLarge:2')).toBeTruthy(); // si torna al dialog
      });

      it('conferma: eliminazione definitiva di entrambe, push; restano solo le note da re-incapsulare', async () => {
        const dlg = await big();
        h.finish.mockResolvedValue({ unreadable: [item('a', 'damaged')] }); // il server dopo l'eliminazione
        fireEvent.click(within(dlg).getByText('vault.rotation.deleteTooLarge:2'));
        fireEvent.click(await screen.findByText('common.deleteForever'));
        await waitFor(() => expect(h.permDelete).toHaveBeenCalledTimes(2));
        expect(h.permDelete.mock.calls.map((c) => c[0]).sort()).toEqual(['big1', 'big2']);
        await waitFor(() => expect(h.syncPush).toHaveBeenCalled());
        const toast = (await import('react-hot-toast')).default as unknown as { success: ReturnType<typeof vi.fn> };
        expect(toast.success).toHaveBeenCalledWith('vault.rotation.deletedTooLarge:2'); // il conteggio reale
        const again = await waitFor(() => { const d = screen.getByRole('dialog'); expect(within(d).getByText('vault.rotation.damaged:1')).toBeTruthy(); return d; });
        expect(within(again).queryByText(/deleteTooLarge/)).toBeNull();
      });

      it('(fix2) una D oltre il limite con modifiche non sincronizzate (riga locale o coda) non si elimina mai: toast, resta nel dialog', async () => {
        h.rows.push({ id: 'big1', syncStatus: 'updated' });
        h.queue.push({ entity: 'NOTE', entityId: 'big2' });
        const dlg = await big();
        h.finish.mockResolvedValue({ unreadable: [item('a', 'damaged'), item('big1', 'damaged', HUGE), item('big2', 'damaged', HUGE)] });
        fireEvent.click(within(dlg).getByText('vault.rotation.deleteTooLarge:2'));
        fireEvent.click(await screen.findByText('common.deleteForever'));
        const toast = (await import('react-hot-toast')).default as unknown as { error: ReturnType<typeof vi.fn> };
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('vault.rotation.deleteSkippedPending:2'));
        expect(h.permDelete).not.toHaveBeenCalled();
        const again = await waitFor(() => { const d = screen.getByRole('dialog'); expect(within(d).getByText('vault.rotation.tooLarge:2')).toBeTruthy(); return d; });
        expect(within(again).getByText('vault.rotation.deleteTooLarge:2')).toBeTruthy();
      });

      it('lock occupato altrove: toast "aperta altrove" (non "modifiche non sincronizzate"), nessuna eliminazione', async () => {
        h.rows.push({ id: 'big1', syncStatus: 'synced' });
        const dlg = await mountWithUnreadable([item('big1', 'damaged', HUGE)]);
        h.rewrap.mockResolvedValue(rw({ tooLarge: ['big1'] }));
        h.finish.mockResolvedValue({ unreadable: [item('big1', 'damaged', HUGE)] });
        h.lockBusy = true;
        fireEvent.click(within(dlg).getByText('vault.rotation.deleteTooLarge:1'));
        fireEvent.click(await screen.findByText('common.deleteForever'));
        const toast = (await import('react-hot-toast')).default as unknown as { error: ReturnType<typeof vi.fn> };
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('vault.rotation.deleteSkippedBusy:1'));
        expect(toast.error).not.toHaveBeenCalledWith('vault.rotation.deleteSkippedPending:1');
        expect(h.permDelete).not.toHaveBeenCalled();
      });

      it('DELETE failed in coda e nota ancora illeggibile dopo la push: riattivato, avviso, nessun toast di eliminazione, resta nel dialog', async () => {
        h.queue.push({ id: 3, entity: 'NOTE', entityId: 'big1', type: 'DELETE', status: 'failed' });
        const dlg = await mountWithUnreadable([item('big1', 'damaged', HUGE)]);
        h.rewrap.mockResolvedValue(rw({ tooLarge: ['big1'] }));
        h.finish.mockResolvedValue({ unreadable: [item('big1', 'damaged', HUGE)] });
        fireEvent.click(within(dlg).getByText('vault.rotation.deleteTooLarge:1'));
        fireEvent.click(await screen.findByText('common.deleteForever'));
        const toast = (await import('react-hot-toast')).default as unknown as { error: ReturnType<typeof vi.fn>; success: ReturnType<typeof vi.fn> };
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('vault.rotation.deletePendingSync:1'));
        expect(h.qUpdate).toHaveBeenCalledWith(3, { status: 'pending', attempts: 0 });
        expect(toast.success).not.toHaveBeenCalledWith(expect.stringContaining('deletedTooLarge'));
        await waitFor(() => expect(within(screen.getByRole('dialog')).getByText('vault.rotation.tooLarge:1')).toBeTruthy());
      });

      it('conferma con solo D oltre il limite: dialog e banner chiusi', async () => {
        const dlg = await mountWithUnreadable([item('big1', 'damaged', HUGE)]);
        h.rewrap.mockResolvedValue(rw({ tooLarge: ['big1'] }));
        fireEvent.click(within(dlg).getByText('vault.rotation.deleteTooLarge:1'));
        fireEvent.click(await screen.findByText('common.deleteForever'));
        await waitFor(() => expect(h.permDelete).toHaveBeenCalledWith('big1'));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(screen.queryByText(/vault\.rotation\.banner/)).toBeNull();
      });

      it('(f) una K oltre il limite non arriva mai a permanentlyDeleteNote, ne\' con la D oltre il limite eliminata insieme ne\' da sola', async () => {
        const dlg = await mountWithUnreadable([item('kbig', 'keyMissing', HUGE), item('dbig', 'damaged', HUGE)]);
        h.rewrap.mockResolvedValue(rw({ tooLarge: ['dbig'] }));
        h.finish.mockResolvedValue({ unreadable: [item('kbig', 'keyMissing', HUGE)] });
        expect(within(dlg).getByText('vault.rotation.keyMissingTooLarge:1')).toBeTruthy();
        fireEvent.click(within(dlg).getByText('vault.rotation.deleteTooLarge:1'));
        fireEvent.click(await screen.findByText('common.deleteForever'));
        await waitFor(() => expect(h.permDelete).toHaveBeenCalledTimes(1));
        expect(h.permDelete).toHaveBeenCalledWith('dbig');
        const again = await waitFor(() => { const d = screen.getByRole('dialog'); expect(within(d).getByText('vault.rotation.keyMissingTooLarge:1')).toBeTruthy(); return d; });
        expect(within(again).queryByText(/deleteTooLarge/)).toBeNull(); // nessuna via di eliminazione per la K
        expect(within(again).queryByText('vault.rotation.confirmRewrap')).toBeNull();
        expect(h.permDelete).toHaveBeenCalledTimes(1);
      });

      it('(g) eliminazione in corso: i pulsanti sono disabilitati, un solo permanentlyDeleteNote per id', async () => {
        let release!: () => void;
        h.permDelete.mockImplementation(() => new Promise<void>((r) => { release = r; }));
        const dlg = await big();
        fireEvent.click(within(dlg).getByText('vault.rotation.deleteTooLarge:2'));
        fireEvent.click(await screen.findByText('common.deleteForever'));
        await waitFor(() => expect(h.permDelete).toHaveBeenCalledTimes(1)); // big1 in volo
        const del = await screen.findByText('vault.rotation.deleteTooLarge:2');
        expect((del as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(del);
        fireEvent.click(screen.getByText('vault.rotation.confirmRewrap'));
        expect(screen.queryByText('vault.rotation.deleteTooLargeConfirm:2')).toBeNull();
        expect(h.rewrap).toHaveBeenCalledTimes(1); // solo il ricontrollo dell'eliminazione, nessun rewrap della conferma
        h.permDelete.mockResolvedValue(undefined);
        release();
        await waitFor(() => expect(h.permDelete).toHaveBeenCalledTimes(2));
        expect(h.permDelete.mock.calls.map((c) => c[0]).sort()).toEqual(['big1', 'big2']);
      });

      it('A1: il ricontrollo ricalcola il bucket: un id tornato readable non si elimina; il ricontrollo non passa consensi e il dialog si riapre senza residuo', async () => {
        const dlg = await big();
        h.rewrap.mockResolvedValue(rw({ readable: ['big1'], tooLarge: ['big2'] }));
        h.finish.mockResolvedValue({ unreadable: [item('a', 'damaged')] });
        fireEvent.click(within(dlg).getByText('vault.rotation.deleteTooLarge:2'));
        fireEvent.click(await screen.findByText('common.deleteForever'));
        await waitFor(() => expect(h.permDelete).toHaveBeenCalledTimes(1));
        expect(h.permDelete).toHaveBeenCalledWith('big2');
        expect(h.rewrap).toHaveBeenLastCalledWith(['big1', 'big2'], ctxNow().ctx);
        const again = await waitFor(() => { const d = screen.getByRole('dialog'); expect(within(d).getByText('vault.rotation.damaged:1')).toBeTruthy(); return d; });
        expect(within(again).queryByText('vault.rotation.residue')).toBeNull();
      });

      it('A1: nessun id nel bucket tooLarge del ricontrollo -> nessuna eliminazione', async () => {
        const dlg = await big();
        h.rewrap.mockResolvedValue(rw({ readable: ['big1', 'big2'] }));
        fireEvent.click(within(dlg).getByText('vault.rotation.deleteTooLarge:2'));
        fireEvent.click(await screen.findByText('common.deleteForever'));
        await waitFor(() => expect(h.rewrap).toHaveBeenCalled());
        await settle();
        expect(h.permDelete).not.toHaveBeenCalled();
      });

      it('A3: U (unverifiable) oltre il limite: nessun pulsante Elimina (anche con una D oltre il limite accanto), mai permanentlyDeleteNote', async () => {
        const dlg = await mountWithUnreadable([item('ubig', 'unverifiable', HUGE), item('dbig', 'damaged', HUGE)]);
        expect(within(dlg).getByText('vault.rotation.unverifiableTooLarge:1')).toBeTruthy();
        h.rewrap.mockResolvedValue(rw({ tooLarge: ['dbig'] }));
        h.finish.mockResolvedValue({ unreadable: [item('ubig', 'unverifiable', HUGE)] });
        fireEvent.click(within(dlg).getByText('vault.rotation.deleteTooLarge:1'));
        fireEvent.click(await screen.findByText('common.deleteForever'));
        await waitFor(() => expect(h.permDelete).toHaveBeenCalledTimes(1));
        expect(h.permDelete).toHaveBeenCalledWith('dbig');
        const again = await waitFor(() => { const d = screen.getByRole('dialog'); expect(within(d).getByText('vault.rotation.unverifiableTooLarge:1')).toBeTruthy(); return d; });
        expect(within(again).queryByText(/deleteTooLarge/)).toBeNull();
      });

      it('A3: U sola oltre il limite (come un server che riscrive nv3.<e-1> in nv3.<e-2>): dialog senza Elimina ne conferma', async () => {
        const dlg = await mountWithUnreadable([item('ubig', 'unverifiable', HUGE)]);
        expect(within(dlg).getByText('vault.rotation.unverifiableTooLarge:1')).toBeTruthy();
        expect(within(dlg).queryByText(/deleteTooLarge/)).toBeNull();
        expect(within(dlg).queryByText('vault.rotation.confirmRewrap')).toBeNull();
      });

      it('A3: il consenso del rewrap (allowKeyMissingIds) comprende K e U entro il limite, non le D', async () => {
        const dlg = await mountWithUnreadable([item('d', 'damaged'), item('k', 'keyMissing'), item('u', 'unverifiable')]);
        fireEvent.click(within(dlg).getByText('vault.rotation.confirmRewrap'));
        await waitFor(() => expect(h.rewrap).toHaveBeenCalledWith(['d', 'k', 'u'], ctxNow().ctx, { allowKeyMissingIds: ['k', 'u'] }));
      });

      it('1: il ricontrollo porta le note in K: nessun toast di successo, nessuna eliminazione, e il dialog non le offre piu come eliminabili', async () => {
        const toast = (await import('react-hot-toast')).default as unknown as { success: ReturnType<typeof vi.fn> };
        const dlg = await big();
        h.rewrap.mockResolvedValue(rw({ keyMissing: ['big1', 'big2'] }));
        h.finish.mockResolvedValue({ unreadable: [item('a', 'damaged'), item('big1', 'keyMissing', HUGE), item('big2', 'keyMissing', HUGE)] });
        fireEvent.click(within(dlg).getByText('vault.rotation.deleteTooLarge:2'));
        fireEvent.click(await screen.findByText('common.deleteForever'));
        const again = await waitFor(() => { const d = screen.getByRole('dialog'); expect(within(d).getByText('vault.rotation.keyMissingTooLarge:2')).toBeTruthy(); return d; });
        expect(within(again).queryByText(/deleteTooLarge/)).toBeNull();
        expect(h.permDelete).not.toHaveBeenCalled();
        expect(toast.success).not.toHaveBeenCalledWith(expect.stringContaining('deletedTooLarge'));
      });

      it('1: epochChanged durante il ricontrollo -> toast errors.vault.epochChanged, non unknownError', async () => {
        const toast = (await import('react-hot-toast')).default as unknown as { error: ReturnType<typeof vi.fn> };
        const dlg = await big();
        h.rewrap.mockRejectedValue(Object.assign(new Error('x'), { name: 'MigrationError', code: 'epochChanged' }));
        fireEvent.click(within(dlg).getByText('vault.rotation.deleteTooLarge:2'));
        fireEvent.click(await screen.findByText('common.deleteForever'));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('errors.vault.epochChanged'));
        expect(h.permDelete).not.toHaveBeenCalled();
      });

      it('eliminazione fallita: toast e il dialog resta', async () => {
        const toast = (await import('react-hot-toast')).default as unknown as { error: ReturnType<typeof vi.fn> };
        const dlg = await big();
        h.permDelete.mockRejectedValue(new Error('idb'));
        fireEvent.click(within(dlg).getByText('vault.rotation.deleteTooLarge:2'));
        fireEvent.click(await screen.findByText('common.deleteForever'));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('errors.common.unknownError'));
        expect(screen.getByText('vault.rotation.tooLarge:2')).toBeTruthy();
      });
    });

    describe('guard rotatedFor e modali (foglio impostazioni, Kit, ripresa)', () => {
      const online = () => act(async () => { window.dispatchEvent(new Event('online')); await Promise.resolve(); });
      const openSettings = async () => fireEvent.click(await screen.findByLabelText('vault.settings.title'));

      it("ripresa fallita (rete): il guard si azzera e il prossimo trigger riprova; con 'busy' no", async () => {
        unlock();
        h.reconcile.mockResolvedValue(res({ staleLeft: 2 }));
        h.finish.mockRejectedValue(new Error('rete'));
        mount();
        await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(1));
        await settle();
        await online();
        await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(2));
        h.finish.mockReset();
        h.finish.mockRejectedValue(Object.assign(new Error('x'), { name: 'MigrationError', code: 'busy' }));
        await online();
        await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(1));
        await settle();
        await online();
        await settle();
        expect(h.finish).toHaveBeenCalledTimes(1); // busy: guard intatto
      });

      it('(i) risultato arrivato con il foglio aperto: nessun dialog; dopo onClose il dialog compare', async () => {
        unlock();
        let resolve!: (v: unknown) => void;
        h.reconcile.mockResolvedValue(res({ staleLeft: 1 }));
        h.finish.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
        mount();
        await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(1));
        await openSettings();
        await act(async () => { resolve({ unreadable: [item('a', 'damaged')] }); });
        await settle();
        expect(screen.getByTestId('settings')).toBeTruthy();
        expect(screen.queryByRole('dialog')).toBeNull();
        fireEvent.click(screen.getByText('settings-close'));
        const dlg = await screen.findByRole('dialog');
        expect(within(dlg).getByText('vault.rotation.damaged:1')).toBeTruthy();
      });

      it('(j) finishRotation rifiutata durante il Kit, poi evento online: nessun dialog finche il foglio e aperto', async () => {
        unlock();
        h.reconcile.mockResolvedValue(res({ staleLeft: 1 }));
        h.finish.mockRejectedValueOnce(new Error('rete'));
        mount();
        await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(1));
        await settle();
        await openSettings(); // cerimonia del Kit in corso (il foglio e' aperto)
        h.finish.mockResolvedValue({ unreadable: [item('a', 'damaged')] });
        await online();
        await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(2));
        await settle();
        expect(screen.queryByRole('dialog')).toBeNull();
        fireEvent.click(screen.getByText('settings-close'));
        expect(await screen.findByRole('dialog')).toBeTruthy();
      });

      it('(k) onRotationPending: foglio chiuso, toast, un solo finishRotation in piu anche con il guard gia impostato', async () => {
        const toast = (await import('react-hot-toast')).default as unknown as { error: ReturnType<typeof vi.fn> };
        unlock();
        h.reconcile.mockResolvedValue(res({ staleLeft: 1 }));
        mount();
        await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(1)); // guard impostato
        await settle();
        await openSettings();
        h.finish.mockResolvedValue({ unreadable: [item('a', 'keyMissing')] });
        fireEvent.click(screen.getByText('rotation-pending'));
        expect(screen.queryByTestId('settings')).toBeNull();
        expect(toast.error).toHaveBeenCalledWith('errors.vault.rotationPending');
        await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(2));
        const dlg = await screen.findByRole('dialog');
        expect(within(dlg).getByText('vault.rotation.keyMissingWarning:1')).toBeTruthy();
        await settle();
        expect(h.finish).toHaveBeenCalledTimes(2);
      });

      it('(l) dopo onKitDone il foglio si chiude e il dialog compare; nessun secondo finishRotation', async () => {
        unlock();
        h.reconcile.mockResolvedValue(res({ staleLeft: 1 }));
        h.finish.mockResolvedValue({ unreadable: [item('a', 'damaged')] });
        mount();
        await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(1));
        await openSettings();
        expect(screen.queryByRole('dialog')).toBeNull();
        fireEvent.click(screen.getByText('kit-done'));
        expect(screen.queryByTestId('settings')).toBeNull();
        const dlg = await screen.findByRole('dialog');
        expect(within(dlg).getByText('vault.rotation.damaged:1')).toBeTruthy();
        await settle();
        expect(h.finish).toHaveBeenCalledTimes(1);
      });
    });
  });
});

describe('VaultPage: sorgente', () => {
  it('nessun importFile e nessun useVaultHydration', () => {
    const src = readFileSync(resolve(__dirname, '../VaultPage.tsx'), 'utf8');
    expect(src).not.toMatch(/importFile/);
    expect(src).not.toMatch(/useVaultHydration/);
  });
});

describe('VaultPage: recupero con il Kit (Fase 4, T6)', () => {
  it('"PIN dimenticato" (onForgot) apre VaultRecovery al posto dello sblocco', async () => {
    h.getKeyring.mockResolvedValue({ status: 'READY', legacyCount: 0 });
    mount();
    fireEvent.click(await within(await screen.findByTestId('unlock')).findByText('forgot'));
    await screen.findByTestId('recovery');
    expect(screen.queryByTestId('unlock')).toBeNull();
  });

  it('?recovery=1 apre VaultRecovery; chiudere con "unlock" torna allo sblocco e toglie il parametro dall URL', async () => {
    h.getKeyring.mockResolvedValue({ status: 'READY', legacyCount: 0 });
    mount('/vault?recovery=1&x=1');
    await screen.findByTestId('recovery');
    expect(screen.getByTestId('where').textContent).toContain('recovery=1');
    fireEvent.click(screen.getByText('rec-unlock'));
    await screen.findByTestId('unlock');
    expect(screen.getByTestId('where').textContent).toBe('/vault?x=1');
  });

  // Causa del test instabile sopra: la cerimonia compare per derivazione dal parametro, l'effetto che la aggancia al flag gira dopo (macrotask). Se la chiusura cade nella finestra,
  // il flag false di closeRecovery viene riportato a true dall'effetto (il parametro e' ancora nell'URL: la navigazione di MemoryRouter e' in startTransition) e lo sblocco non compare mai.
  // Qui il clic parte dal MutationObserver, cioe' subito dopo il commit e prima dell'effetto: deterministico.
  it('chiusura nella stessa finestra del commit (prima dell effetto di aggancio): la cerimonia non si riapre da sola', async () => {
    h.getKeyring.mockResolvedValue({ status: 'READY', legacyCount: 0 });
    let clicked = false;
    const mo = new MutationObserver(() => {
      const btn = !clicked && screen.queryByText('rec-unlock');
      if (btn) { clicked = true; fireEvent.click(btn); }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    try {
      mount('/vault?recovery=1&x=1');
      await screen.findByTestId('unlock');
    } finally { mo.disconnect(); }
    expect(clicked).toBe(true);
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/vault?x=1'));
    expect(screen.queryByTestId('recovery')).toBeNull();
  });

  it('con recoveryOpen e store sbloccato (dopo il 200) non gira checkPendingOnStart, ne il reconcile, ne compare il banner kitUnconfirmed', async () => {
    unlock();
    h.checkPending.mockResolvedValue('kitUnconfirmed');
    mount('/vault?recovery=1');
    await screen.findByTestId('recovery');
    await act(async () => { await Promise.resolve(); });
    expect(h.checkPending).not.toHaveBeenCalled();
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(screen.queryByText('vault.kitUnconfirmed')).toBeNull();
  });

  it('onClose("none") con il vault sbloccato: pagina normale; a quel punto il controllo dei marker parte', async () => {
    unlock();
    mount('/vault?recovery=1');
    fireEvent.click(await screen.findByText('rec-none'));
    await screen.findByLabelText('vault.settings.title');
    expect(screen.queryByTestId('recovery')).toBeNull();
    await waitFor(() => expect(h.checkPending).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('where').textContent).toBe('/vault');
  });

  it('(u) onClose("none") dopo un recupero applicato: finishRotation con le chiavi NUOVE (epoch+1, prev), una volta', async () => {
    unlock();
    mount('/vault?recovery=1');
    const rec = await screen.findByText('rec-none');
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(h.finish).not.toHaveBeenCalled(); // la cerimonia tiene spento il reconcile
    const newKeys = { prev: { epoch: 1 } } as any; // il recupero ha sbloccato lo store con le chiavi a epoch+1
    useVaultStore.setState({ keys: newKeys, epoch: 2 });
    fireEvent.click(rec);
    await waitFor(() => expect(h.finish).toHaveBeenCalledWith({ ctx: { keys: newKeys, userId: 'u1', epoch: 2 } }));
    expect(h.finish).toHaveBeenCalledTimes(1);
  });

  it('onClose("unlock") dopo il recupero non lancia finishRotation da solo', async () => {
    unlock();
    mount('/vault?recovery=1');
    fireEvent.click(await screen.findByText('rec-unlock'));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(h.finish).not.toHaveBeenCalled();
  });

  it('onClose("regenerate") con il vault sbloccato: si apre VaultSettingsSheet', async () => {
    unlock();
    mount('/vault?recovery=1');
    fireEvent.click(await screen.findByText('rec-regen'));
    await screen.findByTestId('settings');
  });
});

describe('VaultPage: cerimonia aperta da ?recovery=1, tenuta e cronologia', () => {
  it('aperta dal parametro su pagina sbloccata, l auto-lock non la smonta (gate ancora in caricamento)', async () => {
    unlock();
    h.getKeyring.mockReturnValue(new Promise(() => {})); // il gate resta 'loading' dopo il blocco
    mount('/vault?recovery=1');
    await screen.findByTestId('recovery');
    act(() => { useVaultStore.setState({ unlockedUserId: null, keys: null }); });
    expect(screen.getByTestId('recovery')).toBeTruthy();
  });

  it('chiudere la cerimonia sostituisce la voce di cronologia: Indietro non la riapre', async () => {
    h.getKeyring.mockResolvedValue({ status: 'READY', legacyCount: 0 });
    function Back() { const n = useNavigate(); return <button onClick={() => n(-1)}>nav-back</button>; }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/vault', '/vault?recovery=1']} initialIndex={1}><VaultPage /><Where /><Back /></MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByText('rec-unlock'));
    await screen.findByTestId('unlock');
    fireEvent.click(screen.getByText('nav-back'));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('where').textContent).toBe('/vault');
    expect(screen.queryByTestId('recovery')).toBeNull();
  });
});

describe('VaultPage: rotazione obbligatoria del Kit (Fase 4, T7)', () => {
  const READY = { status: 'READY', legacyCount: 0 };
  // sblocca dopo che la GET da bloccato ha letto il keyring
  const mountAndUnlock = async (kr: Record<string, unknown>, url = '/') => {
    h.getKeyring.mockResolvedValue({ ...READY, ...kr });
    mount(url);
    await screen.findByTestId(url.includes('recovery') ? 'recovery' : 'unlock');
    await waitFor(() => expect(h.getKeyring).toHaveBeenCalled());
    act(() => { unlock(); });
  };

  it('kitRotationRequired e nessuna richiesta RELEASED: foglio in forceKit dopo lo sblocco', async () => {
    await mountAndUnlock({ kitRotationRequired: true, openRecovery: null });
    expect((await screen.findByTestId('settings')).getAttribute('data-force')).toBe('1');
  });

  it('rootKeyRetired (1.15.1): foglio obbligatorio con motivo "retired", anche senza kitRotationRequired', async () => {
    await mountAndUnlock({ kitRotationRequired: false, rootKeyRetired: true, openRecovery: null });
    const s = await screen.findByTestId('settings');
    expect(s.getAttribute('data-force')).toBe('1');
    expect(s.getAttribute('data-reason')).toBe('retired');
  });

  it('kitRotationRequired con una richiesta aperta non RELEASED: il foglio compare lo stesso', async () => {
    await mountAndUnlock({ kitRotationRequired: true, openRecovery: { id: 'r', status: 'WAITING' } });
    expect((await screen.findByTestId('settings')).getAttribute('data-force')).toBe('1');
  });

  it('F10: con openRecovery RELEASED il foglio non compare', async () => {
    await mountAndUnlock({ kitRotationRequired: true, openRecovery: { id: 'r', status: 'RELEASED' } });
    await screen.findByLabelText('vault.settings.title');
    expect(screen.queryByTestId('settings')).toBeNull();
  });

  it('flag falso o assente: nessun foglio', async () => {
    await mountAndUnlock({ kitRotationRequired: false });
    await screen.findByLabelText('vault.settings.title');
    expect(screen.queryByTestId('settings')).toBeNull();
  });

  it('con la cerimonia del recupero aperta il foglio non compare', async () => {
    await mountAndUnlock({ kitRotationRequired: true }, '/vault?recovery=1');
    await screen.findByTestId('recovery');
    expect(screen.queryByTestId('settings')).toBeNull();
  });

  it('onKitDone: il foglio sparisce e la cache del keyring si riallinea', async () => {
    await mountAndUnlock({ kitRotationRequired: true });
    await screen.findByTestId('settings');
    h.refreshCache.mockClear();
    fireEvent.click(screen.getByText('kit-done'));
    await waitFor(() => expect(screen.queryByTestId('settings')).toBeNull());
    expect(h.refreshCache).toHaveBeenCalledWith('u1');
  });

  it('dopo il blocco e un nuovo sblocco il flag si rilegge dal keyring', async () => {
    await mountAndUnlock({ kitRotationRequired: true });
    await screen.findByTestId('settings');
    h.getKeyring.mockResolvedValue({ ...READY, kitRotationRequired: false });
    act(() => { useVaultStore.setState({ unlockedUserId: null, keys: null }); });
    await screen.findByTestId('unlock');
    act(() => { unlock(); });
    await screen.findByLabelText('vault.settings.title');
    expect(screen.queryByTestId('settings')).toBeNull();
  });
});

describe('VaultPage: rotazione del Kit, giro di correzioni', () => {
  const READY = { status: 'READY', legacyCount: 0 };
  const settings = () => screen.queryByTestId('settings');

  // 1: il flag letto prima della cerimonia non deve sopravvivere a un recupero
  it.each([['none', 'rec-none'], ['regenerate', 'rec-regen']])(
    'chiusura del recupero con "%s" da sbloccato: il flag vecchio non apre il foglio forzato (rilettura del keyring)',
    async (_n, btn) => {
      h.getKeyring.mockResolvedValue({ ...READY, kitRotationRequired: true, openRecovery: { id: 'r', status: 'WAITING' } });
      mount();
      fireEvent.click(await within(await screen.findByTestId('unlock')).findByText('forgot'));
      await screen.findByTestId('recovery');
      act(() => { unlock(); }); // il 200 del complete sblocca lo store
      h.getKeyring.mockResolvedValue({ ...READY, kitRotationRequired: false, openRecovery: null }); // escrow nuovo: il flag e' spento
      fireEvent.click(screen.getByText(btn));
      await waitFor(() => expect(h.getKeyring).toHaveBeenCalledTimes(2));
      await act(async () => { await Promise.resolve(); });
      // 'regenerate' apre il foglio perche' lo chiede l'utente, mai forzato
      expect(settings()?.getAttribute('data-force') ?? '').toBe('');
    },
  );

  it('chiusura del recupero: la rilettura puo\' riaccendere il flag (richiesta aperta non RELEASED)', async () => {
    h.getKeyring.mockResolvedValue({ ...READY, kitRotationRequired: false });
    mount();
    fireEvent.click(await within(await screen.findByTestId('unlock')).findByText('forgot'));
    await screen.findByTestId('recovery');
    act(() => { unlock(); });
    h.getKeyring.mockResolvedValue({ ...READY, kitRotationRequired: true, openRecovery: { id: 'r', status: 'WAITING' } });
    fireEvent.click(screen.getByText('rec-none'));
    expect((await screen.findByTestId('settings')).getAttribute('data-force')).toBe('1');
  });

  // 2: pagina montata gia' sbloccata (NoteEditor -> VaultUnlockDialog -> /vault) o sblocco offline: loadKeyring non gira
  it('montata gia\' sbloccata con flag vero sul server e nessuna richiesta RELEASED: foglio forzato', async () => {
    unlock();
    h.refreshCache.mockResolvedValue({ ...READY, kitRotationRequired: true, openRecovery: null });
    mount();
    expect((await screen.findByTestId('settings')).getAttribute('data-force')).toBe('1');
    expect(h.getKeyring).not.toHaveBeenCalled();
  });

  it('montata gia\' sbloccata con richiesta RELEASED aperta (F10) o flag falso: nessun foglio', async () => {
    unlock();
    h.refreshCache.mockResolvedValue({ ...READY, kitRotationRequired: true, openRecovery: { id: 'r', status: 'RELEASED' } });
    mount();
    await screen.findByLabelText('vault.settings.title');
    await waitFor(() => expect(h.refreshCache).toHaveBeenCalled());
    expect(settings()).toBeNull();
  });

  // 3
  it('senza chiave root attiva nel bundle il foglio non viene forzato', async () => {
    h.rootKey.v = null;
    unlock();
    h.refreshCache.mockResolvedValue({ ...READY, kitRotationRequired: true, openRecovery: null });
    mount();
    await screen.findByLabelText('vault.settings.title');
    await waitFor(() => expect(h.refreshCache).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(settings()).toBeNull();
  });

  it('offline il foglio non e\' forzato; al ritorno online si rilegge il flag (spento: resta chiuso)', async () => {
    unlock();
    h.refreshCache.mockResolvedValue({ ...READY, kitRotationRequired: true, openRecovery: null });
    mount();
    await screen.findByTestId('settings');
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    act(() => { window.dispatchEvent(new Event('offline')); });
    await waitFor(() => expect(settings()).toBeNull());
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    h.refreshCache.mockResolvedValue({ ...READY, kitRotationRequired: false, openRecovery: null });
    act(() => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(h.refreshCache).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(settings()).toBeNull();
  });

  it('offline poi di nuovo online con il flag ancora vero: il foglio torna', async () => {
    unlock();
    h.refreshCache.mockResolvedValue({ ...READY, kitRotationRequired: true, openRecovery: null });
    mount();
    await screen.findByTestId('settings');
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    act(() => { window.dispatchEvent(new Event('offline')); });
    await waitFor(() => expect(settings()).toBeNull());
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    act(() => { window.dispatchEvent(new Event('online')); });
    await screen.findByTestId('settings');
  });

  // 6
  it('?recovery=1 non apre la cerimonia sopra il setup (keyring NONE) e il parametro cade', async () => {
    h.getKeyring.mockResolvedValue({ status: 'NONE', legacyCount: 0 });
    mount('/vault?recovery=1');
    await screen.findByTestId('setup');
    expect(screen.queryByTestId('recovery')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/vault'));
    // a setup finito (store sbloccato, gate ready) il recupero non salta fuori da solo
    act(() => { unlock(); });
    fireEvent.click(screen.getByText('setup-done'));
    expect(screen.queryByTestId('recovery')).toBeNull();
  });

  it('?recovery=1 non apre la cerimonia sopra la migrazione (NONE con note legacy)', async () => {
    h.getKeyring.mockResolvedValue({ status: 'NONE', legacyCount: 3 });
    mount('/vault?recovery=1');
    await screen.findByTestId('migrate');
    expect(screen.queryByTestId('recovery')).toBeNull();
  });
});

describe('VaultPage: guardie rotSeqRef sul flag di rotazione del Kit', () => {
  const READY = { status: 'READY', legacyCount: 0 };
  const settings = () => screen.queryByTestId('settings');
  const deferred = () => { let resolve!: (v: unknown) => void; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };

  it('una lettura da sbloccato arrivata DOPO una cerimonia chiusa (GET: flag falso) non riaccende il foglio', async () => {
    unlock();
    const slow = deferred();
    h.refreshCache.mockReturnValueOnce(slow.p); // la lettura del mount resta in volo
    h.getKeyring.mockResolvedValue({ ...READY, kitRotationRequired: false, openRecovery: null });
    mount('/vault?recovery=1');
    fireEvent.click(await screen.findByText('rec-none'));
    await waitFor(() => expect(h.getKeyring).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    await act(async () => { slow.resolve({ ...READY, kitRotationRequired: true, openRecovery: null }); await Promise.resolve(); });
    await screen.findByLabelText('vault.settings.title');
    expect(settings()).toBeNull();
  });

  it('onKitDone con una lettura ancora in volo: la risposta vecchia (flag vero) non riapre il foglio', async () => {
    unlock();
    const slow = deferred();
    h.refreshCache.mockResolvedValueOnce({ ...READY, kitRotationRequired: true, openRecovery: null }).mockReturnValueOnce(slow.p);
    mount();
    await screen.findByTestId('settings');
    act(() => { window.dispatchEvent(new Event('online')); }); // seconda lettura, in volo
    await waitFor(() => expect(h.refreshCache).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByText('kit-done'));
    await waitFor(() => expect(settings()).toBeNull());
    await act(async () => { slow.resolve({ ...READY, kitRotationRequired: true, openRecovery: null }); await Promise.resolve(); });
    expect(settings()).toBeNull();
  });
});

describe('VaultPage: chiusura della cerimonia e banner (Fase 4, T8)', () => {
  it('la chiusura del recupero emette l\'evento che fa rileggere il banner', async () => {
    h.getKeyring.mockResolvedValue({ status: 'READY', legacyCount: 0 });
    const seen = vi.fn();
    window.addEventListener('notiq:vault-recovery-closed', seen);
    mount('/vault?recovery=1');
    fireEvent.click(await screen.findByText('rec-none'));
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener('notiq:vault-recovery-closed', seen);
  });
});

describe('VaultPage: rotazione obbligatoria del Kit + 409 rotationPending (foglio forzato rinviato)', () => {
  const item = (id: string, reason: 'damaged' | 'keyMissing') => ({ id, noteType: 'NOTE', size: 10, reason });
  const mountForced = async () => {
    h.getKeyring.mockResolvedValue({ status: 'READY', legacyCount: 0, kitRotationRequired: true, openRecovery: null });
    mount();
    await screen.findByTestId('unlock');
    await waitFor(() => expect(h.getKeyring).toHaveBeenCalled());
    act(() => { unlock(); });
    expect((await screen.findByTestId('settings')).getAttribute('data-force')).toBe('1');
  };

  it('(o) forceKit attivo, onRotationPending: il foglio sparisce e, dopo finishRotation con item, compare il dialog', async () => {
    await mountForced();
    h.finish.mockResolvedValue({ unreadable: [item('a', 'keyMissing')] });
    fireEvent.click(screen.getByText('rotation-pending'));
    await waitFor(() => expect(screen.queryByTestId('settings')).toBeNull());
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('vault.rotation.keyMissingWarning:1')).toBeTruthy();
  });

  it('(p) il rewrap che svuota il residuo fa ricomparire il foglio forzato', async () => {
    await mountForced();
    h.finish.mockResolvedValueOnce({ unreadable: [item('a', 'damaged')] }).mockResolvedValue({ unreadable: [] });
    h.rewrap.mockResolvedValue(rw({ rewrapped: ['a'] }));
    fireEvent.click(screen.getByText('rotation-pending'));
    const dlg = await screen.findByRole('dialog');
    expect(screen.queryByTestId('settings')).toBeNull();
    fireEvent.click(within(dlg).getByText('vault.rotation.confirmRewrap'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await screen.findByTestId('settings')).getAttribute('data-force')).toBe('1');
  });

  it('9: rotateStale fallita (rete) dopo il rinvio: toast e il foglio forzato resta chiuso per questo sblocco (niente loop)', async () => {
    const toast = (await import('react-hot-toast')).default as unknown as { error: ReturnType<typeof vi.fn> };
    await mountForced();
    h.finish.mockRejectedValue(new Error('rete'));
    fireEvent.click(screen.getByText('rotation-pending'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('vault.rotation.finishFailed'));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByTestId('settings')).toBeNull();
  });

  it('9b: rotateStale fallita con MigrationError invalid: il foglio forzato resta chiuso', async () => {
    await mountForced();
    h.finish.mockRejectedValue(Object.assign(new Error('x'), { name: 'MigrationError', code: 'invalid' }));
    fireEvent.click(screen.getByText('rotation-pending'));
    await waitFor(() => expect(h.finish).toHaveBeenCalled());
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByTestId('settings')).toBeNull();
  });

  it('9c: rotateStale fallita con locked (benigno): il foglio forzato ricompare', async () => {
    await mountForced();
    h.finish.mockRejectedValue(Object.assign(new Error('x'), { name: 'MigrationError', code: 'locked' }));
    fireEvent.click(screen.getByText('rotation-pending'));
    expect((await screen.findByTestId('settings')).getAttribute('data-force')).toBe('1');
  });

  it('14b: onKitFailed con il foglio forzato: refreshKeyringCache con lo userId (PUT forse committata, risposta persa)', async () => {
    await mountForced();
    h.refreshCache.mockClear();
    fireEvent.click(screen.getByText('kit-failed'));
    expect(h.refreshCache).toHaveBeenCalledWith('u1');
  });

  it('10: nessuna illeggibile ma residuo (failed/tooLarge/conflicts/unverified): banner di rotazione incompleta e il foglio forzato resta rinviato', async () => {
    await mountForced();
    h.finish.mockResolvedValue({ unreadable: [], failed: ['x'], tooLarge: [], conflicts: [], unverified: [] });
    fireEvent.click(screen.getByText('rotation-pending'));
    expect(await screen.findByText('vault.rotation.finishFailed')).toBeTruthy();
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByTestId('settings')).toBeNull();
  });

  it('10: giro pulito (nessun residuo): niente banner di incompletezza', async () => {
    unlock();
    h.reconcile.mockResolvedValue(res({ staleLeft: 1 }));
    h.finish.mockResolvedValue({ unreadable: [], failed: [], tooLarge: [], conflicts: [], unverified: [] });
    mount();
    await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByText('vault.rotation.finishFailed')).toBeNull();
  });

  it('11: localPending durante la rotazione forzata: foglio rinviato con toast, e ricompare dopo il giro del reconcile', async () => {
    const toast = (await import('react-hot-toast')).default as unknown as { error: ReturnType<typeof vi.fn> };
    await mountForced();
    fireEvent.click(screen.getByText('local-pending'));
    expect(toast.error).toHaveBeenCalledWith('errors.vault.localPending');
    expect(screen.queryByTestId('settings')).toBeNull();
    await waitFor(() => expect(h.syncPush).toHaveBeenCalled());
    expect((await screen.findByTestId('settings')).getAttribute('data-force')).toBe('1');
  });

  it('14: foglio forzato, errore non da PIN (flushTimeout): foglio chiuso con toast e resta chiuso per questo sblocco', async () => {
    const toast = (await import('react-hot-toast')).default as unknown as { error: ReturnType<typeof vi.fn> };
    await mountForced();
    fireEvent.click(screen.getByText('kit-failed'));
    expect(toast.error).toHaveBeenCalledWith('vault.migrate.errors.flushTimeout');
    expect(screen.queryByTestId('settings')).toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByTestId('settings')).toBeNull();
  });

  it('14: foglio forzato, invalidRootKey: toast che chiede di ricaricare l app', async () => {
    const toast = (await import('react-hot-toast')).default as unknown as { error: ReturnType<typeof vi.fn> };
    await mountForced();
    fireEvent.click(screen.getByText('kit-failed-root'));
    expect(toast.error).toHaveBeenCalledWith('errors.vault.kitReloadRequired');
    expect(screen.queryByTestId('settings')).toBeNull();
  });

  it('12: dialog mai sopra la cerimonia del Kit: anche se il foglio non e piu aperto, finche non arriva onKitDone', async () => {
    unlock();
    h.reconcile.mockResolvedValue(res({ staleLeft: 1 }));
    h.finish.mockResolvedValue({ unreadable: [item('a', 'damaged')] });
    mount();
    await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByLabelText('vault.settings.title'));
    fireEvent.click(await screen.findByText('kit-start'));
    expect(screen.getByTestId('kit-mock')).toBeTruthy(); // cerimonia montata, foglio non aperto
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => { window.dispatchEvent(new Event('online')); await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByText('kit-done'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('13: onKitDone con un finishRotation a chiavi vecchie ancora in corso: a giro finito (locked) con chiavi nuove rilancia rotateStale', async () => {
    unlock();
    let rejectOld!: (e: unknown) => void;
    h.reconcile.mockResolvedValue(res({ staleLeft: 1 }));
    h.finish.mockReturnValueOnce(new Promise((_, rej) => { rejectOld = rej; }));
    mount();
    await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(1));
    const newKeys = {} as any;
    act(() => { useVaultStore.setState({ keys: newKeys, epoch: 2 }); }); // la rotazione ha cambiato le chiavi
    fireEvent.click(await screen.findByLabelText('vault.settings.title'));
    fireEvent.click(await screen.findByText('kit-done')); // rotateStale: no-op, il vecchio giro e' ancora in corso
    expect(h.finish).toHaveBeenCalledTimes(1);
    h.finish.mockResolvedValue({ unreadable: [item('a', 'damaged')] });
    await act(async () => { rejectOld(Object.assign(new Error('x'), { name: 'MigrationError', code: 'locked' })); await new Promise((r) => setTimeout(r, 30)); });
    await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(2));
    expect(h.finish).toHaveBeenLastCalledWith({ ctx: { keys: newKeys, userId: 'u1', epoch: 2 } });
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  const idle = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });
  const onlineEv = () => act(async () => { window.dispatchEvent(new Event('online')); await Promise.resolve(); });

  it('2: un rinvio local sopravvive a un errore di finishRotation (solo il rinvio stale si annulla)', async () => {
    h.foreignPending.mockResolvedValue(true);
    h.reconcile.mockResolvedValue(res({ staleLeft: 1 }));
    h.finish.mockRejectedValue(new Error('rete'));
    await mountForced();
    await waitFor(() => expect(h.finish).toHaveBeenCalled());
    fireEvent.click(screen.getByText('local-pending'));
    expect(screen.queryByTestId('settings')).toBeNull();
    await idle();
    const calls = h.finish.mock.calls.length;
    await onlineEv(); // reconcile con staleLeft: rotateStale -> finishRotation rifiuta di nuovo
    await waitFor(() => expect(h.finish.mock.calls.length).toBeGreaterThan(calls));
    await idle();
    expect(screen.queryByTestId('settings')).toBeNull();
  });

  it('3: il rinvio local si chiude solo quando non restano envelope locali e-1 non sincronizzati', async () => {
    h.foreignPending.mockResolvedValue(true); // la riga e-1 e' ancora in LEAVE
    await mountForced();
    fireEvent.click(screen.getByText('local-pending'));
    await waitFor(() => expect(h.syncPush).toHaveBeenCalled());
    await idle();
    expect(screen.queryByTestId('settings')).toBeNull();
    h.foreignPending.mockResolvedValue(false);
    await onlineEv(); // nuovo giro del reconcile
    expect((await screen.findByTestId('settings')).getAttribute('data-force')).toBe('1');
  });

  it('4a: rotationIncomplete vale solo per le chiavi che l\'hanno vista', async () => {
    unlock();
    mount();
    fireEvent.click(await screen.findByLabelText('vault.settings.title'));
    h.finish.mockResolvedValue({ unreadable: [], failed: ['x'], tooLarge: [], conflicts: [], unverified: [] });
    fireEvent.click(await screen.findByText('rotation-pending'));
    expect(await screen.findByText('vault.rotation.finishFailed')).toBeTruthy();
    act(() => { useVaultStore.setState({ keys: {} as any, epoch: 2 }); }); // chiavi diverse (nuovo sblocco)
    expect(screen.queryByText('vault.rotation.finishFailed')).toBeNull();
  });

  it('4b: un residuo di soli unverified non accende il banner e non tiene il rinvio stale', async () => {
    await mountForced();
    h.finish.mockResolvedValue({ unreadable: [], failed: [], tooLarge: [], conflicts: [], unverified: ['u'] });
    fireEvent.click(screen.getByText('rotation-pending'));
    expect((await screen.findByTestId('settings')).getAttribute('data-force')).toBe('1');
    expect(screen.queryByText('vault.rotation.finishFailed')).toBeNull();
  });
});
