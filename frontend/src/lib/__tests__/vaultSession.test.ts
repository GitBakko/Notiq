// @vitest-environment node
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { createHash, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installFakeIndexedDb, reset, stores, fail } from './fakeIndexedDb';

// window finto (solo EventTarget) PRIMA degli import: vaultSession registra il listener "storage"
const h = vi.hoisted(() => {
  // zustand persist legge window.localStorage: storage in memoria minimo
  const mem = new Map<string, string>();
  const win = Object.assign(new EventTarget(), {
    localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) },
  });
  (globalThis as unknown as { window: unknown }).window = win;
  /* eslint-disable @typescript-eslint/no-explicit-any -- righe Dexie e item di coda finti */
  return { server: null as unknown as FakeServer, apiRequest: vi.fn(), notes: [] as any[], queue: [] as any[], tags: [] as any[] };
});

// ---- mock: rete, cache SW, Argon2 (veloce e deterministico), authStore
vi.mock('../vaultApi', () => ({
  getKeyring: () => h.server.getKeyring(),
  createKeyring: (b: unknown) => h.server.createKeyring(b as CreateBody),
  unlock: (a: string, rev?: number) => h.server.unlock(a, rev),
  updateKeyring: (p: string, v: string) => h.server.updateKeyring(p, v),
}));
// rete vera sotto la vaultApi VERA (importActual): serve ai test sulla guardia di forma delle risposte 2xx
// rotateVault: controllo dei pending locali (solo envelope, mai plaintext)
// removeFromDevice({ force }): transazione finta (esegue il corpo), primaryKeys/bulkDelete/where().equals().filter().delete() su array
const drop = (arr: any[], pred: (x: any) => boolean) => { for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) arr.splice(i, 1); };
vi.mock('../db', () => ({
  db: {
    notes: {
      filter: (fn: (n: unknown) => boolean) => ({ count: async () => h.notes.filter(fn).length, primaryKeys: async () => h.notes.filter(fn).map((n) => n.id) }),
      bulkDelete: async (ids: string[]) => drop(h.notes, (n) => ids.includes(n.id)),
    },
    tags: {
      filter: (fn: (n: unknown) => boolean) => ({ primaryKeys: async () => h.tags.filter(fn).map((n) => n.id) }),
      bulkDelete: async (ids: string[]) => drop(h.tags, (n) => ids.includes(n.id)),
    },
    syncQueue: {
      filter: (fn: (i: unknown) => boolean) => ({ count: async () => h.queue.filter(fn).length }),
      where: () => ({ equals: (u: string) => ({ filter: (fn: (i: unknown) => boolean) => ({ delete: async () => drop(h.queue, (i) => i.userId === u && fn(i)) }) }) }),
    },
    transaction: async (...a: unknown[]) => (a[a.length - 1] as () => Promise<unknown>)(),
  },
}));
vi.mock('../api', () => ({ default: { request: (...a: unknown[]) => h.apiRequest(...a) } }));
vi.mock('../apiCache', () => ({ purgeApiCache: vi.fn(async () => {}), purgeVaultCache: vi.fn(async () => {}) }));
vi.mock('../../utils/argon2', async (orig) => {
  const real = await orig<typeof import('../../utils/argon2')>();
  return {
    ...real,
    deriveS: vi.fn(async (pin: string, salt: Uint8Array) =>
      new Uint8Array(createHash('sha256').update(pin.normalize('NFC')).update(salt).digest())),
  };
});
// wrapper passanti: i test leggono i buffer grezzi che il codice passa a wrapPrevVk/wrapEscrow (VK_old, VK_new) per verificare l'azzeramento
vi.mock('../../utils/vaultCrypto', async (orig) => {
  const real = await orig<typeof import('../../utils/vaultCrypto')>();
  return { ...real, wrapPrevVk: vi.fn(real.wrapPrevVk), wrapEscrow: vi.fn(real.wrapEscrow) };
});
vi.mock('../../store/authStore', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ user: { id: 'u1', email: 'a@b.c' } as { id: string; email: string } | null })) };
});

import * as session from '../vaultSession';
import { useVaultStore } from '../../store/vaultStore';
import { useAuthStore } from '../../store/authStore';
import { purgeApiCache } from '../apiCache';
import { DEFAULT_KDF, deriveS } from '../../utils/argon2';
import { getShare } from '../deviceKeyStore';
import { b64uDecode, b64uEncode, decryptItem, deriveAuthKey, deriveKekPin, deriveNoteKey, encryptItem, generateVkRaw, importVk, sha256hex, sha256hexBytes, unwrapPrevVk, unwrapVkPin, unwrapVkSigKey, wrapEscrow, wrapPrevVk } from '../../utils/vaultCrypto';

const U = 'u1';
const PIN = 'k7Rq2x';
const PIN2 = 'm4Tz9w';
const V1_ECDH_SPKI =
  '3076301006072a8648ce3d020106052b8104002203620004e6bc0a30815d358c204c38b0aa265f5ae73c053fc6bea50c435c7a094804f14065e4efa35f49019198bc9f3955201bbfa426a9f126b532c127c90c8241bda6490352a8dc8550b2f41f5d1bf26775bc67a1ed05aaee9d690ef83375910eab9315';
const ROOT = { id: 'rk_0123456789abcdef', ecdhSpki: new Uint8Array(Buffer.from(V1_ECDH_SPKI, 'hex')) };
// Stesso vettore di backend/src/__tests__/vault.keyring.test.ts (T1): 60 B 0x00..0x3b.
const ESCROW_VECTOR_HASH = '0ddde28e40838ef6f9853e887f597d6adb5f40eb35d5763c52e1e64d8ba3bfff';

interface CreateBody {
  expectedEpoch: number; kdfParams: { m: number; t: number; p: number }; pinSalt: string; wrappedVkPin: string; authKey: string;
  serverShare: string; vkSigPub: string; wrappedVkSigKey: string; escrowBlob: string; rootKeyId: string; sealedRootShare: string;
  userShareUnderVk: string; password: string; kdf: string;
}
/** `fromServer` false = risposta senza body errors.* (proxy IIS/ARR): un 503 cosi' non e' un rifiuto del vault. */
const apiErr = (status: number, key = 'errors.vault.x', fromServer = true) =>
  Object.assign(new Error(key), { name: 'VaultApiError', status, key, kind: 'x', fromServer });

/** Schema strict di PUT /keyring (vault.service.ts keyringUpdatePayloadSchema + assertRotationShape): chiavi extra o lunghezze sbagliate = 400, come il backend. */
function strictShape(p: Record<string, unknown>) {
  const bad = () => { throw apiErr(400, 'errors.vault.invalidPayload'); };
  const only = (o: unknown, keys: string[]) => { if (!o || typeof o !== 'object' || Object.keys(o).some((k) => !keys.includes(k))) bad(); };
  const len = (v: unknown, n: number | [number, number]) => {
    const l = typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v) ? Buffer.from(v, 'base64url').length : -1;
    if (Array.isArray(n) ? l < n[0] || l > n[1] : l !== n) bad();
  };
  only(p, ['rev', 'wrap', 'escrow', 'rotate']);
  const wrap = p.wrap as Record<string, unknown> | undefined;
  const escrow = p.escrow as Record<string, unknown> | undefined;
  const rotate = p.rotate as Record<string, unknown> | undefined;
  if (wrap) { only(wrap, ['kdf', 'kdfParams', 'pinSalt', 'wrappedVkPin', 'authKey', 'serverShare']); only(wrap.kdfParams, ['m', 't', 'p']); len(wrap.pinSalt, 16); len(wrap.wrappedVkPin, 60); len(wrap.authKey, 32); if (wrap.serverShare !== undefined) len(wrap.serverShare, 32); }
  if (escrow) { only(escrow, ['escrowBlob', 'sealedRootShare', 'rootKeyId', 'userShareUnderVk']); len(escrow.escrowBlob, 60); len(escrow.sealedRootShare, 157); len(escrow.userShareUnderVk, 48); }
  if (rotate) { only(rotate, ['vkSigPub', 'wrappedVkSigKey', 'prevVkWrap']); len(rotate.vkSigPub, 91); len(rotate.wrappedVkSigKey, [80, 220]); len(rotate.prevVkWrap, 60); }
  if (rotate ? !escrow || !wrap?.serverShare : escrow || wrap?.serverShare) bad(); // rotate <=> escrow + wrap.serverShare
}

class FakeServer {
  row: (CreateBody & { epoch: number; rev: number; prevVkWrap?: string | null }) | null = null;
  /** note ferme a un'epoch precedente (GET /keyring.staleCount; con rotate il PUT risponde 409 rotationPending) */
  staleCount = 0;
  unlockRevs: (number | undefined)[] = [];
  lockedUntil: string | null = null;
  createError: unknown = null;
  /** 'applyThen409': applica e poi risponde 409; 'bumpThen409': un altro device alza rev, 409 una volta; 'plain409': 409 senza applicare;
   *  'recoveryThen409': un recupero completato altrove ruota serverShare e authKey, alza rev, 409 */
  putMode: 'ok' | 'applyThen409' | 'bumpThen409' | 'plain409' | 'recoveryThen409' | 'recoveryOpen409' = 'ok';
  unlockError: unknown = null;
  unlockCalls = 0;
  puts: string[] = [];
  onCreate: (() => void) | null = null;
  onPut: (() => void) | null = null;
  escrowOverride: string | null = null;

  async getKeyring(): Promise<Record<string, unknown>> {
    const r = this.row;
    if (!r) return { status: 'NONE', epoch: 0, rev: 0, kdf: null, kdfParams: null, pinSalt: null, wrappedVkPin: null, wrappedVkSigKey: null, rootKeyId: null, lockedUntil: null, escrowHash: null, legacyCount: 0 };
    return {
      status: 'READY', epoch: r.epoch, rev: r.rev, kdf: 'argon2id', kdfParams: r.kdfParams, pinSalt: r.pinSalt, wrappedVkPin: r.wrappedVkPin,
      wrappedVkSigKey: r.wrappedVkSigKey, rootKeyId: r.rootKeyId, lockedUntil: this.lockedUntil, legacyCount: 0, prevVkWrap: r.prevVkWrap ?? null, staleCount: this.staleCount,
      escrowHash: this.escrowOverride ?? createHash('sha256').update(Buffer.from(r.escrowBlob, 'base64url')).digest('hex'),
    };
  }
  async createKeyring(b: CreateBody) {
    this.onCreate?.();
    if (this.createError) throw this.createError;
    if (this.row) throw apiErr(409, 'errors.vault.alreadySetup');
    this.row = { ...b, epoch: b.expectedEpoch, rev: 0 };
    return { status: 'READY', epoch: b.expectedEpoch, rev: 0 };
  }
  async unlock(authKey: string, rev?: number) {
    this.unlockCalls++;
    this.unlockRevs.push(rev);
    if (this.unlockError) throw this.unlockError;
    if (rev !== undefined && this.row && rev !== this.row.rev) throw apiErr(409, 'errors.vault.staleRev'); // senza contare il tentativo
    if (!this.row || authKey !== this.row.authKey) throw apiErr(403, 'errors.vault.invalidPin');
    return { serverShare: this.row.serverShare };
  }
  async updateKeyring(payload: string, proof: string) {
    this.onPut?.();
    this.puts.push(payload);
    const r = this.row!;
    const p = JSON.parse(payload) as { rev: number; wrap?: Partial<CreateBody>; escrow?: Partial<CreateBody>; rotate?: { vkSigPub: string; wrappedVkSigKey: string; prevVkWrap: string } };
    strictShape(p);
    const msg = `notiq/vault/v3/proof|PUT /api/vault/keyring|${U}|${r.epoch}|${p.rev}|${await sha256hex(payload)}`;
    const ok = verify('sha256', Buffer.from(msg), { key: Buffer.from(r.vkSigPub, 'base64url'), format: 'der', type: 'spki', dsaEncoding: 'ieee-p1363' }, Buffer.from(proof, 'base64url'));
    if (!ok) throw apiErr(400, 'errors.vault.invalidProof');
    if (this.putMode === 'plain409') throw apiErr(409, 'errors.vault.staleRev');
    if (this.putMode === 'recoveryOpen409') throw apiErr(409, 'errors.vault.recoveryInProgress');
    if (this.putMode === 'recoveryThen409') {
      r.rev++; r.serverShare = b64uEncode(new Uint8Array(32).fill(7)); r.authKey = b64uEncode(new Uint8Array(32).fill(9)); r.wrappedVkPin = b64uEncode(new Uint8Array(60).fill(5)); this.putMode = 'ok';
      throw apiErr(409, 'errors.vault.staleRev');
    }
    if (this.putMode === 'bumpThen409') { r.rev++; this.putMode = 'ok'; throw apiErr(409, 'errors.vault.staleRev'); }
    if (p.rev !== r.rev) throw apiErr(409, 'errors.vault.staleRev');
    if (p.rotate && this.staleCount > 0) throw apiErr(409, 'errors.vault.rotationPending');
    Object.assign(r, p.wrap ?? {}, p.escrow ?? {});
    if (p.rotate) { r.epoch++; r.vkSigPub = p.rotate.vkSigPub; r.wrappedVkSigKey = p.rotate.wrappedVkSigKey; r.prevVkWrap = p.rotate.prevVkWrap; }
    r.rev++;
    if (this.putMode === 'applyThen409') throw apiErr(409, 'errors.vault.staleRev');
    return { rev: r.rev, epoch: r.epoch };
  }
}

const st = () => useVaultStore.getState();
const baseArgs = { userId: U, pin: PIN, password: 'pw', rootKey: ROOT };
const raw = (name: string) => stores.get(name)!;
/** Risultati (gia' risolti) di tutte le chiamate a deriveS dal mockClear: sono i buffer S veri usati dal codice. */
const deriveResults = () => Promise.all(vi.mocked(deriveS).mock.results.map((r) => r.value as Promise<Uint8Array>));
const allZero = (a: Uint8Array) => a.length > 0 && a.every((x) => x === 0);

beforeAll(installFakeIndexedDb);
beforeEach(async () => {
  reset();
  h.server = new FakeServer();
  await st().lockVault();
  useVaultStore.setState({ byUser: {}, isSetup: false, pinHash: null });
  useAuthStore.setState({ user: { id: U, email: 'a@b.c' } });
  vi.mocked(purgeApiCache).mockClear();
  vi.mocked(deriveS).mockClear();
  h.notes.length = 0;
  h.queue.length = 0;
  h.tags.length = 0;
});
afterEach(() => vi.restoreAllMocks());

