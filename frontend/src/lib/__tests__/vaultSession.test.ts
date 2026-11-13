// @vitest-environment node
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { createHash, verify } from 'node:crypto';
import { installFakeIndexedDb, reset, stores, fail } from './fakeIndexedDb';

// window finto (solo EventTarget) PRIMA degli import: vaultSession registra il listener "storage"
const h = vi.hoisted(() => {
  // zustand persist legge window.localStorage: storage in memoria minimo
  const mem = new Map<string, string>();
  const win = Object.assign(new EventTarget(), {
    localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) },
  });
  (globalThis as unknown as { window: unknown }).window = win;
  return { server: null as unknown as FakeServer, apiRequest: vi.fn() };
});

// ---- mock: rete, cache SW, Argon2 (veloce e deterministico), authStore
vi.mock('../vaultApi', () => ({
  getKeyring: () => h.server.getKeyring(),
  createKeyring: (b: unknown) => h.server.createKeyring(b as CreateBody),
  unlock: (a: string) => h.server.unlock(a),
  updateKeyring: (p: string, v: string) => h.server.updateKeyring(p, v),
}));
// rete vera sotto la vaultApi VERA (importActual): serve ai test sulla guardia di forma delle risposte 2xx
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
import { b64uDecode, b64uEncode, deriveAuthKey, deriveKekPin, sha256hex, sha256hexBytes, unwrapVkPin } from '../../utils/vaultCrypto';

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

class FakeServer {
  row: (CreateBody & { epoch: number; rev: number }) | null = null;
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
      wrappedVkSigKey: r.wrappedVkSigKey, rootKeyId: r.rootKeyId, lockedUntil: this.lockedUntil, legacyCount: 0,
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
  async unlock(authKey: string) {
    this.unlockCalls++;
    if (this.unlockError) throw this.unlockError;
    if (!this.row || authKey !== this.row.authKey) throw apiErr(403, 'errors.vault.invalidPin');
    return { serverShare: this.row.serverShare };
  }
  async updateKeyring(payload: string, proof: string) {
    this.onPut?.();
    this.puts.push(payload);
    const r = this.row!;
    const p = JSON.parse(payload) as { rev: number; wrap?: Partial<CreateBody>; escrow?: Partial<CreateBody> };
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
    Object.assign(r, p.wrap ?? {}, p.escrow ?? {});
    r.rev++;
    if (this.putMode === 'applyThen409') throw apiErr(409, 'errors.vault.staleRev');
    return { rev: r.rev };
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

  it('nessuna cache, NONE, RESET_PENDING, keyring incompleto, errore di rete: nessuna scrittura e nessun throw', async () => {
    const kr = await h.server.getKeyring() as unknown as session.KeyringDto;
    session.syncKeyringCache('altro', kr);
    expect(st().byUser['altro']).toBeUndefined();
    session.syncKeyringCache(U, { ...kr, status: 'NONE' });
    session.syncKeyringCache(U, { ...kr, status: 'RESET_PENDING' });
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
    const { kit, escrowHash } = await session.regenerateKit({ userId: U, pin: PIN, rootKey: ROOT });
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
    const { kit } = await session.regenerateKit({ userId: U, pin: PIN, rootKey: ROOT });
    expect(kit).toHaveLength(20);
  });

  it('409 con escrowHash diverso -> kitNotUpdated, nessun Kit, marker cancellato', async () => {
    h.server.putMode = 'plain409';
    await expect(session.regenerateKit({ userId: U, pin: PIN, rootKey: ROOT })).rejects.toMatchObject({
      code: 'kitNotUpdated', key: 'errors.vault.kitNotUpdated',
    });
    expect(raw('pending').size).toBe(0);
  });

  it('409 recoveryInProgress -> errore con quella chiave, marker cancellato', async () => {
    h.server.putMode = 'recoveryOpen409';
    await expect(session.regenerateKit({ userId: U, pin: PIN, rootKey: ROOT })).rejects.toMatchObject({
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
      await session.regenerateKit({ userId: U, pin: PIN, rootKey: ROOT });
      intact();
      expect(kitMarkers()).toHaveLength(2); // H1 + il proprio, ancora non confermato
    });
    it('409 con hash diverso', async () => {
      h.server.putMode = 'plain409';
      await expect(session.regenerateKit({ userId: U, pin: PIN, rootKey: ROOT })).rejects.toMatchObject({ code: 'kitNotUpdated' });
      intact();
      expect(kitMarkers()).toHaveLength(1); // solo il proprio e' stato cancellato
    });
    it('rifiuto definitivo (400)', async () => {
      h.server.updateKeyring = async () => { throw apiErr(400); };
      await expect(session.regenerateKit({ userId: U, pin: PIN, rootKey: ROOT })).rejects.toMatchObject({ status: 400 });
      intact();
      expect(kitMarkers()).toHaveLength(1);
    });
    it('errore di rete: il proprio marker resta, H1 pure', async () => {
      h.server.updateKeyring = async () => { throw apiErr(0); };
      await expect(session.regenerateKit({ userId: U, pin: PIN, rootKey: ROOT })).rejects.toMatchObject({ status: 0 });
      intact();
      expect(kitMarkers()).toHaveLength(2);
    });
    it('confirmKit(u, h2) cancella solo h2', async () => {
      const { escrowHash } = await session.regenerateKit({ userId: U, pin: PIN, rootKey: ROOT });
      await session.confirmKit(U, escrowHash);
      intact();
      expect(kitMarkers()).toHaveLength(1);
    });
  });

  // N5 (item 5): PUT committato + 503 di proxy (senza body del vault) = esito ambiguo, il marker resta
  it('N5: PUT committato e 503 senza body: il marker resta e al riavvio compare kitUnconfirmed', async () => {
    const orig = h.server.updateKeyring.bind(h.server);
    h.server.updateKeyring = async (p: string, v: string) => { await orig(p, v); throw apiErr(503, 'errors.common.unknownError', false); };
    await expect(session.regenerateKit({ userId: U, pin: PIN, rootKey: ROOT })).rejects.toMatchObject({ status: 503 });
    expect(kitMarkers()).toHaveLength(1);
    expect(await session.checkPendingOnStart(U)).toBe('kitUnconfirmed');
  });

  it('da bloccato non esiste; PIN errato -> wrongPin, nessun PUT', async () => {
    await expect(session.regenerateKit({ userId: U, pin: PIN2, rootKey: ROOT })).rejects.toMatchObject({ code: 'wrongPin' });
    expect(h.server.puts).toHaveLength(0);
    await st().lockVault();
    await expect(session.regenerateKit({ userId: U, pin: PIN, rootKey: ROOT })).rejects.toMatchObject({ code: 'vaultLocked' });
  });
});

