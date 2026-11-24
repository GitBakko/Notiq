import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StaleItem } from '../StaleNotesDialog';

const h = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; syncStatus: string }>,
  queue: [] as Array<{ id?: number; entity: string; entityId: string; type?: string; status?: string }>,
  inTx: false,
  txCalls: [] as unknown[][],
  update: vi.fn(),
  lock: vi.fn(),
  rewrap: vi.fn(),
  finish: vi.fn(),
  permDelete: vi.fn(),
  syncPush: vi.fn(),
}));
vi.mock('../../../lib/db', () => ({
  db: {
    notes: { get: async (id: string) => h.rows.find((r) => r.id === id) },
    syncQueue: {
      filter: (fn: (i: { entity: string; entityId: string; type?: string; status?: string }) => boolean) => ({ toArray: async () => h.queue.filter(fn) }),
      update: (...a: unknown[]) => h.update(...a),
    },
    // ricontrollo + eliminazione devono stare in una sola transazione 'rw' su note e coda
    transaction: async (...a: unknown[]) => {
      h.txCalls.push(a);
      h.inTx = true;
      try { return await (a[a.length - 1] as () => Promise<unknown>)(); } finally { h.inTx = false; }
    },
  },
}));
vi.mock('../../../lib/vaultNoteLock', () => ({ withNoteLock: (...a: unknown[]) => h.lock(...a) }));
vi.mock('../../notes/noteService', () => ({ permanentlyDeleteNote: (...a: unknown[]) => h.permDelete(...a) }));
vi.mock('../../sync/syncService', () => ({ syncPush: (...a: unknown[]) => h.syncPush(...a) }));
vi.mock('../vaultMigration', () => ({
  MAX_REWRAP_LEN: 1000,
  rewrapUnreadable: (...a: unknown[]) => h.rewrap(...a),
  finishRotation: (...a: unknown[]) => h.finish(...a),
}));

import { deleteDamagedThenFinish } from '../staleActions';

const ctx = { keys: {}, userId: 'u', epoch: 1 } as never;
const D = (id: string): StaleItem => ({ id, reason: 'damaged', size: 5000, tooLarge: true } as StaleItem);

beforeEach(() => {
  h.rows = [];
  h.queue = [];
  h.inTx = false;
  h.txCalls = [];
  h.update.mockReset().mockResolvedValue(1);
  h.lock.mockReset().mockImplementation(async (_id: string, fn: () => Promise<unknown>) => ({ status: 'ran', value: await fn() }));
  h.rewrap.mockReset();
  h.finish.mockReset().mockResolvedValue({ unreadable: [] });
  h.permDelete.mockReset().mockResolvedValue(undefined);
  h.syncPush.mockReset().mockResolvedValue(true);
});

describe('deleteDamagedThenFinish: mai eliminare una nota con modifiche non sincronizzate', () => {
  it('riga locale non sincronizzata o item in coda: non si elimina, si conta; le altre si eliminano', async () => {
    h.rewrap.mockResolvedValue({ tooLarge: ['pend', 'queued', 'ok1', 'ok2'] });
    h.rows = [{ id: 'pend', syncStatus: 'updated' }, { id: 'queued', syncStatus: 'synced' }, { id: 'ok1', syncStatus: 'synced' }];
    h.queue = [{ entity: 'NOTE', entityId: 'queued' }, { entity: 'TAG', entityId: 'ok2' }]; // un item di un altro entity non conta
    const onSkipped = vi.fn();
    const onDeleted = vi.fn();
    const done = await deleteDamagedThenFinish(ctx, [D('pend'), D('queued'), D('ok1'), D('ok2')], { live: false, onSkipped, onDeleted });
    expect(h.permDelete.mock.calls.map((c) => c[0]).sort()).toEqual(['ok1', 'ok2']);
    expect([...done!.gone].sort()).toEqual(['ok1', 'ok2']);
    expect(done!.skipped).toBe(2);
    expect(onSkipped).toHaveBeenCalledWith(2);
    expect(onDeleted).toHaveBeenCalledWith(2);
  });

  it('tutte con modifiche pendenti: nessuna eliminazione ne push, finishRotation gira comunque', async () => {
    h.rewrap.mockResolvedValue({ tooLarge: ['a'] });
    h.rows = [{ id: 'a', syncStatus: 'created' }];
    const onSkipped = vi.fn();
    const done = await deleteDamagedThenFinish(ctx, [D('a')], { onSkipped });
    expect(h.permDelete).not.toHaveBeenCalled();
    expect(h.syncPush).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalled();
    expect(done).toMatchObject({ skipped: 1 });
    expect(done!.gone.size).toBe(0);
    expect(onSkipped).toHaveBeenCalledWith(1);
  });
});

