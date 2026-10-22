// Vault v3 (T21): ingresso nel vault. api, Dexie, codec e store finti.
import { describe, it, expect, beforeEach, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any -- mock Vitest: righe Dexie e item di coda sono record liberi */
const h = vi.hoisted(() => {
  class VaultLockedError extends Error {}
  return {
    st: { notes: new Map<string, any>(), queue: [] as any[], keys: {} as any, byUser: {} as Record<string, any> },
    get: vi.fn(), put: vi.fn(), getKeyring: vi.fn(), getItems: vi.fn(), finalizeItems: vi.fn(),
    encryptItem: vi.fn(), decryptItem: vi.fn(),
    order: [] as string[],
    VaultLockedError,
  };
});
const { st, get, put, getKeyring, getItems, finalizeItems, encryptItem, decryptItem, order } = h;

vi.mock('../api', () => ({ default: { get: (...a: unknown[]) => h.get(...a), put: (...a: unknown[]) => h.put(...a) } }));
vi.mock('../db', () => ({
  db: {
    notes: {
      get: async (id: string) => st.notes.get(id),
      update: async (id: string, patch: any) => { order.push('dexie'); st.notes.set(id, { ...st.notes.get(id), ...patch }); return 1; },
    },
    syncQueue: {
      filter: (fn: (i: any) => boolean) => ({ primaryKeys: async () => st.queue.filter(fn).map((i) => i.id), toArray: async () => st.queue.filter(fn).map((i) => ({ ...i })) }),
      update: async (id: number, patch: any) => { st.queue = st.queue.map((i) => (i.id === id ? { ...i, ...patch } : i)); return 1; },
      bulkDelete: async (ids: number[]) => { st.queue = st.queue.filter((i) => !ids.includes(i.id)); },
    },
    transaction: async (_m: string, ...rest: any[]) => rest[rest.length - 1](),
  },
}));
vi.mock('../../utils/vaultCrypto', () => ({ sha256hex: async (s: string) => `h(${s})` }));
vi.mock('../../store/vaultStore', () => ({ useVaultStore: { getState: () => st } }));
vi.mock('../vaultApi', () => ({
  getKeyring: (...a: unknown[]) => h.getKeyring(...a),
  getItems: (...a: unknown[]) => h.getItems(...a),
  finalizeItems: (...a: unknown[]) => h.finalizeItems(...a),
}));
vi.mock('../vaultCodec', () => ({
  encryptItem: (...a: unknown[]) => h.encryptItem(...a),
  decryptItem: (...a: unknown[]) => h.decryptItem(...a),
  VaultLockedError: h.VaultLockedError,
}));

import { beginMovingIn, isMovingIn, moveIn, subscribeMovingIn, vaultEntryState, VaultMoveError } from '../vaultMove';

const SERVER = { id: 'n1', title: 'Titolo', content: '{"type":"doc","v":1}', attachments: [], isVault: false };
const conflict = () => Object.assign(new Error('x'), { response: { status: 422, data: { message: 'errors.vault.conflict' } } });
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as VaultMoveError).code; } return 'ok'; };

