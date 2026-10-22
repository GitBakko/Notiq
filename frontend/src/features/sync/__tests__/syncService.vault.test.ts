// Vault v3 (plan P2, T14, 5.7): push/pull/retry rules for vault rows. Stateful in-memory Dexie so that the effects of one
// item on the next (vaultBaseHash, queue contents, syncStatus) are real, not asserted on call counts alone.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any -- Vitest mocks: Dexie rows and queue items are loose records */
const { st, mockDb, mockApi, mockToast } = vi.hoisted(() => {
  const st = { queue: [] as any[], notes: new Map<string, any>(), nextId: 100 };

  // Dexie-like read chain over a snapshot of rows
  const q = (items: any[]): any => ({
    where: (f: string) => ({
      equals: (v: unknown) => q(items.filter(i => i[f] === v)),
      notEqual: (v: unknown) => q(items.filter(i => i[f] !== v)),
    }),
    filter: (fn: (i: any) => boolean) => q(items.filter(fn)),
    and: (fn: (i: any) => boolean) => q(items.filter(fn)),
    orderBy: () => q([...items].sort((a, b) => a.createdAt - b.createdAt)),
    toArray: async () => items,
    count: async () => items.length,
  });
  const live = (rows: () => any[]) => ({
    where: (f: string) => q(rows()).where(f),
    filter: (fn: (i: any) => boolean) => q(rows()).filter(fn),
    orderBy: () => q(rows()).orderBy(),
    toArray: async () => rows(),
    count: async () => rows().length,
  });
  const idle = () => ({
    ...live(() => []),
    get: vi.fn(async () => undefined),
    bulkGet: vi.fn(async () => []),
    put: vi.fn(async () => undefined),
    bulkPut: vi.fn(async () => undefined),
    bulkDelete: vi.fn(async () => undefined),
    update: vi.fn(async () => 1),
    delete: vi.fn(async () => undefined),
    add: vi.fn(async () => 1),
  });

  const mockDb: Record<string, any> = {
    notebooks: idle(), tags: idle(), taskLists: idle(), taskItems: idle(),
    kanbanBoards: idle(), kanbanColumns: idle(), kanbanCards: idle(),
    notes: {
      ...live(() => [...st.notes.values()]),
      get: vi.fn(async (id: string) => st.notes.get(id)),
      bulkGet: vi.fn(async (ids: string[]) => ids.map(id => st.notes.get(id))),
      bulkPut: vi.fn(async (rows: any[]) => { for (const r of rows) st.notes.set(r.id, r); }),
      put: vi.fn(async (r: any) => { st.notes.set(r.id, r); }),
      bulkDelete: vi.fn(async (ids: string[]) => { for (const id of ids) st.notes.delete(id); }),
      update: vi.fn(async (id: string, patch: any) => {
        const r = st.notes.get(id);
        if (!r) return 0;
        st.notes.set(id, { ...r, ...patch });
        return 1;
      }),
    },
    syncQueue: {
      ...live(() => st.queue),
      get: vi.fn(async (id: number) => st.queue.find(i => i.id === id)),
      delete: vi.fn(async (id: number) => { st.queue = st.queue.filter(i => i.id !== id); }),
      update: vi.fn(async (id: number, patch: any) => {
        st.queue = st.queue.map(i => (i.id === id ? { ...i, ...patch } : i));
        return 1;
      }),
      add: vi.fn(async (item: any) => { st.queue.push({ ...item, id: st.nextId++ }); }),
    },
    transaction: vi.fn(async (...args: unknown[]) => (args[args.length - 1] as () => unknown)()),
  };

  const mockApi = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
  const mockToast = Object.assign(vi.fn(), { error: vi.fn() });
  return { st, mockDb, mockApi, mockToast };
});

vi.mock('../../../lib/db', () => ({ db: mockDb }));
vi.mock('../../../lib/api', () => ({ default: mockApi }));
vi.mock('../../../store/authStore', () => ({ useAuthStore: { getState: () => ({ user: { id: 'user-1' } }) } }));
vi.mock('react-hot-toast', () => ({ default: mockToast }));
vi.mock('../../../lib/queryClient', () => ({ default: { invalidateQueries: vi.fn() } }));
vi.mock('i18next', () => ({ default: { t: (k: string) => k } }));

import { syncPull, syncPush, retryFailedSyncItems } from '../syncService';
import { useVaultStore } from '../../../store/vaultStore';
import { sha256hex } from '../../../utils/vaultCrypto';

// ---------------------------------------------------------------------------
const env = (tag: string, epoch = 1) => `nv3.${epoch}.AAAAAAAAAAAAAAAA.${tag.padEnd(22, 'B')}`;
const T0 = '2026-10-21T10:00:00.000Z';
let seq = 0;

const keyring = (status: 'NONE' | 'READY' | 'RESET_PENDING' = 'READY', epoch = 1): any => ({
  status, epoch, rev: 1, kdf: 'argon2id', kdfParams: { m: 65536, t: 3, p: 1 }, pinSalt: 'x', rootKeyId: 'rk', offlineUnlock: false,
});
const setKeyring = (c: any | null) => useVaultStore.setState({ byUser: c ? { 'user-1': c } : {} });

const putRow = (row: Record<string, unknown>) => st.notes.set(row.id as string, {
  userId: 'user-1', notebookId: 'nb-1', title: '', content: '', isTrashed: false, createdAt: T0, updatedAt: T0,
  tags: [], attachments: [], syncStatus: 'updated', ...row,
});
const vaultRow = (content: string, extra: Record<string, unknown> = {}) =>
  putRow({ id: 'v1', isVault: true, isEncrypted: true, noteType: 'NOTE', vaultBaseHash: 'oldhash', content, ...extra });