describe('deleteDamagedThenFinish: DELETE in coda e Web Lock', () => {
  it('item DELETE in coda (eliminazione precedente): non saltata, nessun nuovo DELETE, syncPush gira', async () => {
    h.rewrap.mockResolvedValue({ tooLarge: ['gone', 'ok'] });
    h.rows = [{ id: 'ok', syncStatus: 'synced' }];
    h.queue = [{ entity: 'NOTE', entityId: 'gone', type: 'DELETE' }];
    const onSkipped = vi.fn();
    const done = await deleteDamagedThenFinish(ctx, [D('gone'), D('ok')], { live: false, onSkipped });
    expect(onSkipped).not.toHaveBeenCalled();
    expect(done!.skipped).toBe(0);
    expect([...done!.gone].sort()).toEqual(['gone', 'ok']);
    expect(h.permDelete.mock.calls.map((c) => c[0])).toEqual(['ok']); // quella gia' eliminata non riaccoda un secondo DELETE
    expect(h.syncPush).toHaveBeenCalled();
  });

  it('solo DELETE in coda: syncPush gira anche se nessuna nota eliminata ora', async () => {
    h.rewrap.mockResolvedValue({ tooLarge: ['gone'] });
    h.queue = [{ entity: 'NOTE', entityId: 'gone', type: 'DELETE' }];
    await deleteDamagedThenFinish(ctx, [D('gone')], { live: false });
    expect(h.permDelete).not.toHaveBeenCalled();
    expect(h.syncPush).toHaveBeenCalledTimes(1);
  });

  it.each(['UPDATE', 'CREATE'])('item %s in coda: saltata come prima', async (type) => {
    h.rewrap.mockResolvedValue({ tooLarge: ['q'] });
    h.rows = [{ id: 'q', syncStatus: 'synced' }];
    h.queue = [{ entity: 'NOTE', entityId: 'q', type }];
    const onSkipped = vi.fn();
    const done = await deleteDamagedThenFinish(ctx, [D('q')], { live: false, onSkipped });
    expect(h.permDelete).not.toHaveBeenCalled();
    expect(onSkipped).toHaveBeenCalledWith(1);
    expect(done!.skipped).toBe(1);
  });

  it('lock non disponibile (editor aperto): id saltato come occupato (non come modifiche pendenti), nessuna eliminazione', async () => {
    h.rewrap.mockResolvedValue({ tooLarge: ['busy', 'ok'] });
    h.rows = [{ id: 'busy', syncStatus: 'synced' }, { id: 'ok', syncStatus: 'synced' }];
    h.lock.mockImplementation(async (id: string, fn: () => Promise<unknown>) => (id === 'busy' ? { status: 'busy' } : { status: 'ran', value: await fn() }));
    const onSkipped = vi.fn();
    const onBusy = vi.fn();
    const done = await deleteDamagedThenFinish(ctx, [D('busy'), D('ok')], { live: false, onSkipped, onBusy });
    expect(h.permDelete.mock.calls.map((c) => c[0])).toEqual(['ok']);
    expect(onBusy).toHaveBeenCalledWith(1);
    expect(onSkipped).not.toHaveBeenCalled();
    expect(done!.busy).toBe(1);
    expect(done!.skipped).toBe(0);
    expect(h.lock).toHaveBeenCalledWith('busy', expect.any(Function), { mode: 'exclusive', ifAvailable: true });
  });

  it('senza navigator.locks: non si elimina, si salta come occupato (non come modifiche pendenti)', async () => {
    h.rewrap.mockResolvedValue({ tooLarge: ['a'] });
    h.rows = [{ id: 'a', syncStatus: 'synced' }];
    h.lock.mockResolvedValue({ status: 'nolocks' });
    const onSkipped = vi.fn();
    const onBusy = vi.fn();
    const done = await deleteDamagedThenFinish(ctx, [D('a')], { live: false, onSkipped, onBusy });
    expect(h.permDelete).not.toHaveBeenCalled();
    expect(onBusy).toHaveBeenCalledWith(1);
    expect(onSkipped).not.toHaveBeenCalled();
    expect(done!.busy).toBe(1);
    expect(done!.skipped).toBe(0);
  });

  it('riga che diventa non sincronizzata tra rewrap e lock: ricontrollo dentro il lock, saltata', async () => {
    h.rewrap.mockResolvedValue({ tooLarge: ['a'] });
    h.rows = [{ id: 'a', syncStatus: 'synced' }];
    h.lock.mockImplementation(async (_id: string, fn: () => Promise<unknown>) => {
      h.rows[0].syncStatus = 'updated'; // un editor ha salvato mentre si attendeva il lock
      return { status: 'ran', value: await fn() };
    });
    const onSkipped = vi.fn();
    await deleteDamagedThenFinish(ctx, [D('a')], { live: false, onSkipped });
    expect(h.permDelete).not.toHaveBeenCalled();
    expect(onSkipped).toHaveBeenCalledWith(1);
  });
});

