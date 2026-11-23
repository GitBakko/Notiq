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
    calls: { items: [] as any[], migrate: [] as any[][], finalize: [] as string[][], keyring: 0 },
    beforeMigrate: null as null | (() => void),
    forceInvalid: false,
    epoch: 1,
    keyringEpoch: null as number | null, // epoch del keyring (default = srv.epoch)
    prevVkWrap: null as string | null,
    finalizeReject: new Set<string>(),
    extraOnIds: [] as string[], // id restituiti in piu' da getItems({ids}) (server che ignora il filtro)
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
  getKeyring: async () => { srv.calls.keyring++; return { epoch: srv.keyringEpoch ?? srv.epoch, prevVkWrap: srv.prevVkWrap }; },
  getItems: async (body: { ids?: string[]; after?: string } = {}) => {
    srv.calls.items.push(body);
    const all = [...srv.items.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    if (body.ids) return { items: all.filter((i) => body.ids!.includes(i.id) || srv.extraOnIds.includes(i.id)), next: null, absent: [], notVault: [] };
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
      else if (cur.content.startsWith(`nv3.${srv.epoch}.`)) status = 'already';
      else if (!it.content.startsWith(`nv3.${srv.epoch}.`)) status = 'invalid';
      else if ((await srv.sha(cur.content)) !== it.baseHash) status = 'conflict';
      else srv.items.set(it.id, { ...cur, content: it.content, title: '' });
      results.push({ id: it.id, status });
    }
    return { results };
  },
  finalizeItems: async (ids: string[]) => {
    srv.calls.finalize.push(ids);
    const rejected = ids.filter((id) => srv.finalizeReject.has(id) || !srv.items.get(id)?.content.startsWith(`nv3.${srv.epoch}.`));
    return { finalized: ids.length - rejected.length, rejected, legacyCount: 0 };
  },
}));