/** escrowHash dell'ultimo setup riuscito: serve a confirmKit(userId, escrowHash). */
let lastHash = '';
async function doSetup(over: Partial<Parameters<typeof session.setup>[0]> = {}) {
  const r = await session.setup({ ...baseArgs, offlineUnlock: true, ...over });
  if (!r.ok) throw new Error('setup non riuscito');
  lastHash = r.escrowHash;
  return r.kit;
}
/** Marker kit (uno per escrow, chiave <userId>:kit:<hash>) letti dallo store raw. */
const kitMarkers = () => [...raw('pending').entries()].filter(([k]) => k.startsWith(U + ':kit:')).map(([, v]) => v as Record<string, unknown>);
const putKit = (hash: string, o: Record<string, unknown> = {}) =>
  raw('pending').set(`${U}:kit:${hash}`, { kind: 'kit', escrowHash: hash, epoch: 0, rev: 0, origin: 'regenerate', ...o });
const putPin = (hash: string) => raw('pending').set(U + ':pin', { kind: 'pin', rev: 0, wrappedVkPinHash: hash });

describe('setup', () => {
  it('marker salvato prima della POST; 201 -> cache, share, unlock, purge, Kit dopo il 201', async () => {
    let markerAtPost: unknown = null;
    h.server.onCreate = () => { markerAtPost = kitMarkers()[0]; };
    const kit = await doSetup();
    // setup: rev null (committa solo da NONE), nessun createdAt/confirmed
    expect(markerAtPost).toEqual({ kind: 'kit', escrowHash: lastHash, epoch: 0, rev: null, origin: 'setup' });
    expect(kit).toHaveLength(20);
    expect(st().byUser[U]).toMatchObject({ status: 'READY', epoch: 0, rev: 0, offlineUnlock: true, rootKeyId: ROOT.id });
    expect(st().byUser[U].wrappedVkPin).toBeDefined();
    expect(st().keys).not.toBeNull();
    expect(st().unlockedUserId).toBe(U);
    expect(await getShare(U)).toMatchObject({ epoch: 0 });
    expect(purgeApiCache).toHaveBeenCalled();
    // il marker resta finche' l'utente non conferma i 2 gruppi
    expect(kitMarkers()).toHaveLength(1);
    await session.confirmKit(U, lastHash);
    expect(raw('pending').size).toBe(0);
  });

  it('marker = escrowHash dell\'escrowBlob inviato', async () => {
    await doSetup();
    const blob = Buffer.from(h.server.row!.escrowBlob, 'base64url');
    expect(blob).toHaveLength(60);
    expect(kitMarkers()[0]).toMatchObject({ escrowHash: createHash('sha256').update(blob).digest('hex') });
    expect(lastHash).toBe(createHash('sha256').update(blob).digest('hex')); // setup restituisce anche l'hash
  });

  it('vettore escrowHash condiviso col backend', async () => {
    expect(await sha256hexBytes(Uint8Array.from({ length: 60 }, (_, i) => i))).toBe(ESCROW_VECTOR_HASH);
  });

  it('offlineUnlock OFF: nessuno share, nessun wrappedVkPin in cache', async () => {
    await doSetup({ offlineUnlock: false });
    expect(raw('shares').size).toBe(0);
    expect(st().byUser[U].wrappedVkPin).toBeUndefined();
  });

  it('kdfParams del nuovo wrap = DEFAULT_KDF (costante, non letterale)', async () => {
    await doSetup();
    expect(h.server.row!.kdfParams).toEqual({ m: DEFAULT_KDF.m, t: DEFAULT_KDF.t, p: DEFAULT_KDF.p });
    expect(deriveS).toHaveBeenCalledWith(PIN, expect.any(Uint8Array), { m: DEFAULT_KDF.m, t: DEFAULT_KDF.t, p: DEFAULT_KDF.p });
    expect(st().byUser[U].kdfParams).toEqual(DEFAULT_KDF);
  });

  it('con DEFAULT_KDF.t = 4 il wrap usa t=4 e si apre solo con kdfCanon t=4', async () => {
    const saved = DEFAULT_KDF.t;
    DEFAULT_KDF.t = 4;
    try {
      await doSetup();
    } finally {
      DEFAULT_KDF.t = saved;
    }
    const row = h.server.row!;
    expect(row.kdfParams.t).toBe(4);
    expect(st().byUser[U].kdfParams.t).toBe(4);
    const S = await vi.mocked(deriveS)(PIN, b64uDecode(row.pinSalt), row.kdfParams);
    const kek = await deriveKekPin(S, b64uDecode(row.serverShare), b64uDecode(row.pinSalt), U);
    await expect(unwrapVkPin(kek, b64uDecode(row.wrappedVkPin), U, 0, { ...row.kdfParams })).resolves.toHaveLength(32);
    await expect(unwrapVkPin(kek, b64uDecode(row.wrappedVkPin), U, 0, { ...row.kdfParams, t: 3 })).rejects.toThrow();
  });

  it('409 alreadySetup: nessun Kit, GET, marker cancellato, nessun unlock', async () => {
    // il server risponde READY solo alla seconda GET: simula un setup concorrente da un altro dispositivo
    const first = h.server.getKeyring.bind(h.server);
    let n = 0;
    h.server.getKeyring = async () => (n++ === 0 ? first() : { ...(await first()), status: 'READY' });
    h.server.createError = apiErr(409, 'errors.vault.alreadySetup');
    const r = await session.setup({ ...baseArgs });
    expect(r).toEqual({ ok: false, reason: 'alreadySetup' });
    expect(n).toBeGreaterThanOrEqual(2);
    expect(raw('pending').size).toBe(0);
    expect(st().keys).toBeNull();
  });

  it('409 con keyring gia\' il NOSTRO (POST committata, risposta persa, ritentata): il marker resta e il setup riesce con Kit (item 6)', async () => {
    const apply = h.server.createKeyring.bind(h.server);
    h.server.createKeyring = async (b: CreateBody) => { await apply(b); throw apiErr(409, 'errors.vault.alreadySetup'); };
    const r = await session.setup({ ...baseArgs });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(kitMarkers().map((m) => m.escrowHash)).toEqual([r.escrowHash]);
    expect(st().byUser[U].rev).toBe(h.server.row!.rev);
    expect(st().keys).not.toBeNull();
    expect(await session.checkPendingOnStart(U)).toBe('kitUnconfirmed');
  });

  it('409 con keyring di un ALTRO escrow: il marker si cancella e non c\'e\' Kit (item 6)', async () => {
    h.server.createKeyring = async (b: CreateBody) => {
      h.server.row = { ...b, epoch: b.expectedEpoch, rev: 0, escrowBlob: b64uEncode(new Uint8Array(60).fill(3)) };
      throw apiErr(409, 'errors.vault.alreadySetup');
    };
    const r = await session.setup({ ...baseArgs });
    expect(r).toEqual({ ok: false, reason: 'alreadySetup' });
    expect(kitMarkers()).toHaveLength(0);
  });

  it('409 con la GET del keyring fallita: il marker NON si cancella senza confronto; al riavvio col keyring nostro -> kitUnconfirmed', async () => {
    const apply = h.server.createKeyring.bind(h.server);
    h.server.createKeyring = async (b: CreateBody) => { await apply(b); throw apiErr(409, 'errors.vault.alreadySetup'); };
    const get = h.server.getKeyring.bind(h.server);
    h.server.onCreate = () => { h.server.getKeyring = async () => { throw new Error('network'); }; }; // dopo la POST ogni GET fallisce
    const r = await session.setup({ ...baseArgs });
    expect(r).toEqual({ ok: false, reason: 'alreadySetup' });
    expect(kitMarkers()).toHaveLength(1);
    h.server.getKeyring = get;
    expect(await session.checkPendingOnStart(U)).toBe('kitUnconfirmed');
  });

  it('503 senza body del vault (proxy) al setup: ambiguo, il marker resta (item 5)', async () => {
    h.server.createError = apiErr(503, 'errors.common.unknownError', false);
    await expect(session.setup({ ...baseArgs })).rejects.toMatchObject({ status: 503 });
    expect(kitMarkers()).toHaveLength(1);
  });

  it.each([[400], [403], [503]])('%i -> marker pending{kit} cancellato subito (store raw)', async (status) => {
    h.server.onCreate = () => expect(raw('pending').size).toBe(1);
    h.server.createError = apiErr(status);
    await expect(session.setup({ ...baseArgs })).rejects.toMatchObject({ status });
    expect(raw('pending').size).toBe(0);
    expect(st().keys).toBeNull();
    expect(raw('shares').size).toBe(0);
  });

  it('errore ambiguo (5xx/rete): il marker resta per il controllo al riavvio', async () => {
    h.server.createError = apiErr(500);
    await expect(session.setup({ ...baseArgs })).rejects.toMatchObject({ status: 500 });
    expect(raw('pending').size).toBe(1);
  });

  it('GET con RESET_PENDING: notReady prima della POST', async () => {
    h.server.getKeyring = async () => ({ status: 'RESET_PENDING', epoch: 1, rev: 0 });
    let posted = false;
    h.server.onCreate = () => { posted = true; };
    await expect(session.setup({ ...baseArgs })).rejects.toMatchObject({ code: 'notReady', key: 'errors.vault.notReady' });
    expect(posted).toBe(false);
    expect(raw('pending').size).toBe(0);
  });

  it('errore di putShare: setup riesce, offlineSaved false, offlineUnlock resta false', async () => {
    fail.writes = 'shares';
    const r = await session.setup({ ...baseArgs, offlineUnlock: true });
    expect(r).toMatchObject({ ok: true, offlineSaved: false });
    expect(st().byUser[U].offlineUnlock).toBe(false);
    expect(raw('shares').size).toBe(0);
    expect(st().unlockedUserId).toBe(U);
  });

  it('offlineSaved true quando lo share e salvato o non richiesto', async () => {
    expect(await session.setup({ ...baseArgs, offlineUnlock: true })).toMatchObject({ ok: true, offlineSaved: true });
  });

  it('azzera S (risultato di deriveS) e pkcs8', async () => {
    const spy = vi.spyOn(crypto.subtle, 'exportKey');
    await doSetup();
    const sList = await deriveResults();
    expect(sList).toHaveLength(1);
    for (const S of sList) expect(allZero(S)).toBe(true);
    const idx = spy.mock.calls.findIndex((c) => c[0] === 'pkcs8');
    expect(idx).toBeGreaterThanOrEqual(0);
    const buf = (await spy.mock.results[idx].value) as ArrayBuffer;
    expect(allZero(new Uint8Array(buf))).toBe(true);
  });

  it('azzera i byte grezzi (VK, serverShare, S_root) ma non il Kit restituito', async () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    const kit = await doSetup();
    const big = spy.mock.results.map((r) => r.value as Uint8Array).filter((a) => a.length === 32);
    expect(big.length).toBeGreaterThanOrEqual(3); // vkRaw, serverShare, sRoot
    for (const a of big) expect(a.every((x) => x === 0)).toBe(true);
    expect(kit.some((x) => x !== 0)).toBe(true);
  });
});

describe('sblocco online', () => {
  beforeEach(async () => {
    await doSetup();
    await st().lockVault();
  });

  it('PIN giusto: sblocca, clearLegacy, purge; aggiorna la cache dal server', async () => {
    useVaultStore.setState({ isSetup: true, pinHash: 'x' });
    vi.mocked(purgeApiCache).mockClear();
    await session.unlockOnline(U, PIN);
    expect(st().unlockedUserId).toBe(U);
    expect(st().keys).not.toBeNull();
    expect(st().isSetup).toBe(false);
    expect(purgeApiCache).toHaveBeenCalledTimes(1);
  });

  it('offline OFF: lo share residuo viene cancellato', async () => {
    expect(raw('shares').size).toBe(1);
    await session.unlockOnline(U, PIN, { offlineUnlock: false });
    expect(raw('shares').size).toBe(0);
    expect(st().byUser[U].offlineUnlock).toBe(false);
  });

  it('errore di putShare allo sblocco: sblocca comunque, offlineSaved false', async () => {
    fail.writes = 'shares';
    await expect(session.unlockOnline(U, PIN, { offlineUnlock: true })).resolves.toEqual({ offlineSaved: false });
    expect(st().byUser[U].offlineUnlock).toBe(false);
    expect(st().unlockedUserId).toBe(U);
  });

  it('azzera S dopo lo sblocco', async () => {
    vi.mocked(deriveS).mockClear();
    await session.unlockOnline(U, PIN);
    const sList = await deriveResults();
    expect(sList).toHaveLength(1);
    for (const S of sList) expect(allZero(S)).toBe(true);
  });

  it('403 -> wrongPin', async () => {
    await expect(session.unlockOnline(U, PIN2)).rejects.toMatchObject({ code: 'wrongPin', key: 'errors.vault.invalidPin' });
    expect(st().keys).toBeNull();
  });

  it('429 -> GET per lockedUntil', async () => {
    const until = new Date(Date.now() + 60_000).toISOString();
    h.server.unlockError = apiErr(429, 'errors.vault.locked');
    const orig = h.server.getKeyring.bind(h.server);
    h.server.getKeyring = async () => ({ ...(await orig()), lockedUntil: h.server.unlockCalls ? until : null });
    await expect(session.unlockOnline(U, PIN)).rejects.toMatchObject({ code: 'pinLocked', lockedUntil: until });
  });

  it('lockedUntil nel futuro: nessuna chiamata a /unlock', async () => {
    h.server.lockedUntil = new Date(Date.now() + 60_000).toISOString();
    await expect(session.unlockOnline(U, PIN)).rejects.toMatchObject({ code: 'pinLocked' });
    expect(h.server.unlockCalls).toBe(0);
  });

  it('lockedUntil passato = sbloccato', async () => {
    h.server.lockedUntil = new Date(Date.now() - 1000).toISOString();
    await session.unlockOnline(U, PIN);
    expect(st().unlockedUserId).toBe(U);
  });

  it('409 notReady -> GET e errore notReady', async () => {
    h.server.unlockError = apiErr(409, 'errors.vault.notReady');
    await expect(session.unlockOnline(U, PIN)).rejects.toMatchObject({ code: 'notReady' });
  });

  it("keyring del server a epoch piu' bassa della cache: keyringRollback, non sblocca, cache invariata", async () => {
    await session.unlockOnline(U, PIN);
    await session.confirmKit(U, lastHash);
    await session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT });
    await st().lockVault();
    const cacheBefore = JSON.stringify(st().byUser[U]);
    expect(st().byUser[U].epoch).toBe(1);
    const unlocks = h.server.unlockCalls;
    h.server.row!.epoch = 0; // server ripristinato da un backup
    await expect(session.unlockOnline(U, PIN)).rejects.toMatchObject({ code: 'keyringRollback', key: 'errors.vault.keyringRollback' });
    expect(st().keys).toBeNull();
    expect(h.server.unlockCalls).toBe(unlocks);
    expect(JSON.stringify(st().byUser[U])).toBe(cacheBefore);
  });

  it('kdfParams del server fuori soglia: rifiutati prima di derivare (deriveS reale)', async () => {
    const real = await vi.importActual<typeof import('../../utils/argon2')>('../../utils/argon2');
    vi.mocked(deriveS).mockImplementationOnce(real.deriveS);
    h.server.row!.kdfParams = { m: 1024, t: 1, p: 1 };
    await expect(session.unlockOnline(U, PIN)).rejects.toThrow('kdfFailed');
    expect(h.server.unlockCalls).toBe(0);
  });
});

