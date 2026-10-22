// Vault v3 (T18): uscita dal vault. api e Dexie finti.
import { describe, it, expect, beforeEach, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any -- mock Vitest: righe Dexie e item di coda sono record liberi */
const { st, put, order } = vi.hoisted(() => ({
  st: { notes: new Map<string, any>(), queue: [] as any[] },
  put: vi.fn(),
  order: [] as string[],
}));

vi.mock('../api', () => ({ default: { put: (...a: unknown[]) => put(...a) } }));
vi.mock('../db', () => ({
  db: {
    notes: {
      get: async (id: string) => st.notes.get(id),
      update: async (id: string, patch: any) => {
        order.push('dexie');
        const r = st.notes.get(id);
        const next = { ...r, ...patch };
        for (const k of Object.keys(patch)) if (patch[k] === undefined) delete next[k];
        st.notes.set(id, next);
        return 1;
      },
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

import { moveOut, VaultMoveError } from '../vaultMove';

const row = () => ({ id: 'n1', isVault: true, isEncrypted: true, title: '', content: 'nv3.env', vaultBaseHash: 'base1', vaultSentHashes: ['x'], syncStatus: 'updated' });

beforeEach(() => {
  st.notes = new Map([['n1', row()]]);
  st.queue = [
    { id: 1, entity: 'NOTE', entityId: 'n1', type: 'UPDATE', data: { content: 'nv3.env2' } },
    { id: 2, entity: 'NOTE', entityId: 'n1', type: 'DELETE' },
    { id: 3, entity: 'NOTE', entityId: 'other', type: 'UPDATE' },
  ];
  order.length = 0;
  put.mockReset();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('moveOut', () => {
  it('PUT con plaintext, isEncrypted:false e baseHash = vaultBaseHash; poi onCommitted, poi Dexie in chiaro senza base', async () => {
    put.mockResolvedValue({ data: { updatedAt: '2026-10-22T10:00:00.000Z' } });
    await moveOut('n1', { title: 'T', content: '{"type":"doc"}', onCommitted: () => order.push('committed') });
    expect(put).toHaveBeenCalledWith('/notes/n1', { isVault: false, isEncrypted: false, content: '{"type":"doc"}', title: 'T', baseHash: 'base1' });
    expect(order).toEqual(['committed', 'dexie']);
    const r = st.notes.get('n1');
    expect(r).toMatchObject({ isVault: false, isEncrypted: false, title: 'T', content: '{"type":"doc"}', syncStatus: 'synced', updatedAt: '2026-10-22T10:00:00.000Z' });
    expect('vaultBaseHash' in r).toBe(false);
    expect('vaultSentHashes' in r).toBe(false);
    // item NOTE non-DELETE della nota tolti (spedirebbero un envelope su una nota in chiaro); DELETE e altre note restano
    expect(st.queue.map((i) => i.id)).toEqual([2, 3]);
  });

  it('item di coda: solo {content,title,isEncrypted} cancellati; misti ripuliti e rimessi pending; riga non synced', async () => {
    st.queue = [
      { id: 1, entity: 'NOTE', entityId: 'n1', type: 'UPDATE', data: { content: 'nv3.env2' } },
      { id: 2, entity: 'NOTE', entityId: 'n1', type: 'UPDATE', data: { title: '', isEncrypted: true } },
      { id: 3, entity: 'NOTE', entityId: 'n1', type: 'UPDATE', data: { isPinned: true } },
      { id: 4, entity: 'NOTE', entityId: 'n1', type: 'UPDATE', data: { content: 'nv3.env3', reminderDate: null }, status: 'failed', attempts: 5, lastError: 'x' },
    ];
    put.mockResolvedValue({ data: {} });
    await moveOut('n1', { title: 'T', content: 'c' });
    expect(st.queue.map((i) => i.id)).toEqual([3, 4]);
    expect(st.queue[0].data).toEqual({ isPinned: true });
    expect(st.queue[1]).toMatchObject({ data: { reminderDate: null }, status: 'pending', attempts: 0 });
    expect(st.notes.get('n1').syncStatus).toBe('updated');
  });

  it('CREATE vault in coda (risposta persa): dopo la PUT 200 e un replay, si cancella; la nota resta synced', async () => {
    st.queue = [
      { id: 1, entity: 'NOTE', entityId: 'n1', type: 'CREATE', data: { title: '', content: 'nv3.env', isEncrypted: true, isVault: true, notebookId: 'b1', id: 'n1', noteType: 'NOTE' } },
    ];
    put.mockResolvedValue({ data: {} });
    await moveOut('n1', { title: 'T', content: 'c' });
    expect(st.queue).toEqual([]);
    expect(st.notes.get('n1').syncStatus).toBe('synced');
  });

  it('transazione Dexie che lancia dopo la PUT 200: nessun rigetto (il chiamante non mostra un falso errore), onCommitted gia chiamato', async () => {
    put.mockResolvedValue({ data: {} });
    const onCommitted = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const orig = st.queue;
    st.queue = new Proxy(orig, { get: () => { throw new Error('idb'); } }) as any;
    await expect(moveOut('n1', { title: 'T', content: 'c', onCommitted })).resolves.toBeUndefined();
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('riga legacy in chiaro senza vaultBaseHash: baseHash = sha256 del content locale', async () => {
    st.notes.set('n1', { ...row(), content: '{"type":"doc","x":1}', vaultBaseHash: undefined });
    put.mockResolvedValue({ data: {} });
    await moveOut('n1', { title: 'T', content: '{"type":"doc","x":1}' });
    expect(put.mock.calls[0][1].baseHash).toBe('h({"type":"doc","x":1})');
  });

  it.each([
    [{ response: { status: 422, data: { message: 'errors.vault.conflict' } } }, 'conflict'],
    [{ response: { status: 422, data: { message: 'errors.vault.notReady' } } }, 'notReady'],
    [{ response: { status: 500, data: {} } }, 'failed'],
    [{ message: 'Network Error' }, 'offline'],
  ])('errore %# -> VaultMoveError(%s), nessuna scrittura locale, nessun onCommitted', async (err, code) => {
    put.mockRejectedValue(err);
    const onCommitted = vi.fn();
    await expect(moveOut('n1', { title: 'T', content: 'c', onCommitted })).rejects.toMatchObject({ name: 'VaultMoveError', code });
    expect(onCommitted).not.toHaveBeenCalled();
    expect(st.notes.get('n1')).toEqual(row());
    expect(st.queue).toHaveLength(3);
  });

  it('offline dichiarato: nessuna chiamata', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await expect(moveOut('n1', { title: 'T', content: 'c' })).rejects.toBeInstanceOf(VaultMoveError);
    expect(put).not.toHaveBeenCalled();
  });
});