describe('marker al riavvio (resolver: una GET /keyring, morte decisa da (epoch, rev))', () => {
  const HX = 'ee'.repeat(32); // un hash che non e' mai quello del keyring
  const outcome = () => session.checkPendingOnStart(U);

  it('kit nuovo: hash uguale -> kitUnconfirmed e il marker resta; il banner non cambia dopo regenerateKit', async () => {
    await doSetup();
    expect(await outcome()).toBe('kitUnconfirmed');
    expect(kitMarkers()).toHaveLength(1);
    await session.confirmKit(U, lastHash);
    await session.regenerateKit({ userId: U, pin: PIN, rootKey: ROOT });
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

  it('kit dopo una regenerateKit con rev oltre il marker di un altro escrow: solo quello superato muore', async () => {
    await doSetup();
    await session.confirmKit(U, lastHash);
    putKit(HX, { rev: 0 }); // costruito sullo stesso keyring (rev 0)
    const { escrowHash } = await session.regenerateKit({ userId: U, pin: PIN, rootKey: ROOT }); // rev -> 1: HX non puo' piu' committare
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

  it.each(BODIES)('X8 regenerateKit e changePin con PUT 200 (%s): errore di rete, nessun Kit, nessun ok, cache e marker non avanzano', async (_n, body) => {
    await doSetup();
    await session.confirmKit(U, lastHash);
    const real = await realApi(body);
    h.server.updateKeyring = (p: string, v: string) => real.updateKeyring(p, v);
    const rev = st().byUser[U].rev;
    const escrow = h.server.row!.escrowBlob;
    const regen = await session.regenerateKit({ userId: U, pin: PIN, rootKey: ROOT }).then(() => 'ok', (e: unknown) => e);
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