describe('sblocco offline e interruttore', () => {
  beforeEach(async () => {
    await doSetup();
    await st().lockVault();
  });

  it('PIN giusto sblocca senza rete; il tag GCM rifiuta il PIN errato', async () => {
    h.server.getKeyring = async () => { throw apiErr(0, 'errors.common.networkError'); };
    await session.unlockOffline(U, PIN);
    expect(st().unlockedUserId).toBe(U);
    expect(st().keys?.sigKey).toBeDefined();
    await st().lockVault();
    await expect(session.unlockOffline(U, PIN2)).rejects.toMatchObject({ code: 'wrongPin' });
    expect(st().keys).toBeNull();
  });

  it('share illeggibile (decryptFailed) -> offlineUnavailable', async () => {
    const sh = raw('shares').get(U) as { shareEnc: Uint8Array };
    sh.shareEnc = crypto.getRandomValues(new Uint8Array(64));
    await expect(session.unlockOffline(U, PIN)).rejects.toMatchObject({ code: 'offlineUnavailable', key: 'errors.vault.offlineUnavailable' });
    expect(st().keys).toBeNull();
  });

  it('wrappedVkSigKey locale corrotta con PIN giusto -> keyringInvalid', async () => {
    const sh = raw('shares').get(U) as { wrappedVkSigKey: Uint8Array };
    sh.wrappedVkSigKey = crypto.getRandomValues(new Uint8Array(96));
    await expect(session.unlockOffline(U, PIN)).rejects.toMatchObject({ code: 'keyringInvalid' });
    expect(st().keys).toBeNull();
  });

  it('switch OFF: cancella share e wrappedVkPin, tiene status/epoch/offlineUnlock:false', async () => {
    await session.setOfflineUnlock(U, false);
    expect(raw('shares').size).toBe(0);
    expect(st().byUser[U]).toMatchObject({ status: 'READY', epoch: 0, offlineUnlock: false });
    expect(st().byUser[U].wrappedVkPin).toBeUndefined();
    await expect(session.unlockOffline(U, PIN)).rejects.toMatchObject({ code: 'offlineUnavailable', key: 'errors.vault.offlineUnavailable' });
  });

  it('switch ON: vale dal prossimo sblocco online (share ricreato)', async () => {
    await session.setOfflineUnlock(U, false);
    await session.setOfflineUnlock(U, true);
    expect(raw('shares').size).toBe(0);
    await session.unlockOnline(U, PIN);
    expect(await getShare(U)).not.toBeNull();
    expect(st().byUser[U].wrappedVkPin).toBeDefined();
  });

  it('share di un epoch diverso dalla cache: non usabile', async () => {
    useVaultStore.setState({ byUser: { [U]: { ...st().byUser[U], epoch: 5 } } });
    await expect(session.unlockOffline(U, PIN)).rejects.toMatchObject({ code: 'offlineUnavailable' });
  });

  it('removeFromDevice cancella cache, chiave, share e marker', async () => {
    await session.removeFromDevice(U);
    expect(st().byUser[U]).toBeUndefined();
    expect(raw('deviceKeys').size + raw('shares').size + raw('pending').size).toBe(0);
  });

  it("removeFromDevice({ force }): toglie anche gli item di coda nota il cui content e' un envelope nv3. senza riga Dexie (ne' flag isVault); i non vault restano", async () => {
    h.queue.push(
      { entity: 'NOTE', userId: U, entityId: 'ghost', type: 'UPDATE', data: { content: 'nv3.1.aa.bb' } },
      { entity: 'NOTE', userId: U, entityId: 'plain', type: 'UPDATE', data: { content: '<p>ciao</p>' } },
      { entity: 'NOTE', userId: U, entityId: 'del', type: 'DELETE' },
    );
    await session.removeFromDevice(U, { force: true });
    expect(h.queue.map((i) => i.entityId)).toEqual(['plain', 'del']);
  });

  it('removeFromDevice senza force non tocca le righe Dexie (le gestisce il chiamante)', async () => {
    h.notes.push({ id: 'n', userId: U, isVault: true, syncStatus: 'updated' });
    await session.removeFromDevice(U);
    expect(h.notes).toHaveLength(1);
  });

  it("removeFromDevice({ force }) toglie anche righe e coda vault non sincronizzate dell'utente, non quelle degli altri ne' le note normali", async () => {
    h.notes.push(
      { id: 'n', userId: U, isVault: true, syncStatus: 'updated' },
      { id: 'm', userId: 'other', isVault: true, syncStatus: 'updated' },
      { id: 'p', userId: U, isVault: false, syncStatus: 'updated' },
    );
    h.tags.push({ id: 't', userId: U, isVault: true, syncStatus: 'created' });
    h.queue.push(
      { entity: 'NOTE', userId: U, entityId: 'n', type: 'UPDATE', data: { isVault: true, content: 'nv3.0.aa.bb' } },
      { entity: 'NOTE', userId: U, entityId: 'gone', type: 'UPDATE', data: { isVault: true, content: 'nv3.0.aa.bb' } },
      { entity: 'NOTE', userId: U, entityId: 'p', type: 'UPDATE', data: { title: 'x' } },
      { entity: 'NOTE', userId: 'other', entityId: 'm', type: 'UPDATE', data: { isVault: true } },
    );
    await session.removeFromDevice(U, { force: true });
    expect(h.notes.map((n) => n.id)).toEqual(['m', 'p']);
    expect(h.tags).toEqual([]);
    expect(h.queue.map((i) => i.entityId)).toEqual(['p', 'm']);
    expect(st().byUser[U]).toBeUndefined();
    expect(raw('deviceKeys').size + raw('shares').size + raw('pending').size).toBe(0);
  });
});

describe('cambio PIN', () => {
  beforeEach(async () => {
    await doSetup();
    await session.confirmKit(U, lastHash);
  });

  it('nuovo PIN attivo, vecchio no; wrap con DEFAULT_KDF; pending senza authKey ne\' payload; firma valida', async () => {
    let pendingDuringPut = '';
    h.server.onPut = () => { pendingDuringPut = JSON.stringify(raw('pending').get(U + ':pin')); };
    await session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 });
    const payload = h.server.puts[0];
    const wrap = JSON.parse(payload).wrap;
    expect(wrap.kdfParams).toEqual({ m: DEFAULT_KDF.m, t: DEFAULT_KDF.t, p: DEFAULT_KDF.p });
    expect(JSON.parse(pendingDuringPut)).toMatchObject({ kind: 'pin', rev: 0 });
    expect(pendingDuringPut).not.toContain(wrap.authKey);
    expect(pendingDuringPut).not.toContain('authKey');
    expect(pendingDuringPut).not.toContain('payload');
    expect(raw('pending').size).toBe(0);
    expect(st().byUser[U].rev).toBe(1);
    await st().lockVault();
    await expect(session.unlockOnline(U, PIN)).rejects.toMatchObject({ code: 'wrongPin' });
    await session.unlockOnline(U, PIN2);
    expect(st().unlockedUserId).toBe(U);
  });

  it('marker pin: chiavi esatte e hash = sha256 del wrappedVkPin inviato', async () => {
    let marker: Record<string, unknown> = {};
    h.server.onPut = () => { marker = raw('pending').get(U + ':pin') as Record<string, unknown>; };
    await session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 });
    expect(Object.keys(marker).sort()).toEqual(['epoch', 'kind', 'rev', 'wrappedVkPinHash']);
    expect(marker).toMatchObject({ epoch: 0, rev: 0 });
    const sent = JSON.parse(h.server.puts[0]).wrap.wrappedVkPin as string;
    expect(marker.wrappedVkPinHash).toBe(createHash('sha256').update(Buffer.from(sent, 'base64url')).digest('hex'));
  });

  it('PUT applicata poi errore di rete: il marker resta e al riavvio e pinApplied', async () => {
    const orig = h.server.updateKeyring.bind(h.server);
    h.server.updateKeyring = async (p: string, v: string) => { await orig(p, v); throw apiErr(0, 'errors.common.networkError'); };
    await expect(session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 })).rejects.toMatchObject({ status: 0 });
    expect(raw('pending').has(U + ':pin')).toBe(true);
    expect(await session.checkPendingOnStart(U)).toBe('pinApplied');
    expect(raw('pending').size).toBe(0);
  });

  it('Kit non confermato + changePin: il marker kit resta, quello pin si cancella', async () => {
    putKit('aa');
    await session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 });
    expect(raw('pending').has(U + ':kit:aa')).toBe(true);
    expect(raw('pending').has(U + ':pin')).toBe(false);
  });

  it('azzera entrambi gli S (PIN attuale e nuovo)', async () => {
    vi.mocked(deriveS).mockClear();
    await session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 });
    const sList = await deriveResults();
    expect(sList).toHaveLength(2);
    for (const S of sList) expect(allZero(S)).toBe(true);
  });

  it('con DEFAULT_KDF.t = 4 il nuovo wrap e la derivazione del nuovo PIN usano t=4', async () => {
    const saved = DEFAULT_KDF.t;
    DEFAULT_KDF.t = 4;
    try {
      await session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 });
    } finally {
      DEFAULT_KDF.t = saved;
    }
    expect(JSON.parse(h.server.puts[0]).wrap.kdfParams.t).toBe(4);
    expect(deriveS).toHaveBeenLastCalledWith(PIN2, expect.any(Uint8Array), { m: DEFAULT_KDF.m, t: 4, p: DEFAULT_KDF.p });
    expect(st().byUser[U].kdfParams.t).toBe(4);
    await st().lockVault();
    await session.unlockOnline(U, PIN2); // il server restituisce kdfParams t=4
    expect(st().keys).not.toBeNull();
  });

  it('409 con wrappedVkPin uguale al nostro: riuscito, un solo PUT', async () => {
    h.server.putMode = 'applyThen409';
    await session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 });
    expect(h.server.puts).toHaveLength(1);
    expect(raw('pending').size).toBe(0);
    expect(st().byUser[U].rev).toBe(1);
  });

  it('409 staleRev con wrap diverso: si ricostruisce con la nuova rev e riesce', async () => {
    h.server.putMode = 'bumpThen409';
    await session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 });
    expect(h.server.puts.map((p) => JSON.parse(p).rev)).toEqual([0, 1]);
    await st().lockVault();
    await session.unlockOnline(U, PIN2);
  });

  it('409 staleRev (epoch e wrappedVkPin invariati): il wrap si ricostruisce col serverShare in memoria, senza un secondo /unlock', async () => {
    h.server.putMode = 'bumpThen409';
    const before = h.server.unlockCalls;
    await session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 });
    expect(h.server.unlockCalls - before).toBe(1); // solo l'apertura iniziale: un tentativo in meno contro il lockout
    await st().lockVault();
    await session.unlockOnline(U, PIN2); // il wrap ricostruito vale
    expect(h.server.puts.map((p) => JSON.parse(p).rev)).toEqual([0, 1]);
    expect(st().byUser[U].rev).toBe(2);
    expect(raw('pending').size).toBe(0);
  });

  it('409 staleRev dopo un recupero altrove (wrappedVkPin cambiato): pinChangedElsewhere, 0 chiamate /unlock dopo il 409, nulla scritto', async () => {
    h.server.putMode = 'recoveryThen409';
    const rowBefore = { ...h.server.row! };
    const before = h.server.unlockCalls;
    await expect(session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 })).rejects.toMatchObject({
      code: 'pinChangedElsewhere', key: 'errors.vault.pinChangedElsewhere',
    });
    expect(h.server.unlockCalls - before).toBe(1); // solo l'apertura iniziale
    expect(h.server.puts).toHaveLength(1); // solo la PUT che ha ricevuto il 409
    const r = h.server.row!;
    expect(r.wrappedVkPin).toBe(b64uEncode(new Uint8Array(60).fill(5))); // quello del recupero, non toccato da noi
    expect(r.pinSalt).toBe(rowBefore.pinSalt);
    expect(raw('pending').size).toBe(0);
    expect(st().byUser[U].rev).toBe(0);
  });

  it('409 persistente: errore, pending cancellato (rifiuto definitivo)', async () => {
    h.server.putMode = 'plain409';
    await expect(session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 })).rejects.toMatchObject({ status: 409 });
    expect(h.server.puts).toHaveLength(2);
    expect(raw('pending').size).toBe(0);
  });

  it('503 pepperMismatch: pending cancellato subito e errore propagato', async () => {
    h.server.updateKeyring = async () => { throw apiErr(503, 'errors.vault.pepperMismatch'); };
    await expect(session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 })).rejects.toMatchObject({ key: 'errors.vault.pepperMismatch' });
    expect(raw('pending').size).toBe(0);
  });

  // item 4: il marker pin e' a slot unico, si cancella solo se e' ancora il nostro (compare-and-delete per hash)
  describe('un changePin concorrente (altra scheda) non perde il suo marker', () => {
    const OTHER_PIN_HASH = 'cd'.repeat(32);
    const steal = () => { h.server.onPut = () => putPin(OTHER_PIN_HASH); }; // l'altra scheda scrive il proprio marker dopo il nostro
    const otherIntact = () => expect(raw('pending').get(U + ':pin')).toMatchObject({ wrappedVkPinHash: OTHER_PIN_HASH });

    it('200', async () => {
      steal();
      await session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 });
      otherIntact();
    });
    it('409 con il nostro wrap gia\' applicato', async () => {
      steal();
      h.server.putMode = 'applyThen409';
      await session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 });
      otherIntact();
    });
    it('409 con wrap cambiato altrove (pinChangedElsewhere)', async () => {
      steal();
      h.server.putMode = 'recoveryThen409';
      await expect(session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 })).rejects.toMatchObject({ code: 'pinChangedElsewhere' });
      otherIntact();
    });
    it('rifiuto definitivo (400)', async () => {
      steal();
      h.server.updateKeyring = async () => { h.server.onPut?.(); throw apiErr(400); };
      await expect(session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 })).rejects.toMatchObject({ status: 400 });
      otherIntact();
    });
  });

  it('503 senza body del vault (proxy): ambiguo, il marker pin resta (item 5)', async () => {
    h.server.updateKeyring = async () => { throw apiErr(503, 'errors.common.unknownError', false); };
    await expect(session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 })).rejects.toMatchObject({ status: 503 });
    expect(raw('pending').has(U + ':pin')).toBe(true);
  });

  it('PIN attuale errato -> wrongPin, nessun PUT; da bloccato -> vaultLocked', async () => {
    await expect(session.changePin({ userId: U, currentPin: PIN2, newPin: 'a1b2c3' })).rejects.toMatchObject({ code: 'wrongPin' });
    expect(h.server.puts).toHaveLength(0);
    await st().lockVault();
    await expect(session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 })).rejects.toMatchObject({ code: 'vaultLocked' });
  });
});

