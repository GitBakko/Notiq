// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// window finto (solo EventTarget) PRIMA degli import: vaultStore registra il listener "storage" e persist usa localStorage
vi.hoisted(() => {
  const mem = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = Object.assign(new EventTarget(), {
    localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) },
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- mock Vitest: server finto con record liberi */
const { srv, apiSpy, queue, notes, syncPushMock, reconcileMock, purgeMock } = vi.hoisted(() => ({
  srv: {
    items: new Map<string, any>(),
    calls: { items: [] as any[], migrate: [] as any[][], finalize: [] as string[][] },
    beforeMigrate: null as null | (() => void),
    forceInvalid: false,
    finalizeReject: new Set<string>(),
    sha: null as unknown as (s: string) => Promise<string>,
  },
  apiSpy: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
  queue: { items: [] as any[] },
  notes: new Map<string, any>(),
  syncPushMock: vi.fn(),
  reconcileMock: vi.fn(),
  purgeMock: vi.fn(),
}));

vi.mock('../../../lib/api', () => ({ default: apiSpy }));
vi.mock('../../../lib/apiCache', () => ({ purgeApiCache: purgeMock, purgeVaultCache: vi.fn() }));
vi.mock('../../../lib/db', () => ({
  db: {
    syncQueue: { filter: (fn: (i: any) => boolean) => ({ toArray: async () => queue.items.filter(fn) }) },
    notes: {
      get: async (id: string) => notes.get(id),
      filter: (fn: (n: any) => boolean) => ({ modify: async (patch: any) => { for (const n of notes.values()) if (fn(n)) Object.assign(n, patch); } }),
    },
  },
}));
// PBKDF2 100k di CryptoJS impiega secondi in Node: qui un cifrario finto con la stessa interfaccia (v2:... e formato legacy 'LEG:'); crypto.ts ha i suoi test
vi.mock('../../../utils/crypto', async (orig) => ({
  ...(await orig<typeof import('../../../utils/crypto')>()),
  encryptContent: (c: string, pin: string) => `v2:00:${pin}:${c}`,
  decryptContent: (enc: string, pin: string) => {
    const m = /^(?:v2:00|LEG):([^:]*):([\s\S]*)$/.exec(enc);
    return m && m[1] === pin ? m[2] : null;
  },
}));
vi.mock('../../sync/syncService', () => ({ syncPush: syncPushMock }));
vi.mock('../../../lib/vaultReconcile', () => ({ vaultReconcile: reconcileMock }));
vi.mock('../../../lib/vaultApi', () => ({
  getItems: async (body: { ids?: string[]; after?: string } = {}) => {
    srv.calls.items.push(body);
    const all = [...srv.items.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    if (body.ids) return { items: all.filter((i) => body.ids!.includes(i.id)), next: null, absent: [], notVault: [] };
    const rest = all.filter((i) => !body.after || i.id > body.after);
    const page = rest.slice(0, 100);
    return { items: page, next: rest.length > 100 ? page[99].id : null };
  },
  migrateItems: async (items: any[]) => {
    srv.calls.migrate.push(items);
    if (srv.beforeMigrate) { const f = srv.beforeMigrate; srv.beforeMigrate = null; f(); }
    const results = [];
    for (const it of items) {
      const cur = srv.items.get(it.id);
      let status = 'ok';
      if (srv.forceInvalid) status = 'invalid';
      else if (!cur) status = 'notFound';
      else if (cur.content.startsWith('nv3.')) status = 'already';
      else if ((await srv.sha(cur.content)) !== it.baseHash) status = 'conflict';
      else srv.items.set(it.id, { ...cur, content: it.content, title: '' });
      results.push({ id: it.id, status });
    }
    return { results };
  },
  finalizeItems: async (ids: string[]) => {
    srv.calls.finalize.push(ids);
    const rejected = ids.filter((id) => srv.finalizeReject.has(id) || !srv.items.get(id)?.content.startsWith('nv3.'));
    return { finalized: ids.length - rejected.length, rejected, legacyCount: 0 };
  },
}));

import {
  classify, closeMigration, createLegacyDecryptor, flushPending, MAX_ENVELOPE_LEN, migrateLegacy, MigrationError, packBatches,
} from '../vaultMigration';
import { EMPTY_CREDENTIAL } from '../credentialTypes';
import { decryptItem, encryptItem, clearVaultCodecCache, type VaultCodecCtx } from '../../../lib/vaultCodec';
import { useVaultStore, type VaultKeys } from '../../../store/vaultStore';
import { encryptContent } from '../../../utils/crypto';
import { generateSigKey, generateVkRaw, importVk, sha256hex } from '../../../utils/vaultCrypto';

const U = 'u1';
const EPOCH = 1;
const doc = (s: string) => JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', text: s }] });
const cred = (o: Partial<Record<string, string>> = {}) => ({ siteUrl: 'https://x.test', username: 'bob', password: 'pw', notes: '', ...o });
let ctx: VaultCodecCtx;

const put = (id: string, noteType: 'NOTE' | 'CREDENTIAL', title: string, content: string) =>
  srv.items.set(id, { id, noteType, title, hasPlaintextVersions: true, content, contentHash: 'x', updatedAt: '2026-10-22T00:00:00Z', isTrashed: false });
const plain = (id: string) => {
  const i = srv.items.get(id);
  return decryptItem(id, i.noteType, i.content, ctx);
};

beforeEach(async () => {
  srv.items.clear();
  srv.calls = { items: [], migrate: [], finalize: [] };
  srv.beforeMigrate = null;
  srv.forceInvalid = false;
  srv.finalizeReject.clear();
  srv.sha = sha256hex;
  queue.items = [];
  notes.clear();
  vi.clearAllMocks();
  const vk = await importVk(generateVkRaw());
  const keys: VaultKeys = { vkHkdf: vk.hkdf, vkAes: vk.aes, sigKey: (await generateSigKey()).privateKey };
  ctx = { keys, userId: U, epoch: EPOCH };
  useVaultStore.setState({ keys, unlockedUserId: U, epoch: EPOCH, isUnlocked: true });
});
afterEach(async () => {
  await useVaultStore.getState().lockVault();
  clearVaultCodecCache();
});

describe('classify / packBatches', () => {
  const base = { id: 'a', hasPlaintextVersions: true, contentHash: '', updatedAt: '', isTrashed: false };
  it('NOTE byte per byte, CREDENTIAL vuota e JSON in chiaro, v2/CryptoJS bloccate', () => {
    expect(classify({ ...base, noteType: 'NOTE', title: 'T', content: '{"a":1}' })).toEqual({ kind: 'ready', t: 'T', c: '{"a":1}' });
    expect(classify({ ...base, noteType: 'NOTE', title: 'T', content: 'U2FsdGVkX1xx' })).toEqual({ kind: 'ready', t: 'T', c: 'U2FsdGVkX1xx' });
    expect(classify({ ...base, noteType: 'CREDENTIAL', title: 'C', content: '' })).toEqual({ kind: 'ready', t: 'C', c: JSON.stringify(EMPTY_CREDENTIAL) });
    expect(classify({ ...base, noteType: 'CREDENTIAL', title: 'C', content: '{"siteUrl":"x"}' })).toEqual({ kind: 'ready', t: 'C', c: '{"siteUrl":"x"}' });
    expect(classify({ ...base, noteType: 'CREDENTIAL', title: 'C', content: 'v2:aabb:xyz' })).toEqual({ kind: 'locked' });
    expect(classify({ ...base, noteType: 'CREDENTIAL', title: 'C', content: 'U2FsdGVkX1+abc' })).toEqual({ kind: 'locked' });
    expect(classify({ ...base, noteType: 'CREDENTIAL', title: 'C', content: '[1,2]' })).toEqual({ kind: 'locked' });
  });

  it('batch: al massimo 200 item e 12 MiB', () => {
    const items = Array.from({ length: 250 }, (_, i) => ({ i, size: 100 }));
    expect(packBatches(items).map((b) => b.length)).toEqual([200, 50]);
    const MiB = 1024 * 1024;
    expect(packBatches([{ size: 5 * MiB }, { size: 5 * MiB }, { size: 5 * MiB }]).map((b) => b.length)).toEqual([2, 1]);
    expect(packBatches([])).toEqual([]);
  });
});

describe('migrateLegacy', () => {
  it('conta gli item con allegati; il campo assente nei backend vecchi vale 0', async () => {
    put('a', 'NOTE', 'Con allegato', doc('a'));
    put('b', 'NOTE', 'Senza campo', doc('b'));
    srv.items.get('a').hasAttachments = true;
    const r = await migrateLegacy({ ctx, pins: [] });
    expect(r.withAttachments).toBe(1);
  });

  it('titolo da /items.title anche oltre le prime 50 note; GET /notes mai chiamato; 250 -> 200+50', async () => {
    for (let i = 0; i < 249; i++) put(`n${String(i).padStart(3, '0')}`, 'NOTE', `Titolo ${i}`, doc(`n${i}`));
    put('zzz-late', 'NOTE', 'Fuori dalle prime 50', doc('late'));
    const r = await migrateLegacy({ ctx, pins: [] });
    expect(r.migrated).toBe(250);
    expect(srv.calls.migrate.map((b) => b.length)).toEqual([200, 50]);
    expect(srv.calls.finalize.map((b) => b.length)).toEqual([200, 50]);
    expect(await plain('zzz-late')).toEqual({ t: 'Fuori dalle prime 50', c: doc('late') });
    expect(srv.items.get('zzz-late').title).toBe('');
    expect(apiSpy.get).not.toHaveBeenCalled();
    expect(apiSpy.request).not.toHaveBeenCalled();
    // la lista del server si legge per pagine di /items (nessun ids senza motivo): solo `after` o {}
    expect(srv.calls.items.filter((b) => b.ids)).toHaveLength(2); // solo la verifica dei due batch
  });

  it('envelope oltre 2 MiB: escluso, lasciato in chiaro, non inviato ne finalizzato', async () => {
    put('big', 'NOTE', 'Grande', 'x'.repeat(MAX_ENVELOPE_LEN + 10));
    put('ok', 'NOTE', 'Piccola', doc('ok'));
    const r = await migrateLegacy({ ctx, pins: [] });
    expect(r.tooLarge).toEqual(['big']);
    expect(r.migrated).toBe(1);
    expect(srv.calls.migrate.flat().map((i) => i.id)).toEqual(['ok']);
    expect(srv.calls.finalize.flat()).toEqual(['ok']);
    expect(srv.items.get('big').content.startsWith('nv3.')).toBe(false);
  });

  it('conflict -> rifetch dell\'id e nuovo giro con il contenuto aggiornato', async () => {
    put('a', 'NOTE', 'A', doc('a'));
    put('b', 'NOTE', 'B', doc('b0'));
    srv.beforeMigrate = () => put('b', 'NOTE', 'B2', doc('b1')); // un altro dispositivo modifica b dopo il listing
    const r = await migrateLegacy({ ctx, pins: [] });
    expect(r.migrated).toBe(2);
    expect(r.conflicts).toEqual([]);
    expect(srv.calls.migrate.map((b) => b.map((i) => i.id))).toEqual([['a', 'b'], ['b']]);
    expect(await plain('b')).toEqual({ t: 'B2', c: doc('b1') });
  });

  it('conflitto che non si risolve: dopo 3 giri resta in conflicts, mai finalizzato', async () => {
    put('b', 'NOTE', 'B', doc('b0'));
    srv.sha = (s) => sha256hex(s + '!'); // il server vede sempre un contenuto diverso
    const r = await migrateLegacy({ ctx, pins: [] });
    expect(r.conflicts).toEqual(['b']);
    expect(r.migrated).toBe(0);
    expect(srv.calls.migrate).toHaveLength(3);
    expect(srv.calls.finalize).toEqual([]);
  });

  it('finalize solo sugli id verificati: "already" con contenuto diverso dall\'originale non si finalizza', async () => {
    put('a', 'NOTE', 'A', doc('a'));
    put('b', 'NOTE', 'B', doc('b'));
    // un altro dispositivo ha gia' migrato b con un testo diverso
    const other = await encryptItem('b', 'NOTE', { t: '', c: doc('modificato altrove') }, ctx);
    srv.beforeMigrate = () => put('b', 'NOTE', '', other);
    const r = await migrateLegacy({ ctx, pins: [] });
    expect(r.migrated).toBe(1);
    expect(r.unverified).toEqual(['b']);
    expect(srv.calls.finalize.flat()).toEqual(['a']);
  });

  it('finalize rifiutato dal server: l\'id va in unverified e non conta come migrato', async () => {
    put('a', 'NOTE', 'A', doc('a'));
    srv.finalizeReject.add('a'); // il server rifiuta (es. epoch cambiato)
    const r = await migrateLegacy({ ctx, pins: [] });
    expect(r.migrated).toBe(0);
    expect(r.unverified).toEqual(['a']);
  });

  it('invalid dal server: ci si ferma con MigrationError e senza finalize', async () => {
    put('a', 'NOTE', 'A', doc('a'));
    srv.forceInvalid = true;
    await expect(migrateLegacy({ ctx, pins: [] })).rejects.toMatchObject({ code: 'invalid' });
    expect(srv.calls.finalize).toEqual([]);
  });

  it('CREDENTIAL: \'\' -> credenziale vuota, JSON in chiaro -> tale e quale', async () => {
    put('c0', 'CREDENTIAL', 'Vuota', '');
    const raw = JSON.stringify(cred({ notes: 'ciao' }), null, 2); // forma con spazi: byte per byte
    put('c1', 'CREDENTIAL', 'Chiaro', raw);
    const r = await migrateLegacy({ ctx, pins: [] });
    expect(r.migrated).toBe(2);
    expect(await plain('c0')).toEqual({ t: 'Vuota', c: JSON.stringify(EMPTY_CREDENTIAL) });
    expect(await plain('c1')).toEqual({ t: 'Chiaro', c: raw });
  });

  it('PIN errato -> fuori (byte identici sul server); 2 PIN diversi (v2 e CryptoJS legacy) -> tutte migrate', async () => {
    const a = JSON.stringify(cred({ username: 'a' }));
    const b = JSON.stringify(cred({ username: 'b' }));
    const c = JSON.stringify(cred({ username: 'c' }));
    const va = encryptContent(a, 'pinA11');
    const vb = encryptContent(b, 'pinB22');
    const vc = `LEG:pinA11:${c}`; // formato legacy a passphrase (cifrario finto, vedi sopra)
    put('ca', 'CREDENTIAL', 'A', va);
    put('cb', 'CREDENTIAL', 'B', vb);
    put('cc', 'CREDENTIAL', 'C', vc);

    const r1 = await migrateLegacy({ ctx, pins: ['pinA11'] });
    expect(r1.migrated).toBe(2);
    expect(r1.locked).toEqual(['cb']);
    expect(srv.items.get('cb').content).toBe(vb);
    expect(srv.calls.migrate.flat().map((i) => i.id).sort()).toEqual(['ca', 'cc']);

    const r2 = await migrateLegacy({ ctx, pins: ['sbagliato', 'pinB22'] });
    expect(r2.migrated).toBe(1);
    expect(r2.locked).toEqual([]);
    expect(await plain('ca')).toEqual({ t: 'A', c: a });
    expect(await plain('cb')).toEqual({ t: 'B', c: b });
    expect(await plain('cc')).toEqual({ t: 'C', c: c });
  });

  it('due PIN diversi nella stessa corsa -> entrambe migrate', async () => {
    const a = JSON.stringify(cred({ username: 'a' }));
    const b = JSON.stringify(cred({ username: 'b' }));
    put('ca', 'CREDENTIAL', 'A', encryptContent(a, 'pinA11'));
    put('cb', 'CREDENTIAL', 'B', encryptContent(b, 'pinB22'));
    const r = await migrateLegacy({ ctx, pins: ['pinA11', 'pinB22'] });
    expect(r.migrated).toBe(2);
    expect(r.locked).toEqual([]);
  });

  it('lock durante il giro -> MigrationError locked, niente invio', async () => {
    put('a', 'NOTE', 'A', doc('a'));
    useVaultStore.setState({ keys: null });
    await expect(migrateLegacy({ ctx, pins: [] })).rejects.toMatchObject({ code: 'locked' });
    expect(srv.calls.migrate).toEqual([]);
  });

  it('item gia\' envelope (nv3.) non si tocca', async () => {
    const env = await encryptItem('done', 'NOTE', { t: 'T', c: doc('d') }, ctx);
    put('done', 'NOTE', '', env);
    const r = await migrateLegacy({ ctx, pins: [] });
    expect(r.migrated).toBe(0);
    expect(srv.calls.migrate).toEqual([]);
  });
});

describe('migrateLegacy: decrypt che rifiuta e invio a flusso', () => {
  it('Worker che rifiuta su un item: solo quello in failed, gli altri proseguono', async () => {
    put('a-note', 'NOTE', 'N', doc('n'));
    put('b-cred', 'CREDENTIAL', 'C', 'v2:boom');
    put('c-cred', 'CREDENTIAL', 'D', 'v2:ok');
    const decryptor = {
      size: 1,
      decrypt: async (c: string) => { if (c === 'v2:boom') throw new Error('legacyWorkerFailed'); return JSON.stringify(cred()); },
      terminate: () => {},
    };
    const r = await migrateLegacy({ ctx, pins: ['p'], decryptor });
    expect(r.failed).toEqual(['b-cred']);
    expect(r.migrated).toBe(2);
    expect(srv.items.get('b-cred').content).toBe('v2:boom');
  });

  it('il primo batch parte prima che tutto il giro sia preparato', async () => {
    for (let i = 0; i < 250; i++) put(`c${String(i).padStart(3, '0')}`, 'CREDENTIAL', `C${i}`, `v2:${i}`);
    let decrypts = 0;
    let atFirstMigrate = -1;
    srv.beforeMigrate = () => { atFirstMigrate = decrypts; };
    const decryptor = { size: 1, decrypt: async () => { decrypts++; return JSON.stringify(cred()); }, terminate: () => {} };
    const r = await migrateLegacy({ ctx, pins: ['p'], decryptor });
    expect(r.migrated).toBe(250);
    expect(atFirstMigrate).toBe(201); // batch da 200 chiuso dal 201esimo item, non dopo 250
    expect(srv.calls.migrate.map((b) => b.length)).toEqual([200, 50]);
  }, 30_000); // 250 item: sotto carico supera il timeout default di 5 s
});

describe('flushPending', () => {
  const pendingVault = (extra: Record<string, unknown> = {}) => ({ id: 1, type: 'UPDATE', entity: 'NOTE', entityId: 'v1', userId: U, createdAt: 1, ...extra });

  it('attende che gli item pending su note vault partano', async () => {
    notes.set('v1', { id: 'v1', isVault: true });
    queue.items = [pendingVault()];
    syncPushMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      queue.items = [];
      return true;
    });
    await expect(flushPending(U, { pollMs: 10, timeoutMs: 2000 })).resolves.toBeUndefined();
    expect(syncPushMock).toHaveBeenCalled();
  });

  it('i failed e le note non vault non bloccano', async () => {
    notes.set('v1', { id: 'v1', isVault: true });
    notes.set('n1', { id: 'n1', isVault: false });
    queue.items = [pendingVault({ status: 'failed' }), pendingVault({ id: 2, entityId: 'n1' })];
    syncPushMock.mockResolvedValue(true);
    await expect(flushPending(U, { pollMs: 10, timeoutMs: 500 })).resolves.toBeUndefined();
  });

  it('pending che non parte -> flushTimeout', async () => {
    notes.set('v1', { id: 'v1', isVault: true });
    queue.items = [pendingVault({ status: 'pending' })];
    syncPushMock.mockResolvedValue(true);
    await expect(flushPending(U, { pollMs: 10, timeoutMs: 80 })).rejects.toBeInstanceOf(MigrationError);
    await expect(flushPending(U, { pollMs: 10, timeoutMs: 80 })).rejects.toMatchObject({ code: 'flushTimeout' });
  });

  it('CREATE con isVault nel payload conta anche senza riga', async () => {
    queue.items = [pendingVault({ type: 'CREATE', data: { isVault: true } })];
    syncPushMock.mockResolvedValue(true);
    await expect(flushPending(U, { pollMs: 10, timeoutMs: 60 })).rejects.toMatchObject({ code: 'flushTimeout' });
  });
});

describe('closeMigration', () => {
  it('reconcile con decryptLegacy sui vecchi PIN; poi clearLegacy e purgeApiCache', async () => {
    const clear = vi.spyOn(useVaultStore.getState(), 'clearLegacy');
    reconcileMock.mockResolvedValue({ legacyLeft: 0 });
    const j = JSON.stringify(cred());
    const res = await closeMigration({ pins: ['x', 'pinA11'] });
    expect(res).toEqual({ legacyLeft: 0 });
    const opts = reconcileMock.mock.calls[0][0];
    expect(await opts.decryptLegacy({ content: encryptContent(j, 'pinA11') })).toBe(j);
    expect(await opts.decryptLegacy({ content: encryptContent(j, 'altro1') })).toBeNull();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(purgeMock).toHaveBeenCalledTimes(1);
  });

  it('ogni riga legacy decifrata tocca auto-lock (PBKDF2 lungo senza input)', async () => {
    const touch = vi.spyOn(useVaultStore.getState(), 'touchVault');
    reconcileMock.mockResolvedValue({ legacyLeft: 0 });
    await closeMigration({ pins: ['pinA11'] });
    await reconcileMock.mock.calls[0][0].decryptLegacy({ content: encryptContent(JSON.stringify(cred()), 'pinA11') });
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it('B.2: svuota searchText delle righe vault (anche se il reconcile fallisce), lascia stare le righe normali', async () => {
    notes.set('v1', { id: 'v1', isVault: true, searchText: 'titolo in chiaro' });
    notes.set('n1', { id: 'n1', isVault: false, searchText: 'testo normale' });
    reconcileMock.mockRejectedValueOnce(new Error('boom'));
    await expect(closeMigration({ pins: [] })).rejects.toThrow('boom');
    expect(notes.get('v1').searchText).toBe('');
    expect(notes.get('n1').searchText).toBe('testo normale');
  });

  it('skipped busy (signal) -> niente pulizia, "riprova"', async () => {
    const clear = vi.spyOn(useVaultStore.getState(), 'clearLegacy');
    reconcileMock.mockResolvedValue({ skipped: 'busy' });
    const ac = new AbortController();
    const res = await closeMigration({ pins: [], signal: ac.signal });
    expect(res.skipped).toBe('busy');
    expect(reconcileMock.mock.calls[0][0].signal).toBe(ac.signal);
    expect(clear).not.toHaveBeenCalled();
    expect(purgeMock).not.toHaveBeenCalled();
  });
});

describe('createLegacyDecryptor', () => {
  it('senza Worker gira inline', async () => {
    const d = createLegacyDecryptor();
    const j = JSON.stringify(cred());
    expect(d.size).toBe(1);
    expect(await d.decrypt(encryptContent(j, 'pinA11'), 'pinA11')).toBe(j);
    expect(await d.decrypt(encryptContent(j, 'pinA11'), 'no')).toBeNull();
    d.terminate();
  });
});