beforeEach(() => {
  st.notes = new Map([['n1', { id: 'n1', isVault: false, isEncrypted: false, title: 'Titolo', content: SERVER.content, searchText: 'testo in chiaro', syncStatus: 'synced' }]]);
  st.queue = [];
  st.keys = {};
  st.byUser = {};
  order.length = 0;
  for (const m of [get, put, getKeyring, getItems, finalizeItems, encryptItem, decryptItem]) m.mockReset();
  get.mockImplementation(async () => { order.push('get'); return { data: { ...SERVER } }; });
  put.mockImplementation(async () => { order.push('put'); return { data: { updatedAt: '2026-10-22T10:00:00.000Z' } }; });
  encryptItem.mockImplementation(async (_id: string, _t: string, item: any) => `nv3.env(${item.t}|${item.c})`);
  decryptItem.mockImplementation(async (_id: string, _t: string, env: string) => {
    const m = /^nv3\.env\((.*?)\|(.*)\)$/s.exec(env)!;
    return { t: m[1], c: m[2] };
  });
  getItems.mockResolvedValue({ items: [{ id: 'n1', content: `nv3.env(Titolo|${SERVER.content})` }] });
  finalizeItems.mockResolvedValue({});
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('moveIn', () => {
  it('GET poi PUT con envelope nv3., baseHash del contenuto del server e title vuoto; onCommitted prima di Dexie', async () => {
    await moveIn('n1', { onCommitted: () => order.push('committed') });
    expect(get).toHaveBeenCalledWith('/notes/n1');
    expect(put).toHaveBeenCalledWith('/notes/n1', {
      isVault: true,
      content: `nv3.env(Titolo|${SERVER.content})`,
      title: '',
      baseHash: `h(${SERVER.content})`,
    });
    expect(order).toEqual(['get', 'put', 'committed', 'dexie']);
  });

  it('riga Dexie: solo envelope, titolo e searchText vuoti, base = hash dell envelope, nessun plaintext', async () => {
    await moveIn('n1');
    const r = st.notes.get('n1');
    expect(r).toMatchObject({
      isVault: true, isEncrypted: true, isPublic: false, title: '', searchText: '',
      content: `nv3.env(Titolo|${SERVER.content})`, vaultBaseHash: `h(nv3.env(Titolo|${SERVER.content}))`,
      vaultSentHashes: [], syncStatus: 'synced', updatedAt: '2026-10-22T10:00:00.000Z',
    });
  });

  it('dopo il 200 toglie dalla coda gli UPDATE in chiaro della nota (non quelli delle altre)', async () => {
    // la coda e vuota all inizio (altrimenti 'pending'): l item compare dopo la PUT, come farebbe un salvataggio tardivo
    put.mockImplementation(async () => {
      st.queue = [{ id: 1, entity: 'NOTE', entityId: 'n1', type: 'UPDATE' }, { id: 2, entity: 'NOTE', entityId: 'x', type: 'UPDATE' }];
      return { data: {} };
    });
    await moveIn('n1');
    expect(st.queue.map((q) => q.id)).toEqual([2]);
  });

  it('item misto in coda dopo la PUT ({isPinned}): resta, senza le chiavi vault; riga non synced; condivisioni locali azzerate', async () => {
    put.mockImplementation(async () => {
      st.queue = [
        { id: 1, entity: 'NOTE', entityId: 'n1', type: 'UPDATE', data: { isPinned: true } },
        { id: 2, entity: 'NOTE', entityId: 'n1', type: 'UPDATE', data: { content: 'plain', title: 'T', isTrashed: true } },
      ];
      return { data: {} };
    });
    st.notes.set('n1', { ...st.notes.get('n1'), sharedWith: [{ userId: 'u2' }], shareId: 's1' });
    await moveIn('n1');
    expect(st.queue.map((q) => [q.id, q.data])).toEqual([[1, { isPinned: true }], [2, { isTrashed: true }]]);
    expect(st.notes.get('n1')).toMatchObject({ syncStatus: 'updated', sharedWith: [], shareId: null });
  });

  it('stato di spostamento di modulo: vero dall inizio di moveIn (anche per una nuova istanza), notifica gli iscritti, si libera a fine e su errore', async () => {
    const seen: boolean[] = [];
    const off = subscribeMovingIn(() => seen.push(isMovingIn('n1')));
    let release!: () => void;
    put.mockImplementation(() => new Promise((res) => { release = () => res({ data: {} }); }));
    const p = moveIn('n1');
    await vi.waitFor(() => expect(put).toHaveBeenCalled());
    expect(isMovingIn('n1')).toBe(true);
    expect(isMovingIn('altra')).toBe(false);
    release();
    await p;
    expect(isMovingIn('n1')).toBe(false);
    expect(seen).toEqual([true, false]);
    // errore: si libera comunque
    get.mockRejectedValue(new Error('net'));
    await code(moveIn('n1'));
    expect(isMovingIn('n1')).toBe(false);
    off();
  });

  it('beginMovingIn annidato (chiamante + moveIn): resta vero finche non finiscono entrambi; il rilascio e idempotente', () => {
    const a = beginMovingIn('n9');
    const b = beginMovingIn('n9');
    a();
    a();
    expect(isMovingIn('n9')).toBe(true);
    b();
    expect(isMovingIn('n9')).toBe(false);
  });

  it('finalize dopo la rilettura se il server restituisce lo stesso testo', async () => {
    await moveIn('n1');
    expect(getItems).toHaveBeenCalledWith({ ids: ['n1'] });
    expect(finalizeItems).toHaveBeenCalledWith(['n1']);
  });

  it('rilettura diversa: niente finalize, ma lo spostamento resta riuscito', async () => {
    getItems.mockResolvedValue({ items: [{ id: 'n1', content: 'nv3.env(Altro|x)' }] });
    await moveIn('n1');
    expect(finalizeItems).not.toHaveBeenCalled();
  });

  it('round-trip diverso: nessuna PUT, failed', async () => {
    decryptItem.mockResolvedValue({ t: 'Titolo', c: 'altro' });
    expect(await code(moveIn('n1'))).toBe('failed');
    expect(put).not.toHaveBeenCalled();
  });

  it('beforePut gira dopo il round-trip e prima della PUT, una volta sola anche con i conflitti', async () => {
    put.mockRejectedValueOnce(conflict());
    await moveIn('n1', { beforePut: async () => { order.push('revoke'); } });
    expect(order.filter((o) => o === 'revoke')).toHaveLength(1);
    expect(order.indexOf('revoke')).toBeLessThan(order.indexOf('put'));
  });

  it('422 conflict: riparte dalla GET (al massimo 2 volte), poi conflict', async () => {
    put.mockRejectedValue(conflict());
    expect(await code(moveIn('n1'))).toBe('conflict');
    expect(get).toHaveBeenCalledTimes(3);
    expect(put).toHaveBeenCalledTimes(3);
    expect(st.notes.get('n1').isVault).toBe(false); // Dexie intatto
  });

  it('un conflict poi 200: ci riesce con la seconda lettura', async () => {
    put.mockRejectedValueOnce(conflict());
    await moveIn('n1');
    expect(get).toHaveBeenCalledTimes(2);
    expect(st.notes.get('n1').isVault).toBe(true);
  });

  it('allegati sul server: attachmentsBlocked, nessuna PUT', async () => {
    get.mockResolvedValue({ data: { ...SERVER, attachments: [{ id: 'a' }] } });
    expect(await code(moveIn('n1'))).toBe('attachmentsBlocked');
    expect(put).not.toHaveBeenCalled();
  });

  it('422 attachmentsBlocked dalla PUT: attachmentsBlocked', async () => {
    put.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 422, data: { message: 'errors.vault.attachmentsBlocked' } } }));
    expect(await code(moveIn('n1'))).toBe('attachmentsBlocked');
  });

  it('offline: nessuna chiamata', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    expect(await code(moveIn('n1'))).toBe('offline');
    expect(get).not.toHaveBeenCalled();
  });

  it('vault bloccato (nessuna chiave): locked, nessuna chiamata', async () => {
    st.keys = null;
    expect(await code(moveIn('n1'))).toBe('locked');
    expect(get).not.toHaveBeenCalled();
  });

  it('cifratura che trova il vault bloccato: locked, nessuna PUT', async () => {
    encryptItem.mockRejectedValue(new h.VaultLockedError());
    expect(await code(moveIn('n1'))).toBe('locked');
    expect(put).not.toHaveBeenCalled();
  });

  it('item ancora in coda per la nota: pending, nessuna GET', async () => {
    vi.useFakeTimers();
    try {
      st.queue = [{ id: 1, entity: 'NOTE', entityId: 'n1', type: 'UPDATE' }];
      const p = code(moveIn('n1'));
      await vi.advanceTimersByTimeAsync(6000);
      expect(await p).toBe('pending');
      expect(get).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('GET senza risposta: offline; GET 404: failed', async () => {
    get.mockRejectedValueOnce(new Error('net'));
    expect(await code(moveIn('n1'))).toBe('offline');
    get.mockRejectedValueOnce(Object.assign(new Error('x'), { response: { status: 404, data: {} } }));
    expect(await code(moveIn('n1'))).toBe('failed');
  });
});

describe('vaultEntryState', () => {
  it('chiavi dell utente in memoria: ready (nessuna chiamata)', async () => {
    st.keys = {}; (st as any).unlockedUserId = 'u1'; (st as any).epoch = 1;
    expect(await vaultEntryState('u1')).toBe('ready');
    expect(getKeyring).not.toHaveBeenCalled();
  });

  it('chiavi di un altro utente: non basta', async () => {
    (st as any).unlockedUserId = 'u2'; (st as any).epoch = 1;
    st.byUser = { u1: { status: 'READY' } };
    expect(await vaultEntryState('u1')).toBe('locked');
  });

  it('cache READY senza chiavi: locked, senza rete', async () => {
    st.keys = null; (st as any).unlockedUserId = null;
    st.byUser = { u1: { status: 'READY' } };
    expect(await vaultEntryState('u1')).toBe('locked');
    expect(getKeyring).not.toHaveBeenCalled();
  });

  it('senza cache: GET keyring READY -> locked, NONE -> setup, errore (UNKNOWN) -> setup', async () => {
    st.keys = null; (st as any).unlockedUserId = null;
    getKeyring.mockResolvedValueOnce({ status: 'READY' });
    expect(await vaultEntryState('u1')).toBe('locked');
    getKeyring.mockResolvedValueOnce({ status: 'NONE' });
    expect(await vaultEntryState('u1')).toBe('setup');
    getKeyring.mockResolvedValueOnce({ status: 'RESET_PENDING' });
    expect(await vaultEntryState('u1')).toBe('setup');
    getKeyring.mockRejectedValueOnce(new Error('503'));
    expect(await vaultEntryState('u1')).toBe('setup');
  });
});