describe('allineamento cache al keyring del server (J.6)', () => {
  type Cache = ReturnType<typeof useVaultStore.getState>['byUser'][string];
  let stale: Cache;
  beforeEach(async () => {
    await doSetup();
    await session.confirmKit(U, lastHash);
    stale = structuredClone(st().byUser[U]);
    await session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 }); // "altro dispositivo": il server ha il nuovo wrap
    await st().lockVault();
    useVaultStore.setState({ byUser: { [U]: stale } }); // questo dispositivo ha ancora la cache vecchia
  });

  it('rev piu\' alta sul server: cache aggiornata, offlineUnlock invariato; il vecchio PIN non sblocca piu\' offline', async () => {
    await session.unlockOffline(U, PIN); // prima del contatto online il vecchio PIN funziona (limite intrinseco)
    await st().lockVault();
    session.syncKeyringCache(U, await h.server.getKeyring() as unknown as session.KeyringDto);
    expect(st().byUser[U].rev).toBe(1);
    expect(st().byUser[U].offlineUnlock).toBe(true);
    await expect(session.unlockOffline(U, PIN)).rejects.toMatchObject({ code: 'wrongPin' });
    await session.unlockOffline(U, PIN2);
    expect(st().unlockedUserId).toBe(U);
  });

  it('refreshKeyringCache fa GET + sync e restituisce il keyring letto', async () => {
    const kr = await session.refreshKeyringCache(U);
    expect(st().byUser[U].rev).toBe(1);
    expect(kr).toMatchObject({ status: 'READY', rev: 1 });
  });

  it('rev uguale o piu\' bassa: cache invariata (mai indietro)', async () => {
    const kr = await h.server.getKeyring() as unknown as session.KeyringDto;
    session.syncKeyringCache(U, { ...kr, rev: stale.rev });
    session.syncKeyringCache(U, { ...kr, rev: stale.rev - 1 });
    expect(st().byUser[U]).toEqual(stale);
  });

  it('nessuna cache, NONE, keyring incompleto, errore di rete: nessuna scrittura e nessun throw', async () => {
    const kr = await h.server.getKeyring() as unknown as session.KeyringDto;
    session.syncKeyringCache('altro', kr);
    expect(st().byUser['altro']).toBeUndefined();
    session.syncKeyringCache(U, { ...kr, status: 'NONE' });
    session.syncKeyringCache(U, { ...kr, wrappedVkPin: null });
    h.server.getKeyring = async () => { throw apiErr(0, 'errors.common.networkError'); };
    await expect(session.refreshKeyringCache(U)).resolves.toBeUndefined();
    expect(st().byUser[U]).toEqual(stale);
  });
});

describe('rigenerazione del Kit', () => {
  beforeEach(async () => {
    await doSetup();
    await session.confirmKit(U, lastHash);
  });

  it('PUT prima: il Kit esce solo dopo il 200; marker con il nuovo escrowHash', async () => {
    const before = h.server.row!.escrowBlob;
    let markerAtPut: unknown = null;
    h.server.onPut = () => { markerAtPut = kitMarkers()[0]; };
    const { kit, escrowHash } = await session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT });
    expect(kit).toHaveLength(20);
    expect(h.server.puts).toHaveLength(1);
    expect(h.server.row!.escrowBlob).not.toBe(before);
    const hash = createHash('sha256').update(Buffer.from(h.server.row!.escrowBlob, 'base64url')).digest('hex');
    expect(escrowHash).toBe(hash);
    // (epoch, rev) del keyring su cui e' costruita la richiesta: dopo il PUT il server li supera
    expect(markerAtPut).toEqual({ kind: 'kit', escrowHash: hash, epoch: 0, rev: 0, origin: 'regenerate' });
    expect(st().byUser[U].rev).toBe(1);
  });

  it('409 con escrowHash uguale -> successo', async () => {
    h.server.putMode = 'applyThen409';
    const { kit } = await session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT });
    expect(kit).toHaveLength(20);
  });

  it('409 con escrowHash diverso -> kitNotUpdated, nessun Kit, marker cancellato', async () => {
    h.server.putMode = 'plain409';
    await expect(session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT })).rejects.toMatchObject({
      code: 'kitNotUpdated', key: 'errors.vault.kitNotUpdated',
    });
    expect(raw('pending').size).toBe(0);
  });

  it('409 recoveryInProgress -> errore con quella chiave, marker cancellato', async () => {
    h.server.putMode = 'recoveryOpen409';
    await expect(session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT })).rejects.toMatchObject({
      code: 'recoveryInProgress', key: 'errors.vault.recoveryInProgress',
    });
    expect(raw('pending').size).toBe(0);
  });

  // MAJOR 1 (§10.2): un marker `recovery` di un altro escrow (H1) non e' di nessuno di questi flussi
  describe('non toccano il marker recovery di un altro escrow', () => {
    const H1 = 'a1'.repeat(32);
    beforeEach(() => putKit(H1, { origin: 'recovery', requestId: 'r1', rev: 0 }));
    const intact = () => expect(kitMarkers().map((m) => m.escrowHash)).toContain(H1);

    it('200', async () => {
      await session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT });
      intact();
      expect(kitMarkers()).toHaveLength(2); // H1 + il proprio, ancora non confermato
    });
    it('409 con hash diverso', async () => {
      h.server.putMode = 'plain409';
      await expect(session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT })).rejects.toMatchObject({ code: 'kitNotUpdated' });
      intact();
      expect(kitMarkers()).toHaveLength(1); // solo il proprio e' stato cancellato
    });
    it('rifiuto definitivo (400)', async () => {
      h.server.updateKeyring = async () => { throw apiErr(400); };
      await expect(session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT })).rejects.toMatchObject({ status: 400 });
      intact();
      expect(kitMarkers()).toHaveLength(1);
    });
    it('errore di rete: il proprio marker resta, H1 pure', async () => {
      h.server.updateKeyring = async () => { throw apiErr(0); };
      await expect(session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT })).rejects.toMatchObject({ status: 0 });
      intact();
      expect(kitMarkers()).toHaveLength(2);
    });
    it('confirmKit(u, h2) cancella solo h2', async () => {
      const { escrowHash } = await session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT });
      await session.confirmKit(U, escrowHash);
      intact();
      expect(kitMarkers()).toHaveLength(1);
    });
  });

  // N5 (item 5): PUT committato + 503 di proxy (senza body del vault) = esito ambiguo, il marker resta
  it('N5: PUT committato e 503 senza body: il marker resta e al riavvio compare kitUnconfirmed', async () => {
    const orig = h.server.updateKeyring.bind(h.server);
    h.server.updateKeyring = async (p: string, v: string) => { await orig(p, v); throw apiErr(503, 'errors.common.unknownError', false); };
    await expect(session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT })).rejects.toMatchObject({ status: 503 });
    expect(kitMarkers()).toHaveLength(1);
    expect(await session.checkPendingOnStart(U)).toBe('kitUnconfirmed');
  });

  it('da bloccato non esiste; PIN errato -> wrongPin, nessun PUT', async () => {
    await expect(session.rotateVault({ userId: U, pin: PIN2, rootKey: ROOT })).rejects.toMatchObject({ code: 'wrongPin' });
    expect(h.server.puts).toHaveLength(0);
    await st().lockVault();
    await expect(session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT })).rejects.toMatchObject({ code: 'vaultLocked' });
  });
});

