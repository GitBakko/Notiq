// Vault v3 (T15, spec 2026-10-22-vault-t15-reconcile-spec.md): decide() pura (tabella T1-T15) e reconcile con crittografia vera,
// Dexie e server finti ma con stato, navigator.locks finto. Invariante I3 verificata dopo ogni test: nessun plaintext marcato
// SEGRETO in Dexie o nella coda (salvo i test che lasciano apposta una riga intatta).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any -- mock Vitest: righe Dexie e item di coda sono record liberi */
const { st, mockDb, mockApi, h } = vi.hoisted(() => {
  const st = { queue: [] as any[], notes: new Map<string, any>(), nextId: 100 };
  const q = (items: any[]): any => ({
    where: (f: string) => ({ equals: (v: unknown) => q(items.filter(i => i[f] === v)), notEqual: (v: unknown) => q(items.filter(i => i[f] !== v)) }),
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
    get: vi.fn(async () => undefined), bulkGet: vi.fn(async () => []), put: vi.fn(async () => undefined),
    bulkPut: vi.fn(async () => undefined), bulkDelete: vi.fn(async () => undefined), update: vi.fn(async () => 1),
    delete: vi.fn(async () => undefined), add: vi.fn(async () => 1),
  });
  const mockDb: Record<string, any> = {
    notebooks: idle(), tags: idle(), taskLists: idle(), taskItems: idle(), kanbanBoards: idle(), kanbanColumns: idle(), kanbanCards: idle(),
    notes: {
      ...live(() => [...st.notes.values()]),
      get: vi.fn(async (id: string) => st.notes.get(id)),
      bulkGet: vi.fn(async (ids: string[]) => ids.map(id => st.notes.get(id))),
      bulkPut: vi.fn(async (rows: any[]) => { for (const r of rows) st.notes.set(r.id, r); }),
      bulkDelete: vi.fn(async (ids: string[]) => { for (const id of ids) st.notes.delete(id); }),
      add: vi.fn(async (row: any) => { st.notes.set(row.id, row); }),
      delete: vi.fn(async (id: string) => { st.notes.delete(id); }),
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
      update: vi.fn(async (id: number, patch: any) => { st.queue = st.queue.map(i => (i.id === id ? { ...i, ...patch } : i)); return 1; }),
      add: vi.fn(async (item: any) => { st.queue.push({ ...item, id: st.nextId++ }); }),
    },
    transaction: vi.fn(async (...args: unknown[]) => (args[args.length - 1] as () => unknown)()),
  };
  const mockApi = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
  return { st, mockDb, mockApi, h: { server: null as any } };
});

vi.mock('../db', () => ({ db: mockDb }));
vi.mock('../api', () => ({ default: mockApi }));
vi.mock('../vaultApi', () => ({
  getItems: (b: unknown) => h.server.getItems(b),
  finalizeItems: (ids: string[]) => h.server.finalize(ids),
}));
vi.mock('../../store/authStore', () => ({ useAuthStore: { getState: () => ({ user: { id: 'user-1' } }) } }));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock('../queryClient', () => ({ default: { invalidateQueries: vi.fn() } }));
vi.mock('i18next', () => ({ default: { t: (k: string) => (k === 'vault.conflictCopySuffix' ? '(conflict)' : k) } }));

import { decide, hydrateVaultNote, vaultReconcile, type Snapshot } from '../vaultReconcile';
import { decryptItem, encryptItem, type VaultCodecCtx } from '../vaultCodec';
import { noteLockName, RECONCILE_LOCK } from '../vaultNoteLock';
import { useVaultStore, type VaultKeys } from '../../store/vaultStore';
import { generateSigKey, generateVkRaw, importVk, sha256hex } from '../../utils/vaultCrypto';
import { syncPush } from '../../features/sync/syncService';
import enLocale from '../../locales/en.json';
import itLocale from '../../locales/it.json';

const U = 'user-1';
const EPOCH = 2;
const T0 = '2026-10-22T10:00:00.000Z';
const T1 = '2026-10-22T11:00:00.000Z';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const doc = (text: string) => JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

// Server finto: listing paginato; con `ids` risponde come il backend (items vault, absent = non e' una nota dell'utente, notVault).
class FakeServer {
  items = new Map<string, any>();
  plain = new Set<string>();
  pageSize = 100;
  finalized: string[][] = [];
  idsCalls: string[][] = [];
  failIds = false;
  put(id: string, content: string, extra: Record<string, unknown> = {}) {
    this.items.set(id, { id, noteType: 'NOTE', title: '', hasPlaintextVersions: false, content, updatedAt: T1, isTrashed: false, ...extra });
  }
  private async dto(i: any) { return { ...i, contentHash: await sha256hex(i.content) }; }
  async getItems(body: { ids?: string[]; after?: string }) {
    if (body.ids) {
      this.idsCalls.push(body.ids);
      if (this.failIds) throw new Error('Network Error');
      return {
        items: await Promise.all(body.ids.filter(id => this.items.has(id)).map(id => this.dto(this.items.get(id)))),
        next: null,
        absent: body.ids.filter(id => !this.items.has(id) && !this.plain.has(id)),
        notVault: body.ids.filter(id => this.plain.has(id)),
      };
    }
    const all = [...this.items.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).filter(i => !body.after || i.id > body.after);
    const page = all.slice(0, this.pageSize);
    return { items: await Promise.all(page.map(i => this.dto(i))), next: all.length > this.pageSize ? page[page.length - 1].id : null };
  }
  async finalize(ids: string[]) {
    this.finalized.push(ids);
    return { finalized: ids.length, rejected: [], legacyCount: 0, migrationState: 'DONE' };
  }
}