const item = (type: 'CREATE' | 'UPDATE' | 'DELETE', entity: string, entityId: string, data?: any, extra: any = {}) => {
  const it = { id: ++seq, type, entity, entityId, userId: 'user-1', data, createdAt: 1_000 + seq, ...extra };
  st.queue.push(it);
  return it;
};
const failedStatusUpdates = () =>
  mockDb.syncQueue.update.mock.calls.filter((c: any[]) => c[1]?.status === 'failed');
const quiet = () => { vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); };
const reject = (status: number, message?: string) => ({ response: { status, data: message ? { message } : {} } });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  st.queue = [];
  st.notes.clear();
  st.nextId = 100;
  seq = 0;
  setKeyring(keyring());
  mockApi.get.mockResolvedValue({ data: [] });
  mockApi.post.mockResolvedValue({ data: {} });
  mockApi.put.mockResolvedValue({ data: {} });
  mockApi.delete.mockResolvedValue({ data: {} });
  quiet();
});

// ---------------------------------------------------------------------------
describe('T14 (a) pull keeps vaultBaseHash', () => {
  const serverRow = (id: string) => ({
    id, title: '', notebookId: 'nb-1', userId: 'user-1', isTrashed: false, createdAt: T0, updatedAt: T0, tags: [], attachments: [],
  });

  it('carries the local vaultBaseHash and content over a synced row the server sent without content', async () => {
    vaultRow(env('local'), { syncStatus: 'synced', vaultBaseHash: 'h-local' });
    mockApi.get.mockImplementation(async (url: string) =>
      ({ data: url === '/notes?includeTrashed=true&all=1' ? [{ ...serverRow('v1'), isVault: true }] : [] }));

    await syncPull();

    const row = st.notes.get('v1');
    expect(row.content).toBe(env('local'));
    expect(row.vaultBaseHash).toBe('h-local');
    expect(row.syncStatus).toBe('synced');
  });

  it('carries vaultSentHashes over, and adds no key when absent', async () => {
    vaultRow(env('local'), { syncStatus: 'synced', vaultSentHashes: ['h-sent', 'h-sent2'] });
    putRow({ id: 'n1', content: '<p>x</p>', syncStatus: 'synced' });
    mockApi.get.mockImplementation(async (url: string) =>
      ({ data: url === '/notes?includeTrashed=true&all=1' ? [{ ...serverRow('v1'), isVault: true }, serverRow('n1')] : [] }));

    await syncPull();

    expect(st.notes.get('v1').vaultSentHashes).toEqual(['h-sent', 'h-sent2']);
    expect('vaultSentHashes' in st.notes.get('n1')).toBe(false);
  });

  it('adds no vaultBaseHash key to rows that never had one (non-vault payloads unchanged)', async () => {
    putRow({ id: 'n1', content: '<p>x</p>', syncStatus: 'synced' });
    mockApi.get.mockImplementation(async (url: string) =>
      ({ data: url === '/notes?includeTrashed=true&all=1' ? [serverRow('n1')] : [] }));

    await syncPull();

    expect('vaultBaseHash' in st.notes.get('n1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('T14 push with an active keyring (5.7.3-5.7.5)', () => {
  it('(b) UPDATE sends the Dexie content and baseHash, never the title', async () => {
    vaultRow(env('newest'));
    item('UPDATE', 'NOTE', 'v1', { content: env('stale'), title: 'Legacy title' });

    await syncPush();

    expect(mockApi.put).toHaveBeenCalledTimes(1);
    expect(mockApi.put).toHaveBeenCalledWith('/notes/v1', { content: env('newest'), baseHash: 'oldhash' });
    expect(st.queue).toHaveLength(0);
  });

  it('(b) other keys of the item travel with the content', async () => {
    vaultRow(env('newest'));
    item('UPDATE', 'NOTE', 'v1', { content: env('stale'), isPinned: true });

    await syncPush();

    expect(mockApi.put).toHaveBeenCalledWith('/notes/v1', { content: env('newest'), isPinned: true, baseHash: 'oldhash' });
  });

  it('(c) acceptance 11: content edits interleaved with TAG CREATE + tags UPDATE -> 1 content PUT with baseHash "oldhash", 0 failed, row synced', async () => {
    vaultRow(env('e3'));
    item('UPDATE', 'NOTE', 'v1', { content: env('e1') });
    item('CREATE', 'TAG', 'tag-1', { id: 'tag-1', name: 'work' });
    item('UPDATE', 'NOTE', 'v1', { tags: [{ tag: { id: 'tag-1' } }] });
    item('UPDATE', 'NOTE', 'v1', { content: env('e2') });
    item('UPDATE', 'NOTE', 'v1', { content: env('e3') });

    for (let i = 0; i < 4; i++) await syncPush();

    const contentPuts = mockApi.put.mock.calls.filter((c: any[]) => c[0] === '/notes/v1' && c[1]?.content !== undefined);
    expect(contentPuts).toEqual([['/notes/v1', expect.objectContaining({ content: env('e3'), baseHash: 'oldhash' })]]);
    expect(mockApi.post).toHaveBeenCalledWith('/tags', { id: 'tag-1', name: 'work' });
    expect(failedStatusUpdates()).toHaveLength(0);
    expect(st.queue).toHaveLength(0);
    expect(st.notes.get('v1').syncStatus).toBe('synced');
  });

  it('(d) vaultBaseHash = sha256 of what was sent; untouched row ends synced', async () => {
    vaultRow(env('sent'));
    item('UPDATE', 'NOTE', 'v1', { content: env('sent') });

    await syncPush();

    expect(st.notes.get('v1').vaultBaseHash).toBe(await sha256hex(env('sent')));
    expect(st.notes.get('v1').syncStatus).toBe('synced');
  });

  it('(d) a row edited during the PUT stays updated, with the hash of what the server got', async () => {
    vaultRow(env('sent'));
    item('UPDATE', 'NOTE', 'v1', { content: env('sent') });
    mockApi.put.mockImplementation(async () => {
      // the editor saved again while the request was in flight
      st.notes.set('v1', { ...st.notes.get('v1'), content: env('typed'), updatedAt: '2026-10-21T10:00:05.000Z' });
      return { data: {} };
    });

    await syncPush();

    const row = st.notes.get('v1');
    expect(row.vaultBaseHash).toBe(await sha256hex(env('sent')));
    expect(row.syncStatus).toBe('updated');
    expect(row.content).toBe(env('typed'));
  });

  it('(d) items of the note still queued after the PUT -> not synced yet', async () => {
    // the last item is not a content one, so the plain rule applies to it: the row must predate item.createdAt
    vaultRow(env('sent'), { updatedAt: new Date(500).toISOString() });
    item('UPDATE', 'NOTE', 'v1', { content: env('sent') });
    item('UPDATE', 'NOTE', 'v1', { isPinned: true });
    mockApi.put.mockResolvedValueOnce({ data: {} }).mockImplementationOnce(async () => {
      expect(st.notes.get('v1').syncStatus).toBe('updated');
      return { data: {} };
    });

    await syncPush();

    expect(mockApi.put).toHaveBeenCalledTimes(2);
    expect(st.notes.get('v1').syncStatus).toBe('synced');
  });

  it('(g) CREATE sends the Dexie envelope with an empty title and stores sha256(res.data.content)', async () => {
    vaultRow(env('dexie'), { syncStatus: 'created', vaultBaseHash: undefined });
    item('CREATE', 'NOTE', 'v1', {
      id: 'v1', title: 'Secret title', content: env('queued'), notebookId: 'nb-old', isVault: true, isEncrypted: true, noteType: 'NOTE',
    });
    // P2002 branch of the server: the note already existed, its content differs from what was sent
    mockApi.post.mockResolvedValue({ data: { id: 'v1', content: env('server') } });

    await syncPush();

    expect(mockApi.post).toHaveBeenCalledWith('/notes', {
      id: 'v1', title: '', content: env('dexie'), notebookId: 'nb-1', isVault: true, isEncrypted: true, noteType: 'NOTE',
    });
    expect(st.notes.get('v1').vaultBaseHash).toBe(await sha256hex(env('server')));
  });

  it('vaultSentHashes is written before the PUT and survives a network failure (lost response)', async () => {
    vaultRow(env('sent'));
    seq = 5000; // unique queue ids: a network failure leaves a module-level backoff keyed by item id
    item('UPDATE', 'NOTE', 'v1', { content: env('sent') });
    let during: any;
    mockApi.put.mockImplementation(async () => {
      during = { ...st.notes.get('v1') };
      throw new Error('Network Error');
    });

    await syncPush();

    expect(during.vaultSentHashes).toEqual([await sha256hex(env('sent'))]);
    expect(st.notes.get('v1').vaultSentHashes).toEqual([await sha256hex(env('sent'))]);
    expect(st.notes.get('v1').vaultBaseHash).toBe('oldhash');
  });

  // Fails the PUT by network for each envelope in turn, the row moving to the next one: v1 may have been applied
  // server side with the response lost, so its hash must survive the retry with v2.
  const failPuts = async (tags: string[], firstSeq: number) => {
    mockApi.put.mockRejectedValue(new Error('Network Error'));
    let s = firstSeq;
    for (const tag of tags) {
      seq = s; s += 100; // unique queue ids: a network failure leaves a module-level backoff keyed by item id
      st.queue = [];
      st.notes.set('v1', { ...st.notes.get('v1'), content: env(tag) });
      item('UPDATE', 'NOTE', 'v1', { content: env(tag) });
      await syncPush();
    }
  };

  it('a retry with v2 after a failed v1 keeps both hashes and the old base', async () => {
    vaultRow(env('v1'));
    await failPuts(['v1', 'v2'], 7000);

    expect(st.notes.get('v1').vaultSentHashes).toEqual([await sha256hex(env('v1')), await sha256hex(env('v2'))]);
    expect(st.notes.get('v1').vaultBaseHash).toBe('oldhash');
  });

  it('keeps only the 5 most recent sent hashes', async () => {
    vaultRow(env('a1'));
    const tags = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
    await failPuts(tags, 8000);

    expect(st.notes.get('v1').vaultSentHashes).toEqual(await Promise.all(tags.slice(-5).map(t => sha256hex(env(t)))));
  });

  it('a 2xx empties the list', async () => {
    vaultRow(env('v1'));
    await failPuts(['v1'], 9000);
    expect(st.notes.get('v1').vaultSentHashes).toHaveLength(1);

    st.queue = [];
    item('UPDATE', 'NOTE', 'v1', { content: env('v1') });
    mockApi.put.mockResolvedValue({ data: {} });
    await syncPush();

    expect(st.notes.get('v1').vaultSentHashes).toEqual([]);
    expect(st.notes.get('v1').vaultBaseHash).toBe(await sha256hex(env('v1')));
  });

  it('writing vaultSentHashes leaves updatedAt and syncStatus alone and the row still ends synced', async () => {
    vaultRow(env('sent'));
    item('UPDATE', 'NOTE', 'v1', { content: env('sent') });
    let during: any;
    mockApi.put.mockImplementation(async () => { during = { ...st.notes.get('v1') }; return { data: {} }; });

    await syncPush();

    expect(during.updatedAt).toBe(T0);
    expect(during.syncStatus).toBe('updated');
    expect(st.notes.get('v1').updatedAt).toBe(T0);
    expect(st.notes.get('v1').syncStatus).toBe('synced');
  });

  it('CREATE also stores vaultSentHashes = [sha256 of the envelope sent]', async () => {
    vaultRow(env('dexie'), { syncStatus: 'created', vaultBaseHash: undefined });
    seq = 6000; // see above: unique ids against the leaked backoff
    item('CREATE', 'NOTE', 'v1', { id: 'v1', title: '', content: env('dexie'), notebookId: 'nb-1', isVault: true });
    mockApi.post.mockRejectedValue(new Error('Network Error'));

    await syncPush();

    expect(st.notes.get('v1').vaultSentHashes).toEqual([await sha256hex(env('dexie'))]);
  });

  it('non vault rows never get vaultSentHashes', async () => {
    putRow({ id: 'n1', content: '<p>x</p>' });
    item('UPDATE', 'NOTE', 'n1', { content: '<p>x</p>' });

    await syncPush();

    expect('vaultSentHashes' in st.notes.get('n1')).toBe(false);
  });

  it('CREATE whose answer carries no content leaves vaultBaseHash unset', async () => {
    vaultRow(env('dexie'), { syncStatus: 'created', vaultBaseHash: undefined });
    item('CREATE', 'NOTE', 'v1', { id: 'v1', title: '', content: env('dexie'), notebookId: 'nb-1', isVault: true });

    await syncPush();

    expect(st.notes.get('v1').vaultBaseHash).toBeUndefined();
  });

  it('a vault CREATE / UPDATE whose Dexie content is not an envelope stays pending as vault:notEnvelope, holds later items, lets DELETE through', async () => {
    vaultRow('<p>plaintext</p>', { syncStatus: 'created', vaultBaseHash: undefined });
    const create = item('CREATE', 'NOTE', 'v1', { id: 'v1', title: '', content: env('x'), notebookId: 'nb-1', isVault: true });
    item('UPDATE', 'NOTE', 'v1', { content: env('y') });

    await syncPush();

    expect(mockApi.post).not.toHaveBeenCalled();
    expect(mockApi.put).not.toHaveBeenCalled();
    const kept = st.queue.find(i => i.id === create.id);
    expect(kept.lastError).toBe('vault:notEnvelope');
    expect(kept.status).not.toBe('failed');
    expect(kept.attempts).toBeUndefined();
    expect(failedStatusUpdates()).toHaveLength(0);

    // a second run does not rewrite the same lastError
    mockDb.syncQueue.update.mockClear();
    await syncPush();
    expect(mockDb.syncQueue.update).not.toHaveBeenCalled();

    item('DELETE', 'NOTE', 'v1');
    await syncPush();
    expect(mockApi.delete).toHaveBeenCalledWith('/notes/v1');
    expect(st.queue).toHaveLength(0);
  });

  it('5.7.9 a vault push does not re-fetch the note nor toast', async () => {
    vaultRow(env('a'));
    item('UPDATE', 'NOTE', 'v1', { content: env('a') });
    mockApi.put.mockResolvedValue({ data: { id: 'v1', content: env('a') } });

    await syncPush();

    expect(mockApi.get).not.toHaveBeenCalledWith('/notes/v1');
    expect(mockToast).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('T14 (e) 422 vault errors (5.7.6-5.7.7)', () => {
  it('422 errors.vault.conflict -> failed with vault:conflict; later UPDATEs wait, DELETE goes through', async () => {
    vaultRow(env('a'));
    const first = item('UPDATE', 'NOTE', 'v1', { content: env('a') });
    item('UPDATE', 'NOTE', 'v1', { content: env('a'), isPinned: true });
    mockApi.put.mockRejectedValueOnce(reject(422, 'errors.vault.conflict'));

    await syncPush();

    expect(mockApi.put).toHaveBeenCalledTimes(1); // the second UPDATE did not overtake in the same run
    expect(st.queue.find(i => i.id === first.id)).toMatchObject({ status: 'failed', lastError: 'vault:conflict' });

    await syncPush(); // next run: the failed vault:* item still holds the note
    expect(mockApi.put).toHaveBeenCalledTimes(1);
    expect(st.queue).toHaveLength(2);

    item('DELETE', 'NOTE', 'v1');
    await syncPush();
    expect(mockApi.delete).toHaveBeenCalledWith('/notes/v1');
    expect(st.queue).toHaveLength(0);
  });

  it.each(['stale', 'plaintextRejected', 'notReady', 'plaintextRequired', 'attachmentsBlocked'])(
    'maps errors.vault.%s to the same key behind vault:',
    async (key) => {
      vaultRow(env('a'));
      const it1 = item('UPDATE', 'NOTE', 'v1', { content: env('a') });
      mockApi.put.mockRejectedValueOnce(reject(422, `errors.vault.${key}`));

      await syncPush();

      expect(st.queue.find(i => i.id === it1.id)).toMatchObject({ status: 'failed', lastError: `vault:${key}` });
    },
  );

  it('maps the key even without a keyring in cache (server already READY, old bundle payload)', async () => {
    setKeyring(null);
    putRow({ id: 'v1', isVault: true, content: '<p>plain</p>', title: 'T' });
    const it1 = item('UPDATE', 'NOTE', 'v1', { content: '<p>plain</p>', title: 'T' });
    mockApi.put.mockRejectedValueOnce(reject(422, 'errors.vault.plaintextRejected'));

    await syncPush();

    expect(st.queue.find(i => i.id === it1.id)).toMatchObject({ status: 'failed', lastError: 'vault:plaintextRejected' });
  });

  it('other 422s keep the generic "validation" mark', async () => {
    putRow({ id: 'n1', content: '<p>x</p>' });
    const a = item('UPDATE', 'NOTE', 'n1', { title: 'x' });
    const b = item('UPDATE', 'NOTE', 'n2', { title: 'y' });
    mockApi.put.mockRejectedValueOnce(reject(422)).mockRejectedValueOnce(reject(422, 'errors.notes.invalid'));

    await syncPush();

    expect(st.queue.find(i => i.id === a.id)).toMatchObject({ status: 'failed', lastError: 'validation' });
    expect(st.queue.find(i => i.id === b.id)).toMatchObject({ status: 'failed', lastError: 'validation' });
  });
});

// ---------------------------------------------------------------------------
describe('T14 (f) retryFailedSyncItems (5.7.8)', () => {
  const failed = (type: 'CREATE' | 'UPDATE', entityId: string, data: any, lastError: string) =>
    item(type, 'NOTE', entityId, data, { status: 'failed', attempts: 5, lastError });
  const wasReset = (id: number) =>
    mockDb.syncQueue.update.mock.calls.some((c: any[]) => c[0] === id && c[1]?.status === 'pending');

  it('skips vault:* items and legacy items on vault rows; resets the rest', async () => {
    vaultRow(env('a'));
    putRow({ id: 'v2', isVault: true, content: '<p>plaintext</p>', title: '' });
    putRow({ id: 'v3', isVault: true, content: env('b'), title: 'Old title' });
    putRow({ id: 'n1', content: '<p>x</p>' });
    const conflict = failed('UPDATE', 'v1', { content: env('a') }, 'vault:conflict');
    const plain = failed('UPDATE', 'v2', { content: '<p>plaintext</p>' }, 'validation');
    const titled = failed('UPDATE', 'v3', { title: 'Old title' }, 'validation');
    const normal = failed('UPDATE', 'n1', { title: 'T' }, 'boom');

    await retryFailedSyncItems();
    await syncPush(); // drain the push retryFailedSyncItems fires

    expect(wasReset(conflict.id)).toBe(false);
    expect(wasReset(plain.id)).toBe(false);
    expect(wasReset(titled.id)).toBe(false);
    expect(wasReset(normal.id)).toBe(true);
    expect(st.queue.find(i => i.id === conflict.id)).toMatchObject({ status: 'failed', attempts: 5 });
    expect(st.queue.find(i => i.id === plain.id)).toMatchObject({ status: 'failed', attempts: 5 });
  });

  it('without a keyring the legacy vault item is retried as before (R-B1)', async () => {
    setKeyring(null);
    putRow({ id: 'v2', isVault: true, content: '<p>plaintext</p>', title: 'T' });
    const legacy = failed('UPDATE', 'v2', { content: '<p>plaintext</p>', title: 'T' }, 'validation');

    await retryFailedSyncItems();
    await syncPush();

    expect(wasReset(legacy.id)).toBe(true);
    expect(mockApi.put).toHaveBeenCalledWith('/notes/v2', { content: '<p>plaintext</p>', title: 'T' });
  });

  it('a vault:* item is skipped even without a keyring (reconcile owns it)', async () => {
    setKeyring(null);
    putRow({ id: 'v2', isVault: true, content: env('a') });
    const held = failed('UPDATE', 'v2', { content: env('a') }, 'vault:stale');

    await retryFailedSyncItems();

    expect(wasReset(held.id)).toBe(false);
  });

  it('a failed vault CREATE with an envelope of the cached epoch gets title "" and the Dexie envelope', async () => {
    vaultRow(env('now', 1), { syncStatus: 'created' });
    const create = failed('CREATE', 'v1', {
      id: 'v1', title: 'Old', content: '<p>old plaintext</p>', notebookId: 'nb-1', isVault: true,
    }, 'validation');

    await retryFailedSyncItems();
    await syncPush();

    expect(mockDb.syncQueue.update).toHaveBeenCalledWith(create.id, expect.objectContaining({
      status: 'pending',
      data: { id: 'v1', title: '', content: env('now', 1), notebookId: 'nb-1', isVault: true, isEncrypted: true },
    }));
  });

  it('an envelope of another epoch is not used to refresh the payload', async () => {
    vaultRow(env('old', 0), { syncStatus: 'created' });
    const data = { id: 'v1', title: '', content: env('q', 0), notebookId: 'nb-1', isVault: true };
    const create = failed('CREATE', 'v1', data, 'validation');

    await retryFailedSyncItems();

    const call = mockDb.syncQueue.update.mock.calls.find((c: any[]) => c[0] === create.id);
    expect(call[1]).not.toHaveProperty('data');
  });
});

// ---------------------------------------------------------------------------
describe('T14 (h) non-vault rows: payloads byte-identical, keyring or not', () => {
  it.each([['READY keyring', keyring()], ['no keyring', null]])('%s', async (_n, c) => {
    setKeyring(c);
    seq = 7000; // unique queue ids: the (f) tests leave a module-level backoff on the low ids
    putRow({ id: 'n1', content: '<p>x</p>', title: 'T' });
    const upd = item('UPDATE', 'NOTE', 'n1', { title: 'T', content: '<p>x</p>' });
    item('CREATE', 'NOTE', 'n2', { id: 'n2', title: 'N', content: '<p>y</p>', notebookId: 'nb-9' });

    await syncPush();

    expect(mockApi.put.mock.calls[0][1]).toBe(upd.data); // the very same object, not a rebuilt one
    expect(mockApi.post).toHaveBeenCalledWith('/notes', { title: 'N', content: '<p>y</p>', notebookId: 'nb-9', id: 'n2' });
  });

  it('a vault UPDATE without content (pin, reminder) is sent as queued, keyring READY', async () => {
    vaultRow(env('a'));
    const upd = item('UPDATE', 'NOTE', 'v1', { isPinned: true, title: '' });

    await syncPush();

    expect(mockApi.put.mock.calls[0][1]).toBe(upd.data);
  });

  it('a normal note uses the old synced rule (updatedAt <= item.createdAt)', async () => {
    putRow({ id: 'n1', content: '<p>x</p>', updatedAt: new Date(500).toISOString() });
    item('UPDATE', 'NOTE', 'n1', { content: '<p>x</p>' }); // createdAt = 1001

    await syncPush();

    expect(st.notes.get('n1').syncStatus).toBe('synced');
  });
});

// ---------------------------------------------------------------------------
describe('T14 (i) no READY keyring in cache: legacy payloads leave unchanged', () => {
  it.each([
    ['no entry', null],
    ['NONE', keyring('NONE')],
    ['RESET_PENDING', keyring('RESET_PENDING')],
    ['READY without integer epoch', { ...keyring(), epoch: undefined }],
  ])('%s', async (_n, c) => {
    setKeyring(c);
    putRow({ id: 'v1', isVault: true, isEncrypted: true, content: '<p>secret</p>', title: 'My secret', vaultBaseHash: undefined });
    const upd = item('UPDATE', 'NOTE', 'v1', { content: '<p>secret</p>', title: 'My secret' });
    item('CREATE', 'NOTE', 'v2', { id: 'v2', title: 'Another secret', content: '<p>s2</p>', notebookId: 'nb-1', isVault: true });

    await syncPush();

    expect(mockApi.put.mock.calls[0][1]).toBe(upd.data);
    expect(mockApi.put).toHaveBeenCalledWith('/notes/v1', { content: '<p>secret</p>', title: 'My secret' });
    expect(mockApi.post).toHaveBeenCalledWith('/notes', {
      title: 'Another secret', content: '<p>s2</p>', notebookId: 'nb-1', isVault: true, id: 'v2',
    });
  });
});

// ---------------------------------------------------------------------------
describe('T15 sent hashes: atomic add, prefix removal (CREATE and UPDATE)', () => {
  const NOTES_URL = '/notes?includeTrashed=true&all=1';

  it('adding a hash keeps the ones already there, no duplicates, max 5', async () => {
    vaultRow(env('mine'), { vaultSentHashes: ['h1', 'h2', 'h3', 'h4', 'h5'] });
    item('UPDATE', 'NOTE', 'v1', { content: env('mine') });
    let during: any;
    mockApi.put.mockImplementation(async () => { during = [...st.notes.get('v1').vaultSentHashes]; return { data: {} }; });

    await syncPush();

    expect(during).toEqual(['h2', 'h3', 'h4', 'h5', await sha256hex(env('mine'))]);
  });

  it('adding does not touch updatedAt nor syncStatus and runs inside a Dexie transaction', async () => {
    vaultRow(env('mine'));
    item('UPDATE', 'NOTE', 'v1', { content: env('mine') });
    let during: any;
    mockApi.put.mockImplementation(async () => { during = { ...st.notes.get('v1') }; return { data: {} }; });

    await syncPush();

    expect(during.updatedAt).toBe(T0);
    expect(during.syncStatus).toBe('updated');
    expect(mockDb.transaction).toHaveBeenCalled();
  });

  it('UPDATE 2xx removes the prefix up to its own hash; the hash another tab added after stays', async () => {
    vaultRow(env('a'), { vaultSentHashes: ['old'] });
    item('UPDATE', 'NOTE', 'v1', { content: env('a') });
    const ha = await sha256hex(env('a'));
    mockApi.put.mockImplementation(async () => {
      // tab B sends its own envelope while A's PUT is in flight
      const r = st.notes.get('v1');
      st.notes.set('v1', { ...r, vaultSentHashes: [...r.vaultSentHashes, 'hash-of-B'] });
      return { data: {} };
    });

    await syncPush();

    expect(st.notes.get('v1').vaultSentHashes).toEqual(['hash-of-B']);
    expect(st.notes.get('v1').vaultBaseHash).toBe(ha);
    expect(st.notes.get('v1').syncStatus).toBe('synced');
  });

  it('CREATE 2xx: same prefix rule, and vaultBaseHash from the answer', async () => {
    vaultRow(env('c'), { syncStatus: 'created', vaultBaseHash: undefined });
    item('CREATE', 'NOTE', 'v1', { id: 'v1', title: '', content: env('c'), notebookId: 'nb-1', isVault: true });
    mockApi.post.mockImplementation(async () => {
      const r = st.notes.get('v1');
      st.notes.set('v1', { ...r, vaultSentHashes: [...r.vaultSentHashes, 'hash-of-B'] });
      return { data: { content: env('server') } };
    });

    await syncPush();

    expect(st.notes.get('v1').vaultSentHashes).toEqual(['hash-of-B']);
    expect(st.notes.get('v1').vaultBaseHash).toBe(await sha256hex(env('server')));
  });

  it('CREATE 2xx with a single own hash leaves an empty list', async () => {
    vaultRow(env('c'), { syncStatus: 'created', vaultBaseHash: undefined });
    item('CREATE', 'NOTE', 'v1', { id: 'v1', title: '', content: env('c'), notebookId: 'nb-1', isVault: true });
    mockApi.post.mockResolvedValue({ data: { content: env('c') } });

    await syncPush();

    expect(st.notes.get('v1').vaultSentHashes).toEqual([]);
  });

  it('own hash not in the list (-1): the list stays intact, never emptied', async () => {
    vaultRow(env('a'), { vaultSentHashes: [] });
    item('UPDATE', 'NOTE', 'v1', { content: env('a') });
    mockApi.put.mockImplementation(async () => {
      st.notes.set('v1', { ...st.notes.get('v1'), vaultSentHashes: ['x1', 'x2'] });
      return { data: {} };
    });

    await syncPush();

    expect(st.notes.get('v1').vaultSentHashes).toEqual(['x1', 'x2']);
  });

  describe('(c) pull: vault flag flip under the note lock', () => {
    const serverRow = (extra: Record<string, unknown>) => ({
      id: 'v1', title: 'T', notebookId: 'nb-1', userId: 'user-1', isTrashed: false, createdAt: T0, updatedAt: T0, tags: [], attachments: [], ...extra,
    });
    const pullWith = async (row: any) => {
      mockApi.get.mockImplementation(async (url: string) => ({ data: url === NOTES_URL ? [row] : [] }));
      await syncPull();
    };
    const held = new Set<string>();
    const installLocks = () => Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (name: string, opts: any, cb: (l: unknown) => Promise<unknown>) => {
          if (held.has(name)) return opts.ifAvailable ? cb(null) : undefined;
          held.add(name);
          try { return await cb({ name }); } finally { held.delete(name); }
        },
      },
    });
    beforeEach(() => { held.clear(); installLocks(); });
    afterEach(() => { Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }); });

    const flipSetup = () => vaultRow(env('local'), {
      syncStatus: 'synced', vaultBaseHash: 'h-local', vaultSentHashes: ['s1'], title: '',
    });

    it('lock held: the row is untouched; applied by the next pull after the release', async () => {
      flipSetup();
      const before = { ...st.notes.get('v1') };
      held.add('notiq-vault-note:v1');

      await pullWith(serverRow({ isVault: false, isEncrypted: false, content: '<p>plain</p>' }));
      expect(st.notes.get('v1')).toEqual(before);

      held.clear();
      await pullWith(serverRow({ isVault: false, isEncrypted: false, content: '<p>plain</p>' }));
      const row = st.notes.get('v1');
      expect(row.isVault).toBe(false);
      expect(row.content).toBe('<p>plain</p>');
      expect(row.title).toBe('T');
      expect('vaultBaseHash' in row).toBe(false);
      expect('vaultSentHashes' in row).toBe(false);
      expect(row.syncStatus).toBe('synced');
    });

    it('server content missing: the flipped row gets an empty content, not the old envelope', async () => {
      flipSetup();
      await pullWith(serverRow({ isVault: false, isEncrypted: false }));
      expect(st.notes.get('v1').content).toBe('');
    });

    it('the flip is not written if the row became dirty meanwhile', async () => {
      flipSetup();
      const realGet = mockDb.notes.get.getMockImplementation()!;
      let calls = 0;
      // the editor grabs the row between the pull transaction and the flip (the 2nd get of v1 is the re-read)
      mockDb.notes.get.mockImplementation(async (id: string) => {
        if (++calls === 1) st.notes.set(id, { ...st.notes.get(id), syncStatus: 'updated', content: env('edited') });
        return realGet(id);
      });
      await pullWith(serverRow({ isVault: false, isEncrypted: false, content: '<p>plain</p>' }));
      const row = st.notes.get('v1');
      expect(row.isVault).toBe(true);
      expect(row.content).toBe(env('edited'));
    });

    it('without navigator.locks the flip is written directly', async () => {
      Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
      flipSetup();
      await pullWith(serverRow({ isVault: false, isEncrypted: false, content: '<p>plain</p>' }));
      expect(st.notes.get('v1').isVault).toBe(false);
      expect(st.notes.get('v1').content).toBe('<p>plain</p>');
    });

    it('rows with the same vault flag still go through bulkPut and keep base / sent hashes', async () => {
      flipSetup();
      await pullWith(serverRow({ isVault: true, isEncrypted: true }));
      const row = st.notes.get('v1');
      expect(row.vaultBaseHash).toBe('h-local');
      expect(row.vaultSentHashes).toEqual(['s1']);
      expect(mockDb.notes.put).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
describe('T15 push of a vault note: shared note lock with ifAvailable', () => {
  const NAME = 'notiq-vault-note:v1';
  const excl = new Set<string>();
  const shared = new Map<string, number>();
  const duringPut: string[] = [];
  const installLocks = () => Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (name: string, opts: any, cb: (l: unknown) => Promise<unknown>) => {
        const mode = opts.mode ?? 'exclusive';
        const ok = !excl.has(name) && (mode === 'shared' || !(shared.get(name) ?? 0));
        if (!ok) return opts.ifAvailable ? cb(null) : undefined;
        if (mode === 'shared') shared.set(name, (shared.get(name) ?? 0) + 1); else excl.add(name);
        try { return await cb({ name, mode }); } finally {
          if (mode === 'shared') shared.set(name, (shared.get(name) ?? 1) - 1); else excl.delete(name);
        }
      },
    },
  });
  beforeEach(() => { excl.clear(); shared.clear(); duringPut.length = 0; installLocks(); });
  afterEach(() => { Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }); });

  it('exclusive holder: the item is not sent and nothing changes; sent after the release', async () => {
    vaultRow(env('mine'));
    const it = item('UPDATE', 'NOTE', 'v1', { content: env('mine') });
    const rowBefore = { ...st.notes.get('v1') };
    excl.add(NAME);

    await syncPush();

    expect(mockApi.put).not.toHaveBeenCalled();
    expect(st.queue).toEqual([it]);
    expect(mockDb.syncQueue.update).not.toHaveBeenCalled();
    expect(st.notes.get('v1')).toEqual(rowBefore);

    excl.delete(NAME);
    await syncPush();

    expect(mockApi.put).toHaveBeenCalledTimes(1);
    expect(st.queue).toEqual([]);
    expect(st.notes.get('v1').syncStatus).toBe('synced');
  });

  it('a shared holder (open editor): the item is sent; the lock is shared during the PUT and released after', async () => {
    vaultRow(env('mine'));
    item('UPDATE', 'NOTE', 'v1', { content: env('mine') });
    shared.set(NAME, 1); // the editor
    mockApi.put.mockImplementation(async () => { duringPut.push(`shared:${shared.get(NAME)}`, `excl:${excl.has(NAME)}`); return { data: {} }; });

    await syncPush();

    expect(mockApi.put).toHaveBeenCalledTimes(1);
    expect(duringPut).toEqual(['shared:2', 'excl:false']);
    expect(shared.get(NAME)).toBe(1);
    expect(st.notes.get('v1').syncStatus).toBe('synced');
  });

  // the reconcile commits while the push waits for the lock: it rewrites (strips isEncrypted:false) or deletes the queue item
  const mutateWhileWaiting = (fn: () => void) => {
    const real = (navigator as any).locks.request;
    (navigator as any).locks.request = async (...a: any[]) => { fn(); return real(...a); };
  };

  it('queue item rewritten by the reconcile while waiting for the lock: the old version is not sent', async () => {
    vaultRow(env('mine'));
    const it = item('UPDATE', 'NOTE', 'v1', { content: env('mine'), isEncrypted: false });
    mutateWhileWaiting(() => { st.queue = st.queue.map(i => (i.id === it.id ? { ...i, data: { content: env('mine') } } : i)); });

    await syncPush();

    expect(mockApi.put).not.toHaveBeenCalled();
    expect(st.queue).toHaveLength(1);
    expect(shared.get(NAME) ?? 0).toBe(0);
  });

  it('queue item deleted by the reconcile while waiting for the lock: nothing is sent', async () => {
    vaultRow(env('mine'));
    const it = item('UPDATE', 'NOTE', 'v1', { content: env('mine') });
    mutateWhileWaiting(() => { st.queue = st.queue.filter(i => i.id !== it.id); });

    await syncPush();

    expect(mockApi.put).not.toHaveBeenCalled();
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(shared.get(NAME) ?? 0).toBe(0);
  });

  it('CREATE is under the same lock: busy with an exclusive holder, sent without', async () => {
    vaultRow(env('c'), { syncStatus: 'created', vaultBaseHash: undefined });
    item('CREATE', 'NOTE', 'v1', { id: 'v1', title: '', content: env('c'), notebookId: 'nb-1', isVault: true });
    excl.add(NAME);
    await syncPush();
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(st.queue).toHaveLength(1);

    excl.delete(NAME);
    await syncPush();
    expect(mockApi.post).toHaveBeenCalledTimes(1);
  });

  it('a non-vault note is pushed without taking the lock', async () => {
    putRow({ id: 'n9', content: '<p>x</p>' });
    item('UPDATE', 'NOTE', 'n9', { content: '<p>x</p>' });
    excl.add('notiq-vault-note:n9');

    await syncPush();

    expect(mockApi.put).toHaveBeenCalledTimes(1);
  });

  it('without navigator.locks the push runs as before', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    vaultRow(env('mine'));
    item('UPDATE', 'NOTE', 'v1', { content: env('mine') });

    await syncPush();

    expect(mockApi.put).toHaveBeenCalledTimes(1);
    expect(st.notes.get('v1').syncStatus).toBe('synced');
  });

  // last: a 500 puts item id 1 in the module's in-memory backoff, and ids restart at 1 in every test
  it('the lock is released also when the PUT fails', async () => {
    vaultRow(env('mine'));
    item('UPDATE', 'NOTE', 'v1', { content: env('mine') });
    mockApi.put.mockRejectedValue(reject(500));

    await syncPush();

    expect(shared.get(NAME) ?? 0).toBe(0);
  });
});