describe('rotazione della VK (rotateVault, P4 fase 5)', () => {
  let oldKeys: NonNullable<ReturnType<typeof st>['keys']>;
  beforeEach(async () => {
    await doSetup();
    await session.confirmKit(U, lastHash);
    oldKeys = st().keys!;
    vi.mocked(wrapPrevVk).mockClear();
    vi.mocked(wrapEscrow).mockClear();
  });
  const rotate = () => session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT });
  const aesRoundTrip = async (enc: CryptoKey, dec: CryptoKey) => {
    const iv = new Uint8Array(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, enc, new Uint8Array([1, 2, 3]));
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, dec, ct));
  };

  it('200: Kit, store a epoch+1 con prev = VK vecchia, share e cache a epoch+1, server ruotato', async () => {
    const oldPub = h.server.row!.vkSigPub;
    const { kit, escrowHash } = await rotate();
    expect(kit).toHaveLength(20);
    expect(h.server.puts).toHaveLength(1);
    const row = h.server.row!;
    expect(row.epoch).toBe(1);
    expect(row.vkSigPub).not.toBe(oldPub); // la proof e' stata verificata dal fake con la SPKI vecchia sull'epoch vecchia
    expect(row.prevVkWrap).toBeTruthy();
    expect(escrowHash).toBe(createHash('sha256').update(Buffer.from(row.escrowBlob, 'base64url')).digest('hex'));
    expect(st().epoch).toBe(1);
    expect(st().unlockedUserId).toBe(U);
    expect(st().keys!.prev).toMatchObject({ epoch: 0 });
    expect(await aesRoundTrip(oldKeys.vkAes, st().keys!.prev!.vkAes)).toEqual(new Uint8Array([1, 2, 3])); // prev e' la VK vecchia
    await expect(aesRoundTrip(oldKeys.vkAes, st().keys!.vkAes)).rejects.toBeDefined(); // e la corrente e' un'altra
    expect(st().byUser[U]).toMatchObject({ epoch: 1, rev: 1, pinSalt: row.pinSalt, wrappedVkPin: row.wrappedVkPin, rootKeyId: ROOT.id });
    expect(await getShare(U)).toMatchObject({ epoch: 1 });
    expect(kitMarkers().map((m) => m.escrowHash)).toEqual([escrowHash]);
  });

  it('il marker (epoch, rev) del keyring vecchio e\' scritto PRIMA della PUT', async () => {
    let markerAtPut: unknown = null;
    h.server.onPut = () => { markerAtPut = kitMarkers()[0]; };
    const { escrowHash } = await rotate();
    expect(markerAtPut).toEqual({ kind: 'kit', escrowHash, epoch: 0, rev: 0, origin: 'regenerate' });
  });

  it('PIN invariato: dopo il lock lo sblocco online con lo stesso PIN apre epoch+1 con prev', async () => {
    await rotate();
    await st().lockVault();
    await session.unlockOnline(U, PIN);
    expect(st().epoch).toBe(1);
    expect(st().keys!.prev).toMatchObject({ epoch: 0 });
    expect(await aesRoundTrip(oldKeys.vkAes, st().keys!.prev!.vkAes)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('sblocco online: prevVkWrap non apribile -> sblocco riuscito senza prev', async () => {
    await rotate();
    await st().lockVault();
    h.server.row!.prevVkWrap = b64uEncode(new Uint8Array(60).fill(3));
    await session.unlockOnline(U, PIN);
    expect(st().unlockedUserId).toBe(U);
    expect(st().epoch).toBe(1);
    expect(st().keys!.prev).toBeUndefined();
  });

  it('a epoch 0 un prevVkWrap eventuale e\' ignorato (nessuna epoch precedente)', async () => {
    await st().lockVault();
    h.server.row!.prevVkWrap = b64uEncode(new Uint8Array(60).fill(3));
    await session.unlockOnline(U, PIN);
    expect(st().keys!.prev).toBeUndefined();
  });

  it('sblocco offline dopo la rotazione: share a epoch+1, nessun prev (D4)', async () => {
    await rotate();
    await st().lockVault();
    await session.unlockOffline(U, PIN);
    expect(st().epoch).toBe(1);
    expect(st().keys!.prev).toBeUndefined();
  });

  it('409 con escrowHash uguale -> successo (store epoch+1 con prev)', async () => {
    h.server.putMode = 'applyThen409';
    const { kit } = await rotate();
    expect(kit).toHaveLength(20);
    expect(st().epoch).toBe(1);
    expect(st().keys!.prev).toMatchObject({ epoch: 0 });
    expect(st().byUser[U]).toMatchObject({ epoch: 1, rev: 1 });
    expect(await getShare(U)).toMatchObject({ epoch: 1 });
  });

  it('409 con escrowHash diverso -> kitNotUpdated, marker cancellato, store e share invariati', async () => {
    h.server.putMode = 'plain409';
    await expect(rotate()).rejects.toMatchObject({ code: 'kitNotUpdated', key: 'errors.vault.kitNotUpdated' });
    expect(raw('pending').size).toBe(0);
    expect(st().epoch).toBe(0);
    expect(st().keys!.vkAes).toBe(oldKeys.vkAes);
    expect(st().keys!.prev).toBeUndefined();
    expect(await getShare(U)).toMatchObject({ epoch: 0 });
  });

  it('staleCount > 0 dal GET: rotationPending, nulla scritto, nessun PIN speso', async () => {
    h.server.staleCount = 2;
    vi.mocked(deriveS).mockClear();
    await expect(rotate()).rejects.toMatchObject({ code: 'rotationPending', key: 'errors.vault.rotationPending' });
    expect(h.server.puts).toHaveLength(0);
    expect(h.server.unlockCalls).toBe(0);
    expect(deriveS).not.toHaveBeenCalled();
    expect(raw('pending').size).toBe(0);
    expect(st().epoch).toBe(0);
  });

  it('409 rotationPending dalla PUT (note stale comparse nel frattempo): rotationPending, marker cancellato', async () => {
    h.server.onPut = () => { h.server.staleCount = 1; };
    await expect(rotate()).rejects.toMatchObject({ code: 'rotationPending' });
    expect(raw('pending').size).toBe(0);
    expect(st().epoch).toBe(0);
  });

  it('PIN errato -> wrongPin, nessuna PUT', async () => {
    await expect(session.rotateVault({ userId: U, pin: PIN2, rootKey: ROOT })).rejects.toMatchObject({ code: 'wrongPin' });
    expect(h.server.puts).toHaveLength(0);
  });

  it('payload conforme allo schema strict (chiavi esatte, lunghezze, rotate <=> escrow + serverShare)', async () => {
    const oldSalt = h.server.row!.pinSalt;
    await rotate(); // il fake risponde 400 a ogni chiave extra o lunghezza sbagliata
    const p = JSON.parse(h.server.puts[0]) as Record<string, Record<string, string>>;
    expect(Object.keys(p).sort()).toEqual(['escrow', 'rev', 'rotate', 'wrap']);
    expect(Object.keys(p.rotate).sort()).toEqual(['prevVkWrap', 'vkSigPub', 'wrappedVkSigKey']);
    expect(Object.keys(p.wrap).sort()).toEqual(['authKey', 'kdf', 'kdfParams', 'pinSalt', 'serverShare', 'wrappedVkPin']);
    expect(p.wrap.kdfParams).toEqual({ m: DEFAULT_KDF.m, t: DEFAULT_KDF.t, p: 1 });
    expect(p.wrap.pinSalt).not.toBe(oldSalt); // salt nuovo, quindi seconda Argon2
    expect(deriveS).toHaveBeenCalledWith(PIN, b64uDecode(p.wrap.pinSalt), { m: DEFAULT_KDF.m, t: DEFAULT_KDF.t, p: DEFAULT_KDF.p });
  });

  it('byte grezzi di VK vecchia e nuova azzerati a fine rotazione, anche con la PUT rifiutata', async () => {
    await rotate();
    const vkNewRaw = vi.mocked(wrapEscrow).mock.calls[0][1];
    const vkOldRaw = vi.mocked(wrapPrevVk).mock.calls[0][1];
    expect(allZero(vkOldRaw)).toBe(true);
    expect(allZero(vkNewRaw)).toBe(true);
    vi.mocked(wrapPrevVk).mockClear();
    vi.mocked(wrapEscrow).mockClear();
    h.server.putMode = 'plain409';
    await expect(rotate()).rejects.toMatchObject({ code: 'kitNotUpdated' });
    expect(allZero(vi.mocked(wrapPrevVk).mock.calls[0][1])).toBe(true);
    expect(allZero(vi.mocked(wrapEscrow).mock.calls[0][1])).toBe(true);
  });
});

describe('rotateVault / changePin: epoch non in memoria, coda, ordine del commit', () => {
  let oldKeys: NonNullable<ReturnType<typeof st>['keys']>;
  beforeEach(async () => {
    await doSetup();
    await session.confirmKit(U, lastHash);
    oldKeys = st().keys!;
  });
  const rotate = () => session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT });
  /** Dispositivo B: sbloccato a epoch 0 mentre A ha ruotato il server a epoch 1 (stesso PIN). */
  const deviceBStale = async () => {
    await rotate();
    useVaultStore.setState({ keys: oldKeys, epoch: 0, unlockedUserId: U, isUnlocked: true });
    return h.server.puts.length;
  };

  it('rotateVault con epoch del server != epoch in memoria: epochChanged, vault bloccato, nessuna PUT', async () => {
    const puts = await deviceBStale();
    await expect(rotate()).rejects.toMatchObject({ code: 'epochChanged', key: 'errors.vault.epochChanged' });
    expect(h.server.puts).toHaveLength(puts);
    expect(h.server.row!.epoch).toBe(1);
    expect(st().keys).toBeNull();
    expect(st().isUnlocked).toBe(false);
  });

  it('epoch diversa E staleCount > 0: vince epochChanged (lock), non rotationPending', async () => {
    const puts = await deviceBStale();
    h.server.staleCount = 3;
    await expect(rotate()).rejects.toMatchObject({ code: 'epochChanged', key: 'errors.vault.epochChanged' });
    expect(h.server.puts).toHaveLength(puts);
    expect(st().keys).toBeNull();
    expect(st().isUnlocked).toBe(false);
  });

  it('changePin con epoch del server != epoch in memoria: stesso errore, vault bloccato, nessuna PUT', async () => {
    const puts = await deviceBStale();
    await expect(session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 })).rejects.toMatchObject({ code: 'epochChanged', key: 'errors.vault.epochChanged' });
    expect(h.server.puts).toHaveLength(puts);
    expect(st().keys).toBeNull();
  });

  it('vaultSession non importa nulla da features/ (il flush della coda è della UI)', () => {
    const src = readFileSync(fileURLToPath(new URL('../vaultSession.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/from '\.\.\/features\//);
  });

  describe('hasForeignEpochPending esportata (riusata dalla pagina per il rinvio del foglio forzato)', () => {
    it('true con una riga o un item di coda nv3.<e-1>. non sincronizzati; false per synced, e-2 o altri utenti', async () => {
      expect(await session.hasForeignEpochPending(U, 1)).toBe(false);
      h.notes.push({ id: 's', userId: U, isVault: true, syncStatus: 'synced', content: 'nv3.0.aa.bb' }, { id: 'o', userId: 'altro', isVault: true, syncStatus: 'updated', content: 'nv3.0.aa.bb' });
      expect(await session.hasForeignEpochPending(U, 1)).toBe(false);
      h.notes.push({ id: 'n', userId: U, isVault: true, syncStatus: 'updated', content: 'nv3.0.aa.bb' });
      expect(await session.hasForeignEpochPending(U, 1)).toBe(true);
      expect(await session.hasForeignEpochPending(U, 2)).toBe(false);
    });
  });

  describe("envelope locali non sincronizzati di un'altra epoch (localPending)", () => {
    beforeEach(async () => {
      await rotate(); // store a epoch 1: l'envelope "e-1" e' nv3.0.
      expect(st().epoch).toBe(1);
    });
    const puts = () => h.server.puts.length;

    it('riga vault non synced con nv3.<e-1>.: localPending, nessuna PUT', async () => {
      h.notes.push({ id: 'n', userId: U, isVault: true, syncStatus: 'updated', content: 'nv3.0.aa.bb', title: '' });
      const before = puts();
      await expect(rotate()).rejects.toMatchObject({ code: 'localPending', key: 'errors.vault.localPending' });
      expect(puts()).toBe(before);
      expect(st().epoch).toBe(1);
      expect(st().keys).not.toBeNull();
    });

    it("item di coda con envelope di un'altra epoch: localPending", async () => {
      h.queue.push({ entity: 'NOTE', userId: U, entityId: 'n', type: 'UPDATE', data: { isVault: true, content: 'nv3.0.aa.bb' } });
      const before = puts();
      await expect(rotate()).rejects.toMatchObject({ code: 'localPending' });
      expect(puts()).toBe(before);
    });

    it('riga dirty in e-2: non blocca', async () => {
      await rotate(); // epoch 2: e-2 = nv3.0.
      expect(st().epoch).toBe(2);
      h.notes.push({ id: 'n', userId: U, isVault: true, syncStatus: 'updated', content: 'nv3.0.aa.bb' });
      const before = puts();
      await rotate();
      expect(puts()).toBe(before + 1);
    });

    it('riga dirty malformata o di epoca futura: non blocca', async () => {
      h.notes.push(
        { id: 'a', userId: U, isVault: true, syncStatus: 'updated', content: 'nv3.zz' },
        { id: 'b', userId: U, isVault: true, syncStatus: 'updated', content: 'nv3.7.aa.bb' },
      );
      const before = puts();
      await rotate();
      expect(puts()).toBe(before + 1);
    });

    it('B7: il server omette prevVkWrap ma la sessione ha prev, con righe locali e-1 non sincronizzate: localPending, nessuna PUT', async () => {
      expect(st().keys!.prev).toBeDefined();
      h.server.row!.prevVkWrap = null;
      h.notes.push({ id: 'n', userId: U, isVault: true, syncStatus: 'updated', content: 'nv3.0.aa.bb' });
      const before = puts();
      await expect(rotate()).rejects.toMatchObject({ code: 'localPending' });
      expect(puts()).toBe(before);
    });

    it('riga dirty in e-1 con sessione senza prev e prevVkWrap assente: non blocca (non si aprirebbe comunque)', async () => {
      h.server.row!.prevVkWrap = null;
      const k = st().keys!;
      useVaultStore.setState({ keys: { vkHkdf: k.vkHkdf, vkAes: k.vkAes, sigKey: k.sigKey } });
      h.notes.push({ id: 'n', userId: U, isVault: true, syncStatus: 'updated', content: 'nv3.0.aa.bb' });
      const before = puts();
      await rotate();
      expect(puts()).toBe(before + 1);
    });

    it("caso normale: righe synced, non synced all'epoch corrente, di altri utenti, non vault -> la rotazione procede", async () => {
      h.notes.push(
        { id: 'a', userId: U, isVault: true, syncStatus: 'synced', content: 'nv3.0.aa.bb' },
        { id: 'b', userId: U, isVault: true, syncStatus: 'updated', content: 'nv3.1.aa.bb' },
        { id: 'c', userId: 'other', isVault: true, syncStatus: 'updated', content: 'nv3.0.aa.bb' },
        { id: 'd', userId: U, isVault: false, syncStatus: 'updated', content: '{"plain":1}' },
      );
      h.queue.push({ entity: 'NOTE', userId: U, entityId: 'b', type: 'UPDATE', data: { isVault: true, content: 'nv3.1.aa.bb' } });
      const before = puts();
      await rotate();
      expect(puts()).toBe(before + 1);
      expect(st().epoch).toBe(2);
    });
  });

  describe('ordine del commit di rotateVault', () => {
    it('unlock a epoch+1 subito dopo la cache, prima di ogni await: un refreshKeyringCache concorrente non blocca', async () => {
      let epochAtNextMicrotask: number | null | undefined;
      const unsub = useVaultStore.subscribe((s, prev) => {
        if (s.byUser[U]?.epoch === 1 && prev.byUser[U]?.epoch !== 1 && epochAtNextMicrotask === undefined) {
          void Promise.resolve().then(() => { epochAtNextMicrotask = st().epoch; });
        }
      });
      try {
        await rotate();
      } finally {
        unsub();
      }
      expect(epochAtNextMicrotask).toBe(1);
      expect(st().epoch).toBe(1);
    });

    it('vault bloccato durante la rotazione: cache e share aggiornati, NON si risblocca, il Kit si restituisce comunque', async () => {
      h.server.onPut = () => { void st().lockVault(); };
      const { kit } = await rotate();
      expect(kit).toHaveLength(20);
      expect(h.server.row!.epoch).toBe(1);
      expect(st().keys).toBeNull();
      expect(st().isUnlocked).toBe(false);
      expect(st().byUser[U]).toMatchObject({ epoch: 1, rev: 1 });
      expect(await getShare(U)).toMatchObject({ epoch: 1 });
      expect(purgeApiCache).toHaveBeenCalled();
    });

    it('bloccato e ri-sbloccato durante la rotazione a epoch vecchia: la sessione incoerente si blocca (lockVault)', async () => {
      h.server.onPut = () => {
        void st().lockVault();
        useVaultStore.setState({ keys: { ...oldKeys }, epoch: 0, unlockedUserId: U, isUnlocked: true });
      };
      await rotate();
      expect(st().keys).toBeNull();
      expect(st().isUnlocked).toBe(false);
      expect(st().byUser[U]).toMatchObject({ epoch: 1 });
    });

    it('ri-sbloccato durante la rotazione ma non a epoch vecchia: la sessione nuova non si tocca', async () => {
      let relocked: unknown = null;
      h.server.onPut = () => {
        void st().lockVault();
        useVaultStore.setState({ keys: { ...oldKeys }, epoch: 1, unlockedUserId: U, isUnlocked: true });
        relocked = st().keys;
      };
      await rotate();
      expect(st().keys).toBe(relocked);
      expect(st().epoch).toBe(1);
    });
  });
});

describe('syncKeyringCache: epoch del server oltre quella in memoria', () => {
  beforeEach(async () => { await doSetup(); await session.confirmKit(U, lastHash); });
  const krAt = async (over: Partial<session.KeyringDto>) => ({ ...(await h.server.getKeyring() as unknown as session.KeyringDto), ...over });

  it('durante la rotazione propria (dalla PUT al commit) un keyring a epoch+1 non blocca; a rotazione finita si', async () => {
    const kr1 = await krAt({ epoch: 1, rev: 1 });
    h.server.onPut = () => { session.syncKeyringCache(U, kr1); };
    await session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT });
    await Promise.resolve();
    expect(st().keys).not.toBeNull();
    expect(st().epoch).toBe(1);
    session.syncKeyringCache(U, await krAt({ epoch: 2, rev: 3 })); // flag azzerato: un'epoch oltre la memoria blocca di nuovo
    await vi.waitFor(() => expect(st().unlockedUserId).toBeNull());
  });

  it('il flag si azzera anche con la rotazione fallita (409 con hash diverso)', async () => {
    h.server.putMode = 'plain409';
    await expect(session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT })).rejects.toMatchObject({ code: 'kitNotUpdated' });
    session.syncKeyringCache(U, await krAt({ epoch: 1, rev: 3 }));
    await vi.waitFor(() => expect(st().unlockedUserId).toBeNull());
  });

  it('epoch piu\' alta -> lockVault, ma la cache resta all\'epoch verificata (B5)', async () => {
    session.syncKeyringCache(U, await krAt({ epoch: 1, rev: 3 }));
    await vi.waitFor(() => expect(st().unlockedUserId).toBeNull());
    expect(st().keys).toBeNull();
    expect(st().byUser[U].epoch).toBe(0);
  });
  it('stessa epoch (anche con rev piu\' alta) -> resta sbloccato', async () => {
    session.syncKeyringCache(U, await krAt({ rev: 5 }));
    await Promise.resolve();
    expect(st().unlockedUserId).toBe(U);
  });
  it('vault bloccato: nessun throw, resta bloccato', async () => {
    await st().lockVault();
    session.syncKeyringCache(U, await krAt({ epoch: 2, rev: 3 }));
    expect(st().unlockedUserId).toBeNull();
  });
  it('keyring NONE alla stessa epoch: nessun lock (RESET_PENDING e reset avvenuto: vedi la regola P3 in fondo)', async () => {
    session.syncKeyringCache(U, await krAt({ status: 'NONE', epoch: 0 }));
    await Promise.resolve();
    expect(st().unlockedUserId).toBe(U);
  });
  it('sbloccato per un altro utente: nessun lock', async () => {
    useVaultStore.setState({ byUser: { ...st().byUser, altro: st().byUser[U] } });
    session.syncKeyringCache('altro', await krAt({ epoch: 2, rev: 3 }));
    await Promise.resolve();
    expect(st().unlockedUserId).toBe(U);
  });
});