describe('deleteDamagedThenFinish: DELETE failed in coda', () => {
  it('item DELETE failed della nota: riattivato a pending/attempts 0 PRIMA di syncPush', async () => {
    h.rewrap.mockResolvedValue({ tooLarge: ['gone'] });
    h.queue = [
      { id: 7, entity: 'NOTE', entityId: 'gone', type: 'DELETE', status: 'failed' },
      { id: 8, entity: 'NOTE', entityId: 'gone', type: 'DELETE', status: 'pending' }, // non failed: intatto
      { id: 9, entity: 'NOTE', entityId: 'other', type: 'DELETE', status: 'failed' }, // un altra nota: intatta
    ];
    await deleteDamagedThenFinish(ctx, [D('gone')], { live: false });
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith(7, { status: 'pending', attempts: 0 });
    expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(h.syncPush.mock.invocationCallOrder[0]);
  });

  it('id ancora illeggibile dopo la push: non conteggiato come eliminato, avviso onPendingSync; gli altri si contano', async () => {
    h.rewrap.mockResolvedValue({ tooLarge: ['stuck', 'ok'] });
    h.rows = [{ id: 'ok', syncStatus: 'synced' }];
    h.queue = [{ id: 1, entity: 'NOTE', entityId: 'stuck', type: 'DELETE', status: 'failed' }];
    h.finish.mockResolvedValue({ unreadable: [{ id: 'stuck' }] });
    const onDeleted = vi.fn();
    const onPendingSync = vi.fn();
    const done = await deleteDamagedThenFinish(ctx, [D('stuck'), D('ok')], { live: false, onDeleted, onPendingSync });
    expect([...done!.gone]).toEqual(['ok']);
    expect([...done!.unconfirmed]).toEqual(['stuck']);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(onDeleted).toHaveBeenCalledWith(1);
    expect(onPendingSync).toHaveBeenCalledWith(1);
  });

  it('tutte ancora illeggibili: nessun onDeleted', async () => {
    h.rewrap.mockResolvedValue({ tooLarge: ['stuck'] });
    h.queue = [{ id: 1, entity: 'NOTE', entityId: 'stuck', type: 'DELETE', status: 'failed' }];
    h.finish.mockResolvedValue({ unreadable: [{ id: 'stuck' }] });
    const onDeleted = vi.fn();
    const onPendingSync = vi.fn();
    const done = await deleteDamagedThenFinish(ctx, [D('stuck')], { live: false, onDeleted, onPendingSync });
    expect(done!.gone.size).toBe(0);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onPendingSync).toHaveBeenCalledWith(1);
  });
});

describe('deleteDamagedThenFinish: finishRotation che lancia dopo un\'eliminazione', () => {
  it('conferma del server non leggibile: onPendingSync (mai onDeleted) e rilancia', async () => {
    h.rewrap.mockResolvedValue({ tooLarge: ['a', 'b'] });
    h.rows = [{ id: 'a', syncStatus: 'synced' }, { id: 'b', syncStatus: 'synced' }];
    h.finish.mockRejectedValue(new Error('net'));
    const onDeleted = vi.fn();
    const onPendingSync = vi.fn();
    await expect(deleteDamagedThenFinish(ctx, [D('a'), D('b')], { live: false, onDeleted, onPendingSync })).rejects.toThrow('net');
    expect(onPendingSync).toHaveBeenCalledWith(2);
    expect(onDeleted).not.toHaveBeenCalled();
  });
});

describe('deleteDamagedThenFinish: ricontrollo ed eliminazione atomici', () => {
  it('percorso normale: ricontrollo e permanentlyDeleteNote dentro una transazione rw su note e coda', async () => {
    h.rewrap.mockResolvedValue({ tooLarge: ['a'] });
    h.rows = [{ id: 'a', syncStatus: 'synced' }];
    let inTxAtDelete = false;
    h.permDelete.mockImplementation(async () => { inTxAtDelete = h.inTx; });
    const done = await deleteDamagedThenFinish(ctx, [D('a')], { live: false });
    expect(inTxAtDelete).toBe(true);
    expect(h.txCalls).toHaveLength(1);
    expect(h.txCalls[0][0]).toBe('rw');
    expect(h.txCalls[0]).toHaveLength(4); // 'rw', db.notes, db.syncQueue, fn
    expect([...done!.gone]).toEqual(['a']);
  });

  it('nota sporcata nella finestra tra lock e transazione: il ricontrollo dentro la transazione la salta', async () => {
    h.rewrap.mockResolvedValue({ tooLarge: ['a'] });
    h.rows = [{ id: 'a', syncStatus: 'synced' }];
    h.lock.mockImplementation(async (_id: string, fn: () => Promise<unknown>) => { h.rows[0].syncStatus = 'updated'; return { status: 'ran', value: await fn() }; });
    const onSkipped = vi.fn();
    await deleteDamagedThenFinish(ctx, [D('a')], { live: false, onSkipped });
    expect(h.permDelete).not.toHaveBeenCalled();
    expect(onSkipped).toHaveBeenCalledWith(1);
  });
});