import {
  classify, closeMigration, createLegacyDecryptor, finishRotation, flushPending, MAX_ENVELOPE_LEN, MAX_REWRAP_LEN, migrateLegacy,
  MigrationError, packBatches, rewrapUnreadable,
} from '../vaultMigration';
import { EMPTY_CREDENTIAL } from '../credentialTypes';
import { decryptItem, encryptItem, clearVaultCodecCache, type VaultCodecCtx } from '../../../lib/vaultCodec';
import { useVaultStore, type VaultKeys } from '../../../store/vaultStore';
import { encryptContent } from '../../../utils/crypto';
import { b64uEncode, generateSigKey, generateVkRaw, importVk, sha256hex, wrapPrevVk, type VaultKey } from '../../../utils/vaultCrypto';

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
  srv.calls = { items: [], migrate: [], finalize: [], keyring: 0 };
  srv.keyringEpoch = null;
  srv.beforeMigrate = null;
  srv.forceInvalid = false;
  srv.epoch = EPOCH;
  srv.finalizeReject.clear();
  srv.extraOnIds = [];
  srv.prevVkWrap = null;
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

  it("solo contenuto NON envelope: envelope di un'altra epoch e malformati restano intatti, li tocca solo finishRotation", async () => {
    put('leg', 'NOTE', 'Legacy', doc('l'));
    const vk0 = await importVk(generateVkRaw());
    const ctx0: VaultCodecCtx = { keys: { ...ctx.keys, vkHkdf: vk0.hkdf, vkAes: vk0.aes }, userId: U, epoch: 0 };
    const old = await encryptItem('old', 'NOTE', { t: 'O', c: doc('o') }, ctx0);
    put('old', 'NOTE', '', old);
    put('bad', 'NOTE', '', 'nv3.5.x');
    const r = await migrateLegacy({ ctx, pins: [] });
    expect(r.migrated).toBe(1);
    expect(srv.calls.migrate.flat().map((i) => i.id)).toEqual(['leg']);
    expect(srv.items.get('old').content).toBe(old);
    expect(srv.items.get('bad').content).toBe('nv3.5.x');
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
  }, 60000); // 250 note cifrate (CPU-bound): oltre i 5 s di default sotto carico (5064 ms osservati, e oltre 15 s a suite piena)

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

  it("conflitto: il rifetch rispetta `only` ('legacy'): un envelope di e-1 comparso nel frattempo non si tocca", async () => {
    const vk0 = await importVk(generateVkRaw());
    const ctx0: VaultCodecCtx = { keys: { ...ctx.keys, vkHkdf: vk0.hkdf, vkAes: vk0.aes }, userId: U, epoch: 0 };
    const ctxP: VaultCodecCtx = { ...ctx, keys: { ...ctx.keys, prev: { epoch: 0, vkHkdf: vk0.hkdf, vkAes: vk0.aes } } }; // con prev l'envelope e-1 sarebbe migrabile
    useVaultStore.setState({ keys: ctxP.keys });
    put('a', 'NOTE', 'A', doc('a'));
    put('b', 'NOTE', 'B', doc('b0'));
    const old = await encryptItem('b', 'NOTE', { t: 'B1', c: doc('b1') }, ctx0);
    srv.beforeMigrate = () => put('b', 'NOTE', '', old); // un altro dispositivo la sostituisce con un envelope stale dopo il listing
    const r = await migrateLegacy({ ctx: ctxP, pins: [] });
    expect(r.migrated).toBe(1);
    expect(srv.calls.migrate.map((b) => b.map((i) => i.id))).toEqual([['a', 'b']]); // nessun secondo giro per b
    expect(srv.items.get('b').content).toBe(old);
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

// ---------------------------------------------------------------------------------------------------------------------
// Rotazione della VK (Fase 5, T8): finishRotation + rewrapUnreadable
// ---------------------------------------------------------------------------------------------------------------------
describe('finishRotation / rewrapUnreadable', () => {
  let ctx1: VaultCodecCtx; // epoch 1 (chiavi vecchie: scrive gli envelope "stale")
  let ctx2: VaultCodecCtx; // epoch 2 con prev = VK1
  let ctx2NoPrev: VaultCodecCtx;
  let vk1Raw: Uint8Array;
  let vk2: VaultKey;
  /** prevVkWrap valido dell'epoch 2 (VK1 sotto VK2), come lo darebbe il keyring. */
  const validPrevWrap = async () => b64uEncode(await wrapPrevVk(vk2, vk1Raw, U, 2, 1));
  const staleCount = () => [...srv.items.values()].filter((i) => !i.content.startsWith('nv3.2.')).length;
  const putStale = async (id: string, noteType: 'NOTE' | 'CREDENTIAL', t: string, c: string) => {
    const env = await encryptItem(id, noteType, { t, c }, ctx1);
    put(id, noteType, '', env);
    return env;
  };
  const plain2 = (id: string) => decryptItem(id, srv.items.get(id).noteType, srv.items.get(id).content, ctx2);

  beforeEach(async () => {
    vk1Raw = generateVkRaw();
    const vk1 = await importVk(vk1Raw);
    vk2 = await importVk(generateVkRaw());
    const sig = (await generateSigKey()).privateKey;
    ctx1 = { keys: { vkHkdf: vk1.hkdf, vkAes: vk1.aes, sigKey: sig }, userId: U, epoch: 1 };
    const keys2: VaultKeys = { vkHkdf: vk2.hkdf, vkAes: vk2.aes, sigKey: sig, prev: { epoch: 1, vkHkdf: vk1.hkdf, vkAes: vk1.aes } };
    ctx2 = { keys: keys2, userId: U, epoch: 2 };
    ctx2NoPrev = { keys: { ...keys2, prev: undefined }, userId: U, epoch: 2 };
    srv.epoch = 2;
    useVaultStore.setState({ keys: keys2, unlockedUserId: U, epoch: 2, isUnlocked: true });
  });

  it('SX -> SE: ricifrati, verificati dai byte del server e finalizzati; gli envelope gia\' correnti non si toccano; nulla in Dexie o in coda', async () => {
    await putStale('n1', 'NOTE', 'Uno', doc('uno'));
    await putStale('c1', 'CREDENTIAL', 'Cred', JSON.stringify(cred({ notes: 'x' })));
    put('cur', 'NOTE', '', await encryptItem('cur', 'NOTE', { t: 'T', c: doc('cur') }, ctx2));
    const before = srv.items.get('cur').content;
    const r = await finishRotation({ ctx: ctx2 });
    expect(r.migrated).toBe(2);
    expect(r.unreadable).toEqual([]);
    expect(r.unverified).toEqual([]);
    expect(staleCount()).toBe(0);
    expect(await plain2('n1')).toEqual({ t: 'Uno', c: doc('uno') });
    expect(await plain2('c1')).toEqual({ t: 'Cred', c: JSON.stringify(cred({ notes: 'x' })) });
    expect(srv.items.get('cur').content).toBe(before);
    expect(srv.calls.migrate.flat().map((i) => i.id).sort()).toEqual(['c1', 'n1']);
    expect(srv.calls.finalize.flat().sort()).toEqual(['c1', 'n1']);
    expect(srv.items.get('n1').title).toBe('');
    expect(queue.items).toEqual([]); // il mock di db non ha metodi di scrittura: qualunque put/add avrebbe lanciato
    expect(notes.size).toBe(0);
  });

  it('interrotto dopo il listing (signal) -> nulla scritto; secondo giro con un item gia\' fatto -> nessuno stale e solo gli stale inviati', async () => {
    await putStale('a', 'NOTE', 'A', doc('a'));
    await putStale('b', 'NOTE', 'B', doc('b'));
    const ac = new AbortController();
    // abort subito dopo il listing (onProgress iniziale), prima di qualunque invio
    await expect(finishRotation({ ctx: ctx2, signal: ac.signal, onProgress: () => ac.abort() })).rejects.toMatchObject({ code: 'aborted' });
    expect(srv.calls.migrate).toEqual([]);
    expect(staleCount()).toBe(2);
    // stato a meta' giro: 'a' gia' all'epoch 2 (fatto dal giro interrotto)
    srv.items.set('a', { ...srv.items.get('a'), content: await encryptItem('a', 'NOTE', { t: 'A', c: doc('a') }, ctx2) });
    const r = await finishRotation({ ctx: ctx2 });
    expect(r.migrated).toBe(1);
    expect(srv.calls.migrate.flat().map((i) => i.id)).toEqual(['b']);
    expect(staleCount()).toBe(0);
  });

  it('conflitto: nuovo giro col contenuto aggiornato; se non si risolve, dopo 3 giri resta in conflicts e non si finalizza', async () => {
    await putStale('a', 'NOTE', 'A', doc('a'));
    const other = await encryptItem('a', 'NOTE', { t: 'A2', c: doc('a1') }, ctx1);
    srv.beforeMigrate = () => put('a', 'NOTE', '', other); // un altro dispositivo la cambia dopo il listing
    const r = await finishRotation({ ctx: ctx2 });
    expect(r.migrated).toBe(1);
    expect(r.conflicts).toEqual([]);
    expect(srv.calls.migrate).toHaveLength(2);
    expect(await plain2('a')).toEqual({ t: 'A2', c: doc('a1') });

    await putStale('b', 'NOTE', 'B', doc('b'));
    srv.calls = { items: [], migrate: [], finalize: [], keyring: 0 };
    srv.sha = (x) => sha256hex(x + '!');
    const r2 = await finishRotation({ ctx: ctx2 });
    expect(r2.conflicts).toEqual(['b']);
    expect(srv.calls.migrate).toHaveLength(3);
    expect(srv.calls.finalize).toEqual([]);
  });

  it('conflitto: il keyring si rilegge al rifetch; epoch cambiata nel frattempo -> epochChanged, vault bloccato, niente secondo giro', async () => {
    await putStale('a', 'NOTE', 'A', doc('a'));
    srv.beforeMigrate = () => { put('a', 'NOTE', '', srv.items.get('a').content + 'x'); srv.keyringEpoch = 3; }; // conflitto + rotazione fatta altrove
    const lock = vi.spyOn(useVaultStore.getState(), 'lockVault');
    await expect(finishRotation({ ctx: ctx2 })).rejects.toMatchObject({ name: 'MigrationError', code: 'epochChanged' });
    expect(lock).toHaveBeenCalled();
    expect(srv.calls.keyring).toBe(1);
    expect(srv.calls.migrate).toHaveLength(1);
  });

  it('e-1 con prev -> migrata; malformata ed e-2 -> unreadable unverifiable (D18), intatte; nessuna chiamata al keyring', async () => {
    const vk0 = await importVk(generateVkRaw());
    const ctx0: VaultCodecCtx = { keys: { ...ctx1.keys, vkHkdf: vk0.hkdf, vkAes: vk0.aes }, userId: U, epoch: 0 };
    const good = await putStale('good', 'NOTE', 'G', doc('g'));
    put('bad', 'NOTE', '', 'nv3.1.garbage');
    put('malformed', 'NOTE', '', 'nv3.xx');
    const old2 = await encryptItem('old2', 'NOTE', { t: 'O', c: doc('o') }, ctx0);
    put('old2', 'NOTE', '', old2);
    const r = await finishRotation({ ctx: ctx2 });
    expect(r.migrated).toBe(1);
    expect(r.unreadable).toEqual([
      { id: 'bad', noteType: 'NOTE', size: 'nv3.1.garbage'.length, reason: 'unverifiable' },
      { id: 'malformed', noteType: 'NOTE', size: 'nv3.xx'.length, reason: 'unverifiable' },
      { id: 'old2', noteType: 'NOTE', size: old2.length, reason: 'unverifiable' },
    ]);
    expect(srv.items.get('bad').content).toBe('nv3.1.garbage');
    expect(srv.items.get('old2').content).toBe(old2);
    expect(srv.calls.migrate.flat().map((i) => i.id)).toEqual(['good']);
    expect(srv.calls.finalize.flat()).toEqual(['good']);
    expect(srv.items.get('good').content).not.toBe(good);
    expect(srv.calls.keyring).toBe(0);
  });

  it("A3: un server che riscrive nv3.<e-1>. in nv3.<e-2>. non fa passare la nota per 'damaged' (e quindi eliminabile): e' unverifiable", async () => {
    const env = await putStale('a', 'NOTE', 'A', doc('a'));
    put('a', 'NOTE', '', env.replace('nv3.1.', 'nv3.0.'));
    const r = await finishRotation({ ctx: ctx2 });
    expect(r.unreadable).toMatchObject([{ id: 'a', reason: 'unverifiable' }]);
  });

  describe('A2/A4: eccezioni della decifratura', () => {
    // la terza lettura di keys.prev (dopo assertEpochsKnown e resolvePrev) cade dentro decryptItem
    const flaky = (err: unknown) => {
      let n = 0;
      const keys = { ...ctx2.keys };
      const prev = ctx2.keys.prev;
      Object.defineProperty(keys, 'prev', { get: () => { if (++n === 3) throw err; return prev; }, enumerable: true });
      useVaultStore.setState({ keys });
      return { ...ctx2, keys };
    };

    it('eccezione non-AEAD (transitoria) -> failed, NON unreadable', async () => {
      await putStale('a', 'NOTE', 'A', doc('a'));
      const r = await finishRotation({ ctx: flaky(new Error('boom')) });
      expect(r.failed).toEqual(['a']);
      expect(r.unreadable).toEqual([]);
      expect(srv.calls.migrate).toEqual([]);
    });

    it('MigrationError dentro prepare -> si propaga (non diventa failed)', async () => {
      await putStale('a', 'NOTE', 'A', doc('a'));
      await expect(finishRotation({ ctx: flaky(new MigrationError('epochChanged')) })).rejects.toMatchObject({ name: 'MigrationError', code: 'epochChanged' });
    });

    it('MigrationError nel ciclo di rewrapUnreadable -> si propaga (non diventa failed)', async () => {
      await putStale('a', 'NOTE', 'A', doc('a'));
      await expect(rewrapUnreadable(['a'], flaky(new MigrationError('epochChanged')))).rejects.toMatchObject({ name: 'MigrationError', code: 'epochChanged' });
    });
  });

  it('e-1 con prev ma tag errato -> damaged', async () => {
    const env = await putStale('a', 'NOTE', 'A', doc('a'));
    const i = env.length - 8;
    put('a', 'NOTE', '', env.slice(0, i) + (env[i] === 'A' ? 'B' : 'A') + env.slice(i + 1));
    const r = await finishRotation({ ctx: ctx2 });
    expect(r.migrated).toBe(0);
    expect(r.unreadable).toMatchObject([{ id: 'a', reason: 'damaged' }]);
    expect(srv.calls.migrate).toEqual([]);
  });

  it("epoch futura con il keyring a un'altra epoch (F) -> epochChanged, vault bloccato, zero /migrate (nemmeno per le altre note)", async () => {
    await putStale('good', 'NOTE', 'G', doc('g'));
    const fut = (await encryptItem('fut', 'CREDENTIAL', { t: '', c: '{}' }, ctx2)).replace('nv3.2.', 'nv3.3.');
    put('fut', 'CREDENTIAL', '', fut);
    srv.keyringEpoch = 3; // rotazione fatta altrove
    const lock = vi.spyOn(useVaultStore.getState(), 'lockVault');
    await expect(finishRotation({ ctx: ctx2 })).rejects.toMatchObject({ code: 'epochChanged' });
    expect(lock).toHaveBeenCalled();
    expect(srv.calls.migrate).toEqual([]);
    expect(srv.items.get('fut').content).toBe(fut);
  });

  it('envelope ben formato di epoch maggiore col keyring ancora a ctx.epoch -> unverifiable, nessun lock; le altre note proseguono', async () => {
    await putStale('good', 'NOTE', 'G', doc('g'));
    const fut = (await encryptItem('fut', 'NOTE', { t: '', c: '{}' }, ctx2)).replace('nv3.2.', 'nv3.5.');
    put('fut', 'NOTE', '', fut);
    const lock = vi.spyOn(useVaultStore.getState(), 'lockVault');
    const r = await finishRotation({ ctx: ctx2 });
    expect(lock).not.toHaveBeenCalled();
    expect(r.unreadable).toMatchObject([{ id: 'fut', reason: 'unverifiable' }]);
    expect(r.migrated).toBe(1);
    expect(srv.items.get('fut').content).toBe(fut);
  });

  it('nv3.5.x malformato su un vault a epoch 1 -> unverifiable, nessun lock, nessuna lettura del keyring (niente loop a ogni sblocco)', async () => {
    srv.epoch = 1;
    put('bad', 'NOTE', '', 'nv3.5.x');
    const lock = vi.spyOn(useVaultStore.getState(), 'lockVault');
    const r = await finishRotation({ ctx: { ...ctx2, epoch: 1 } });
    expect(lock).not.toHaveBeenCalled();
    expect(r.unreadable).toMatchObject([{ id: 'bad', reason: 'unverifiable' }]);
    expect(srv.calls.keyring).toBe(0);
  });

  describe("senza prev in sessione (sblocco offline): prevVkWrap dal keyring, senza PIN ne' /unlock", () => {
    beforeEach(() => { useVaultStore.setState({ keys: ctx2NoPrev.keys }); });

    it('e-1 con prevVkWrap valido -> migrata; lo store non cambia', async () => {
      await putStale('a', 'NOTE', 'A', doc('a'));
      await putStale('b', 'CREDENTIAL', 'B', JSON.stringify(cred()));
      srv.prevVkWrap = await validPrevWrap();
      const r = await finishRotation({ ctx: ctx2NoPrev });
      expect(r.migrated).toBe(2);
      expect(r.unreadable).toEqual([]);
      expect(srv.calls.keyring).toBe(1);
      expect(useVaultStore.getState().keys).toBe(ctx2NoPrev.keys);
      expect(useVaultStore.getState().keys!.prev).toBeUndefined();
      expect(await plain2('a')).toEqual({ t: 'A', c: doc('a') });
    });

    it('prevVkWrap nullo -> keyMissing, nessuna scrittura', async () => {
      await putStale('a', 'NOTE', 'A', doc('a'));
      await putStale('b', 'CREDENTIAL', 'B', JSON.stringify(cred()));
      const before = [...srv.items.values()].map((i) => i.content);
      const r = await finishRotation({ ctx: ctx2NoPrev });
      expect(r.migrated).toBe(0);
      expect(r.unreadable.map((u) => [u.id, u.reason])).toEqual([['a', 'keyMissing'], ['b', 'keyMissing']]);
      expect(srv.calls.migrate).toEqual([]);
      expect([...srv.items.values()].map((i) => i.content)).toEqual(before);
    });

    it('prevVkWrap spazzatura -> keyMissing, nessuna scrittura', async () => {
      await putStale('a', 'NOTE', 'A', doc('a'));
      srv.prevVkWrap = b64uEncode(new Uint8Array(60).fill(3));
      const r = await finishRotation({ ctx: ctx2NoPrev });
      expect(r.unreadable).toMatchObject([{ id: 'a', reason: 'keyMissing' }]);
      expect(srv.calls.migrate).toEqual([]);
    });

    it('prevVkWrap di lunghezza anomala (alfabeto b64url, 79 caratteri) -> broken, quindi keyMissing, nessuna scrittura', async () => {
      await putStale('a', 'NOTE', 'A', doc('a'));
      srv.prevVkWrap = 'A'.repeat(79);
      const r = await finishRotation({ ctx: ctx2NoPrev });
      expect(r.unreadable).toMatchObject([{ id: 'a', reason: 'keyMissing' }]);
      expect(srv.calls.migrate).toEqual([]);
    });

    it("keyring a un'epoch diversa da ctx -> epochChanged, vault bloccato, nessuna scrittura", async () => {
      await putStale('a', 'NOTE', 'A', doc('a'));
      srv.prevVkWrap = await validPrevWrap();
      srv.keyringEpoch = 3;
      const lock = vi.spyOn(useVaultStore.getState(), 'lockVault');
      await expect(finishRotation({ ctx: ctx2NoPrev })).rejects.toMatchObject({ code: 'epochChanged' });
      expect(lock).toHaveBeenCalled();
      expect(srv.calls.migrate).toEqual([]);
    });
  });

  it('con prev in sessione il keyring non si legge nemmeno se ha prevVkWrap', async () => {
    await putStale('a', 'NOTE', 'A', doc('a'));
    srv.prevVkWrap = 'x'.repeat(80);
    const r = await finishRotation({ ctx: ctx2 });
    expect(r.migrated).toBe(1);
    expect(srv.calls.keyring).toBe(0);
  });

  it('le note legacy SL non entrano in finishRotation (le migra migrateLegacy)', async () => {
    put('leg', 'NOTE', 'Legacy', doc('l'));
    const r = await finishRotation({ ctx: ctx2 });
    expect(r.migrated).toBe(0);
    expect(r.unreadable).toEqual([]);
    expect(srv.calls.migrate).toEqual([]);
    expect(srv.items.get('leg').content).toBe(doc('l'));
  });

  it('live: di default un lock ferma il giro; con live:false (recupero) no', async () => {
    await putStale('a', 'NOTE', 'A', doc('a'));
    useVaultStore.setState({ keys: null });
    await expect(finishRotation({ ctx: ctx2 })).rejects.toMatchObject({ code: 'locked' });
    expect(srv.calls.migrate).toEqual([]);
    const r = await finishRotation({ ctx: ctx2, live: false });
    expect(r.migrated).toBe(1);
  });

  describe('rewrapUnreadable', () => {
    it('NOTE e CREDENTIAL illeggibili -> envelope all\'epoch corrente con l\'envelope vecchio verbatim; finalizzate', async () => {
      put('n', 'NOTE', '', 'nv3.1.garbage-note');
      put('c', 'CREDENTIAL', '', 'nv3.1.garbage-cred');
      const r = await rewrapUnreadable(['n', 'c'], ctx2, { allowKeyMissingIds: ['n', 'c'] }); // malformate = U: serve il consenso
      expect([...r.rewrapped].sort()).toEqual(['c', 'n']);
      expect(staleCount()).toBe(0);
      expect(srv.calls.finalize.flat().sort()).toEqual(['c', 'n']);
      const body = JSON.parse((await plain2('n')).c);
      expect(body.type).toBe('doc');
      expect(body.content).toHaveLength(2);
      const msg = body.content[0].content[0].text as string;
      expect(msg).toMatch(/\S/);
      expect(msg).not.toBe('vault.rotation.unreadableNote');
      expect(body.content[1]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'nv3.1.garbage-note' }] });
      expect(JSON.parse((await plain2('c')).c)).toMatchObject({ siteUrl: '', username: '', password: '', notes: 'nv3.1.garbage-cred' });
    });

    it('K (e-1, nessuna prev) fuori da allowKeyMissingIds -> bucket keyMissing, nessuna scrittura; solo gli id in lista -> rewrapped', async () => {
      const env1 = await putStale('k1', 'NOTE', 'A', doc('a'));
      const env2 = await putStale('k2', 'NOTE', 'B', doc('b'));
      useVaultStore.setState({ keys: ctx2NoPrev.keys });
      let r = await rewrapUnreadable(['k1', 'k2'], ctx2NoPrev);
      expect([...r.keyMissing].sort()).toEqual(['k1', 'k2']);
      expect(r.rewrapped).toEqual([]);
      expect(srv.calls.migrate).toEqual([]);
      expect(srv.items.get('k1').content).toBe(env1);
      r = await rewrapUnreadable(['k1', 'k2'], ctx2NoPrev, { allowKeyMissingIds: ['k1'] });
      expect(r.rewrapped).toEqual(['k1']);
      expect(r.keyMissing).toEqual(['k2']);
      expect(srv.items.get('k2').content).toBe(env2); // una K non in lista non si tocca
    });

    it("il server che restituisce id in piu' di quelli chiesti: gli extra si ignorano, non si toccano", async () => {
      put('a', 'NOTE', '', 'nv3.1.garbage-a');
      put('x', 'NOTE', '', 'nv3.1.garbage-x');
      srv.extraOnIds = ['x'];
      const r = await rewrapUnreadable(['a'], ctx2, { allowKeyMissingIds: ['a'] });
      expect(r.rewrapped).toEqual(['a']);
      expect(r.notFound).toBe(0);
      expect(srv.calls.migrate.flat().map((i) => i.id)).toEqual(['a']);
      expect(srv.items.get('x').content).toBe('nv3.1.garbage-x');
    });

    it('D (e-1 con prev, tag errato) si re-incapsula senza flag', async () => {
      const env = await putStale('n', 'NOTE', 'N', doc('n'));
      const i = env.length - 8;
      put('n', 'NOTE', '', env.slice(0, i) + (env[i] === 'A' ? 'B' : 'A') + env.slice(i + 1));
      const r = await rewrapUnreadable(['n'], ctx2);
      expect(r.rewrapped).toEqual(['n']);
      expect(r.keyMissing).toEqual([]);
    });

    it('U (unverifiable: malformata) richiede il consenso come la K: senza flag resta intatta (bucket keyMissing), con flag si re-incapsula', async () => {
      put('u', 'NOTE', '', 'nv3.1.garbage-u');
      let r = await rewrapUnreadable(['u'], ctx2);
      expect(r.keyMissing).toEqual(['u']);
      expect(srv.items.get('u').content).toBe('nv3.1.garbage-u');
      r = await rewrapUnreadable(['u'], ctx2, { allowKeyMissingIds: ['u'] });
      expect(r.rewrapped).toEqual(['u']);
    });

    it('K diventata leggibile (nel frattempo il keyring ha un prevVkWrap valido) -> readable, non scritta', async () => {
      await putStale('a', 'NOTE', 'A', doc('a'));
      useVaultStore.setState({ keys: ctx2NoPrev.keys });
      srv.prevVkWrap = await validPrevWrap();
      const r = await rewrapUnreadable(['a'], ctx2NoPrev, { allowKeyMissingIds: ['a'] });
      expect(r.readable).toEqual(['a']);
      expect(r.rewrapped).toEqual([]);
      expect(srv.calls.migrate).toEqual([]);
    });

    it('esito already di /migrate -> readable (non unverified)', async () => {
      put('bad', 'NOTE', '', 'nv3.1.garbage');
      const cur = await encryptItem('bad', 'NOTE', { t: 'T', c: doc('c') }, ctx2);
      srv.beforeMigrate = () => put('bad', 'NOTE', '', cur); // un altro dispositivo l'ha gia' portata all'epoch corrente
      const r = await rewrapUnreadable(['bad'], ctx2, { allowKeyMissingIds: ['bad'] });
      expect(r.readable).toEqual(['bad']);
      expect(r.unverified).toEqual([]);
      expect(r.rewrapped).toEqual([]);
    });

    it("epoch futura con il keyring a un'altra epoch -> epochChanged, vault bloccato, zero /migrate", async () => {
      put('fut', 'NOTE', '', (await encryptItem('fut', 'NOTE', { t: '', c: '{}' }, ctx2)).replace('nv3.2.', 'nv3.3.'));
      put('bad', 'NOTE', '', 'nv3.1.garbage');
      srv.keyringEpoch = 3;
      const lock = vi.spyOn(useVaultStore.getState(), 'lockVault');
      await expect(rewrapUnreadable(['bad', 'fut'], ctx2)).rejects.toMatchObject({ code: 'epochChanged' });
      expect(lock).toHaveBeenCalled();
      expect(srv.calls.migrate).toEqual([]);
    });

    it('envelope vecchio oltre ~1,5 MiB -> tooLarge, non toccato (D7)', async () => {
      const big = 'nv3.1.' + 'x'.repeat(MAX_REWRAP_LEN);
      put('big', 'NOTE', '', big);
      const r = await rewrapUnreadable(['big'], ctx2, { allowKeyMissingIds: ['big'] });
      expect(r.tooLarge).toEqual(['big']);
      expect(r.rewrapped).toEqual([]);
      expect(srv.items.get('big').content).toBe(big);
      expect(srv.calls.migrate).toEqual([]);
    });

    it('nota diventata leggibile (o gia\' corrente) -> saltata; CAS perso -> conflicts', async () => {
      await putStale('ok', 'NOTE', 'T', doc('t'));
      put('cur', 'NOTE', '', await encryptItem('cur', 'NOTE', { t: 'T', c: doc('c') }, ctx2));
      put('bad', 'NOTE', '', 'nv3.1.garbage');
      let r = await rewrapUnreadable(['ok', 'cur'], ctx2);
      expect([...r.readable].sort()).toEqual(['cur', 'ok']);
      expect(r.rewrapped).toEqual([]);
      expect(srv.calls.migrate).toEqual([]);
      srv.beforeMigrate = () => put('bad', 'NOTE', '', 'nv3.1.changed-meanwhile');
      r = await rewrapUnreadable(['bad'], ctx2, { allowKeyMissingIds: ['bad'] });
      expect(r.conflicts).toEqual(['bad']);
      expect(srv.items.get('bad').content).toBe('nv3.1.changed-meanwhile');
      expect(srv.calls.finalize).toEqual([]);
    });
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