describe('cache del keyring: epoch solo verificata (B5) e rollback sul keyring riletto (B6)', () => {
  beforeEach(async () => { await doSetup(); await session.confirmKit(U, lastHash); });

  it('B5(i): una GET con epoch gonfiata prima dello sblocco non alza la cache; il keyring vero poi sblocca senza keyringRollback', async () => {
    await st().lockVault();
    const before = st().byUser[U].epoch;
    h.server.row!.epoch = before + 7; // GET gonfiata: il wrap non si apre (AAD con l'epoch vera)
    await expect(session.unlockOnline(U, PIN)).rejects.toBeTruthy();
    expect(st().byUser[U].epoch).toBe(before);
    session.syncKeyringCache(U, { ...(await h.server.getKeyring() as unknown as session.KeyringDto), epoch: before + 9, rev: 99 });
    expect(st().byUser[U].epoch).toBe(before);
    h.server.row!.epoch = before; // il server vero
    await session.unlockOnline(U, PIN);
    expect(st().unlockedUserId).toBe(U);
    expect(st().byUser[U].epoch).toBe(before);
  });

  it('B5(ii): uno sblocco riuscito a epoch e+1 (rotazione fatta altrove) alza la cache', async () => {
    const c0 = { ...st().byUser[U] };
    await session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT });
    await st().lockVault();
    st().setKeyringCache(U, c0); // questo dispositivo non ha visto la rotazione
    expect(st().byUser[U].epoch).toBe(0);
    await session.unlockOnline(U, PIN);
    expect(st().unlockedUserId).toBe(U);
    expect(st().byUser[U].epoch).toBe(1);
  });

  it('LOW-a: syncKeyringCache con epoch del server piu\' alta cancella lo share del dispositivo: offlineUnavailable fino a uno sblocco online, cache invariata', async () => {
    await st().lockVault();
    expect(raw('shares').size).toBe(1);
    session.syncKeyringCache(U, { ...(await h.server.getKeyring() as unknown as session.KeyringDto), epoch: 1, rev: 3 });
    await vi.waitFor(() => expect(raw('shares').size).toBe(0));
    expect(st().byUser[U].epoch).toBe(0);
    await expect(session.unlockOffline(U, PIN)).rejects.toMatchObject({ code: 'offlineUnavailable' });
    await session.unlockOnline(U, PIN); // lo sblocco online ripristina lo share (preferenza offline in cache)
    expect(raw('shares').size).toBe(1);
  });

  it('LOW-a: a parita\' di epoch (solo rev) lo share resta', async () => {
    await st().lockVault();
    session.syncKeyringCache(U, { ...(await h.server.getKeyring() as unknown as session.KeyringDto), rev: 5 });
    await Promise.resolve();
    expect(raw('shares').size).toBe(1);
  });

  it('F6 rotazione, 409 col nostro hash ma epoch non attesa: la cache non prende l\'epoch del server', async () => {
    const orig = h.server.updateKeyring.bind(h.server);
    let sentEscrowHash = '';
    h.server.updateKeyring = async (p: string, v: string) => {
      await orig(p, v);
      sentEscrowHash = createHash('sha256').update(Buffer.from(JSON.parse(p).escrow.escrowBlob, 'base64url')).digest('hex');
      throw apiErr(409, 'errors.vault.staleRev');
    };
    const realGet = h.server.getKeyring.bind(h.server);
    let lie = false;
    h.server.getKeyring = async () => { const k = await realGet() as { epoch: number }; return lie ? { ...k, epoch: k.epoch + 5, escrowHash: sentEscrowHash } : k; };
    const orig2 = h.server.updateKeyring;
    h.server.updateKeyring = async (p: string, v: string) => { try { return await orig2(p, v); } finally { lie = true; } };
    await session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT });
    expect(st().byUser[U].epoch).toBeLessThanOrEqual(1);
  });

  it('F6 setup, ramo alreadySetup (kr0 READY): nessuna cache scritta senza averla creata noi', async () => {
    await st().lockVault();
    useVaultStore.setState({ byUser: {} });
    h.server.row!.epoch = 5;
    const r = await session.setup({ ...baseArgs });
    expect(r).toEqual({ ok: false, reason: 'alreadySetup' });
    expect(st().byUser[U]).toBeUndefined();
  });

  it('F6 setup, ramo 409 alreadySetup (keyring di un altro): nessuna cache scritta', async () => {
    await st().lockVault();
    useVaultStore.setState({ byUser: {} });
    const first = h.server.getKeyring.bind(h.server);
    let n = 0;
    h.server.getKeyring = async () => (n++ === 0 ? { ...(await first()), status: 'NONE' as const } : first());
    h.server.createError = apiErr(409, 'errors.vault.alreadySetup');
    const r = await session.setup({ ...baseArgs });
    expect(r).toEqual({ ok: false, reason: 'alreadySetup' });
    expect(st().byUser[U]).toBeUndefined();
  });

  it('F6 checkPending con marker pin non applicato e keyring a epoch gonfiata: la cache non sale', async () => {
    h.server.updateKeyring = async () => { throw apiErr(0, 'errors.common.networkError'); }; // la PUT non arriva: marker pin resta
    await expect(session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 })).rejects.toMatchObject({ status: 0 });
    expect(raw('pending').has(U + ':pin')).toBe(true);
    h.server.row!.epoch = 6;
    await session.checkPendingOnStart(U);
    expect(st().byUser[U].epoch).toBe(0);
  });

  it('B6: il keyring riletto dopo il 409 staleRev a epoch piu\' bassa della cache -> keyringRollback, nessun secondo unlock', async () => {
    await session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT });
    await st().lockVault();
    expect(st().byUser[U].epoch).toBe(1);
    const real = h.server.getKeyring.bind(h.server);
    let n = 0;
    h.server.getKeyring = async () => {
      const k = await real();
      if (n++ === 0) { h.server.row!.rev++; return k; } // il primo e' regolare, ma l'unlock trovera' la rev cambiata (409 staleRev)
      return { ...k, epoch: 0 }; // il riletto e' un backup piu' vecchio
    };
    h.server.unlockRevs = [];
    await expect(session.unlockOnline(U, PIN)).rejects.toMatchObject({ code: 'keyringRollback', key: 'errors.vault.keyringRollback' });
    expect(h.server.unlockRevs).toHaveLength(1);
    expect(st().keys).toBeNull();
  });
});

describe('sblocco online: keyring cambiato fra GET e unlock (409 staleRev)', () => {
  it('unlock invia rev del keyring letto; al 409 si rilegge e si ritenta UNA volta col keyring fresco', async () => {
    await doSetup();
    await session.confirmKit(U, lastHash);
    const stale = await h.server.getKeyring();
    await session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 }); // altro dispositivo: salt e rev nuovi
    await st().lockVault();
    h.server.unlockRevs = [];
    const real = h.server.getKeyring.bind(h.server);
    let n = 0;
    h.server.getKeyring = async () => (n++ === 0 ? stale : real());
    await session.unlockOnline(U, PIN2);
    expect(st().unlockedUserId).toBe(U);
    expect(h.server.unlockRevs).toEqual([stale.rev, h.server.row!.rev]);
    expect(st().byUser[U]).toMatchObject({ rev: h.server.row!.rev, pinSalt: h.server.row!.pinSalt });
  });
  it('secondo staleRev di fila: nessun terzo tentativo, notReady', async () => {
    await doSetup();
    await session.confirmKit(U, lastHash);
    await st().lockVault();
    const stale = await h.server.getKeyring();
    h.server.row!.rev++;
    h.server.getKeyring = async () => stale; // il server e' sempre piu' avanti di cio' che si legge
    h.server.unlockRevs = [];
    await expect(session.unlockOnline(U, PIN)).rejects.toMatchObject({ code: 'notReady' });
    expect(h.server.unlockRevs).toHaveLength(2);
  });
});