// navigator.locks finto: exclusive e shared (i shared coesistono, un exclusive esclude tutti), FIFO per nome, ifAvailable e AbortSignal
// sull'attesa. `lockLog` registra ogni richiesta (nome, modo, ifAvailable).
const lockLog: Array<{ name: string; mode: string; ifAvailable: boolean }> = [];
const installLocks = () => {
  const state = new Map<string, { mode: string; n: number }>();
  const waiting = new Map<string, Array<{ mode: string; go: () => void }>>();
  const canGrant = (name: string, mode: string) => {
    const st0 = state.get(name);
    return !st0 || (mode === 'shared' && st0.mode === 'shared');
  };
  const pump = (name: string) => {
    const q = waiting.get(name) ?? [];
    while (q.length && canGrant(name, q[0].mode)) q.shift()!.go();
  };
  const request = async (name: string, opts: any, cb: (lock: unknown) => Promise<unknown>) => {
    const mode = opts.mode ?? 'exclusive';
    lockLog.push({ name, mode, ifAvailable: opts.ifAvailable === true });
    const run = async () => {
      const cur0 = state.get(name);
      if (cur0) cur0.n++; else state.set(name, { mode, n: 1 });
      try { return await cb({ name, mode }); } finally {
        const cur = state.get(name)!;
        if (--cur.n === 0) state.delete(name);
        pump(name);
      }
    };
    if (canGrant(name, mode) && !(waiting.get(name)?.length)) return run();
    if (opts.ifAvailable) return cb(null);
    return new Promise((resolve, reject) => {
      const entry = { mode, go: () => { run().then(resolve, reject); } };
      waiting.set(name, [...(waiting.get(name) ?? []), entry]);
      opts.signal?.addEventListener('abort', () => {
        waiting.set(name, (waiting.get(name) ?? []).filter(w => w !== entry));
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  };
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
};
const removeLocks = () => Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
/** Un'altra scheda tiene il lock `name` finche' non si chiama release(). 'shared' = editor aperto o push in corso. */
const hold = (name: string, mode: 'exclusive' | 'shared' = 'exclusive') => {
  let release!: () => void;
  const done = (navigator as any).locks.request(name, { mode }, () => new Promise<void>(res => { release = res; }));
  lockLog.pop(); // la richiesta del test non e' del reconcile
  return { release: () => release(), done: done as Promise<unknown> };
};
const tick = () => new Promise(r => setTimeout(r, 0));

let ctx: VaultCodecCtx;
let scan = true;
const enc = (id: string, t: string, c: string, type: 'NOTE' | 'CREDENTIAL' = 'NOTE') => encryptItem(id, type, { t, c }, ctx);
let seq = 0;
const putRow = (row: Record<string, unknown>) => st.notes.set(row.id as string, {
  userId: U, notebookId: 'nb-1', title: '', content: '', isTrashed: false, createdAt: T0, updatedAt: T0,
  tags: [], attachments: [], syncStatus: 'synced', isVault: true, isEncrypted: true, noteType: 'NOTE', ...row,
});
const item = (type: 'CREATE' | 'UPDATE' | 'DELETE', entityId: string, data?: any, extra: any = {}) => {
  const it = { id: ++seq, type, entity: 'NOTE', entityId, userId: U, data, createdAt: 1_000 + seq, ...extra };
  st.queue.push(it);
  return it;
};
const failed = (lastError: string) => ({ status: 'failed', lastError, attempts: 3 });
const copies = (excluding: string[]) => [...st.notes.values()].filter(n => !excluding.includes(n.id));
const keyring = (status: 'READY' | 'NONE' = 'READY') =>
  ({ status, epoch: EPOCH, rev: 1, kdf: 'argon2id', kdfParams: { m: 65536, t: 3, p: 1 }, pinSalt: 'x', rootKeyId: 'rk', offlineUnlock: false } as any);
const passthrough = async (...a: unknown[]) => (a[a.length - 1] as () => unknown)();
const zero = { hydrated: 0, conflictsResolved: 0, copies: 0, legacyResolved: 0, reactivated: 0, unresolved: 0, later: 0 };

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  st.queue = []; st.notes.clear(); st.nextId = 100; seq = 0; scan = true;
  lockLog.length = 0;
  installLocks();
  h.server = new FakeServer();
  const vk = await importVk(generateVkRaw());
  const keys: VaultKeys = { vkHkdf: vk.hkdf, vkAes: vk.aes, sigKey: (await generateSigKey()).privateKey };
  useVaultStore.setState({ byUser: { [U]: keyring() }, keys, unlockedUserId: U, epoch: EPOCH, isUnlocked: true });
  ctx = { keys, userId: U, epoch: EPOCH };
  mockDb.transaction.mockImplementation(passthrough);
  mockApi.get.mockResolvedValue({ data: [] });
  mockApi.post.mockResolvedValue({ data: {} });
  mockApi.put.mockResolvedValue({ data: {} });
  mockApi.delete.mockResolvedValue({ data: {} });
});

afterEach(() => {
  // I3: nessun plaintext marcato in Dexie o in coda dopo un giro
  if (scan) expect(JSON.stringify([...st.notes.values(), ...st.queue])).not.toMatch(/SEGRETO/);
  removeLocks();
});

// ---------------------------------------------------------------------------
// decide(): pura, un caso per ogni riga della tabella e per ogni precondizione
// ---------------------------------------------------------------------------
describe('decide: precondizioni nell\'ordine della spec', () => {
  const E2 = `nv3.${EPOCH}.AAAAAAAAAAAAAAAA.${'B'.repeat(22)}`;
  const dRow = (o: any = {}): any => ({
    id: 'n1', userId: U, notebookId: 'nb-1', title: '', content: E2, isTrashed: false, createdAt: T0, updatedAt: T0, tags: [], attachments: [],
    syncStatus: 'synced', isVault: true, isEncrypted: true, noteType: 'NOTE', vaultBaseHash: 'hb', ...o,
  });
  let n = 0;
  const dItem = (type: string, data: any = {}, extra: any = {}): any => ({ id: ++n, type, entity: 'NOTE', entityId: 'n1', userId: U, data, createdAt: 1, ...extra });
  const fl = (e: string) => ({ status: 'failed', lastError: e });
  const srvItem = (content = E2, extra: any = {}): any => ({
    k: 'item', item: { id: 'n1', noteType: 'NOTE', title: '', hasPlaintextVersions: false, content, contentHash: '', updatedAt: T1, isTrashed: false, ...extra },
  });
  const S0: any = { k: 'S0' };
  const P = { t: 'T', c: 'C' };
  const dec = (o: Partial<Snapshot>) => {
    const d = decide({ id: 'n1', userId: U, epoch: EPOCH, k: true, lock: 'held', items: [], srv: S0, ...o } as Snapshot);
    return `${d.rule}:${d.op}${d.copy ? `+${d.copy}` : ''}${d.why ? `(${d.why})` : ''}`;
  };

  it('P1 Z: riga di un altro utente o condivisa, o item di un altro utente: NONE, e vince su tutto', () => {
    expect(dec({ row: dRow({ userId: 'user-2' }), srv: srvItem() })).toBe('P1:NONE');
    expect(dec({ row: dRow({ ownership: 'shared' }), srv: srvItem() })).toBe('P1:NONE');
    expect(dec({ items: [dItem('UPDATE', {}, { userId: 'user-2' })] })).toBe('P1:NONE');
    expect(dec({ row: dRow({ userId: 'user-2' }), k: false, lock: 'busy' })).toBe('P1:NONE');
  });
  it('P2 K assente: SKIP del giro, prima del lock', () => {
    expect(dec({ row: dRow(), k: false, lock: 'busy' })).toBe('P2:SKIP');
  });
  it('P3 QD: una DELETE in coda -> NONE, prima del lock', () => {
    expect(dec({ row: dRow(), items: [dItem('DELETE')], lock: 'busy' })).toBe('P3:NONE');
  });
  it('P4 lock della nota non ottenuto: LATER, prima di S?', () => {
    expect(dec({ row: dRow(), lock: 'busy', srv: { k: 'unknown' } })).toBe('P4:LATER');
  });
  it('P5 locks assente: solo REQUEUE/ACK/finalize, il resto LATER', () => {
    const conflict = [dItem('UPDATE', { content: E2 }, fl('vault:conflict'))];
    expect(dec({ row: dRow(), lock: 'none', items: conflict, srv: srvItem(), hs: 'a', hl: 'b', P })).toBe('P5:LATER'); // sarebbe COPY+ADOPT
    expect(dec({ row: dRow(), lock: 'none', items: conflict, srv: srvItem(), hs: 'a', hl: 'a' })).toBe('T2:ACK');
    expect(dec({ row: dRow(), lock: 'none', items: conflict, srv: srvItem(), hs: 'hb', hl: 'b' })).toBe('T3:REQUEUE');
    expect(dec({ row: dRow(), lock: 'none', srv: srvItem(), hs: 'x' })).toBe('P5:LATER'); // sarebbe HYDRATE
  });
  it('P5 senza navigator.locks: ogni op consentita (NONE, SKIP, LATER, LEAVE, REQUEUE, ACK) passa, ogni altra diventa LATER', () => {
    const E1 = `nv3.${EPOCH - 1}.AAAAAAAAAAAAAAAA.${'B'.repeat(22)}`;
    const PLAIN = '{"type":"doc"}';
    const upd = dRow({ syncStatus: 'updated' });
    const vstale = [dItem('UPDATE', { content: E1 }, fl('vault:stale'))]; // content diverso dalla riga: ricifrata dopo il fallimento
    const conflict = [dItem('UPDATE', { content: E2 }, fl('vault:conflict'))];
    const none = { lock: 'none' } as const;
    // consentite: stessa decisione che si avrebbe con il lock
    expect(dec({ ...none, row: dRow({ vaultBaseHash: 'hs' }), srv: srvItem(), hs: 'hs', hl: 'hs' })).toBe('T1:NONE');
    expect(dec({ ...none, row: dRow(), k: false })).toBe('P2:SKIP');
    expect(dec({ ...none, row: dRow(), srv: { k: 'unknown' } })).toBe('P6:LATER');
    expect(dec({ ...none, row: upd, srv: srvItem(E1), hs: 'x', hl: 'y', P })).toBe('T8:LEAVE(epoch)');
    expect(dec({ ...none, row: upd, items: conflict, srv: srvItem(), hs: 'hb', hl: 'y' })).toBe('T3:REQUEUE');
    expect(dec({ ...none, row: upd, items: conflict, srv: srvItem(), hs: 'x', hl: 'x' })).toBe('T2:ACK');
    // negate: sarebbero scritture di contenuto o di item
    const create = dItem('CREATE', { id: 'n1', title: '', content: E2, isEncrypted: true, isVault: true, notebookId: 'nb-1' }, fl('vault:stale'));
    const denied: Array<[string, Partial<Snapshot>]> = [
      ['HYDRATE', { row: dRow(), srv: srvItem(), hs: 'x', hl: 'y' }],
      ['STRIP_REQUEUE', { row: upd, items: vstale, srv: srvItem(), hs: 'x', hl: 'y' }],
      ['QUEUE_CONTENT', { row: upd, srv: srvItem(), hs: 'hb', hl: 'y', P }],
      ['SYNC', { row: upd, srv: srvItem(), hs: 'x', hl: 'x' }],
      ['ADOPT', { row: upd, items: conflict, srv: srvItem(), hs: 'x', hl: 'y', P }],
      ['DROP', { row: dRow(), srv: { k: 'SN' } }],
      ['DROP_ITEMS', { items: vstale, srv: S0 }],
      ['UNVAULT', { row: dRow({ isVault: false, syncStatus: 'updated', content: PLAIN }), items: vstale, srv: { k: 'SN' } }],
      ['REFRESH_CREATE', { row: dRow({ syncStatus: 'created' }), items: [create], srv: S0 }],
      ['STRIP_CONTENT', { row: upd, items: [dItem('UPDATE', { content: PLAIN, isPinned: true }, fl('vault:plaintextRejected'))], srv: srvItem(), hs: 'x', hl: 'y', P }],
    ];
    for (const [op, o] of denied) {
      expect(dec({ ...o, lock: 'held' }), `${op} con il lock`).toMatch(new RegExp(`:${op}`));
      expect(dec({ ...o, ...none }), `${op} senza lock`).toBe('P5:LATER');
    }
  });
  it('P6 S?: LATER con una riga; con riga assente (T15) il server non serve', () => {
    expect(dec({ row: dRow(), srv: { k: 'unknown' } })).toBe('P6:LATER');
    expect(dec({ srv: { k: 'unknown' } })).toBe('T15:NONE');
  });
});

describe('decide: tabella T1-T15', () => {
  const E2 = `nv3.${EPOCH}.AAAAAAAAAAAAAAAA.${'B'.repeat(22)}`;
  const E1 = `nv3.${EPOCH - 1}.AAAAAAAAAAAAAAAA.${'B'.repeat(22)}`;
  const PLAIN = '{"type":"doc"}';
  const dRow = (o: any = {}): any => ({
    id: 'n1', userId: U, notebookId: 'nb-1', title: '', content: E2, isTrashed: false, createdAt: T0, updatedAt: T0, tags: [], attachments: [],
    syncStatus: 'synced', isVault: true, isEncrypted: true, noteType: 'NOTE', vaultBaseHash: 'hb', ...o,
  });
  const dirty = (o: any = {}) => dRow({ syncStatus: 'updated', ...o });
  let n = 0;
  const dItem = (type: string, data: any = {}, extra: any = {}): any => ({ id: ++n, type, entity: 'NOTE', entityId: 'n1', userId: U, data, createdAt: 1, ...extra });
  const fl = (e: string) => ({ status: 'failed', lastError: e });
  const srvItem = (content = E2, extra: any = {}): any => ({
    k: 'item', item: { id: 'n1', noteType: 'NOTE', title: '', hasPlaintextVersions: false, content, contentHash: '', updatedAt: T1, isTrashed: false, ...extra },
  });
  const SN: any = { k: 'SN' };
  const S0: any = { k: 'S0' };
  const P = { t: 'T', c: 'C' };
  const dec = (o: Partial<Snapshot>) => {
    const d = decide({ id: 'n1', userId: U, epoch: EPOCH, k: true, lock: 'held', items: [], srv: S0, ...o } as Snapshot);
    return `${d.rule}:${d.op}${d.copy ? `+${d.copy}` : ''}${d.why ? `(${d.why})` : ''}`;
  };

  it('T1 SE, LS/LV, Q0: Hs diverso dalla base -> HYDRATE; uguale -> NONE; riga non caricata -> HYDRATE', () => {
    expect(dec({ row: dRow(), srv: srvItem(), hs: 'hs', hl: 'hl' })).toBe('T1:HYDRATE');
    expect(dec({ row: dRow({ vaultBaseHash: 'hs' }), srv: srvItem(), hs: 'hs', hl: 'hs' })).toBe('T1:NONE');
    expect(dec({ row: dRow({ content: '' }), srv: srvItem(), hs: 'hs' })).toBe('T1:HYDRATE');
    expect(dec({ row: dRow({ vaultBaseHash: 'hs' }), items: [dItem('UPDATE', { isPinned: true })], srv: srvItem(), hs: 'hs', hl: 'hs' })).toBe('T1:NONE');
  });
  it('T2 SE, conflict, Hs==sha(L) o Hs fra gli inviati: ACK', () => {
    const items = [dItem('UPDATE', { content: E2 }, fl('vault:conflict'))];
    expect(dec({ row: dirty(), items, srv: srvItem(), hs: 'x', hl: 'x' })).toBe('T2:ACK');
    expect(dec({ row: dirty({ vaultSentHashes: ['a', 'x'] }), items, srv: srvItem(), hs: 'x', hl: 'y' })).toBe('T2:ACK');
  });
  it('T3 SE, conflict: Hs==base -> REQUEUE senza copie; altrimenti COPY(P)+ADOPT', () => {
    const items = [dItem('UPDATE', { content: E2 }, fl('vault:conflict'))];
    expect(dec({ row: dirty(), items, srv: srvItem(), hs: 'hb', hl: 'y', P })).toBe('T3:REQUEUE');
    expect(dec({ row: dirty(), items, srv: srvItem(), hs: 'x', hl: 'y', P })).toBe('T3:ADOPT+vault');
    expect(dec({ row: dirty(), items, srv: srvItem(), hs: 'x', hl: 'y', P: 'epoch' })).toBe('T3:LEAVE(epoch)');
  });
  it('T4 SE, LD, Q0: SYNC / QUEUE_CONTENT / NONE / COPY+ADOPT', () => {
    expect(dec({ row: dirty(), srv: srvItem(), hs: 'x', hl: 'x' })).toBe('T4:SYNC');
    expect(dec({ row: dirty(), srv: srvItem(), hs: 'hb', hl: 'y', P })).toBe('T4:QUEUE_CONTENT');
    expect(dec({ row: dirty(), items: [dItem('UPDATE', { content: E2 })], srv: srvItem(), hs: 'hb', hl: 'y', P })).toBe('T4:NONE');
    expect(dec({ row: dirty({ vaultSentHashes: ['x'] }), items: [dItem('UPDATE', { content: E2 })], srv: srvItem(), hs: 'x', hl: 'y', P })).toBe('T4:QUEUE_CONTENT');
    expect(dec({ row: dirty(), items: [dItem('UPDATE', { content: E2 })], srv: srvItem(), hs: 'x', hl: 'y', P })).toBe('T4:ADOPT+vault');
  });
  it('T5 SE, riga envelope corrente, errore vault non conflict o payload non pulito: STRIP+REQUEUE; epoch vecchio LEAVE; errore non vault NONE', () => {
    expect(dec({ row: dirty(), items: [dItem('UPDATE', { content: E1 }, fl('vault:stale'))], srv: srvItem(), hs: 'x', hl: 'y' })).toBe('T5:STRIP_REQUEUE');
    // stesso content che ha fallito e payload gia' canonico: niente ciclo push/reconcile
    expect(dec({ row: dirty(), items: [dItem('UPDATE', { content: E2 }, fl('vault:stale'))], srv: srvItem(), hs: 'x', hl: 'y' })).toBe('T5:LEAVE(unchanged)');
    expect(dec({ row: dirty(), items: [dItem('UPDATE', { content: E2 }, fl('vault:notReady'))], srv: srvItem(), hs: 'x', hl: 'y' })).toBe('T5:LEAVE(unchanged)');
    expect(dec({ row: dirty(), items: [dItem('UPDATE', { isPinned: true, isEncrypted: false })], srv: srvItem(), hs: 'x', hl: 'y' })).toBe('T5:STRIP_REQUEUE');
    expect(dec({ row: dirty(), items: [dItem('UPDATE', { isVault: false })], srv: srvItem(), hs: 'x', hl: 'y' })).toBe('T5:STRIP_REQUEUE');
    expect(dec({ row: dirty({ content: E1 }), items: [dItem('UPDATE', {}, fl('vault:stale'))], srv: srvItem(), hs: 'x', hl: 'y' })).toBe('T5:LEAVE(epoch)');
    expect(dec({ row: dirty(), items: [dItem('UPDATE', {}, fl('validation'))], srv: srvItem(), hs: 'x', hl: 'y' })).toBe('Qf:NONE');
  });
  it('T6 SE, LP: ADOPT se P==server; REENCRYPT con il titolo degli item; STRIP del content stantio; altrimenti COPY+ADOPT; PIN vecchio LEAVE', () => {
    const upd = [dItem('UPDATE', { title: 'T', content: PLAIN }, fl('vault:plaintextRejected'))];
    const plainRow = dirty({ content: PLAIN, title: 'T', isEncrypted: false });
    expect(dec({ row: plainRow, items: upd, srv: srvItem(), hs: 'x', same: true })).toBe('T6:ADOPT');
    expect(dec({ row: plainRow, items: upd, srv: srvItem(), hs: 'x', P })).toBe('T6:ADOPT+vault');
    expect(dec({ row: plainRow, items: upd, srv: srvItem(), hs: 'x', P: 'legacyPin' })).toBe('T6:LEAVE(legacyPin)');
    expect(dec({ row: dirty(), items: [dItem('UPDATE', { title: 'Nuovo' }, fl('validation'))], srv: srvItem(), hs: 'x', hl: 'y', P })).toBe('T6:REENCRYPT_TITLE');
    expect(dec({ row: dirty(), items: [dItem('UPDATE', { content: PLAIN, isPinned: true }, fl('vault:plaintextRejected'))], srv: srvItem(), hs: 'x', hl: 'y', P })).toBe('T6:STRIP_CONTENT');
    expect(dec({ row: dirty({ title: 'Titolo' }), srv: srvItem(), hs: 'x', hl: 'y', P })).toBe('T6:ADOPT+vault');
  });
  it('T7 SL: P==server -> ADOPT (NONE se gia\' uguale e pulita); P diverso COPY+ADOPT; riga envelope: niente da adottare', () => {
    const upd = [dItem('UPDATE', { content: PLAIN }, fl('vault:plaintextRejected'))];
    const plainRow = dirty({ content: PLAIN, isEncrypted: false });
    expect(dec({ row: plainRow, items: upd, srv: srvItem(PLAIN), hs: 'x', same: true })).toBe('T7:ADOPT');
    expect(dec({ row: dRow({ content: PLAIN, isEncrypted: false }), srv: srvItem(PLAIN), hs: 'x', same: true })).toBe('T7:NONE');
    expect(dec({ row: plainRow, items: upd, srv: srvItem('altro'), hs: 'x', P })).toBe('T7:ADOPT+vault');
    expect(dec({ row: plainRow, items: upd, srv: srvItem('altro'), hs: 'x', P: 'legacyPin' })).toBe('T7:LEAVE(legacyPin)');
    expect(dec({ row: dRow(), srv: srvItem(PLAIN), hs: 'x', hl: 'y' })).toBe('T7:NONE');
    expect(dec({ row: dirty(), srv: srvItem(PLAIN), hs: 'x', hl: 'y', P })).toBe('T7:LEAVE(legacyLeft)');
  });
  it('T8 SX: LEAVE(epoch), la gestisce P3', () => {
    expect(dec({ row: dirty(), srv: srvItem(E1), hs: 'x', hl: 'y', P })).toBe('T8:LEAVE(epoch)');
  });
  it('T9 S0, U, con CREATE: REENCRYPT su LP; NONE se gia\' canonica; altrimenti REFRESH+REQUEUE', () => {
    const create = (extra: any = {}, data: any = {}) => dItem('CREATE', { id: 'n1', title: '', content: E2, isEncrypted: true, isVault: true, notebookId: 'nb-1', ...data }, extra);
    const legacyRow = dirty({ syncStatus: 'created', content: PLAIN, title: 'T', isEncrypted: false });
    expect(dec({ row: legacyRow, items: [create({}, { title: 'T', content: PLAIN })], srv: S0, P })).toBe('T9:REENCRYPT_CREATE');
    expect(dec({ row: legacyRow, items: [create({}, { title: 'T', content: PLAIN })], srv: S0, P: 'legacyPin' })).toBe('T9:LEAVE(legacyPin)');
    expect(dec({ row: dirty({ syncStatus: 'created' }), items: [create()], srv: S0 })).toBe('T9:NONE');
    expect(dec({ row: dirty({ syncStatus: 'created' }), items: [create(fl('vault:stale'))], srv: S0 })).toBe('T9:REFRESH_CREATE');
    expect(dec({ row: dirty({ syncStatus: 'created' }), items: [create({}, { title: undefined })], srv: S0 })).toBe('T9:REFRESH_CREATE');
    expect(dec({ row: dirty({ syncStatus: 'created', content: E1 }), items: [create()], srv: S0 })).toBe('T9:LEAVE(epoch)');
  });
  it('T10 S0, U, senza CREATE: COPY(P)+DROP; S0 senza U: DROP', () => {
    expect(dec({ row: dirty(), items: [dItem('UPDATE', { content: E2 })], srv: S0, P })).toBe('T10:DROP+vault');
    expect(dec({ row: dirty(), srv: S0 })).toBe('T10:DROP');
    expect(dec({ row: dRow(), srv: S0 })).toBe('T10:DROP');
  });
  it('T11 SN, riga vault: con U COPY(P)+DROP, senza U DROP', () => {
    expect(dec({ row: dirty(), srv: SN, P })).toBe('T11:DROP+vault');
    expect(dec({ row: dRow(), srv: SN })).toBe('T11:DROP');
  });
  it('T12 LN+SE: copia nel vault e adozione (LNp solo con U, LNe sempre)', () => {
    expect(dec({ row: dirty({ isVault: false, content: PLAIN }), srv: srvItem(), P })).toBe('T12:ADOPT+vault');
    expect(dec({ row: dRow({ isVault: false, content: PLAIN }), srv: srvItem() })).toBe('T12:ADOPT');
    expect(dec({ row: dRow({ isVault: false }), srv: srvItem(), P })).toBe('T12:ADOPT+vault');
  });
  it('T13 LN+SN e LN+S0', () => {
    const vf = [dItem('UPDATE', { isVault: true, content: PLAIN }, fl('vault:plaintextRequired'))];
    const lnp = dirty({ isVault: false, content: PLAIN });
    const lne = dirty({ isVault: false });
    expect(dec({ row: lnp, items: vf, srv: SN })).toBe('T13:UNVAULT');
    expect(dec({ row: lnp, srv: SN })).toBe('T13:NONE');
    expect(dec({ row: lne, items: vf, srv: SN, P })).toBe('T13:DROP+vault');
    expect(dec({ row: lnp, items: vf, srv: S0, P })).toBe('T13:DROP+plain');
    expect(dec({ row: lne, items: vf, srv: S0, P })).toBe('T13:DROP+vault');
    expect(dec({ row: dRow({ isVault: false, content: PLAIN }), srv: S0 })).toBe('T13:DROP');
  });
  it('T14 LN+SL e LN+SX: LEAVE; LN in tutte le combinazioni LNp/LNe x SN/S0/SL/SX non esce mai da una regola T12-T14', () => {
    expect(dec({ row: dirty({ isVault: false, content: PLAIN }), srv: srvItem(PLAIN), P })).toBe('T14:LEAVE(legacyLeft)');
    expect(dec({ row: dirty({ isVault: false }), srv: srvItem(PLAIN), P })).toBe('T14:LEAVE(legacyLeft)');
    expect(dec({ row: dirty({ isVault: false, content: PLAIN }), srv: srvItem(E1), P })).toBe('T14:LEAVE(epoch)');
    expect(dec({ row: dirty({ isVault: false }), srv: srvItem(E1), P })).toBe('T14:LEAVE(epoch)');
    const vf = [dItem('UPDATE', { content: PLAIN }, fl('vault:stale'))];
    for (const row of [dirty({ isVault: false, content: PLAIN }), dirty({ isVault: false })]) {
      for (const srv of [SN, S0, srvItem(PLAIN), srvItem(E1), srvItem(E2)]) {
        const d = dec({ row, items: vf, srv, P });
        expect(d).toMatch(/^T1[234]:/);
      }
    }
  });
  it('T15 riga assente: NONE senza item; con item vault:* DROP degli item, con la copia se hanno contenuto', () => {
    expect(dec({ srv: S0 })).toBe('T15:NONE');
    const vf = [dItem('CREATE', { content: E2 }, fl('vault:stale'))];
    expect(dec({ items: vf, srv: S0, P })).toBe('T15:DROP_ITEMS+vault');
    expect(dec({ items: vf, srv: SN })).toBe('T15:DROP_ITEMS');
    expect(dec({ items: vf, srv: S0, P: 'decrypt' })).toBe('T15:LEAVE(decrypt)');
    expect(dec({ items: [dItem('UPDATE', { isPinned: true }, fl('validation'))], srv: S0 })).toBe('T15:NONE');
  });
});

// ---------------------------------------------------------------------------
describe('T1 idratazione', () => {
  it('aggiorna le righe synced, non tocca le dirty in pari con la base ne\' quelle col lock tenuto altrove, non crea righe assenti; paginata', async () => {
    h.server.pageSize = 2;
    const old = await enc('a', 'old', doc('old'));
    for (const id of ['a', 'b', 'c', 'd', 'e']) h.server.put(id, await enc(id, `srv-${id}`, doc(id)));
    putRow({ id: 'a', content: old, vaultBaseHash: await sha256hex(old) });
    const locB = await enc('b', 'loc', doc('loc-b'));
    putRow({ id: 'b', content: locB, syncStatus: 'updated', vaultBaseHash: await sha256hex(h.server.items.get('b').content) });
    item('UPDATE', 'b', { content: locB });
    putRow({ id: 'c', content: await enc('c', 'old', doc('c-old')), vaultBaseHash: 'x' });
    putRow({ id: 'e', content: h.server.items.get('e').content, vaultBaseHash: await sha256hex(h.server.items.get('e').content) });
    const cOld = st.notes.get('c').content;
    const other = hold(noteLockName('c')); // un'altra scheda ha la nota aperta

    const r = await vaultReconcile();
    other.release();
    await other.done;

    expect(r.hydrated).toBe(1);
    expect(r.later).toBe(1);
    expect(st.notes.get('a').content).toBe(h.server.items.get('a').content);
    expect(st.notes.get('a').vaultBaseHash).toBe(await sha256hex(h.server.items.get('a').content));
    expect(st.notes.get('b').content).toBe(locB);
    expect(st.notes.get('c').content).toBe(cOld);
    expect(st.notes.has('d')).toBe(false);
    expect(st.notes.get('e').updatedAt).toBe(T0); // stesso hash: nessuna scrittura

    // rilasciato il lock, il giro dopo la idrata
    expect((await vaultReconcile()).hydrated).toBe(1);
    expect(st.notes.get('c').content).toBe(h.server.items.get('c').content);
  });

  it('riga con content "" (non caricato) viene riempita da hydrateVaultNote, che lavora su un solo id e solo sulle righe synced o vuote', async () => {
    const s = await enc('a', 'srv', doc('srv'));
    h.server.put('a', s);
    putRow({ id: 'a', content: '', syncStatus: 'updated' });

    expect(await hydrateVaultNote('a')).toBe(true);
    expect(st.notes.get('a').content).toBe(s);
    expect(h.server.idsCalls).toEqual([['a']]);

    const mine = await enc('a', 'mia', doc('mia'));
    putRow({ id: 'a', content: mine, syncStatus: 'updated', vaultBaseHash: 'x' });
    expect(await hydrateVaultNote('a')).toBe(false);
    expect(st.notes.get('a').content).toBe(mine);
  });

  it('hydrateVaultNote: una push che chiude fra la GET e la transazione (base/stato cambiati) non viene sovrascritta con l envelope vecchio', async () => {
    const old = await enc('a', 'old', doc('old'));
    h.server.put('a', await enc('a', 'srv', doc('srv')));
    putRow({ id: 'a', content: old, vaultBaseHash: await sha256hex(old) });
    const orig = h.server.getItems.bind(h.server);
    vi.spyOn(h.server, 'getItems').mockImplementation(async (b: any) => {
      const res = await orig(b);
      const pushed = await enc('a', 'push', doc('push'));
      st.notes.set('a', { ...st.notes.get('a'), content: pushed, vaultBaseHash: await sha256hex(pushed), updatedAt: T1 });
      return res;
    });

    expect(await hydrateVaultNote('a')).toBe(false);
    expect(await decryptItem('a', 'NOTE', st.notes.get('a').content, ctx)).toEqual({ t: 'push', c: doc('push') });
  });

  it('un content del server che non e envelope (vault legacy) non entra in Dexie', async () => {
    const old = await enc('a', 'old', doc('old'));
    h.server.put('a', doc('PLAIN-DAL-SERVER'));
    putRow({ id: 'a', content: old, vaultBaseHash: await sha256hex(old) });

    const r = await vaultReconcile();

    expect(r.hydrated).toBe(0);
    expect(st.notes.get('a').content).toBe(old);
    expect(await hydrateVaultNote('a')).toBe(false);
    expect(r.legacyLeft).toBe(1);
  });

  it('hydrateVaultNote non idrata mai una riga non vault (LN): resta com\'e, la risolve T12 nel giro', async () => {
    const s = await enc('a', 'srv', doc('srv'));
    h.server.put('a', s);
    putRow({ id: 'a', isVault: false, isEncrypted: false, title: 'Normale', content: '', syncStatus: 'synced' });
    const before = JSON.stringify(st.notes.get('a'));

    expect(await hydrateVaultNote('a')).toBe(false);
    expect(JSON.stringify(st.notes.get('a'))).toBe(before);
  });

  it('hydrateVaultNote usa l\'epoch corrente: un envelope di un altro epoch non entra in Dexie', async () => {
    const old = await enc('a', 'old', doc('old'));
    h.server.put('a', `nv3.${EPOCH - 1}.AAAAAAAAAAAAAAAA.${'B'.repeat(22)}`);
    putRow({ id: 'a', content: old, vaultBaseHash: 'x' });

    expect(await hydrateVaultNote('a')).toBe(false);
    expect(st.notes.get('a').content).toBe(old);
  });
});

// ---------------------------------------------------------------------------
describe('T2-T4 conflitti', () => {
  it('2 vault:conflict della stessa nota -> 1 sola copia (id casuale); la riga prende il server; gli item si ripuliscono; secondo giro a zero (I5)', async () => {
    const local = await enc('n1', 'Titolo', doc('mio testo'));
    const srv = await enc('n1', 'Titolo', doc('testo altrui'));
    h.server.put('n1', srv);
    putRow({ id: 'n1', content: local, syncStatus: 'updated', vaultBaseHash: 'old', vaultSentHashes: [await sha256hex(local)] });
    const i1 = item('UPDATE', 'n1', { content: local }, failed('vault:conflict'));
    const i2 = item('UPDATE', 'n1', { content: local, isPinned: true }, failed('vault:conflict'));
    const i3 = item('UPDATE', 'n1', { isPinned: false });

    const r = await vaultReconcile();

    expect(r.copies).toBe(1);
    expect(r.conflictsResolved).toBe(1);
    const [copy, ...more] = copies(['n1']);
    expect(more).toHaveLength(0);
    expect(copy.id).toMatch(UUID_RE);
    expect(copy.isVault && copy.isEncrypted && copy.title === '' && copy.syncStatus === 'created').toBe(true);
    expect(await decryptItem(copy.id, 'NOTE', copy.content, ctx)).toEqual({ t: 'Titolo (conflict)', c: doc('mio testo') });
    expect(st.queue.filter(i => i.type === 'CREATE' && i.entityId === copy.id)).toHaveLength(1);
    expect(st.queue.find(i => i.type === 'CREATE').data).toMatchObject({ title: '', content: copy.content, isVault: true, isEncrypted: true, noteType: 'NOTE' });

    const row = st.notes.get('n1');
    expect(row).toMatchObject({ content: srv, vaultBaseHash: await sha256hex(srv), syncStatus: 'synced' });
    expect(row.vaultSentHashes).toEqual([]);
    expect(st.queue.find(i => i.id === i1.id)).toBeUndefined();
    expect(st.queue.find(i => i.id === i2.id)).toMatchObject({ data: { isPinned: true }, status: 'pending' });
    expect(st.queue.find(i => i.id === i2.id).lastError).toBeUndefined();
    expect(st.queue.find(i => i.id === i3.id).data).toEqual({ isPinned: false });

    // I5: il giro dopo non trova niente da fare (nemmeno sulla copia, CREATE gia' canonica)
    const r2 = await vaultReconcile();
    expect(r2).toMatchObject(zero);
    expect(copies(['n1'])).toHaveLength(1);
  });

  it('T3 con Hs==base: la PUT era partita con una base vecchia, nessuna copia, item di nuovo pending', async () => {
    const local = await enc('n1', 'T', doc('mio'));
    const srv = await enc('n1', 'T', doc('server'));
    h.server.put('n1', srv);
    putRow({ id: 'n1', content: local, syncStatus: 'updated', vaultBaseHash: await sha256hex(srv) });
    const it = item('UPDATE', 'n1', { content: local }, failed('vault:conflict'));

    const r = await vaultReconcile();

    expect(r.copies).toBe(0);
    expect(r.conflictsResolved).toBe(1);
    expect(copies(['n1'])).toHaveLength(0);
    expect(st.queue.find(i => i.id === it.id)).toMatchObject({ status: 'pending', attempts: 0, data: { content: local } });
    expect(st.notes.get('n1')).toMatchObject({ content: local, syncStatus: 'updated' });
  });

  it('T2 risposta persa: il server ha gia\' i byte inviati -> nessuna copia, base aggiornata, item di nuovo pending', async () => {
    const v1 = await enc('n1', 'T', doc('v1'));
    const v2 = await enc('n1', 'T', doc('v2'));
    h.server.put('n1', v1);
    putRow({ id: 'n1', content: v2, syncStatus: 'updated', vaultBaseHash: await sha256hex('v0'), vaultSentHashes: [await sha256hex(v1)] });
    const it = item('UPDATE', 'n1', { content: v2 }, failed('vault:conflict'));

    const r = await vaultReconcile();

    expect(copies(['n1'])).toHaveLength(0);
    expect(r.copies).toBe(0);
    expect(r.conflictsResolved).toBe(1);
    expect(st.notes.get('n1')).toMatchObject({ content: v2, vaultBaseHash: await sha256hex(v1), syncStatus: 'updated' });
    expect(st.queue.find(i => i.id === it.id)).toMatchObject({ status: 'pending', data: { content: v2 } });
    expect(st.queue.find(i => i.id === it.id).lastError).toBeUndefined();

    await syncPush();
    expect(mockApi.put).toHaveBeenCalledWith('/notes/n1', { content: v2, baseHash: await sha256hex(v1) });
  });

  it('T2 sul percorso reale della push: v1 applicata ma risposta persa, modifica a v2, 422 conflict -> nessuna copia', async () => {
    const v0 = await enc('n1', 'T', doc('v0'));
    const v1 = await enc('n1', 'T', doc('v1'));
    const v2 = await enc('n1', 'T', doc('v2'));
    h.server.put('n1', v0);
    putRow({ id: 'n1', content: v1, syncStatus: 'updated', vaultBaseHash: await sha256hex(v0) });
    item('UPDATE', 'n1', { content: v1 });
    let lostResponse = true;
    mockApi.put.mockImplementation(async (_url: string, body: any) => {
      if (lostResponse) {
        h.server.put('n1', body.content); // il server applica...
        throw new Error('Network Error'); // ...ma la risposta non arriva
      }
      if ((await sha256hex(h.server.items.get('n1').content)) !== body.baseHash) {
        throw Object.assign(new Error('conflict'), { response: { status: 422, data: { message: 'errors.vault.conflict' } } });
      }
      h.server.put('n1', body.content);
      return { data: {} };
    });

    await syncPush();
    expect(st.notes.get('n1').vaultSentHashes).toEqual([await sha256hex(v1)]);
    st.notes.set('n1', { ...st.notes.get('n1'), content: v2 }); // modifica offline a v2
    lostResponse = false;
    await syncPush();
    expect(st.queue.find(i => i.entityId === 'n1')).toMatchObject({ status: 'failed', lastError: 'vault:conflict' });
    expect(st.notes.get('n1').vaultSentHashes).toEqual([await sha256hex(v1), await sha256hex(v2)]);

    const r = await vaultReconcile();

    expect(copies(['n1'])).toHaveLength(0);
    expect(r.copies).toBe(0);
    expect(st.notes.get('n1')).toMatchObject({ content: v2, vaultBaseHash: await sha256hex(v1) });
    expect(st.queue.find(i => i.entityId === 'n1')).toMatchObject({ status: 'pending' });

    mockApi.put.mockClear();
    await syncPush();
    expect(mockApi.put).toHaveBeenCalledWith('/notes/n1', { content: v2, baseHash: await sha256hex(v1) });
  });

  it('sentHash anche per la CREATE: la POST fallita per rete lascia l\'hash inviato sulla riga', async () => {
    const content = await enc('n1', 'T', doc('x'));
    putRow({ id: 'n1', content, syncStatus: 'created' });
    item('CREATE', 'n1', { id: 'n1', title: '', content, notebookId: 'nb-1', isVault: true, isEncrypted: true, noteType: 'NOTE' });
    mockApi.post.mockRejectedValue(new Error('Network Error'));

    await syncPush();

    expect(st.notes.get('n1').vaultSentHashes).toEqual([await sha256hex(content)]);
  });

  it('T10 nota sparita dal server: copia + cancellazione di riga e coda', async () => {
    const local = await enc('n1', 'T', doc('solo mio'));
    putRow({ id: 'n1', content: local, syncStatus: 'updated' });
    item('UPDATE', 'n1', { content: local }, failed('vault:conflict'));

    await vaultReconcile();

    expect(st.notes.has('n1')).toBe(false);
    const [copy] = copies([]);
    expect(await decryptItem(copy.id, 'NOTE', copy.content, ctx)).toEqual({ t: 'T (conflict)', c: doc('solo mio') });
    expect(st.queue.filter(i => i.entityId === 'n1')).toHaveLength(0);
    expect(st.queue.filter(i => i.entityId === copy.id)).toHaveLength(1);
  });

  it('server non raggiungibile per i candidati assenti dal listing (S?): LATER, riga e coda intatte', async () => {
    const local = await enc('n1', 'T', doc('mio'));
    putRow({ id: 'n1', content: local, syncStatus: 'updated' });
    const it = item('UPDATE', 'n1', { content: local }, failed('vault:conflict'));
    h.server.failIds = true;

    const r = await vaultReconcile();

    expect(r.later).toBe(1);
    expect(st.notes.get('n1').content).toBe(local);
    expect(st.queue.find(i => i.id === it.id)).toMatchObject({ status: 'failed', lastError: 'vault:conflict' });
  });
});

// ---------------------------------------------------------------------------
describe('lock: due schede', () => {
  const conflict = async () => {
    const local = await enc('n1', 'T', doc('mio'));
    h.server.put('n1', await enc('n1', 'T', doc('altrui')));
    putRow({ id: 'n1', content: local, syncStatus: 'updated' });
    const it = item('UPDATE', 'n1', { content: local }, failed('vault:conflict'));
    return { local, it };
  };

  it('il lock della nota e\' tenuto altrove: busy (later), riga e coda intatte; rilasciato, il giro dopo risolve', async () => {
    const { local, it } = await conflict();
    const other = hold(noteLockName('n1'));

    const r1 = await vaultReconcile();
    expect(r1).toMatchObject({ later: 1, unresolved: 1, copies: 0 });
    expect(st.notes.get('n1').content).toBe(local);
    expect(st.queue.find(i => i.id === it.id)).toMatchObject({ status: 'failed', lastError: 'vault:conflict' });

    other.release();
    await other.done;
    const r2 = await vaultReconcile();
    expect(r2.copies).toBe(1);
    expect(r2.later).toBe(0);
  });

  it('lo stato dell\'item cambiato fra decide e commit -> LATER: nessuna copia, riga intatta; il giro dopo copia una volta sola', async () => {
    const { local } = await conflict();
    mockDb.transaction.mockImplementation(async (...a: unknown[]) => {
      st.queue = st.queue.map(i => ({ ...i, status: 'pending', lastError: undefined })); // un'altra scheda ha riprovato l'item
      return passthrough(...a);
    });
    const r1 = await vaultReconcile();
    mockDb.transaction.mockImplementation(passthrough);

    expect(r1.later).toBe(1);
    expect(copies(['n1'])).toHaveLength(0);
    expect(st.notes.get('n1').content).toBe(local);

    const r2 = await vaultReconcile();
    expect(r2.copies).toBe(1);
    expect(copies(['n1'])).toHaveLength(1);
  });

  it('il lock del giro e\' in attesa: un altro giro tiene il lock, il nostro aspetta e poi parte', async () => {
    h.server.put('a', await enc('a', 'T', doc('x')));
    const other = hold(RECONCILE_LOCK);
    let done = false;
    const p = vaultReconcile().then(r => { done = true; return r; });
    await tick();
    await tick();
    expect(done).toBe(false);
    expect(h.server.idsCalls).toHaveLength(0);

    other.release();
    await other.done;
    const r = await p;
    expect(r.skipped).toBeUndefined();
  });

  it('decryptLegacy con signal: l\'attesa del lock del giro si interrompe -> skipped busy; poi il giro parte', async () => {
    putRow({ id: 'c1', noteType: 'CREDENTIAL', content: 'U2FsdGVkX1-legacy', syncStatus: 'created', isEncrypted: false });
    item('CREATE', 'c1', { id: 'c1', title: '', content: 'U2FsdGVkX1-legacy', notebookId: 'nb-1', isVault: true, noteType: 'CREDENTIAL' }, failed('vault:plaintextRejected'));
    const other = hold(RECONCILE_LOCK);
    const ac = new AbortController();
    const decryptLegacy = vi.fn(async () => JSON.stringify({ username: 'bob' }));

    const p = vaultReconcile({ decryptLegacy, signal: ac.signal });
    await tick();
    ac.abort();
    const r1 = await p;
    expect(r1.skipped).toBe('busy');
    expect(decryptLegacy).not.toHaveBeenCalled();

    other.release();
    await other.done;
    const r2 = await vaultReconcile({ decryptLegacy });
    expect(r2.legacyResolved).toBe(1);
    expect(await decryptItem('c1', 'CREDENTIAL', st.notes.get('c1').content, ctx)).toEqual({ t: '', c: JSON.stringify({ username: 'bob' }) });
  });

  it('abort di una chiamata in coda: quel chiamante riceve busy subito, il giro in coda continua per gli altri', async () => {
    h.server.put('a', await enc('a', 'T', doc('x')));
    const other = hold(RECONCILE_LOCK);
    const p1 = vaultReconcile(); // in volo, in attesa del lock del giro
    await tick();
    const ac = new AbortController();
    const decryptLegacy = vi.fn(async () => null);
    const p2 = vaultReconcile({ decryptLegacy, signal: ac.signal }); // in coda
    const p3 = vaultReconcile(); // collassa nel giro in coda
    await tick();
    ac.abort();
    expect(await p2).toMatchObject({ ...zero, skipped: 'busy' });
    expect((await vaultReconcile({ signal: ac.signal })).skipped).toBe('busy'); // signal gia' abortito

    other.release();
    await other.done;
    expect((await p1).skipped).toBeUndefined();
    expect((await p3).skipped).toBeUndefined(); // il giro in coda non e' stato interrotto
  });

  it('senza navigator.locks: ACK e REQUEUE si fanno, la copia (che sostituisce la riga) viene rinviata', async () => {
    removeLocks();
    const v1 = await enc('n1', 'T', doc('v1'));
    const v2 = await enc('n1', 'T', doc('v2'));
    h.server.put('n1', v1);
    putRow({ id: 'n1', content: v2, syncStatus: 'updated', vaultBaseHash: 'b', vaultSentHashes: [await sha256hex(v1)] });
    item('UPDATE', 'n1', { content: v2 }, failed('vault:conflict'));
    expect((await vaultReconcile()).conflictsResolved).toBe(1);
    expect(st.notes.get('n1').vaultBaseHash).toBe(await sha256hex(v1));

    const local = await enc('n2', 'T', doc('mio'));
    h.server.put('n2', await enc('n2', 'T', doc('altrui')));
    putRow({ id: 'n2', content: local, syncStatus: 'updated', vaultBaseHash: 'old' });
    item('UPDATE', 'n2', { content: local }, failed('vault:conflict'));
    const r = await vaultReconcile();
    expect(r).toMatchObject({ later: 1, copies: 0 });
    expect(st.notes.get('n2').content).toBe(local);
  });
});

// ---------------------------------------------------------------------------
describe('T5 item bloccati su errori vault', () => {
  it('riga ricifrata con l\'epoch corrente -> item riattivati e la push successiva parte', async () => {
    const content = await enc('n1', 'T', doc('x'));
    h.server.put('n1', content);
    putRow({ id: 'n1', content, syncStatus: 'updated', vaultBaseHash: await sha256hex('v0') });
    const a = item('UPDATE', 'n1', { content: await enc('n1', 'T', doc('old')) }, failed('vault:stale')); // la riga e' stata ricifrata dopo il fallimento
    const b = item('UPDATE', 'n1', { isPinned: true }, failed('vault:notReady'));
    item('UPDATE', 'n1', { isPinned: false });

    await syncPush();
    expect(mockApi.put).not.toHaveBeenCalled(); // prima: bloccata

    const r = await vaultReconcile();
    expect(r.reactivated).toBe(2);
    for (const it of [a, b]) {
      expect(st.queue.find(i => i.id === it.id)).toMatchObject({ status: 'pending', attempts: 0 });
      expect(st.queue.find(i => i.id === it.id).lastError).toBeUndefined();
    }

    await syncPush();
    expect(mockApi.put).toHaveBeenCalledWith('/notes/n1', expect.objectContaining({ content, baseHash: await sha256hex('v0') }));
    // la riga e' dirty ma pari al server (push senza marcatura): T4 SYNC la chiude, poi tutto a zero
    expect(await vaultReconcile()).toMatchObject({ copies: 0, unresolved: 0, later: 0 });
    expect(await vaultReconcile()).toMatchObject(zero);
  });

  it('item vault:notReady con payload gia canonico e content uguale a quello della riga: non si riattiva al secondo giro (niente ciclo push/reconcile)', async () => {
    const content = await enc('n1', 'T', doc('x'));
    h.server.put('n1', content);
    putRow({ id: 'n1', content, syncStatus: 'updated', vaultBaseHash: await sha256hex('v0') });
    const a = item('UPDATE', 'n1', { content: await enc('n1', 'T', doc('old')) }, failed('vault:notReady'));

    expect((await vaultReconcile()).reactivated).toBe(1);
    // la push riparte e fallisce uguale, con il content della riga
    st.queue = st.queue.map(i => (i.id === a.id ? { ...i, ...failed('vault:notReady'), data: { content } } : i));

    const r = await vaultReconcile();
    expect(r.reactivated).toBe(0);
    expect(r.unresolved).toBe(1);
    expect(st.queue.find(i => i.id === a.id)).toMatchObject({ status: 'failed', lastError: 'vault:notReady' });
  });

  it('riga con envelope di un epoch vecchio, o keyring non READY: gli item restano', async () => {
    const oldEpoch = `nv3.${EPOCH - 1}.AAAAAAAAAAAAAAAA.${'B'.repeat(22)}`;
    putRow({ id: 'n1', content: oldEpoch, syncStatus: 'updated' });
    const a = item('UPDATE', 'n1', { content: oldEpoch }, failed('vault:stale'));

    const r0 = await vaultReconcile();
    expect(r0.reactivated).toBe(0);
    expect(r0.unresolved).toBe(1);
    expect(st.queue.find(i => i.id === a.id)).toMatchObject({ status: 'failed', lastError: 'vault:stale' });

    const content = await enc('n2', 'T', doc('x'));
    putRow({ id: 'n2', content, syncStatus: 'updated' });
    const b = item('UPDATE', 'n2', { content }, failed('vault:notReady'));
    useVaultStore.setState({ byUser: { [U]: keyring('NONE') } });

    const r = await vaultReconcile();
    expect(r.skipped).toBe('notReady');
    expect(st.queue.find(i => i.id === b.id)).toMatchObject({ status: 'failed', lastError: 'vault:notReady' });
  });

  it('riattiva anche plaintextRequired / attachmentsBlocked se la riga e envelope corrente e il payload e pulito', async () => {
    const content = await enc('n1', 'T', doc('x'));
    h.server.put('n1', content);
    putRow({ id: 'n1', content, syncStatus: 'updated', vaultBaseHash: await sha256hex(content) });
    const a = item('UPDATE', 'n1', { content }, failed('vault:plaintextRequired'));
    const b = item('UPDATE', 'n1', { isPinned: true }, failed('vault:attachmentsBlocked'));

    const r = await vaultReconcile();

    expect(r.reactivated).toBe(2);
    for (const x of [a, b]) expect(st.queue.find(i => i.id === x.id)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('sostituisce il vecchio test 765: il payload non pulito (isVault in un UPDATE, isEncrypted false) si ripulisce e si riaccoda, non si rifiuta', async () => {
    const content = await enc('n1', 'T', doc('x'));
    h.server.put('n1', content);
    putRow({ id: 'n1', content, syncStatus: 'updated', vaultBaseHash: await sha256hex(content) });
    const bad1 = item('UPDATE', 'n1', { isVault: false }, failed('vault:stale'));
    const bad2 = item('UPDATE', 'n1', { isPinned: true, isEncrypted: false }, failed('vault:stale'));
    const ok = item('UPDATE', 'n1', { isPinned: true }, failed('vault:stale'));

    const r = await vaultReconcile();

    expect(r.reactivated).toBe(3);
    expect(st.queue.find(i => i.id === bad1.id)).toBeUndefined(); // restava vuoto
    expect(st.queue.find(i => i.id === bad2.id)).toMatchObject({ status: 'pending', data: { isPinned: true } });
    expect(st.queue.find(i => i.id === ok.id)).toMatchObject({ status: 'pending' });
  });

  it('errore non vault (validation) su riga envelope: non e\' del reconcile, item intatto', async () => {
    const content = await enc('n1', 'T', doc('x'));
    h.server.put('n1', content);
    putRow({ id: 'n1', content, syncStatus: 'updated', vaultBaseHash: await sha256hex(content) });
    const it = item('UPDATE', 'n1', { isPinned: true }, failed('validation'));

    const r = await vaultReconcile();

    expect(r).toMatchObject(zero);
    expect(st.queue.find(i => i.id === it.id)).toMatchObject({ status: 'failed', lastError: 'validation' });
  });
});

// ---------------------------------------------------------------------------
describe('T6-T9 righe e item legacy', () => {
  it('T6 item solo-titolo su riga envelope: ri-cifratura sul posto col titolo nuovo, UPDATE{content} accodato, nessuna copia; secondo giro a zero', async () => {
    const content = await enc('n1', '', doc('corpo'));
    h.server.put('n1', content);
    const base = await sha256hex(content);
    putRow({ id: 'n1', content, syncStatus: 'synced', vaultBaseHash: base });
    const it = item('UPDATE', 'n1', { title: 'Titolo legacy' }, failed('validation'));

    const r = await vaultReconcile();

    expect(r.legacyResolved).toBe(1);
    expect(r.copies).toBe(0);
    expect(copies(['n1'])).toHaveLength(0);
    const row = st.notes.get('n1');
    expect(row).toMatchObject({ title: '', syncStatus: 'updated', vaultBaseHash: base });
    expect(row.content).not.toBe(content);
    expect(await decryptItem('n1', 'NOTE', row.content, ctx)).toEqual({ t: 'Titolo legacy', c: doc('corpo') });
    expect(st.queue.find(i => i.id === it.id)).toBeUndefined();
    const upd = st.queue.filter(i => i.entityId === 'n1');
    expect(upd).toHaveLength(1);
    expect(upd[0]).toMatchObject({ type: 'UPDATE', data: { content: row.content } });

    expect(await vaultReconcile()).toMatchObject(zero);
  });

  it('T6 riga con titolo in chiaro e contenuto in chiaro, nota presente sul server -> copia cifrata, la riga prende il server; nessun plaintext resta', async () => {
    const srv = await enc('n1', 'T', doc('server'));
    h.server.put('n1', srv);
    putRow({ id: 'n1', content: doc('SEGRETO-CORPO'), title: 'SEGRETO-TITOLO', syncStatus: 'updated', isEncrypted: false });
    item('UPDATE', 'n1', { title: 'SEGRETO-TITOLO', content: doc('SEGRETO-CORPO') }, failed('vault:plaintextRejected'));

    await vaultReconcile();

    const [copy] = copies(['n1']);
    expect(await decryptItem(copy.id, 'NOTE', copy.content, ctx)).toEqual({ t: 'SEGRETO-TITOLO (conflict)', c: doc('SEGRETO-CORPO') });
    expect(st.notes.get('n1').content).toBe(srv);
    expect(st.queue.filter(i => i.entityId === 'n1')).toHaveLength(0);
  });

  it('T6 {t,c} uguale al server -> la riga prende il server senza copia', async () => {
    const srv = await enc('n1', 'T', doc('uguale'));
    h.server.put('n1', srv);
    putRow({ id: 'n1', content: doc('uguale'), title: 'T', syncStatus: 'updated', isEncrypted: false });
    item('UPDATE', 'n1', { title: 'T', content: doc('uguale') }, failed('vault:plaintextRejected'));

    const r = await vaultReconcile();

    expect(r.legacyResolved).toBe(1);
    expect(r.copies).toBe(0);
    expect(copies(['n1'])).toHaveLength(0);
    expect(st.notes.get('n1')).toMatchObject({ content: srv, syncStatus: 'synced' });
    expect(st.queue.filter(i => i.entityId === 'n1')).toHaveLength(0);
  });

  it('T6 riga legacy synced con title "" (la pull lo azzera), server con t non vuoto e stesso c -> ADOPT, nessuna copia', async () => {
    const srv = await enc('n1', 'Titolo server', doc('uguale'));
    h.server.put('n1', srv);
    putRow({ id: 'n1', content: doc('uguale'), title: '', syncStatus: 'synced', isEncrypted: false });

    const r = await vaultReconcile();

    expect(r.copies).toBe(0);
    expect(copies(['n1'])).toHaveLength(0);
    expect(st.notes.get('n1')).toMatchObject({ content: srv, syncStatus: 'synced' });
  });

  it('T6 riga legacy synced con titolo locale non vuoto e senza item -> 1 copia con il titolo locale', async () => {
    const srv = await enc('n1', 'Titolo server', doc('uguale'));
    h.server.put('n1', srv);
    putRow({ id: 'n1', content: doc('uguale'), title: 'Titolo locale', syncStatus: 'synced', isEncrypted: false });

    const r = await vaultReconcile();

    expect(r.copies).toBe(1);
    const [copy] = copies(['n1']);
    expect(await decryptItem(copy.id, 'NOTE', copy.content, ctx)).toEqual({ t: 'Titolo locale (conflict)', c: doc('uguale') });
  });

  it('T6 riga legacy con titolo locale diverso dal server, stesso c -> copia come prima', async () => {
    const srv = await enc('n1', 'Titolo server', doc('uguale'));
    h.server.put('n1', srv);
    putRow({ id: 'n1', content: doc('uguale'), title: 'Titolo locale', syncStatus: 'updated', isEncrypted: false });
    item('UPDATE', 'n1', { title: 'Titolo locale', content: doc('uguale') }, failed('vault:plaintextRejected'));

    const r = await vaultReconcile();

    expect(r.copies).toBe(1);
    const [copy] = copies(['n1']);
    expect(await decryptItem(copy.id, 'NOTE', copy.content, ctx)).toEqual({ t: 'Titolo locale (conflict)', c: doc('uguale') });
  });

  it('T6 item con content in chiaro stantio su riga gia envelope: il content torna all envelope della riga, niente copia', async () => {
    const content = await enc('n1', 'T', doc('corpo'));
    h.server.put('n1', await enc('n1', 'T', doc('altro')));
    putRow({ id: 'n1', content, syncStatus: 'updated', vaultBaseHash: await sha256hex('v0') });
    const upd = item('UPDATE', 'n1', { content: doc('SEGRETO-STANTIO'), isPinned: true }, failed('vault:plaintextRejected'));

    const r = await vaultReconcile();

    expect(r.legacyResolved).toBe(1);
    expect(copies(['n1'])).toHaveLength(0);
    expect(st.queue.find(i => i.id === upd.id)).toMatchObject({ status: 'pending', data: { content, isPinned: true } });
  });

  it('T9 CREATE legacy senza nota sul server -> ri-cifrata sul posto (stesso id), CREATE rinfrescata; la push parte; secondo giro a zero (I5)', async () => {
    putRow({ id: 'n1', content: doc('SEGRETO-CORPO'), title: 'SEGRETO-TITOLO', syncStatus: 'created', isEncrypted: false });
    const create = item('CREATE', 'n1', { id: 'n1', title: 'SEGRETO-TITOLO', content: doc('SEGRETO-CORPO'), notebookId: 'nb-1', isVault: true, noteType: 'NOTE' }, failed('vault:plaintextRejected'));
    const upd = item('UPDATE', 'n1', { title: 'SEGRETO-TITOLO', content: doc('SEGRETO-CORPO') });

    const r = await vaultReconcile();

    expect(r.legacyResolved).toBe(1);
    expect(r.copies).toBe(0);
    expect(st.notes.size).toBe(1);
    const row = st.notes.get('n1');
    expect(row).toMatchObject({ title: '', isEncrypted: true, syncStatus: 'created' });
    expect(await decryptItem('n1', 'NOTE', row.content, ctx)).toEqual({ t: 'SEGRETO-TITOLO', c: doc('SEGRETO-CORPO') });
    const c = st.queue.find(i => i.id === create.id);
    expect(c).toMatchObject({ status: 'pending', data: { title: '', content: row.content, isEncrypted: true, isVault: true, notebookId: 'nb-1', id: 'n1' } });
    expect(c.lastError).toBeUndefined();
    expect(st.queue.find(i => i.id === upd.id)).toBeUndefined();

    expect(await vaultReconcile()).toMatchObject(zero);

    await syncPush();
    expect(mockApi.post).toHaveBeenCalledWith('/notes', expect.objectContaining({ id: 'n1', title: '', content: row.content }));
  });

  it('T9 CREDENTIAL con CREATE vault:stale: il noteType e\' conservato, la CREATE si rinfresca; secondo giro: canonica, tutto a zero', async () => {
    const content = await enc('c1', '', JSON.stringify({ username: 'bob' }), 'CREDENTIAL');
    putRow({ id: 'c1', noteType: 'CREDENTIAL', content, syncStatus: 'created' });
    const create = item('CREATE', 'c1', { id: 'c1', title: '', content, notebookId: 'nb-1', isVault: true, isEncrypted: true, noteType: 'CREDENTIAL' }, failed('vault:stale'));

    const r = await vaultReconcile();

    expect(r.legacyResolved).toBe(1);
    expect(st.queue.find(i => i.id === create.id)).toMatchObject({
      status: 'pending', attempts: 0,
      data: { id: 'c1', title: '', content, isEncrypted: true, isVault: true, noteType: 'CREDENTIAL', notebookId: 'nb-1' },
    });
    expect(st.queue.find(i => i.id === create.id).lastError).toBeUndefined();
    expect(copies(['c1'])).toHaveLength(0);

    expect(await vaultReconcile()).toMatchObject(zero);
  });

  it('T9 credenziale legacy non decifrabile: lasciata com\'e\' (LEAVE legacyPin); con decryptLegacy viene ri-cifrata', async () => {
    putRow({ id: 'c1', noteType: 'CREDENTIAL', content: 'U2FsdGVkX1-legacy', syncStatus: 'created', isEncrypted: false });
    item('CREATE', 'c1', { id: 'c1', title: '', content: 'U2FsdGVkX1-legacy', notebookId: 'nb-1', isVault: true, noteType: 'CREDENTIAL' }, failed('vault:plaintextRejected'));

    let r = await vaultReconcile();
    expect(r.unresolved).toBe(1);
    expect(st.notes.get('c1').content).toBe('U2FsdGVkX1-legacy');

    r = await vaultReconcile({ decryptLegacy: async () => JSON.stringify({ username: 'bob' }) });
    expect(r.legacyResolved).toBe(1);
    expect(await decryptItem('c1', 'CREDENTIAL', st.notes.get('c1').content, ctx)).toEqual({ t: '', c: JSON.stringify({ username: 'bob' }) });
  });

  it('T7 credenziale legacy identica al server: la riga prende il server senza copia e senza decryptLegacy', async () => {
    h.server.put('c1', 'U2FsdGVkX1-legacy', { noteType: 'CREDENTIAL' });
    putRow({ id: 'c1', noteType: 'CREDENTIAL', content: 'U2FsdGVkX1-legacy', syncStatus: 'updated', isEncrypted: false });
    item('UPDATE', 'c1', { content: 'U2FsdGVkX1-legacy' }, failed('vault:plaintextRejected'));
    const decryptLegacy = vi.fn(async () => JSON.stringify({ username: 'bob' }));

    const r = await vaultReconcile({ decryptLegacy });

    expect(decryptLegacy).not.toHaveBeenCalled();
    expect(r.legacyResolved).toBe(1);
    expect(r.copies).toBe(0);
    expect(copies(['c1'])).toHaveLength(0);
    expect(st.notes.get('c1')).toMatchObject({ content: 'U2FsdGVkX1-legacy', syncStatus: 'synced' });
    expect(st.queue.filter(i => i.entityId === 'c1')).toHaveLength(0);
  });

  it('T7 credenziale legacy con titolo diverso dal server: non e\' "uguale", decryptLegacy chiamato', async () => {
    h.server.put('c1', 'U2FsdGVkX1-legacy', { noteType: 'CREDENTIAL', title: '' });
    putRow({ id: 'c1', noteType: 'CREDENTIAL', content: 'U2FsdGVkX1-legacy', syncStatus: 'updated', isEncrypted: false });
    item('UPDATE', 'c1', { title: 'Nuovo titolo', content: 'U2FsdGVkX1-legacy' }, failed('vault:plaintextRejected'));
    const decryptLegacy = vi.fn(async () => JSON.stringify({ username: 'bob' }));

    await vaultReconcile({ decryptLegacy });

    expect(decryptLegacy).toHaveBeenCalled();
  });

  it('T8 envelope del server di un altro epoch: la riga resta com\'e\' (unresolved)', async () => {
    const local = await enc('n1', 'T', doc('mio'));
    h.server.put('n1', `nv3.${EPOCH - 1}.AAAAAAAAAAAAAAAA.${'B'.repeat(22)}`);
    putRow({ id: 'n1', content: local, syncStatus: 'updated', vaultBaseHash: 'x' });
    item('UPDATE', 'n1', { content: local });

    const r = await vaultReconcile();

    expect(r.unresolved).toBe(1);
    expect(st.notes.get('n1').content).toBe(local);
    expect(r.legacyLeft).toBe(1);
  });

  it('copia oltre 2 MiB: saltata, nota invariata (unresolved)', async () => {
    scan = false;
    h.server.put('n1', await enc('n1', 'T', doc('piccolo')));
    const big = doc('x'.repeat(2.1 * 1024 * 1024));
    putRow({ id: 'n1', content: big, title: 'T', syncStatus: 'updated', isEncrypted: false });
    item('UPDATE', 'n1', { title: 'T', content: big }, failed('vault:plaintextRejected'));

    const r = await vaultReconcile();

    expect(r.unresolved).toBe(1);
    expect(copies(['n1'])).toHaveLength(0);
    expect(st.notes.get('n1').content).toBe(big);
  });

  it('ri-cifratura sul posto oltre 2 MiB: saltata, riga e coda intatte (unresolved)', async () => {
    scan = false;
    const big = doc('x'.repeat(2.1 * 1024 * 1024));
    putRow({ id: 'n1', content: big, title: 'T', syncStatus: 'created', isEncrypted: false });
    const create = item('CREATE', 'n1', { id: 'n1', title: 'T', content: big, notebookId: 'nb-1', isVault: true, noteType: 'NOTE' }, failed('vault:plaintextRejected'));

    const r = await vaultReconcile();

    expect(r.unresolved).toBe(1);
    expect(st.notes.get('n1')).toMatchObject({ content: big, title: 'T', isEncrypted: false });
    expect(st.queue.find(i => i.id === create.id)).toMatchObject({ status: 'failed', data: { content: big } });
  });
});

// ---------------------------------------------------------------------------
describe('T11-T15 nota spostata, note non vault, riga assente', () => {
  it('T11 il server dice "non vault" per una riga vault con lavoro locale: copia cifrata + riga via', async () => {
    const local = await enc('n1', 'T', doc('mio'));
    putRow({ id: 'n1', content: local, syncStatus: 'updated' });
    item('UPDATE', 'n1', { content: local }, failed('vault:stale'));
    h.server.plain.add('n1');

    await vaultReconcile();

    expect(st.notes.has('n1')).toBe(false);
    const [copy] = copies([]);
    expect(await decryptItem(copy.id, 'NOTE', copy.content, ctx)).toEqual({ t: 'T (conflict)', c: doc('mio') });
    expect(st.queue.filter(i => i.entityId === 'n1')).toHaveLength(0);
  });

  it('T13 LNp+SN: l\'item perde i campi vault e torna pending, la riga non si tocca', async () => {
    putRow({ id: 'n1', isVault: false, isEncrypted: false, title: 'Normale', content: doc('normale'), syncStatus: 'updated' });
    const it = item('UPDATE', 'n1', { content: doc('normale'), isVault: true, isEncrypted: true, isPinned: true }, failed('vault:plaintextRequired'));
    h.server.plain.add('n1');

    const r = await vaultReconcile();

    expect(r.conflictsResolved).toBe(1);
    expect(st.queue.find(i => i.id === it.id)).toMatchObject({ status: 'pending', attempts: 0, data: { content: doc('normale'), isPinned: true } });
    expect(st.queue.find(i => i.id === it.id).data).not.toHaveProperty('isVault');
    expect(st.queue.find(i => i.id === it.id).data).not.toHaveProperty('isEncrypted');
    expect(st.notes.get('n1')).toMatchObject({ isVault: false, content: doc('normale'), title: 'Normale' });
  });

  it('T13 LNp+S0 con lavoro locale: copia in chiaro non vault (senza crypto) + riga via', async () => {
    putRow({ id: 'n1', isVault: false, isEncrypted: false, title: 'Normale', content: doc('normale'), syncStatus: 'updated' });
    item('UPDATE', 'n1', { content: doc('normale') }, failed('vault:stale'));

    await vaultReconcile();

    expect(st.notes.has('n1')).toBe(false);
    const [copy] = copies([]);
    expect(copy).toMatchObject({ isVault: false, isEncrypted: false, title: 'Normale (conflict)', content: doc('normale'), syncStatus: 'created' });
    expect(st.queue.find(i => i.entityId === copy.id)).toMatchObject({ type: 'CREATE', data: { id: copy.id, title: 'Normale (conflict)', content: doc('normale'), notebookId: 'nb-1' } });
    expect(st.queue.find(i => i.entityId === copy.id).data).not.toHaveProperty('isVault');
    expect(st.queue.filter(i => i.entityId === 'n1')).toHaveLength(0);
  });

  it('T13 LNe+S0: una riga non vault con un envelope va nel vault come copia cifrata, poi via', async () => {
    const env = await enc('n1', 'T', doc('nel vault'));
    putRow({ id: 'n1', isVault: false, isEncrypted: false, content: env, syncStatus: 'updated' });
    item('UPDATE', 'n1', { content: env }, failed('vault:plaintextRequired'));

    await vaultReconcile();

    expect(st.notes.has('n1')).toBe(false);
    const [copy] = copies([]);
    expect(copy).toMatchObject({ isVault: true, isEncrypted: true });
    expect(await decryptItem(copy.id, 'NOTE', copy.content, ctx)).toEqual({ t: 'T (conflict)', c: doc('nel vault') });
  });

  it('T12 LN+SE con modifiche locali: copia nel vault, la riga diventa la nota vault del server', async () => {
    const srv = await enc('n1', 'T', doc('server'));
    h.server.put('n1', srv);
    putRow({ id: 'n1', isVault: false, isEncrypted: false, title: 'Locale', content: doc('locale'), syncStatus: 'updated' });
    item('UPDATE', 'n1', { content: doc('locale') }, failed('vault:plaintextRequired'));

    await vaultReconcile();

    const [copy] = copies(['n1']);
    expect(await decryptItem(copy.id, 'NOTE', copy.content, ctx)).toEqual({ t: 'Locale (conflict)', c: doc('locale') });
    expect(st.notes.get('n1')).toMatchObject({ isVault: true, isEncrypted: true, content: srv, title: '', syncStatus: 'synced', vaultBaseHash: await sha256hex(srv) });
  });

  it('T14 LN+SL: la riga resta com\'e\' finche\' la nota non e\' migrata', async () => {
    h.server.put('n1', doc('legacy'));
    putRow({ id: 'n1', isVault: false, isEncrypted: false, title: 'Normale', content: doc('normale'), syncStatus: 'updated' });
    item('UPDATE', 'n1', { content: doc('normale') }, failed('vault:stale'));

    const r = await vaultReconcile();

    expect(r.unresolved).toBe(1);
    expect(st.notes.get('n1')).toMatchObject({ isVault: false, content: doc('normale') });
  });

  it('T15 riga assente con CREATE vault:* e contenuto: copia cifrata dall\'item e item via; senza contenuto solo item via', async () => {
    const env = await enc('gone', 'T', doc('orfano'));
    item('CREATE', 'gone', { id: 'gone', title: '', content: env, notebookId: 'nb-1', isVault: true, isEncrypted: true, noteType: 'NOTE' }, failed('vault:stale'));
    item('UPDATE', 'gone2', { isPinned: true }, failed('vault:stale'));

    await vaultReconcile();

    expect(st.queue.filter(i => i.entityId === 'gone' || i.entityId === 'gone2')).toHaveLength(0);
    const [copy, ...more] = copies([]);
    expect(more).toHaveLength(0);
    expect(await decryptItem(copy.id, 'NOTE', copy.content, ctx)).toEqual({ t: 'T (conflict)', c: doc('orfano') });
    expect(st.queue.filter(i => i.entityId === copy.id)).toHaveLength(1);
  });

  it('T13 LNp+S0 con una CREDENTIAL: la copia in chiaro conserva il noteType (riga e payload della coda)', async () => {
    putRow({ id: 'n1', isVault: false, isEncrypted: false, noteType: 'CREDENTIAL', title: 'Accesso', content: doc('segreto-normale'), syncStatus: 'updated' });
    item('UPDATE', 'n1', { content: doc('segreto-normale') }, failed('vault:stale'));

    await vaultReconcile();

    expect(st.notes.has('n1')).toBe(false);
    const [copy] = copies([]);
    expect(copy).toMatchObject({ isVault: false, noteType: 'CREDENTIAL', title: 'Accesso (conflict)' });
    expect(st.queue.find(i => i.entityId === copy.id)).toMatchObject({ type: 'CREATE', data: { id: copy.id, noteType: 'CREDENTIAL' } });
  });

  it('T13 LNp+S0 oltre 2 MiB: niente copia in chiaro (LEAVE size), riga e coda intatte', async () => {
    const big = doc('x'.repeat(2.1 * 1024 * 1024));
    putRow({ id: 'n1', isVault: false, isEncrypted: false, title: 'Grande', content: big, syncStatus: 'updated' });
    const it = item('UPDATE', 'n1', { content: big }, failed('vault:stale'));

    const r = await vaultReconcile();

    expect(r.unresolved).toBe(1);
    expect(r.copies).toBe(0);
    expect(copies(['n1'])).toHaveLength(0);
    expect(st.notes.get('n1').content).toBe(big);
    expect(st.queue.find(i => i.id === it.id)).toMatchObject({ status: 'failed', lastError: 'vault:stale' });
  });

  it('T13 UNVAULT con riga non caricata (content ""): il payload non porta content (un PUT con "" cancellerebbe il server), gli altri campi restano', async () => {
    const env = await enc('n1', 'T', doc('x'));
    putRow({ id: 'n1', isVault: false, isEncrypted: false, title: 'Normale', content: '', syncStatus: 'updated' });
    const it = item('UPDATE', 'n1', { content: env, isVault: true, isEncrypted: true, isPinned: true }, failed('vault:plaintextRequired'));
    h.server.plain.add('n1');

    const r = await vaultReconcile();

    expect(r.conflictsResolved).toBe(1);
    const after = st.queue.find(i => i.id === it.id);
    expect(after).toMatchObject({ status: 'pending', attempts: 0, data: { isPinned: true } });
    expect(after.data).not.toHaveProperty('content');
    expect(after.data).not.toHaveProperty('isVault');
    expect(after.data).not.toHaveProperty('isEncrypted');
    expect(st.notes.get('n1').content).toBe('');
  });

  it('T13 UNVAULT: un item che resta vuoto (solo content + campi vault, riga non caricata) si cancella', async () => {
    const env = await enc('n1', 'T', doc('x'));
    putRow({ id: 'n1', isVault: false, isEncrypted: false, title: 'Normale', content: '', syncStatus: 'updated' });
    const it = item('UPDATE', 'n1', { content: env, isVault: true, isEncrypted: true }, failed('vault:plaintextRequired'));
    h.server.plain.add('n1');

    await vaultReconcile();

    expect(st.queue.find(i => i.id === it.id)).toBeUndefined();
  });

  it('T12 ADOPT: gli item riaccodati perdono anche isVault (non solo content/title/isEncrypted)', async () => {
    const srv = await enc('n1', 'T', doc('server'));
    h.server.put('n1', srv);
    putRow({ id: 'n1', isVault: false, isEncrypted: false, title: 'Locale', content: doc('locale'), syncStatus: 'updated' });
    const mixed = item('UPDATE', 'n1', { content: doc('locale'), isVault: true, isPinned: true }, failed('vault:plaintextRequired'));
    const onlyVault = item('UPDATE', 'n1', { isVault: true }, failed('vault:plaintextRequired'));

    await vaultReconcile();

    const after = st.queue.find(i => i.id === mixed.id);
    expect(after).toMatchObject({ status: 'pending', data: { isPinned: true } });
    expect(after.data).not.toHaveProperty('isVault');
    expect(st.queue.find(i => i.id === onlyVault.id)).toBeUndefined();
    expect(st.notes.get('n1')).toMatchObject({ isVault: true, content: srv });
  });

  it('senza navigator.locks: UNVAULT e DROP (scritture di item o di riga) si rinviano, l\'item resta com\'e', async () => {
    removeLocks();
    putRow({ id: 'n1', isVault: false, isEncrypted: false, title: 'Normale', content: doc('normale'), syncStatus: 'updated' });
    const it = item('UPDATE', 'n1', { content: doc('normale'), isVault: true }, failed('vault:plaintextRequired'));
    h.server.plain.add('n1');

    const r = await vaultReconcile();

    expect(r).toMatchObject({ later: 1, conflictsResolved: 0 });
    expect(st.queue.find(i => i.id === it.id)).toMatchObject({ status: 'failed', data: { isVault: true } });
  });
});

// ---------------------------------------------------------------------------
describe('Z: righe di altri utenti e condivise (I7)', () => {
  it('una riga di un altro userId, o shared, non si tocca mai, nemmeno con item in errore e nota nel listing', async () => {
    scan = false;
    const srv = await enc('n1', 'T', doc('server'));
    h.server.put('n1', srv);
    h.server.put('n2', srv);
    putRow({ id: 'n1', userId: 'user-2', content: doc('altro utente'), title: 'X', syncStatus: 'updated', isEncrypted: false });
    item('UPDATE', 'n1', { title: 'X', content: doc('altro utente') }, { ...failed('vault:plaintextRejected'), userId: 'user-2' });
    putRow({ id: 'n2', ownership: 'shared', content: doc('condivisa'), title: 'Y', syncStatus: 'updated', isEncrypted: false });
    const before = JSON.stringify([...st.notes.values(), ...st.queue]);

    const r = await vaultReconcile();

    expect(r).toMatchObject(zero);
    expect(JSON.stringify([...st.notes.values(), ...st.queue])).toBe(before);
    expect(h.server.idsCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('finalize', () => {
  it('solo con decifratura e validazione strutturale valide', async () => {
    const okNote = await enc('ok', 'T', doc('x'));
    const okCred = await enc('cred', 'T', JSON.stringify({ username: 'u' }), 'CREDENTIAL');
    const badDoc = await enc('baddoc', 'T', JSON.stringify({ type: 'paragraph' }));
    const badCred = await enc('badcred', 'T', JSON.stringify(['x']), 'CREDENTIAL');
    const notJson = await enc('notjson', 'T', 'plain text');
    const tampered = (await enc('tamper', 'T', doc('x'))).replace(/.$/, (ch: string) => (ch === 'A' ? 'B' : 'A'));
    const wrongId = await enc('someone-else', 'T', doc('x'));
    const done = await enc('done', 'T', doc('x'));
    h.server.put('ok', okNote, { hasPlaintextVersions: true });
    h.server.put('cred', okCred, { hasPlaintextVersions: true, noteType: 'CREDENTIAL' });
    h.server.put('baddoc', badDoc, { hasPlaintextVersions: true });
    h.server.put('badcred', badCred, { hasPlaintextVersions: true, noteType: 'CREDENTIAL' });
    h.server.put('notjson', notJson, { hasPlaintextVersions: true });
    h.server.put('tamper', tampered, { hasPlaintextVersions: true });
    h.server.put('wrongid', wrongId, { hasPlaintextVersions: true });
    h.server.put('done', done);
    h.server.put('legacy', doc('plain'), { hasPlaintextVersions: true });

    const r = await vaultReconcile();

    expect(h.server.finalized).toEqual([['cred', 'ok']]);
    expect(r.finalized).toBe(2);
    expect(r.legacyLeft).toBe(1);
  });

  it('al massimo 500 id per chiamata', async () => {
    h.server.pageSize = 1000;
    for (let i = 0; i < 501; i++) {
      const id = `n${String(i).padStart(4, '0')}`;
      h.server.put(id, await enc(id, 'T', doc('x')), { hasPlaintextVersions: true });
    }
    await vaultReconcile();
    expect(h.server.finalized.map((c: string[]) => c.length)).toEqual([500, 1]);
    // 501 cifrature e 501 decifrature WebCrypto vere (serve superare il limite di 500): ~0.2 s in locale, ma oltre i 5 s di default su CI o
    // macchine cariche. Il test resta significativo (nessun mock del limite): si allarga solo il timeout.
  }, 30_000);
});

// ---------------------------------------------------------------------------
describe('guardie del giro', () => {
  it('K assente (precondizione 2 della spec, SKIP del giro): skipped "locked" prima di ogni lock e di ogni chiamata al server; blocco a meta\' giro -> aborted', async () => {
    await useVaultStore.getState().lockVault();
    expect(await vaultReconcile()).toMatchObject({ ...zero, skipped: 'locked' });
    expect(h.server.idsCalls).toHaveLength(0);
    expect(lockLog).toHaveLength(0);

    const vk = await importVk(generateVkRaw());
    const keys: VaultKeys = { vkHkdf: vk.hkdf, vkAes: vk.aes, sigKey: ctx.keys.sigKey };
    useVaultStore.setState({ keys, unlockedUserId: U, epoch: EPOCH, isUnlocked: true });
    h.server.put('a', await enc('a', 'T', doc('x')), { hasPlaintextVersions: true });
    const real = h.server.getItems.bind(h.server);
    h.server.getItems = async (b: any) => { const out = await real(b); void useVaultStore.getState().lockVault(); return out; };
    const r = await vaultReconcile();
    expect(r.aborted).toBe(true);
    expect(h.server.finalized).toHaveLength(0);
  });

  // Server finto con il primo listing fermo su un cancello: tiene il primo giro "in volo" mentre il test chiama vaultReconcile di nuovo.
  const gateFirstListing = () => {
    const real = h.server.getItems.bind(h.server);
    let open!: () => void;
    const opened = new Promise<void>(res => { open = res; });
    let listings = 0, active = 0, maxActive = 0, first = true;
    h.server.getItems = async (b: any) => {
      if (b.ids) return real(b);
      listings++;
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (first) { first = false; await opened; }
        return await real(b);
      } finally { active--; }
    };
    return { open, listings: () => listings, maxActive: () => maxActive };
  };

  it('K assente anche con le chiavi di un altro utente: skipped "locked", nessuna chiamata', async () => {
    useVaultStore.setState({ unlockedUserId: 'user-2' });
    expect(await vaultReconcile()).toMatchObject({ ...zero, skipped: 'locked' });
    expect(h.server.idsCalls).toHaveLength(0);
  });

  it('single-flight: una chiamata durante un giro NON ne condivide il risultato, accoda un secondo giro che parte dopo il primo', async () => {
    h.server.put('a', await enc('a', 'T', doc('x')));
    const gate = gateFirstListing();
    const p1 = vaultReconcile();
    const p2 = vaultReconcile();
    expect(p2).not.toBe(p1);
    await tick();
    await tick();
    expect(gate.listings()).toBe(1); // il secondo giro non parte finche' il primo e' in volo

    gate.open();
    await Promise.all([p1, p2]);

    expect(gate.listings()).toBe(2);
    expect(gate.maxActive()).toBe(1); // mai due giri insieme
    await vaultReconcile(); // dopo la fine non resta niente appeso: la chiamata riparte da sola
    expect(gate.listings()).toBe(3);
  });

  it('single-flight: piu chiamate durante un giro collassano in UN solo giro in coda, che usa il decryptLegacy di chi lo porta', async () => {
    putRow({ id: 'c1', noteType: 'CREDENTIAL', content: 'U2FsdGVkX1-legacy', syncStatus: 'created', isEncrypted: false });
    item('CREATE', 'c1', { id: 'c1', title: '', content: 'U2FsdGVkX1-legacy', notebookId: 'nb-1', isVault: true, noteType: 'CREDENTIAL' }, failed('vault:plaintextRejected'));
    const gate = gateFirstListing();
    const decryptLegacy = vi.fn(async () => JSON.stringify({ username: 'bob' }));

    const p1 = vaultReconcile();
    const p2 = vaultReconcile();
    const p3 = vaultReconcile({ decryptLegacy });
    const p4 = vaultReconcile();
    expect(p2).not.toBe(p1);
    expect(p3).toBe(p2);
    expect(p4).toBe(p2);
    gate.open();
    const [r1, r2] = [await p1, await p2];

    expect(gate.listings()).toBe(2); // un solo giro in coda per tre chiamate
    expect(gate.maxActive()).toBe(1);
    expect(decryptLegacy).toHaveBeenCalledTimes(1);
    expect(r1.unresolved).toBe(1); // il primo giro non poteva decifrare la credenziale legacy
    expect(r2.legacyResolved).toBe(1);
    expect(await decryptItem('c1', 'CREDENTIAL', st.notes.get('c1').content, ctx)).toEqual({ t: '', c: JSON.stringify({ username: 'bob' }) });
  });

  it('single-flight: passaggio di mano atomico, una chiamata fatta quando finisce il primo giro trova quello in coda in volo e si accoda dietro', async () => {
    h.server.put('a', await enc('a', 'T', doc('x')));
    const gate = gateFirstListing();
    const p1 = vaultReconcile();
    const p2 = vaultReconcile();
    let p3!: Promise<unknown>;
    void p1.then(() => { p3 = vaultReconcile(); }); // gira dopo il callback finally del primo: la coda e' gia' diventata il giro in volo
    gate.open();
    await p2;
    expect(p3).not.toBe(p2);
    await p3;

    expect(gate.listings()).toBe(3);
    expect(gate.maxActive()).toBe(1);
  });

  it('stato vecchio: una PUT 2xx che arriva dopo il listing (item cancellato, base e syncStatus cambiati) -> LATER, nessuna HYDRATE col vecchio envelope', async () => {
    const vOld = await enc('n1', 'T', doc('vecchio'));
    const vNew = await enc('n1', 'T', doc('nuovo'));
    h.server.put('n1', vOld);
    putRow({ id: 'n1', content: vNew, syncStatus: 'updated', vaultBaseHash: await sha256hex(vOld) });
    const it = item('UPDATE', 'n1', { content: vNew });
    const real = h.server.getItems.bind(h.server);
    h.server.getItems = async (b: any) => {
      const out = await real(b);
      if (!b.ids) { // la push finisce subito dopo che il server ha risposto al listing
        h.server.put('n1', vNew);
        st.queue = st.queue.filter(i => i.id !== it.id);
        st.notes.set('n1', { ...st.notes.get('n1'), syncStatus: 'synced', vaultBaseHash: await sha256hex(vNew), updatedAt: T1 });
      }
      return out;
    };

    const r = await vaultReconcile();

    expect(r.hydrated).toBe(0);
    expect(r.later).toBe(1);
    expect(st.notes.get('n1').content).toBe(vNew);
    h.server.getItems = real;
    const r2 = await vaultReconcile(); // il giro dopo vede il server nuovo
    expect(r2).toMatchObject(zero);
    expect(st.notes.get('n1').content).toBe(vNew);
  });

  it('stato vecchio: la riga cambia (base, syncStatus, updatedAt) dopo che il candidato e stato registrato -> LATER, nessuna HYDRATE', async () => {
    const vOld = await enc('n1', 'T', doc('vecchio'));
    const vNew = await enc('n1', 'T', doc('nuovo'));
    h.server.put('n1', vOld);
    putRow({ id: 'n1', content: vNew, syncStatus: 'updated', vaultBaseHash: 'x' });
    mockDb.notes.bulkGet.mockImplementationOnce(async (ids: string[]) => {
      const out = ids.map(id => st.notes.get(id));
      // un'altra scheda salva subito dopo la lettura del candidato
      st.notes.set('n1', { ...st.notes.get('n1'), syncStatus: 'synced', vaultBaseHash: await sha256hex(vNew), updatedAt: T1 });
      return out;
    });

    const r = await vaultReconcile();

    expect(r.hydrated).toBe(0);
    expect(r.later).toBe(1);
    expect(st.notes.get('n1')).toMatchObject({ content: vNew, syncStatus: 'synced' });
  });

  it('stato vecchio nel commit: la base cambia fra decide e commit -> LATER', async () => {
    const local = await enc('n1', 'T', doc('mio'));
    h.server.put('n1', await enc('n1', 'T', doc('altrui')));
    putRow({ id: 'n1', content: local, syncStatus: 'updated' });
    item('UPDATE', 'n1', { content: local }, failed('vault:conflict'));
    mockDb.transaction.mockImplementation(async (...a: unknown[]) => {
      st.notes.set('n1', { ...st.notes.get('n1'), vaultBaseHash: 'cambiata' });
      return passthrough(...a);
    });

    const r = await vaultReconcile();
    mockDb.transaction.mockImplementation(passthrough);

    expect(r.later).toBe(1);
    expect(copies(['n1'])).toHaveLength(0);
    expect(st.notes.get('n1').content).toBe(local);
  });

  it('lock del commit: exclusive con ifAvailable; un holder shared (editor aperto o push in corso) lo esclude, rilasciato il giro dopo risolve', async () => {
    const local = await enc('n1', 'T', doc('mio'));
    h.server.put('n1', await enc('n1', 'T', doc('altrui')));
    putRow({ id: 'n1', content: local, syncStatus: 'updated', vaultBaseHash: 'old' });
    item('UPDATE', 'n1', { content: local }, failed('vault:conflict'));
    const editor = hold(noteLockName('n1'), 'shared');

    const r1 = await vaultReconcile();
    expect(r1).toMatchObject({ later: 1, copies: 0 });
    expect(st.notes.get('n1').content).toBe(local);
    expect(lockLog.filter(l => l.name === noteLockName('n1'))).toEqual([{ name: noteLockName('n1'), mode: 'exclusive', ifAvailable: true }]);

    editor.release();
    await editor.done;
    lockLog.length = 0;
    const r2 = await vaultReconcile();
    expect(r2.copies).toBe(1);
    expect(lockLog.find(l => l.name === noteLockName('n1'))).toEqual({ name: noteLockName('n1'), mode: 'exclusive', ifAvailable: true });
    expect(lockLog.find(l => l.name === RECONCILE_LOCK)).toMatchObject({ mode: 'exclusive', ifAvailable: false });
  });
});

describe('i18n', () => {
  it('vault.conflictCopySuffix esiste in en e it e non e la chiave grezza', () => {
    for (const loc of [enLocale, itLocale] as any[]) {
      expect(typeof loc.vault.conflictCopySuffix).toBe('string');
      expect(loc.vault.conflictCopySuffix.length).toBeGreaterThan(0);
      expect(loc.vault.conflictCopySuffix).not.toBe('vault.conflictCopySuffix');
    }
    expect(enLocale.vault.conflictCopySuffix).toBe('(conflict copy)');
    expect(itLocale.vault.conflictCopySuffix).toBe('(copia in conflitto)');
  });

  it('errors.vault.plaintextRequired esiste in en e it', () => {
    expect((enLocale as any).errors.vault.plaintextRequired).toBe('This item must be in plain text outside the vault.');
    expect((itLocale as any).errors.vault.plaintextRequired).toBe('Questo elemento deve essere in chiaro fuori dal vault.');
  });
});