describe('marker al riavvio (resolver: una GET /keyring, morte decisa da (epoch, rev))', () => {
  const HX = 'ee'.repeat(32); // un hash che non e' mai quello del keyring
  const outcome = () => session.checkPendingOnStart(U);

  it('kit nuovo: hash uguale -> kitUnconfirmed e il marker resta; il banner non cambia dopo rotateVault', async () => {
    await doSetup();
    expect(await outcome()).toBe('kitUnconfirmed');
    expect(kitMarkers()).toHaveLength(1);
    await session.confirmKit(U, lastHash);
    await session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT });
    expect(await outcome()).toBe('kitUnconfirmed');
    expect(kitMarkers()).toHaveLength(1);
  });

  describe('kit nuovo con rev (regenerate / recovery), hash diverso dal keyring', () => {
    beforeEach(async () => { await doSetup(); await session.confirmKit(U, lastHash); }); // keyring: epoch 0, rev 0

    it('epoch diversa -> cancellato', async () => {
      putKit(HX, { epoch: 1, rev: 5 });
      expect(await outcome()).toBe('none');
      expect(kitMarkers()).toHaveLength(0);
    });
    it('kr.rev > m.rev -> cancellato', async () => {
      h.server.row!.rev = 3;
      putKit(HX, { rev: 2 });
      expect(await outcome()).toBe('none');
      expect(kitMarkers()).toHaveLength(0);
    });
    it('stesso rev e hash diverso (F1): resta, nessun banner', async () => {
      putKit(HX, { rev: 0 });
      expect(await outcome()).toBe('none');
      expect(kitMarkers()).toHaveLength(1);
    });
    it('rev del keyring piu\' basso del marker: resta (il commit puo\' ancora arrivare)', async () => {
      putKit(HX, { rev: 1 });
      expect(await outcome()).toBe('none');
      expect(kitMarkers()).toHaveLength(1);
    });
    it('origin recovery: stessa regola', async () => {
      putKit(HX, { origin: 'recovery', requestId: 'r1', rev: 0 });
      expect(await outcome()).toBe('none');
      expect(kitMarkers()).toHaveLength(1);
      h.server.row!.rev = 1;
      expect(await outcome()).toBe('none');
      expect(kitMarkers()).toHaveLength(0);
    });
  });

  describe('kit nuovo del setup (rev null), hash diverso dal keyring', () => {
    it('keyring ancora NONE, stessa epoch: resta (il setup puo\' essere in volo)', async () => {
      putKit(HX, { origin: 'setup', rev: null });
      expect(await outcome()).toBe('none');
      expect(kitMarkers()).toHaveLength(1);
    });
    it('keyring non NONE -> cancellato', async () => {
      await doSetup();
      await session.confirmKit(U, lastHash);
      putKit(HX, { origin: 'setup', rev: null });
      expect(await outcome()).toBe('none');
      expect(kitMarkers()).toHaveLength(0);
    });
    it('epoch diversa (anche con keyring NONE) -> cancellato', async () => {
      putKit(HX, { origin: 'setup', rev: null, epoch: 0 });
      const first = h.server.getKeyring.bind(h.server);
      h.server.getKeyring = async () => ({ ...(await first()), epoch: 1 });
      expect(await outcome()).toBe('none');
      expect(kitMarkers()).toHaveLength(0);
    });
  });

  it('slot legacy P2 (<userId>:kit): hash uguale -> kitUnconfirmed e resta; diverso -> cancellato; mai riscritto', async () => {
    await doSetup();
    await session.confirmKit(U, lastHash);
    raw('pending').set(U + ':kit', { kind: 'kit', escrowHash: lastHash, confirmed: false });
    expect(await outcome()).toBe('kitUnconfirmed');
    expect(raw('pending').has(U + ':kit')).toBe(true);
    raw('pending').set(U + ':kit', { kind: 'kit', escrowHash: HX, confirmed: false });
    expect(await outcome()).toBe('none');
    expect(raw('pending').has(U + ':kit')).toBe(false);
  });

  it('kit dopo una rotateVault con rev oltre il marker di un altro escrow: solo quello superato muore', async () => {
    await doSetup();
    await session.confirmKit(U, lastHash);
    putKit(HX, { rev: 0 }); // costruito sullo stesso keyring (rev 0)
    const { escrowHash } = await session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT }); // rev -> 1: HX non puo' piu' committare
    expect(await outcome()).toBe('kitUnconfirmed');
    expect(kitMarkers().map((m) => m.escrowHash)).toEqual([escrowHash]);
  });

  it('nessun marker -> none, nessuna GET; GET fallita -> unknown e i marker restano (tutti i tipi)', async () => {
    const spy = vi.spyOn(h.server, 'getKeyring');
    expect(await outcome()).toBe('none');
    expect(spy).not.toHaveBeenCalled();
    putKit('aa');
    putPin('bb');
    raw('pending').set(U + ':kit', { kind: 'kit', escrowHash: 'cc', confirmed: false });
    h.server.getKeyring = async () => { throw apiErr(0); };
    expect(await outcome()).toBe('unknown');
    expect(raw('pending').size).toBe(3);
  });

  // N1 (item 7): il token cambia utente durante la GET, la risposta e' di B
  it('N1: utente del token cambiato prima o durante la GET -> unknown, nessuna scrittura ne\' cancellazione, cache intatta', async () => {
    await doSetup();
    const cacheBefore = JSON.stringify(st().byUser[U]);
    putKit(HX, { rev: 0 });
    putPin('dd');
    const g = h.server.getKeyring.bind(h.server);
    h.server.getKeyring = async () => {
      useAuthStore.setState({ user: { id: 'u2', email: 'b@b.c' } });
      return { ...(await g()), rev: 9, escrowHash: 'bb'.repeat(32), pinSalt: 'SALT_OF_B' };
    };
    const before = raw('pending').size;
    expect(await outcome()).toBe('unknown');
    expect(raw('pending').size).toBe(before);
    expect(JSON.stringify(st().byUser[U])).toBe(cacheBefore);
    // utente gia' diverso prima della GET: nessuna GET
    h.server.getKeyring = g;
    const spy = vi.spyOn(h.server, 'getKeyring');
    expect(await outcome()).toBe('unknown');
    expect(spy).not.toHaveBeenCalled();
    useAuthStore.setState({ user: { id: U, email: 'a@b.c' } });
    expect(await outcome()).toBe('kitUnconfirmed');
  });

  it('una sola GET /keyring per tutti i marker', async () => {
    await doSetup();
    putKit(HX, { rev: 0 });
    putPin('bb');
    const spy = vi.spyOn(h.server, 'getKeyring');
    await outcome();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('entrambi i marker: kit non confermato vince, il marker pin viene risolto e cancellato', async () => {
    await doSetup();
    putPin(await sha256hexBytes(b64uDecode(h.server.row!.wrappedVkPin)));
    expect(await outcome()).toBe('kitUnconfirmed');
    expect(raw('pending').has(U + ':pin')).toBe(false);
    expect(kitMarkers()).toHaveLength(1);
  });

  it('pin: applicato vs non applicato', async () => {
    await doSetup();
    await session.confirmKit(U, lastHash);
    putPin(await sha256hexBytes(b64uDecode(h.server.row!.wrappedVkPin)));
    expect(await outcome()).toBe('pinApplied');
    expect(raw('pending').size).toBe(0);
    putPin('ab'.repeat(32));
    h.server.row!.rev++; // il keyring ha superato la rev del marker con un altro wrap: il PUT non e' passato e non puo' piu' passare
    expect(await outcome()).toBe('pinNotApplied');
    expect(raw('pending').size).toBe(0);
  });

  // Q20 (giro 3): a parita' di rev l'hash diverso puo' essere un cambio PIN ancora in volo in un'altra scheda
  it('pin: hash diverso a parita\' di rev -> marker intatto, nessun esito (none)', async () => {
    await doSetup();
    await session.confirmKit(U, lastHash);
    putPin('ab'.repeat(32)); // rev 0, come il keyring
    expect(await outcome()).toBe('none');
    expect(raw('pending').get(U + ':pin')).toMatchObject({ wrappedVkPinHash: 'ab'.repeat(32) });
  });

  // regola unica col kit: contano solo (epoch, rev); uno status diverso da READY a parita' di rev non cancella il marker (PUT forse in volo)
  it('pin: hash diverso, keyring non READY con (epoch, rev) invariati -> marker intatto, nessun esito', async () => {
    await doSetup();
    await session.confirmKit(U, lastHash);
    putPin('ab'.repeat(32)); // epoch non indicato, rev 0
    h.server.getKeyring = async () => ({ status: 'RESET_PENDING', epoch: 0, rev: 0, kdf: null, kdfParams: null, pinSalt: null, wrappedVkPin: null, wrappedVkSigKey: null, rootKeyId: null, lockedUntil: null, escrowHash: null, legacyCount: 0 });
    expect(await outcome()).toBe('none');
    expect(raw('pending').has(U + ':pin')).toBe(true);
    h.server.getKeyring = async () => ({ status: 'RESET_PENDING', epoch: 0, rev: 1, kdf: null, kdfParams: null, pinSalt: null, wrappedVkPin: null, wrappedVkSigKey: null, rootKeyId: null, lockedUntil: null, escrowHash: null, legacyCount: 0 });
    expect(await outcome()).toBe('pinNotApplied'); // rev superata: ora si
    expect(raw('pending').has(U + ':pin')).toBe(false);
  });

  it('pin: hash diverso con epoch diversa a parita\' di rev -> pinNotApplied e marker cancellato; senza epoch (marker vecchio) vale solo la rev', async () => {
    await doSetup();
    await session.confirmKit(U, lastHash);
    raw('pending').set(U + ':pin', { kind: 'pin', rev: 0, epoch: 7, wrappedVkPinHash: 'ab'.repeat(32) });
    expect(await outcome()).toBe('pinNotApplied');
    expect(raw('pending').size).toBe(0);
    raw('pending').set(U + ':pin', { kind: 'pin', rev: 0, wrappedVkPinHash: 'ab'.repeat(32) }); // marker P2 senza epoch
    expect(await outcome()).toBe('none');
    expect(raw('pending').has(U + ':pin')).toBe(true);
  });

  it('Q20 scheda B fa checkPendingOnStart mentre il PUT di A e in volo, poi la risposta si perde: B non dice "non applicato", il riavvio dice pinApplied', async () => {
    await doSetup();
    await session.confirmKit(U, lastHash);
    const orig = h.server.updateKeyring.bind(h.server);
    let tabB = '';
    h.server.updateKeyring = async (p: string, v: string) => {
      tabB = await session.checkPendingOnStart(U);
      await orig(p, v);
      throw apiErr(0, 'errors.common.networkError', false);
    };
    await expect(session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 })).rejects.toMatchObject({ status: 0 });
    expect(tabB).toBe('none');
    expect(raw('pending').has(U + ':pin')).toBe(true);
    expect(await session.checkPendingOnStart(U)).toBe('pinApplied');
    expect(raw('pending').size).toBe(0);
  });

  it('pin: se un\'altra scheda ha gia\' cancellato il marker (compare-and-delete false) -> none, niente toast doppio', async () => {
    await doSetup();
    await session.confirmKit(U, lastHash);
    putPin(await sha256hexBytes(b64uDecode(h.server.row!.wrappedVkPin)));
    const first = h.server.getKeyring.bind(h.server);
    h.server.getKeyring = async () => { raw('pending').delete(U + ':pin'); return first(); }; // l'altra scheda vince la corsa durante la GET
    expect(await outcome()).toBe('none');
  });

  // Regressione StrictMode (P2 del red-team): due esecuzioni dell'effect, anche con navigator.locks occupato, ricevono lo stesso esito
  it('due checkPendingOnStart concorrenti -> entrambe pinApplied, una sola GET, anche con navigator.locks occupato', async () => {
    await doSetup();
    await session.confirmKit(U, lastHash);
    putPin(await sha256hexBytes(b64uDecode(h.server.row!.wrappedVkPin)));
    vi.stubGlobal('navigator', { locks: { request: async (_n: string, _o: unknown, cb: (l: null) => unknown) => cb(null) } });
    const spy = vi.spyOn(h.server, 'getKeyring');
    try {
      const [a, b] = await Promise.all([outcome(), outcome()]);
      expect([a, b]).toEqual(['pinApplied', 'pinApplied']);
      expect(spy).toHaveBeenCalledTimes(1);
      // la promise in volo si toglie al settle: una chiamata successiva rifa la lettura
      expect(await outcome()).toBe('none');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('due chiamate concorrenti, kit non confermato: entrambe kitUnconfirmed', async () => {
    await doSetup();
    const [a, b] = await Promise.all([outcome(), outcome()]);
    expect([a, b]).toEqual(['kitUnconfirmed', 'kitUnconfirmed']);
  });
});

describe('cambio utente senza logout', () => {
  it('setAuth di un altro utente blocca il vault; lo stesso utente no', async () => {
    await doSetup();
    useAuthStore.setState({ user: { id: U, email: 'a@b.c' } });
    expect(st().unlockedUserId).toBe(U);
    useAuthStore.setState({ user: { id: 'u2', email: 'b@b.c' } });
    expect(st().unlockedUserId).toBeNull();
    expect(st().keys).toBeNull();
  });
});

describe('cambio utente da un\'altra scheda (evento storage)', () => {
  const fire = (newValue: string | null, key = 'auth-storage') =>
    window.dispatchEvent(Object.assign(new Event('storage'), { key, newValue }));
  const authJson = (id: string) => JSON.stringify({ state: { user: { id }, token: 't' }, version: 0 });

  it('u2 in auth-storage blocca il vault; stesso utente o altra chiave no (JSON rotto/logout li blocca vaultStore)', async () => {
    await doSetup();
    fire(authJson(U));
    fire(authJson('u2'), 'altra-chiave');
    expect(st().unlockedUserId).toBe(U);
    fire(authJson('u2'));
    expect(st().unlockedUserId).toBeNull();
    expect(st().keys).toBeNull();
  });

  it('logout da un\'altra scheda (newValue assente) blocca il vault', async () => {
    await doSetup();
    fire(null);
    expect(st().keys).toBeNull();
  });
});

describe('autoconsistenza dei test', () => {
  it('authKey derivata dal PIN coincide con quella inviata al setup', async () => {
    await doSetup();
    const S = await vi.mocked(deriveS)(PIN, b64uDecode(h.server.row!.pinSalt), DEFAULT_KDF);
    expect(b64uEncode(await deriveAuthKey(S, U))).toBe(h.server.row!.authKey);
  });
});

// Un 2xx con un body che non e' del vault (portale, proxy, errore IIS con 200) passa dalla guardia di forma di vaultApi (VERA, via importActual): errore di rete, mai un fatto.
describe('risposta 2xx non del vault (guardia di forma)', () => {
  const BODIES: [string, unknown][] = [['html', '<html>portal</html>'], ['vuoto', {}], ['rev stringa', { status: 'READY', epoch: 0, rev: 'x' }]];
  const realApi = async (body: unknown) => {
    const real = await vi.importActual<typeof import('../vaultApi')>('../vaultApi');
    h.apiRequest.mockReset();
    h.apiRequest.mockResolvedValue({ data: body });
    return real;
  };

  it.each(BODIES)('X3 marker kit di un setup committato + GET /keyring (%s): unknown, il marker resta (non si cancella come "superato")', async (_n, body) => {
    await doSetup();
    const real = await realApi(body);
    h.server.getKeyring = () => real.getKeyring();
    expect(await session.checkPendingOnStart(U)).toBe('unknown');
    expect(kitMarkers()).toHaveLength(1);
  });

  it.each(BODIES)('X4 marker pin + GET /keyring (%s): unknown, il marker pin resta', async (_n, body) => {
    await doSetup();
    await session.confirmKit(U, lastHash);
    putPin('ab'.repeat(32));
    const real = await realApi(body);
    h.server.getKeyring = () => real.getKeyring();
    expect(await session.checkPendingOnStart(U)).toBe('unknown');
    expect(raw('pending').get(U + ':pin')).toMatchObject({ wrappedVkPinHash: 'ab'.repeat(32) });
  });

  it.each(BODIES)('X8 rotateVault e changePin con PUT 200 (%s): errore di rete, nessun Kit, nessun ok, cache e marker non avanzano', async (_n, body) => {
    await doSetup();
    await session.confirmKit(U, lastHash);
    const real = await realApi(body);
    h.server.updateKeyring = (p: string, v: string) => real.updateKeyring(p, v);
    const rev = st().byUser[U].rev;
    const escrow = h.server.row!.escrowBlob;
    const regen = await session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT }).then(() => 'ok', (e: unknown) => e);
    expect(regen).not.toBe('ok');
    expect(regen).toMatchObject({ status: 0 });
    const cp = await session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 }).then(() => 'ok', (e: unknown) => e);
    expect(cp).not.toBe('ok');
    expect(cp).toMatchObject({ status: 0 });
    expect(st().byUser[U].rev).toBe(rev);
    expect(h.server.row!.escrowBlob).toBe(escrow);
    expect(h.server.puts).toHaveLength(0); // il server non ha visto nulla: la risposta spazzatura era di un intermediario
  });
});

describe('Y2 PUT del cambio PIN in timeout, committata dopo; secondo tentativo con lo stesso PIN', () => {
  it('il secondo tentativo trova il wrap cambiato (409): pinChangedElsewhere, che il testo spiega come "forse un tuo tentativo precedente"; il nuovo PIN apre', async () => {
    await doSetup();
    await session.confirmKit(U, lastHash);
    const orig = h.server.updateKeyring.bind(h.server);
    let first: [string, string] | null = null;
    let n = 0;
    h.server.updateKeyring = async (p: string, v: string) => {
      if (++n === 1) { first = [p, v]; throw apiErr(0, 'errors.common.networkError', false); } // timeout lato client: il server la elabora piu' tardi
      if (n === 2) await orig(...first!);
      return orig(p, v);
    };
    await expect(session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 })).rejects.toMatchObject({ status: 0 });
    await expect(session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 })).rejects.toMatchObject({ code: 'pinChangedElsewhere', key: 'errors.vault.pinChangedElsewhere' });
    await st().lockVault();
    await expect(session.unlockOnline(U, PIN2)).resolves.toBeDefined(); // il PIN del primo tentativo vale
  });
});

describe('(k) rotationParts: i pezzi della rotazione, con sonde', () => {
  const EO = 4;
  const mk = async () => {
    const vkOldRaw = generateVkRaw();
    return { vkOldRaw, vkOld: await importVk(vkOldRaw) };
  };

  it('prev si riapre con la VK nuova e da la VK vecchia; la firma verifica con spki; il wrap della sigKey si apre a epoch+1', async () => {
    const { vkOldRaw, vkOld } = await mk();
    const p = await session.rotationParts(vkOldRaw, vkOld, U, EO);
    expect(p.vkNewRaw).toHaveLength(32);
    expect(p.vkNewRaw).not.toEqual(vkOldRaw);
    const prev = await unwrapPrevVk(p.vkNew, p.prevVkWrap, U, EO + 1, EO);
    const ctx = { userId: U, noteId: 'n1', noteType: 'NOTE', epoch: EO };
    const env = await encryptItem(await deriveNoteKey(vkOld, ctx.noteId), ctx, { t: 't', c: 'c' });
    expect((await decryptItem(await deriveNoteKey(prev, ctx.noteId), ctx, env)).c).toBe('c');
    const key = await unwrapVkSigKey(p.vkNew, p.wrappedVkSigKey, U, EO + 1);
    const ecdsa = { name: 'ECDSA', hash: 'SHA-256' } as const;
    const pub = await crypto.subtle.importKey('spki', p.sig.spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const msg = new Uint8Array([9, 8, 7]);
    expect(await crypto.subtle.verify(ecdsa, pub, await crypto.subtle.sign(ecdsa, key, msg), msg)).toBe(true);
    expect(p.prevVkWrap).toHaveLength(60);
  });

  it('sonda prev manomessa -> keyringInvalid', async () => {
    const { vkOldRaw, vkOld } = await mk();
    vi.mocked(wrapPrevVk).mockResolvedValueOnce(new Uint8Array(60));
    await expect(session.rotationParts(vkOldRaw, vkOld, U, EO)).rejects.toMatchObject({ code: 'keyringInvalid' });
  });

  it('sonda firma manomessa -> keyringInvalid', async () => {
    const { vkOldRaw, vkOld } = await mk();
    vi.spyOn(crypto.subtle, 'verify').mockResolvedValueOnce(false);
    await expect(session.rotationParts(vkOldRaw, vkOld, U, EO)).rejects.toMatchObject({ code: 'keyringInvalid' });
  });
});

describe('guardia contro backend 1.14 (serverOutdated)', () => {
  beforeEach(async () => {
    await doSetup();
    await session.confirmKit(U, lastHash);
    vi.mocked(deriveS).mockClear();
  });
  /** Un backend 1.14 non manda mai staleCount: dalla n-esima GET (0 = sempre) in poi lo toglie. */
  const dropStaleCountFrom = (from: number, onFirst?: () => void) => {
    const real = h.server.getKeyring.bind(h.server);
    let n = 0;
    h.server.getKeyring = async () => {
      const k = await real();
      if (n++ === 0) onFirst?.();
      if (n - 1 >= from) delete k.staleCount;
      return k;
    };
  };
  const snapshot = () => ({ epoch: st().epoch, keys: st().keys, entry: JSON.stringify(st().byUser[U]), unlocked: st().unlockedUserId });
  const expectUntouched = (before: ReturnType<typeof snapshot>) => {
    expect(h.server.puts).toHaveLength(0);
    expect(st().epoch).toBe(before.epoch);
    expect(st().keys).toBe(before.keys);
    expect(JSON.stringify(st().byUser[U])).toBe(before.entry);
    expect(st().unlockedUserId).toBe(before.unlocked);
    expect(kitMarkers()).toHaveLength(0);
    expect(raw('pending').size).toBe(0);
  };
  const outdated = { code: 'serverOutdated', key: 'errors.vault.serverOutdated' };

  it('(a) rotateVault: prima GET senza staleCount -> serverOutdated, nessun unlock/Argon2/PUT, store invariato', async () => {
    dropStaleCountFrom(0);
    const before = snapshot();
    const unlocks = h.server.unlockCalls;
    await expect(session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT })).rejects.toMatchObject(outdated);
    expect(h.server.unlockCalls).toBe(unlocks);
    expect(deriveS).not.toHaveBeenCalled();
    expectUntouched(before);
  });

  it('(b) rotateVault: GET riletta da openKeyring senza staleCount -> serverOutdated, 0 PUT, store invariato', async () => {
    dropStaleCountFrom(1, () => { h.server.row!.rev++; }); // la rev cambia fra GET e unlock: 409 staleRev, openKeyring rilegge
    const before = snapshot();
    await expect(session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT })).rejects.toMatchObject(outdated);
    expect(h.server.unlockRevs).toHaveLength(2); // prima unlock -> 409 staleRev, seconda sul keyring riletto
    expectUntouched(before);
  });

  it('(c) changePin: GET senza staleCount -> serverOutdated, nessun unlock/Argon2/PUT, store invariato', async () => {
    dropStaleCountFrom(0);
    const before = snapshot();
    const unlocks = h.server.unlockCalls;
    await expect(session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 })).rejects.toMatchObject(outdated);
    expect(h.server.unlockCalls).toBe(unlocks);
    expect(deriveS).not.toHaveBeenCalled();
    expectUntouched(before);
  });

  it('(d) changePin: GET riletta da openKeyring senza staleCount -> serverOutdated, 0 PUT, store invariato', async () => {
    dropStaleCountFrom(1, () => { h.server.row!.rev++; });
    const before = snapshot();
    await expect(session.changePin({ userId: U, currentPin: PIN, newPin: PIN2 })).rejects.toMatchObject(outdated);
    expect(h.server.unlockRevs).toHaveLength(2); // prima unlock -> 409 staleRev, seconda sul keyring riletto
    expectUntouched(before);
  });
});

// P3 (reset del vault, piano §2.7): una regola sola, solo su un 200 validato (mai 404, 5xx, rete).
describe('syncKeyringCache: regola del reset (P3)', () => {
  beforeEach(async () => { await doSetup(); await session.confirmKit(U, lastHash); });
  const krWith = async (over: Partial<session.KeyringDto>) => ({ ...(await h.server.getKeyring() as unknown as session.KeyringDto), ...over });
  const vaultRows = () => {
    h.notes.push({ id: 'v1', userId: U, isVault: true, syncStatus: 'updated' }, { id: 'p1', userId: U, isVault: false, syncStatus: 'synced' });
    h.tags.push({ id: 't1', userId: U, isVault: true, syncStatus: 'synced' });
    h.queue.push({ entity: 'NOTE', userId: U, entityId: 'v1', type: 'UPDATE', data: { isVault: true, content: 'nv3.0.aa.bb' } });
  };

  // il server dice RESET_PENDING anche alla rilettura di conferma (P3: la risposta che ha avviato la sospensione puo' essere vecchia)
  const stillPending = async (over: Partial<session.KeyringDto> = {}) => {
    const pending = await krWith({ status: 'RESET_PENDING', resetScheduledAt: '2026-12-03T10:00:00.000Z', ...over });
    h.server.getKeyring = async () => pending as unknown as Record<string, unknown>;
    return pending;
  };

  it('RESET_PENDING da sbloccato: blocca il vault e cancella lo share; cache e righe Dexie restano', async () => {
    vaultRows();
    const before = structuredClone(st().byUser[U]);
    const stale0 = await stillPending();
    await session.syncKeyringCache(U, stale0);
    expect(st().unlockedUserId).toBeNull();
    expect(st().keys).toBeNull();
    expect(raw('shares').size).toBe(0);
    expect(st().byUser[U]).toEqual(before);
    expect(h.notes.map((n) => n.id)).toEqual(['v1', 'p1']);
    expect(h.queue).toHaveLength(1);
    await expect(session.unlockOffline(U, PIN)).rejects.toMatchObject({ code: 'offlineUnavailable' });
  });

  it('risposta RESET_PENDING vecchia (annullo -> READY -> sblocco online nel frattempo): da sbloccato si rilegge una volta e NON si blocca ne\' si cancella lo share', async () => {
    vaultRows();
    const staleReply = await krWith({ status: 'RESET_PENDING', resetScheduledAt: '2026-12-03T10:00:00.000Z' });
    const ready = await krWith({}); // il server ora e' READY
    const get = vi.fn(async () => ready as unknown as Record<string, unknown>);
    h.server.getKeyring = get;
    expect(raw('shares').size).toBe(1);
    await session.syncKeyringCache(U, staleReply);
    expect(get).toHaveBeenCalledTimes(1);
    expect(st().unlockedUserId).toBe(U);
    expect(st().keys).not.toBeNull();
    expect(raw('shares').size).toBe(1);
    expect(h.notes).toHaveLength(2);
  });

  it('RESET_PENDING confermato dalla rilettura: si sospende (una sola lettura in piu\')', async () => {
    const stale = await stillPending();
    const get = vi.fn(h.server.getKeyring.bind(h.server));
    h.server.getKeyring = get;
    await session.syncKeyringCache(U, stale);
    expect(get).toHaveBeenCalledTimes(1);
    expect(st().unlockedUserId).toBeNull();
    expect(raw('shares').size).toBe(0);
  });

  it('rilettura fallita (rete, 5xx): non si puo\' confermare, quindi niente blocco', async () => {
    const stale = await krWith({ status: 'RESET_PENDING' });
    h.server.getKeyring = async () => { throw apiErr(0, 'errors.common.networkError'); };
    await session.syncKeyringCache(U, stale);
    expect(st().unlockedUserId).toBe(U);
    expect(raw('shares').size).toBe(1);
  });

  it('vault bloccato (o in sblocco) e risposta vecchia: la rilettura dice READY, quindi lo share NON si cancella (lo sblocco offline resta)', async () => {
    await st().lockVault();
    const stale = await krWith({ status: 'RESET_PENDING' });
    const ready = await krWith({});
    const get = vi.fn(async () => ready as unknown as Record<string, unknown>);
    h.server.getKeyring = get;
    await session.syncKeyringCache(U, stale);
    expect(get).toHaveBeenCalledTimes(1);
    expect(raw('shares').size).toBe(1);
  });

  it('vault bloccato e RESET_PENDING confermato dalla rilettura: lo share si cancella', async () => {
    await st().lockVault();
    const stale = await stillPending();
    await session.syncKeyringCache(U, stale);
    expect(raw('shares').size).toBe(0);
  });

  it('due chiamate ravvicinate (due istanze di useOpenRecovery): una sola rilettura', async () => {
    const stale = await stillPending();
    const real = h.server.getKeyring.bind(h.server);
    const get = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); return real(); });
    h.server.getKeyring = get;
    await Promise.all([session.syncKeyringCache(U, stale), session.syncKeyringCache(U, stale)]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(st().unlockedUserId).toBeNull();
    // finito il giro il guard e' libero: una nuova sospensione rilegge di nuovo
    await session.syncKeyringCache(U, stale);
    expect(get).toHaveBeenCalledTimes(2);
  });

  describe('utente non piu\' quello corrente (cambio account: closure vecchia con il token di un altro)', () => {
    const switchUser = () => useAuthStore.setState({ user: { id: 'u2', email: 'x@y.z' } });

    it('purge: nessuna cancellazione ne\' blocco', async () => {
      vaultRows();
      const kr = await krWith({ status: 'NONE', epoch: 1, rev: 0, lastResetEpoch: 1 });
      switchUser();
      await session.syncKeyringCache(U, kr);
      expect(st().byUser[U]).toBeDefined();
      expect(h.notes).toHaveLength(2);
      expect(h.queue).toHaveLength(1);
      expect(raw('shares').size).toBe(1);
    });

    it('RESET_PENDING: nessuna rilettura, nessun blocco, nessun deleteShare', async () => {
      const stale = await stillPending();
      const get = vi.fn(h.server.getKeyring.bind(h.server));
      h.server.getKeyring = get;
      switchUser();
      await session.syncKeyringCache(U, stale);
      expect(get).not.toHaveBeenCalled();
      expect(raw('shares').size).toBe(1);
    });

    it('l\'utente cambia durante la rilettura: niente blocco ne\' deleteShare', async () => {
      const pending = await krWith({ status: 'RESET_PENDING' });
      h.server.getKeyring = async () => { switchUser(); return pending as unknown as Record<string, unknown>; };
      await session.syncKeyringCache(U, pending);
      expect(raw('shares').size).toBe(1);
    });

    it('l\'utente cambia durante il lock del purge: le righe non si cancellano', async () => {
      vaultRows();
      const un = st().registerPreLock(async () => { switchUser(); });
      await session.syncKeyringCache(U, await krWith({ status: 'NONE', epoch: 1, rev: 0 }));
      un();
      expect(st().byUser[U]).toBeDefined();
      expect(h.notes).toHaveLength(2);
      expect(h.queue).toHaveLength(1);
    });

    it('l\'utente cambia durante il lock della sospensione: lo share resta', async () => {
      const stale = await stillPending();
      const un = st().registerPreLock(async () => { switchUser(); });
      await session.syncKeyringCache(U, stale);
      un();
      expect(raw('shares').size).toBe(1);
    });
  });

  it('RESET_PENDING con il vault di un altro utente sbloccato: non lo blocca', async () => {
    useVaultStore.setState({ byUser: { ...st().byUser, altro: st().byUser[U] } });
    await session.syncKeyringCache('altro', await krWith({ status: 'RESET_PENDING' }));
    expect(st().unlockedUserId).toBe(U);
  });

  it('NONE con epoch maggiore della cache: purge (lock, righe vault, coda, cache, share); le note normali restano', async () => {
    vaultRows();
    await session.syncKeyringCache(U, await krWith({ status: 'NONE', epoch: 1, rev: 0 }));
    expect(st().unlockedUserId).toBeNull();
    expect(st().byUser[U]).toBeUndefined();
    expect(h.notes.map((n) => n.id)).toEqual(['p1']);
    expect(h.tags).toEqual([]);
    expect(h.queue).toEqual([]);
    expect(raw('deviceKeys').size + raw('shares').size + raw('pending').size).toBe(0);
  });

  it('READY con lastResetEpoch maggiore dell\'epoch in cache: purge', async () => {
    vaultRows();
    await session.syncKeyringCache(U, await krWith({ epoch: 1, rev: 3, lastResetEpoch: 1 }));
    expect(st().byUser[U]).toBeUndefined();
    expect(h.notes.map((n) => n.id)).toEqual(['p1']);
  });

  it('una rotazione (lastResetEpoch null, assente o <= cache) non fa il purge', async () => {
    vaultRows();
    await session.syncKeyringCache(U, await krWith({ epoch: 1, rev: 3, lastResetEpoch: null }));
    await session.syncKeyringCache(U, await krWith({ epoch: 1, rev: 3 }));
    await session.syncKeyringCache(U, await krWith({ epoch: 3, rev: 3, lastResetEpoch: 0 }));
    expect(st().byUser[U]).toBeDefined();
    expect(h.notes).toHaveLength(2);
    expect(h.queue).toHaveLength(1);
  });

  it('NONE alla stessa epoch della cache: nessun purge', async () => {
    vaultRows();
    await session.syncKeyringCache(U, await krWith({ status: 'NONE', epoch: 0 }));
    expect(st().byUser[U]).toBeDefined();
    expect(h.notes).toHaveLength(2);
  });

  it('senza cache non c\'e\' niente da purgare ne\' da bloccare', async () => {
    vaultRows();
    await session.syncKeyringCache('altro', await krWith({ status: 'NONE', epoch: 5 }));
    expect(h.notes).toHaveLength(2);
    expect(st().unlockedUserId).toBe(U);
  });

  it('il flusher pre-lock gira PRIMA della cancellazione delle righe', async () => {
    vaultRows();
    const seen: number[] = [];
    const un = st().registerPreLock(async () => { await Promise.resolve(); seen.push(h.notes.filter((n) => n.isVault).length); });
    await session.syncKeyringCache(U, await krWith({ status: 'NONE', epoch: 1, rev: 0 }));
    un();
    expect(seen).toEqual([1]);
    expect(h.notes.filter((n) => n.isVault)).toEqual([]);
  });

  it('guard in-flight: due sync ravvicinate fanno un solo giro (un solo lock con i flusher)', async () => {
    vaultRows();
    let flushes = 0;
    const un = st().registerPreLock(async () => { flushes++; });
    const kr = await krWith({ status: 'NONE', epoch: 1, rev: 0 });
    await Promise.all([session.syncKeyringCache(U, kr), session.syncKeyringCache(U, kr)]);
    un();
    expect(flushes).toBe(1);
    expect(st().byUser[U]).toBeUndefined();
  });

  it('durante la rotazione propria nessun purge', async () => {
    vaultRows();
    const kr = await krWith({ status: 'NONE', epoch: 1, rev: 0 });
    h.server.onPut = () => { void session.syncKeyringCache(U, kr); };
    await session.rotateVault({ userId: U, pin: PIN, rootKey: ROOT });
    await Promise.resolve();
    expect(st().byUser[U]).toBeDefined();
    expect(h.notes).toHaveLength(2);
  });

  it('refreshKeyringCache: GET fallita (404, 5xx, rete) = nessun purge, nessun blocco', async () => {
    vaultRows();
    for (const e of [apiErr(404, 'errors.vault.notFound'), apiErr(500, 'errors.common.unknownError'), apiErr(0, 'errors.common.networkError')]) {
      h.server.getKeyring = async () => { throw e; };
      await expect(session.refreshKeyringCache(U)).resolves.toBeUndefined();
    }
    expect(st().byUser[U]).toBeDefined();
    expect(st().unlockedUserId).toBe(U);
    expect(h.notes).toHaveLength(2);
  });

  it('refreshKeyringCache aspetta il purge', async () => {
    vaultRows();
    h.server.getKeyring = async () => ({ status: 'NONE', epoch: 1, rev: 0, kdf: null, kdfParams: null, pinSalt: null, wrappedVkPin: null, wrappedVkSigKey: null, rootKeyId: null, lockedUntil: null, escrowHash: null, legacyCount: 0, lastResetEpoch: 1 });
    await session.refreshKeyringCache(U);
    expect(st().byUser[U]).toBeUndefined();
    expect(h.notes.map((n) => n.id)).toEqual(['p1']);
  });
});
