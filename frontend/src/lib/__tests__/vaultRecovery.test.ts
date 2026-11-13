// @vitest-environment node
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { createHash, verify } from 'node:crypto';
import { fail, installFakeIndexedDb, reset, stores } from './fakeIndexedDb';

const h = vi.hoisted(() => {
  const mem = new Map<string, string>();
  const win = Object.assign(new EventTarget(), {
    localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) },
  });
  (globalThis as unknown as { window: unknown }).window = win;
  return { server: null as unknown as FakeServer, apiRequest: vi.fn() };
});

vi.mock('../vaultApi', () => ({
  getKeyring: () => h.server.getKeyring(),
  createRecovery: (pub: string, reason?: string) => h.server.createRecovery(pub, reason),
  getRecovery: (id: string) => h.server.getRecovery(id),
  cancelRecovery: (id: string) => h.server.cancelRecovery(id),
  completeRecovery: (id: string, p: string, v: string) => h.server.completeRecovery(id, p, v),
  unlock: vi.fn(),
  updateKeyring: vi.fn(),
}));
// rete vera sotto la vaultApi VERA (importActual): serve ai test sulla guardia di forma delle risposte 2xx
vi.mock('../api', () => ({ default: { request: (...a: unknown[]) => h.apiRequest(...a) } }));
vi.mock('../apiCache', () => ({ purgeApiCache: vi.fn(async () => {}), purgeVaultCache: vi.fn(async () => {}) }));
vi.mock('../../utils/argon2', async (orig) => {
  const real = await orig<typeof import('../../utils/argon2')>();
  return {
    ...real,
    deriveS: vi.fn(async (pin: string, salt: Uint8Array) => new Uint8Array(createHash('sha256').update(pin.normalize('NFC')).update(salt).digest())),
  };
});
vi.mock('../../store/authStore', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ user: { id: '50c718e3-3cca-439b-95e3-3b5f9d65a0e2', email: 'a@b.c' } as { id: string; email: string } | null })) };
});
// Chiave ECDSA root di TEST (quella della fixture) al posto di quella di produzione; ECDH attiva = chiave del vettore V1 dei test di vaultSession.
vi.mock('../../utils/vaultRootKeys', async () => {
  const f = (await import('../../utils/__tests__/fixtures/vaultRecoveryVectors.json')).default;
  const ecdh = Uint8Array.from(Buffer.from(
    '3076301006072a8648ce3d020106052b8104002203620004e6bc0a30815d358c204c38b0aa265f5ae73c053fc6bea50c435c7a094804f14065e4efa35f49019198bc9f3955201bbfa426a9f126b532c127c90c8241bda6490352a8dc8550b2f41f5d1bf26775bc67a1ed05aaee9d690ef83375910eab9315', 'hex'));
  return {
    VAULT_ROOT_KEYS: { [f.rootKeyId]: { ecdhSpki: Buffer.from(ecdh).toString('base64url'), ecdsaSpki: f.ecdsaSpki } },
    getActiveRootKey: () => ({ id: f.rootKeyId, ecdhSpki: ecdh }),
  };
});
vi.mock('../../utils/vaultCrypto', async (orig) => {
  const real = await orig<typeof import('../../utils/vaultCrypto')>();
  return { ...real, sealRootShare: vi.fn(real.sealRootShare) };
});
vi.mock('../../utils/vaultRecoveryCrypto', async (orig) => {
  const real = await orig<typeof import('../../utils/vaultRecoveryCrypto')>();
  return { ...real, buildRecoveryPayload: vi.fn(real.buildRecoveryPayload), generateRecoveryKeyPair: vi.fn(real.generateRecoveryKeyPair) };
});

import fixture from '../../utils/__tests__/fixtures/vaultRecoveryVectors.json';
import * as rec from '../vaultRecovery';
import * as device from '../deviceKeyStore';
import { useVaultStore } from '../../store/vaultStore';
import { useAuthStore } from '../../store/authStore';
import { checkPendingOnStart, confirmKit } from '../vaultSession';
import { purgeApiCache } from '../apiCache';
import { deriveS } from '../../utils/argon2';
import { buildRecoveryPayload, fingerprintOf, generateRecoveryKeyPair } from '../../utils/vaultRecoveryCrypto';
import {
  b64uDecode, b64uEncode, decryptShare, deriveKekPin, deriveRk, generateSigKey, generateVkRaw, importVk, sealRootShare, sha256hex, sha256hexBytes,
  unwrapEscrow, unwrapVkPin, wrapEscrow, wrapVkPin, wrapVkSigKey,
} from '../../utils/vaultCrypto';
import { formatKit } from '../../utils/vaultKit';
import enLocale from '../../locales/en.json';
import itLocale from '../../locales/it.json';

// ogni test fa ECDH P-384 e AES vere (anche 2-3 cerimonie): 5 s non bastano a suite piena sotto carico
vi.setConfig({ testTimeout: 30000 });

const F = fixture;
const U = F.userId;
const RID = F.requestId;
const OLD_PIN = 'k7Rq2x';
const NEW_PIN = 'm4Tz9w';
const KDF = { m: 65536, t: 10, p: 1 };
const P384 = { name: 'ECDH', namedCurve: 'P-384' } as const;

/** `fromServer` (vaultApi): vero se il body ha un message errors.*. Il default e' una risposta del vault; `proxy503` e' un 503 di IIS/ARR (senza body). */
const apiErr = (status: number, key = 'errors.vault.x', fromServer = true) => Object.assign(new Error(key), { name: 'VaultApiError', status, key, kind: 'x', fromServer });
const netErr = () => apiErr(0, 'errors.common.networkError', false);
const proxy503 = () => apiErr(503, 'errors.common.unknownError', false);
const code = (e: unknown) => (e as { code?: string }).code;

type Row = {
  epoch: number; rev: number; kdfParams: typeof KDF; pinSalt: string; wrappedVkPin: string; wrappedVkSigKey: string; vkSigPub: string;
  rootKeyId: string; escrowBlob: string; serverShare: string; authKey: string; escrowHash: string;
};

class FakeServer {
  kr!: Row;
  r: { status: string; fingerprint: string; payloadHash?: string; sealedCodeA?: string | null; sig: string } | null = null;
  posts: { id: string; payload: string; proof: string }[] = [];
  created: { pub: string }[] = [];
  cancelled: string[] = [];
  /** Errori lanciati dalle prossime POST del complete PRIMA di elaborarle (una per chiamata). */
  failQueue: unknown[] = [];
  /** Come sopra ma DOPO aver applicato il payload (risposta persa). */
  applyThenFailQueue: unknown[] = [];
  /** Errore lanciato da OGNI POST del complete, senza applicare nulla. */
  completeError: unknown = null;
  getRecoveryError: unknown = null;
  getRecoveryCalls = 0;
  getKeyringCalls = 0;
  getKeyringError: unknown = null;
  createError: unknown = null;
  createFingerprint: string | null = null;
  openRecovery: { id: string; status: string; fingerprint: string; createdAt: string; notBefore: string | null } | null = null;
  /** Ganci dei test, chiamati all'inizio della rispettiva operazione. */
  onPost: (() => void) | null = null;
  onCreate: (() => void) | null = null;
  onGetRecovery: (() => void) | null = null;
  onGetKeyring: (() => Promise<void>) | null = null;

  async getKeyring() {
    this.getKeyringCalls++;
    if (this.onGetKeyring) await this.onGetKeyring();
    if (this.getKeyringError) throw this.getKeyringError;
    const k = this.kr;
    return {
      status: 'READY', epoch: k.epoch, rev: k.rev, kdf: 'argon2id', kdfParams: k.kdfParams, pinSalt: k.pinSalt, wrappedVkPin: k.wrappedVkPin,
      wrappedVkSigKey: k.wrappedVkSigKey, rootKeyId: k.rootKeyId, lockedUntil: null, escrowHash: k.escrowHash, legacyCount: 0, openRecovery: this.openRecovery,
    };
  }
  async createRecovery(pub: string, _reason?: string) {
    this.onCreate?.();
    if (this.createError) throw this.createError;
    this.created.push({ pub });
    const fingerprint = this.createFingerprint ?? await fingerprintOf(b64uDecode(pub));
    this.r = { status: 'PENDING_APPROVAL', fingerprint, sig: F.signature };
    return { id: RID, fingerprint };
  }
  async getRecovery(id: string) {
    this.getRecoveryCalls++;
    this.onGetRecovery?.();
    if (this.getRecoveryError) throw this.getRecoveryError;
    if (!this.r || id !== RID) throw apiErr(404, 'errors.vault.recoveryNotFound');
    const released = this.r.status === 'RELEASED';
    return {
      status: this.r.status, fingerprint: this.r.fingerprint, notBefore: F.notBefore, releaseExpiresAt: null,
      sealedCodeA: this.r.status === 'PENDING_CODE' ? (this.r.sealedCodeA ?? null) : null,
      rootShareForClient: released ? F.sealedShare : null, rootSignature: released ? this.r.sig : null, escrowBlob: released ? this.kr.escrowBlob : null,
    };
  }
  async cancelRecovery(id: string) { this.cancelled.push(id); if (this.r) this.r.status = 'CANCELLED'; return { status: 'CANCELLED' as const }; }
  async completeRecovery(id: string, payload: string, proof: string) {
    this.posts.push({ id, payload, proof });
    this.onPost?.();
    if (this.completeError) throw this.completeError;
    if (this.failQueue.length) throw this.failQueue.shift();
    const r = this.r!;
    const hash = await sha256hex(payload);
    if (r.status === 'COMPLETED' && r.payloadHash === hash) return { status: 'COMPLETED' as const };
    if (r.status !== 'RELEASED') throw apiErr(409, 'errors.vault.recoveryStateConflict');
    const p = JSON.parse(payload) as { rev: number; wrap: Record<string, unknown>; escrow: Record<string, unknown> };
    if (p.rev !== this.kr.rev) throw apiErr(409, 'errors.vault.staleRev');
    const msg = `notiq/vault/v3/proof|POST /api/vault/recovery/${id}/complete|${U}|${this.kr.epoch}|${p.rev}|${hash}`;
    const ok = verify('sha256', Buffer.from(msg), { key: Buffer.from(this.kr.vkSigPub, 'base64url'), format: 'der', type: 'spki', dsaEncoding: 'ieee-p1363' }, Buffer.from(proof, 'base64url'));
    if (!ok) throw apiErr(400, 'errors.vault.invalidProof');
    Object.assign(this.kr, p.wrap, p.escrow, { rev: this.kr.rev + 1 });
    this.kr.escrowHash = createHash('sha256').update(Buffer.from(this.kr.escrowBlob, 'base64url')).digest('hex');
    r.status = 'COMPLETED';
    r.payloadHash = hash;
    if (this.applyThenFailQueue.length) throw this.applyThenFailQueue.shift();
    return { status: 'COMPLETED' as const };
  }
}

/** Web Lock finto ma con semantica vera: esclusivo, ifAvailable, tenuto finche' la promise del callback non si risolve. */
function fakeLocks() {
  const held = new Set<string>();
  const locks = {
    held,
    request: async (name: string, opts: { ifAvailable?: boolean }, cb: (l: unknown) => Promise<unknown> | unknown) => {
      if (held.has(name)) { if (opts.ifAvailable) return cb(null); throw new Error('wait non supportato nel fake'); }
      held.add(name);
      try { return await cb({ name }); } finally { held.delete(name); }
    },
  };
  vi.stubGlobal('navigator', { locks });
  return locks;
}
const LOCK = `notiq-vault-recovery:${U}`;

const st = () => useVaultStore.getState();
const raw = (name: string) => stores.get(name)!;
type KitM = { kind: string; escrowHash: string; epoch: number; rev: number | null; origin: string; requestId?: string };
/** Marker kit (uno per escrow, chiave <userId>:kit:<hash>); MARKER = il primo (i test con un solo marker). */
const MARKERS = () => [...raw('pending').entries()].filter(([k]) => k.startsWith(U + ':kit:')).map(([, v]) => v as KitM);
const MARKER = () => MARKERS()[0] as KitM | undefined;
const seedKit = (hash: string, o: Partial<KitM> = {}) => raw('pending').set(`${U}:kit:${hash}`, { kind: 'kit', escrowHash: hash, epoch: 0, rev: 3, origin: 'recovery', requestId: RID, ...o });
const KEY = () => raw('deviceKeys').get('recovery:' + U) as { requestId: string | null; publicRaw: Uint8Array; createdAt: number } | undefined;
const OTHER = '11111111-2222-4333-8444-555555555555';
const MIN = 60_000;

interface World { vkRaw: Uint8Array; sUser: Uint8Array; kit: string }

/** Keyring vero (VK, escrow col Kit vecchio e S_root della fixture), richiesta RELEASED e chiave del dispositivo = quella della fixture. */
async function world(opts: { bindKey?: boolean } = {}): Promise<World> {
  const vkRaw = generateVkRaw();
  const vk = await importVk(vkRaw);
  const pinSalt = crypto.getRandomValues(new Uint8Array(16));
  const serverShare = crypto.getRandomValues(new Uint8Array(32));
  const S = await deriveS(OLD_PIN, pinSalt, KDF);
  const kek = await deriveKekPin(S, serverShare, pinSalt, U);
  const sig = await generateSigKey();
  const sUser = crypto.getRandomValues(new Uint8Array(20));
  const rk = await deriveRk(Uint8Array.from(Buffer.from(F.sRootHex, 'hex')), sUser, U);
  const escrowBlob = await wrapEscrow(rk, vkRaw, U, 0, F.rootKeyId);
  h.server.kr = {
    epoch: 0, rev: 3, kdfParams: KDF, pinSalt: b64uEncode(pinSalt), wrappedVkPin: b64uEncode(await wrapVkPin(kek, vkRaw, U, 0, KDF)),
    wrappedVkSigKey: b64uEncode(await wrapVkSigKey(vk, sig.pkcs8, U, 0)), vkSigPub: b64uEncode(sig.spki), rootKeyId: F.rootKeyId,
    escrowBlob: b64uEncode(escrowBlob), serverShare: b64uEncode(serverShare), authKey: 'old', escrowHash: await sha256hexBytes(escrowBlob),
  };
  h.server.r = { status: 'RELEASED', fingerprint: F.fingerprint, sig: F.signature };
  if (opts.bindKey !== false) {
    const priv = await crypto.subtle.importKey('pkcs8', b64uDecode(F.clientPkcs8), P384, false, ['deriveBits']);
    await device.addRecoveryKey(U, { privateKey: priv, publicRaw: b64uDecode(F.clientPubRaw) });
    await device.bindRecoveryKeyIf(U, b64uDecode(F.clientPubRaw), RID);
  }
  return { vkRaw, sUser, kit: formatKit(sUser) };
}

/** Tutti i valori delle store raw come testo latin1: serve a cercare segreti in chiaro. */
function dump(): string {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (v instanceof Uint8Array) out.push(Buffer.from(v).toString('latin1'));
    else if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object' && !('algorithm' in v)) Object.values(v).forEach(walk);
  };
  for (const m of stores.values()) for (const [k, v] of m) { out.push(k); walk(v); }
  return out.join('\n');
}

beforeAll(installFakeIndexedDb);
beforeEach(async () => {
  reset();
  h.server = new FakeServer();
  await st().lockVault();
  useVaultStore.setState({ byUser: {}, isSetup: false, pinHash: null });
  useAuthStore.setState({ user: { id: U, email: 'a@b.c' } });
  vi.stubGlobal('navigator', {}); // Node ha navigator.locks vero: senza stub un lock di un test resterebbe tenuto nei successivi (i test con i lock usano fakeLocks)
  vi.mocked(purgeApiCache).mockClear();
  vi.mocked(deriveS).mockClear();
  vi.mocked(buildRecoveryPayload).mockClear();
  vi.mocked(sealRootShare).mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); });

// ================================================================ T5: richiesta

/** Chiave orfana (requestId null) creata `ageMs` fa; ritorna l'FP e la pubblica. */
async function orphan(ageMs = 0) {
  const kp = await generateRecoveryKeyPair();
  await device.addRecoveryKey(U, kp, Date.now() - ageMs);
  h.server.kr = { epoch: 0, rev: 3 } as Row;
  return { kp, fp: await fingerprintOf(kp.publicRaw) };
}
const openFor = (fp: string, status = 'WAITING') => ({ id: RID, status, fingerprint: fp, createdAt: 'x', notBefore: null });

describe('startRecovery', () => {
  it('salva la chiave PRIMA della POST (requestId null, con createdAt), poi la lega; la POST porta la pubblica raw; nessun lock', async () => {
    const locks = fakeLocks();
    let keyAtPost: typeof KEY extends () => infer R ? R : never;
    let lockedAtPost = true;
    const orig = h.server.createRecovery.bind(h.server);
    h.server.createRecovery = async (pub: string) => { keyAtPost = KEY(); lockedAtPost = locks.held.size > 0; return orig(pub); };
    const before = Date.now();
    const r = await rec.startRecovery(U);
    expect(keyAtPost!).toMatchObject({ requestId: null });
    expect(keyAtPost!.createdAt).toBeGreaterThanOrEqual(before);
    expect(lockedAtPost).toBe(false);
    expect(r).toMatchObject({ id: RID });
    expect(KEY()).toMatchObject({ requestId: RID });
    expect(b64uDecode(h.server.created[0].pub)).toHaveLength(97);
    expect(r.fingerprint).toBe(await fingerprintOf((await device.getRecoveryKey(U))!.publicRaw));
  });

  it('chiave gia legata a una richiesta aperta: recoveryAlreadyOpen, nessuna POST, chiave intatta', async () => {
    await world();
    h.server.r!.status = 'WAITING';
    await expect(rec.startRecovery(U)).rejects.toMatchObject({ code: 'alreadyOpen', key: 'errors.vault.recoveryAlreadyOpen' });
    expect(h.server.created).toHaveLength(0);
    expect(KEY()).toMatchObject({ requestId: RID });
  });

  it('chiave legata a una richiesta chiusa (COMPLETED, 404): la sync la cancella e la richiesta riparte', async () => {
    await world();
    h.server.r!.status = 'COMPLETED';
    const r = await rec.startRecovery(U);
    expect(r.id).toBe(RID);
    expect(h.server.created).toHaveLength(1);
    expect(KEY()).toMatchObject({ requestId: RID });
  });

  it('chiave orfana con openRecovery dello stesso FP: si lega, poi recoveryAlreadyOpen', async () => {
    const { fp } = await orphan(MIN);
    h.server.r = { status: 'PENDING_APPROVAL', fingerprint: fp, sig: F.signature };
    h.server.openRecovery = openFor(fp, 'PENDING_APPROVAL');
    await expect(rec.startRecovery(U)).rejects.toMatchObject({ code: 'alreadyOpen' });
    expect(KEY()).toMatchObject({ requestId: RID });
    expect(h.server.created).toHaveLength(0);
  });

  it('chiave orfana oltre i 10 minuti senza openRecovery: si cancella e la richiesta riparte', async () => {
    await orphan(11 * MIN);
    const r = await rec.startRecovery(U);
    expect(r.id).toBe(RID);
    expect(h.server.created).toHaveLength(1);
    expect(KEY()).toMatchObject({ requestId: RID });
  });

  it('chiave orfana di 1 minuto senza openRecovery, o con GET /keyring in errore: retryLater (non alreadyOpen), chiave intatta, nessuna POST', async () => {
    const { kp } = await orphan(MIN);
    await expect(rec.startRecovery(U)).rejects.toMatchObject({ code: 'retryLater', key: 'vault.recovery.errors.retryLater' });
    for (const e of [netErr(), apiErr(500), apiErr(401)]) {
      h.server.getKeyringError = e;
      await expect(rec.startRecovery(U)).rejects.toMatchObject({ code: 'retryLater' });
    }
    expect(KEY()).toMatchObject({ requestId: null });
    expect(KEY()!.publicRaw).toEqual(kp.publicRaw);
    expect(h.server.created).toHaveLength(0);
  });

  it('due start in parallelo: una sola richiesta, l altra alreadyOpen (add e create-only, mai ConstraintError)', async () => {
    const res = await Promise.allSettled([rec.startRecovery(U), rec.startRecovery(U)]);
    expect(res.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rej = res.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(rej.reason).toMatchObject({ code: 'alreadyOpen' });
    expect(h.server.created).toHaveLength(1);
    expect(KEY()).toMatchObject({ requestId: RID });
  });

  it('rifiuto 4xx (tranne 401), 429 e 503: la chiave si cancella subito; rete, altri 5xx, 401: resta', async () => {
    for (const status of [400, 403, 404, 409, 422, 429, 503]) {
      reset();
      h.server.createError = apiErr(status);
      await expect(rec.startRecovery(U)).rejects.toMatchObject({ status });
      expect(KEY()).toBeUndefined();
    }
    for (const e of [netErr(), apiErr(500), apiErr(502), apiErr(401), proxy503()]) { // 503 senza fromServer: ambiguo, la POST potrebbe essere arrivata
      reset();
      h.server.createError = e;
      await expect(rec.startRecovery(U)).rejects.toBe(e);
      expect(KEY()).toMatchObject({ requestId: null });
    }
  });

  it('FP del 201 diverso da quello locale: richiesta annullata, chiave cancellata, releaseInvalid', async () => {
    h.server.createFingerprint = 'AAAAAAAA';
    await expect(rec.startRecovery(U)).rejects.toMatchObject({ code: 'releaseInvalid', key: 'vault.recovery.errors.releaseInvalid' });
    expect(h.server.cancelled).toEqual([RID]);
    expect(KEY()).toBeUndefined();
  });

  it('utente del token diverso: prima della POST niente di niente; dopo il 201 niente bind', async () => {
    useAuthStore.setState({ user: { id: OTHER, email: 'x@y.z' } });
    await expect(rec.startRecovery(U)).rejects.toMatchObject({ code: 'notReady' });
    expect(KEY()).toBeUndefined();
    expect(h.server.created).toHaveLength(0);
    useAuthStore.setState({ user: { id: U, email: 'a@b.c' } });
    h.server.onCreate = () => useAuthStore.setState({ user: { id: OTHER, email: 'x@y.z' } });
    await expect(rec.startRecovery(U)).rejects.toMatchObject({ code: 'notReady' });
    expect(KEY()).toMatchObject({ requestId: null }); // niente bind: la risolvera' una sync
  });

  it('rifiuto 4xx con utente cambiato durante la POST: la chiave non si cancella', async () => {
    h.server.createError = apiErr(400);
    h.server.onCreate = () => useAuthStore.setState({ user: { id: OTHER, email: 'x@y.z' } });
    await expect(rec.startRecovery(U)).rejects.toBeDefined();
    expect(KEY()).toMatchObject({ requestId: null });
  });

  it('F6 chiave sparita durante la POST: la richiesta creata si annulla sul server, poi notThisDevice', async () => {
    h.server.onCreate = () => { raw('deviceKeys').delete('recovery:' + U); };
    await expect(rec.startRecovery(U)).rejects.toMatchObject({ code: 'notThisDevice' });
    expect(h.server.cancelled).toEqual([RID]);
    expect(h.server.r?.status).toBe('CANCELLED');
    expect(KEY()).toBeUndefined();
  });

  it('F6 chiave sostituita da un\'altra durante la POST: annulla la richiesta e non tocca la chiave nuova', async () => {
    const other = await generateRecoveryKeyPair();
    h.server.onCreate = () => { raw('deviceKeys').set('recovery:' + U, { requestId: null, privateKey: other.privateKey, publicRaw: other.publicRaw, createdAt: Date.now() }); };
    await expect(rec.startRecovery(U)).rejects.toMatchObject({ code: 'notThisDevice' });
    expect(h.server.cancelled).toEqual([RID]);
    expect(KEY()).toMatchObject({ requestId: null });
    expect(KEY()!.publicRaw).toEqual(other.publicRaw);
  });

  it('utente cambiato mentre si genera la chiave: notReady, nessuna chiave, nessuna POST', async () => {
    vi.mocked(generateRecoveryKeyPair).mockImplementationOnce(async () => {
      const kp = await (await vi.importActual<typeof import('../../utils/vaultRecoveryCrypto')>('../../utils/vaultRecoveryCrypto')).generateRecoveryKeyPair();
      useAuthStore.setState({ user: { id: OTHER, email: 'x@y.z' } });
      return kp;
    });
    await expect(rec.startRecovery(U)).rejects.toMatchObject({ code: 'notReady' });
    expect(KEY()).toBeUndefined();
    expect(h.server.created).toHaveLength(0);
  });
});

describe('localRecovery e readCodeA', () => {
  it('localRecovery: null senza chiave, altrimenti requestId e FP propri', async () => {
    expect(await rec.localRecovery(U)).toBeNull();
    await world();
    expect(await rec.localRecovery(U)).toEqual({ requestId: RID, fingerprint: F.fingerprint });
  });

  it('readCodeA: apre la meta A solo in PENDING_CODE; altri stati null', async () => {
    await world();
    h.server.r!.sealedCodeA = F.sealedCode;
    expect(await rec.readCodeA(U, RID)).toBeNull(); // RELEASED
    h.server.r!.status = 'PENDING_CODE';
    expect(await rec.readCodeA(U, RID)).toBe(F.codeA);
    h.server.r!.status = 'WAITING';
    expect(await rec.readCodeA(U, RID)).toBeNull();
  });

  it('readCodeA: senza chiave locale (o altra richiesta) notThisDevice, senza chiamare il server', async () => {
    await expect(rec.readCodeA(U, RID)).rejects.toMatchObject({ code: 'notThisDevice' });
    await world();
    await expect(rec.readCodeA(U, 'altra-richiesta')).rejects.toMatchObject({ code: 'notThisDevice' });
    expect(h.server.getRecoveryCalls).toBe(0);
  });

  it('readCodeA: busta che la chiave locale non apre -> notThisDevice', async () => {
    await world();
    await device.deleteRecoveryKeyIf(U, { requestId: RID });
    const other = await generateRecoveryKeyPair();
    await device.addRecoveryKey(U, other);
    await device.bindRecoveryKeyIf(U, other.publicRaw, RID);
    h.server.r!.status = 'PENDING_CODE';
    h.server.r!.sealedCodeA = F.sealedCode;
    await expect(rec.readCodeA(U, RID)).rejects.toMatchObject({ code: 'notThisDevice' });
  });
});

describe('syncLocalRecovery', () => {
  const noWrites = async () => { expect(KEY()).toBeDefined(); };

  it('nessuna chiave: none, nessuna chiamata', async () => {
    expect(await rec.syncLocalRecovery(U)).toBe('none');
    expect(h.server.getRecoveryCalls + h.server.getKeyringCalls).toBe(0);
  });

  it('chiave legata: stati aperti -> active, chiave intatta', async () => {
    for (const status of ['PENDING_APPROVAL', 'PENDING_CODE', 'WAITING', 'RELEASED']) {
      reset();
      await world();
      h.server.r!.status = status;
      expect(await rec.syncLocalRecovery(U)).toBe('active');
      await noWrites();
    }
  });

  it('chiave legata: COMPLETED, CANCELLED, REJECTED, EXPIRED, 404 recoveryNotFound -> cleared, chiave cancellata', async () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'REJECTED', 'EXPIRED']) {
      reset();
      await world();
      h.server.r!.status = status;
      expect(await rec.syncLocalRecovery(U)).toBe('cleared');
      expect(KEY()).toBeUndefined();
    }
    reset();
    await world();
    h.server.r = null;
    expect(await rec.syncLocalRecovery(U)).toBe('cleared');
    expect(KEY()).toBeUndefined();
  });

  it('chiave legata: rete, 5xx, 401, altri 404 -> unknown, nulla si cancella', async () => {
    await world();
    for (const e of [netErr(), apiErr(500), apiErr(401), apiErr(404, 'errors.common.notFound'), apiErr(403)]) {
      h.server.getRecoveryError = e;
      expect(await rec.syncLocalRecovery(U)).toBe('unknown');
      await noWrites();
    }
  });

  it('non cancella mai marker kit/pin del vault (la sync non li tocca)', async () => {
    await world();
    seedKit('ab');
    await device.setPending(U, { kind: 'pin', rev: 1, wrappedVkPinHash: 'cd' });
    h.server.r!.status = 'EXPIRED';
    expect(await rec.syncLocalRecovery(U)).toBe('cleared');
    expect(MARKER()).toBeDefined();
    expect(await device.getPending(U, 'pin')).not.toBeNull();
  });

  describe('chiave orfana (requestId null, POST senza esito)', () => {
    it('openRecovery con lo stesso FP: si lega (anche se giovane), active', async () => {
      const { fp } = await orphan(1000);
      h.server.openRecovery = openFor(fp);
      expect(await rec.syncLocalRecovery(U)).toBe('active');
      expect(KEY()).toMatchObject({ requestId: RID });
    });

    it('giovane (< 10 min) e keyring senza openRecovery o con FP diverso: unknown, nulla cancellato', async () => {
      await orphan(MIN);
      expect(await rec.syncLocalRecovery(U)).toBe('unknown');
      h.server.openRecovery = openFor('AAAAAAAA');
      expect(await rec.syncLocalRecovery(U)).toBe('unknown');
      expect(KEY()).toMatchObject({ requestId: null });
    });

    it('vecchia (>= 10 min) e keyring 200 senza openRecovery, o con FP diverso: cleared', async () => {
      await orphan(10 * MIN + 1000);
      expect(await rec.syncLocalRecovery(U)).toBe('cleared');
      expect(KEY()).toBeUndefined();
      await orphan(10 * MIN + 1000);
      h.server.openRecovery = openFor('AAAAAAAA');
      expect(await rec.syncLocalRecovery(U)).toBe('cleared');
      expect(KEY()).toBeUndefined();
    });

    it('vecchia ma GET /keyring in rete, 5xx o 401: unknown, nulla cancellato', async () => {
      await orphan(20 * MIN);
      for (const e of [netErr(), apiErr(500), apiErr(502), apiErr(401)]) {
        h.server.getKeyringError = e;
        expect(await rec.syncLocalRecovery(U)).toBe('unknown');
        expect(KEY()).toMatchObject({ requestId: null });
      }
    });

    it('sync vecchia contro una chiave nuova di startRecovery: la chiave nuova resta intatta', async () => {
      const { kp: k1 } = await orphan(20 * MIN);
      const k2 = await generateRecoveryKeyPair();
      // mentre la sync aspetta il keyring, la chiave vecchia sparisce e ne arriva una nuova (startRecovery)
      h.server.onGetKeyring = async () => {
        h.server.onGetKeyring = null;
        await device.deleteRecoveryKeyIf(U, { publicRaw: k1.publicRaw });
        await device.addRecoveryKey(U, k2);
      };
      expect(await rec.syncLocalRecovery(U)).toBe('unknown');
      expect(KEY()!.publicRaw).toEqual(k2.publicRaw);
    });

    it('lega con CAS: se la chiave e cambiata mentre si aspettava, niente bind', async () => {
      const { kp: k1, fp } = await orphan(MIN);
      const k2 = await generateRecoveryKeyPair();
      h.server.openRecovery = openFor(fp);
      h.server.onGetKeyring = async () => {
        h.server.onGetKeyring = null;
        await device.deleteRecoveryKeyIf(U, { publicRaw: k1.publicRaw });
        await device.addRecoveryKey(U, k2);
      };
      expect(await rec.syncLocalRecovery(U)).toBe('unknown');
      expect(KEY()).toMatchObject({ requestId: null });
      expect(KEY()!.publicRaw).toEqual(k2.publicRaw);
    });
  });

  describe('utente del token', () => {
    it('diverso prima della chiamata: unknown, nessuna chiamata, nulla cancellato', async () => {
      await world();
      useAuthStore.setState({ user: { id: OTHER, email: 'x@y.z' } });
      expect(await rec.syncLocalRecovery(U)).toBe('unknown');
      expect(h.server.getRecoveryCalls).toBe(0);
      await noWrites();
    });

    it('cambiato durante la risposta: 404 recoveryNotFound e stati chiusi non cancellano nulla', async () => {
      await world();
      h.server.r = null; // 404
      h.server.onGetRecovery = () => useAuthStore.setState({ user: { id: OTHER, email: 'x@y.z' } });
      expect(await rec.syncLocalRecovery(U)).toBe('unknown');
      await noWrites();
      useAuthStore.setState({ user: { id: U, email: 'a@b.c' } });
      h.server.r = { status: 'EXPIRED', fingerprint: F.fingerprint, sig: F.signature };
      expect(await rec.syncLocalRecovery(U)).toBe('unknown');
      await noWrites();
    });

    it('orfana: cambiato durante il GET /keyring: niente bind e niente delete', async () => {
      const { fp } = await orphan(20 * MIN);
      h.server.openRecovery = openFor(fp);
      h.server.onGetKeyring = async () => { useAuthStore.setState({ user: { id: OTHER, email: 'x@y.z' } }); };
      expect(await rec.syncLocalRecovery(U)).toBe('unknown');
      expect(KEY()).toMatchObject({ requestId: null });
    });
  });
});

// ================================================================ T6: completamento (commit, poi Kit)

const NOW = { delays: [0, 0] };
async function prepared(offline = false) {
  const w = await world();
  st().setKeyringCache(U, { status: 'READY', epoch: 0, rev: 3, kdf: 'argon2id', kdfParams: KDF, pinSalt: h.server.kr.pinSalt, wrappedVkPin: h.server.kr.wrappedVkPin, rootKeyId: F.rootKeyId, offlineUnlock: offline });
  return w;
}
const complete = (w: World, over: Partial<Parameters<typeof rec.completeRecovery>[0]> = {}) =>
  rec.completeRecovery({ userId: U, requestId: RID, kit: w.kit, newPin: NEW_PIN, retryDelaysMs: NOW.delays, ...over });
const applied = (r: Awaited<ReturnType<typeof rec.completeRecovery>>) => {
  expect(r.verdict).toBe('applied');
  return r.kit!;
};
/** Stato IDB dopo un esito diverso da 200: solo il marker `kit` e la chiave di recupero ancora legata, nessuno share, nessuna chiave del dispositivo. */
function expectNoWritesBeyondMarker() {
  expect([...raw('pending').keys()]).toEqual([`${U}:kit:${MARKER()!.escrowHash}`]);
  expect([...raw('deviceKeys').keys()]).toEqual(['recovery:' + U]);
  expect(KEY()).toMatchObject({ requestId: RID });
  expect(raw('shares').size).toBe(0);
  expect(st().unlockedUserId).toBeNull();
}

describe('completeRecovery', () => {
  it('ritardi dei tentativi: 1 s e 3 s di default', () => {
    expect(rec.RETRY_DELAYS_MS).toEqual([1000, 3000]);
  });

  describe('percorso felice', () => {
    it('marker kit PRIMA della POST (escrowHash = sha256 del nuovo escrowBlob); 200: store sbloccato, Kit di 20 B, chiave cancellata, nessun segreto in IDB', async () => {
      const w = await prepared();
      let atPost: unknown;
      const orig = h.server.completeRecovery.bind(h.server);
      h.server.completeRecovery = async (...a: Parameters<FakeServer['completeRecovery']>) => { atPost = MARKER(); return orig(...a); };
      const kit = applied(await complete(w));
      expect(kit).toHaveLength(20);
      expect(h.server.posts).toHaveLength(1);
      const built = JSON.parse((await vi.mocked(buildRecoveryPayload).mock.results[0].value).payload) as { wrap: { authKey: string; serverShare: string; wrappedVkPin: string }; escrow: Record<string, string> };
      expect(atPost).toEqual({ kind: 'kit', escrowHash: await sha256hexBytes(b64uDecode(built.escrow.escrowBlob)), epoch: 0, rev: 3, origin: 'recovery', requestId: RID });
      expect(h.server.r!.status).toBe('COMPLETED');
      expect(st().unlockedUserId).toBe(U);
      expect(st().keys).not.toBeNull();
      expect(st().byUser[U]).toMatchObject({ rev: 4, epoch: 0 });
      expect(st().byUser[U].pinSalt).toBe(h.server.kr.pinSalt);
      expect(KEY()).toBeUndefined();
      expect(purgeApiCache).toHaveBeenCalled();
      const all = dump();
      for (const secret of [built.wrap.authKey, built.wrap.serverShare, NEW_PIN, formatKit(kit), b64uEncode(kit), built.escrow.sealedRootShare, built.escrow.userShareUnderVk]) expect(all).not.toContain(secret);
      expect(all).not.toContain(Buffer.from(built.wrap.serverShare, 'base64url').toString('latin1'));
      // P5: in IDB solo hash, numeri, origin e requestId (nessun createdAt, nessun payload)
      expect([...raw('pending').keys()]).toEqual([`${U}:kit:${h.server.kr.escrowHash}`]);
      expect(raw('pending').get(`${U}:kit:${h.server.kr.escrowHash}`)).toEqual({ kind: 'kit', escrowHash: h.server.kr.escrowHash, epoch: 0, rev: 3, origin: 'recovery', requestId: RID });
    });

    it('checkPendingOnStart sul keyring aggiornato -> kitUnconfirmed; confirmKit chiude il marker', async () => {
      const w = await prepared();
      const r = await complete(w);
      applied(r);
      expect(r.escrowHash).toBe(h.server.kr.escrowHash); // item 1: l'hash lo porta il risultato, la UI lo passa a confirmKit
      expect(MARKER()).toBeDefined(); // il modulo non lo cancella mai
      expect(await checkPendingOnStart(U)).toBe('kitUnconfirmed');
      await confirmKit(U, r.escrowHash!);
      expect(MARKER()).toBeUndefined();
      expect(await checkPendingOnStart(U)).toBe('none');
    });

    // item 2 (N9): dispositivo senza cache del keyring (nuovo, o dopo "Rimuovi vault da questo dispositivo")
    it('N9: senza cache del keyring il recupero la crea dal server PRIMA dello sblocco: store sbloccato e cache con rev, escrowHash e pinSalt nuovi', async () => {
      const w = await world(); // nessuna setKeyringCache
      expect(st().byUser[U]).toBeUndefined();
      let cacheAtUnlock: unknown = 'non chiamato';
      const unlock = st().unlock;
      useVaultStore.setState({ unlock: (...a: Parameters<typeof unlock>) => { cacheAtUnlock = st().byUser[U]; unlock(...a); } });
      try {
        const r = await complete(w);
        applied(r);
        expect(cacheAtUnlock).toMatchObject({ status: 'READY', rev: 4 }); // la cache c'era gia' quando lo store si e' sbloccato
      } finally {
        useVaultStore.setState({ unlock });
      }
      expect(st().unlockedUserId).toBe(U);
      expect(st().byUser[U]).toMatchObject({
        status: 'READY', epoch: 0, rev: 4, pinSalt: h.server.kr.pinSalt, rootKeyId: F.rootKeyId, offlineUnlock: false, // wrappedVkPin non si tiene in cache con lo sblocco offline spento
      });
      expect(await checkPendingOnStart(U)).toBe('kitUnconfirmed'); // e il Kit non confermato e' ancora tracciato (hash del keyring = quello del marker)
    });

    it('N9: senza cache e refresh fallito: sbloccato comunque (il server ha committato), nessuna cache sintetizzata, nessuno share', async () => {
      const w = await world();
      h.server.onPost = () => { h.server.getKeyringError = netErr(); };
      applied(await complete(w));
      expect(st().unlockedUserId).toBe(U);
      expect(st().byUser[U]).toBeUndefined();
      expect(raw('shares').size).toBe(0);
    });

    it('nuovo wrap e nuovo escrow restituiscono la stessa VK; Kit vecchio e share vecchia sul nuovo escrow falliscono; dimensioni del payload', async () => {
      const w = await prepared();
      let sRootNew = new Uint8Array(0);
      vi.mocked(sealRootShare).mockImplementationOnce(async (s, ...rest) => {
        sRootNew = s.slice();
        return (await vi.importActual<typeof import('../../utils/vaultCrypto')>('../../utils/vaultCrypto')).sealRootShare(s, ...rest);
      });
      const kit = applied(await complete(w));
      const built = JSON.parse((await vi.mocked(buildRecoveryPayload).mock.results[0].value).payload) as { wrap: { pinSalt: string; serverShare: string; wrappedVkPin: string; kdfParams: typeof KDF }; escrow: Record<string, string> };
      expect(b64uDecode(built.escrow.escrowBlob)).toHaveLength(60);
      expect(b64uDecode(built.escrow.sealedRootShare)).toHaveLength(157);
      expect(b64uDecode(built.escrow.userShareUnderVk)).toHaveLength(48);
      expect(b64uDecode(built.wrap.wrappedVkPin)).toHaveLength(60);
      const S = await deriveS(NEW_PIN, b64uDecode(built.wrap.pinSalt), KDF);
      const kek = await deriveKekPin(S, b64uDecode(built.wrap.serverShare), b64uDecode(built.wrap.pinSalt), U);
      expect(await unwrapVkPin(kek, b64uDecode(built.wrap.wrappedVkPin), U, 0, built.wrap.kdfParams)).toEqual(w.vkRaw);
      const blob = b64uDecode(built.escrow.escrowBlob);
      expect(await unwrapEscrow(await deriveRk(sRootNew, kit, U), blob, U, 0, built.escrow.rootKeyId)).toEqual(w.vkRaw);
      await expect(unwrapEscrow(await deriveRk(sRootNew, w.sUser, U), blob, U, 0, built.escrow.rootKeyId)).rejects.toThrow();
      await expect(unwrapEscrow(await deriveRk(Uint8Array.from(Buffer.from(F.sRootHex, 'hex')), w.sUser, U), blob, U, 0, built.escrow.rootKeyId)).rejects.toThrow();
    });

    it('vkProof verificato con node:crypto sul path del complete (e non su un altro); S del nuovo PIN azzerato', async () => {
      const w = await prepared();
      vi.mocked(deriveS).mockClear();
      applied(await complete(w));
      const { payload, proof } = h.server.posts[0];
      const msg = (path: string) => `notiq/vault/v3/proof|${path}|${U}|0|3|${createHash('sha256').update(payload).digest('hex')}`;
      const pub = { key: Buffer.from(h.server.kr.vkSigPub, 'base64url'), format: 'der' as const, type: 'spki' as const, dsaEncoding: 'ieee-p1363' as const };
      expect(verify('sha256', Buffer.from(msg(`POST /api/vault/recovery/${RID}/complete`)), pub, Buffer.from(proof, 'base64url'))).toBe(true);
      expect(verify('sha256', Buffer.from(msg('PUT /api/vault/keyring')), pub, Buffer.from(proof, 'base64url'))).toBe(false);
      const results = await Promise.all(vi.mocked(deriveS).mock.results.map((r) => r.value as Promise<Uint8Array>));
      expect(results.length).toBeGreaterThan(0);
      for (const s of results) expect(s.every((x) => x === 0)).toBe(true);
    });

    it('sblocco offline attivo: lo share del dispositivo ha il NUOVO serverShare; spento: share cancellato', async () => {
      const w = await prepared(true);
      await device.putShare(U, { epoch: 0, shareEnc: new Uint8Array([1]), wrappedVkSigKey: new Uint8Array([2]) });
      applied(await complete(w));
      const share = (await device.getShare(U))!;
      const devKey = (await device.getDeviceKey(U))!;
      expect(b64uEncode(await decryptShare(devKey, share.shareEnc, U, 0))).toBe(h.server.kr.serverShare);
      expect(share.wrappedVkSigKey).toEqual(b64uDecode(h.server.kr.wrappedVkSigKey));
      expect(st().byUser[U].offlineUnlock).toBe(true);

      reset();
      h.server = new FakeServer();
      const q = await prepared(false);
      await device.putShare(U, { epoch: 0, shareEnc: new Uint8Array([1]), wrappedVkSigKey: new Uint8Array([2]) });
      applied(await complete(q));
      expect(await device.getShare(U)).toBeNull();
    });

    it('la cache del keyring si aggiorna SOLO dal server: senza risposta del GET resta quella vecchia (nessuna cache sintetizzata)', async () => {
      const w = await prepared();
      h.server.onPost = () => { h.server.getKeyringError = netErr(); };
      applied(await complete(w));
      expect(st().byUser[U]).toMatchObject({ rev: 3 });
      expect(st().unlockedUserId).toBe(U);
    });

    it('passi dopo il 200 best-effort: purge che rifiuta e scritture IDB dello share che falliscono, applied comunque', async () => {
      const w = await prepared(true);
      vi.mocked(purgeApiCache).mockRejectedValueOnce(new Error('boom'));
      fail.writes = 'shares';
      const r = await complete(w);
      expect(r.verdict).toBe('applied');
      expect(st().unlockedUserId).toBe(U);
      expect(KEY()).toBeUndefined();
    });

    it('chiave effimera: compare-and-delete su requestId (una chiave legata ad altra richiesta non si cancella)', async () => {
      const w = await prepared();
      h.server.onPost = () => {
        // un altro flusso ha sostituito la chiave con una legata a un'altra richiesta
        raw('deviceKeys').set('recovery:' + U, { ...KEY()!, requestId: 'altra-richiesta' });
      };
      applied(await complete(w));
      expect(KEY()).toMatchObject({ requestId: 'altra-richiesta' });
    });
  });

  describe('marker prima della POST', () => {
    it('addKitMarker che rifiuta: 0 POST, errore, nessun Kit', async () => {
      const w = await prepared();
      fail.writes = 'pending';
      await expect(complete(w)).rejects.toBeDefined();
      expect(h.server.posts).toHaveLength(0);
      fail.writes = null;
      expect(MARKER()).toBeUndefined();
      expect(KEY()).toMatchObject({ requestId: RID });
    });
  });

  describe('tentativi sui transitori', () => {
    it('rete x2 e poi 200: applied, con lo STESSO body in ogni tentativo', async () => {
      const w = await prepared();
      h.server.failQueue = [netErr(), netErr()];
      applied(await complete(w));
      expect(h.server.posts).toHaveLength(3);
      expect(new Set(h.server.posts.map((p) => p.payload)).size).toBe(1);
      expect(new Set(h.server.posts.map((p) => p.proof)).size).toBe(1);
      expect(st().unlockedUserId).toBe(U);
    });

    it('risposta persa dopo l applicazione, poi retry: 200 idempotente, applied', async () => {
      const w = await prepared();
      h.server.applyThenFailQueue = [netErr()];
      applied(await complete(w));
      expect(h.server.posts).toHaveLength(2);
      expect(h.server.r!.status).toBe('COMPLETED');
    });

    it('rete, 5xx e 429 per 3 tentativi: unknown dopo 3 POST, marker presente, nessun Kit', async () => {
      for (const e of [netErr(), apiErr(500), apiErr(502), apiErr(429)]) {
        reset();
        h.server = new FakeServer();
        const w = await prepared();
        h.server.completeError = e;
        const r = await complete(w);
        expect(r).toMatchObject({ verdict: 'unknown' });
        expect(r.kit).toBeUndefined();
        expect(h.server.posts).toHaveLength(3);
        expectNoWritesBeyondMarker();
      }
    });

    it('i ritardi iniettati si rispettano (2 attese)', async () => {
      const w = await prepared();
      h.server.completeError = netErr();
      const t0 = Date.now();
      await complete(w, { retryDelaysMs: [30, 30] });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
    });
  });

  describe('tabella dei verdetti', () => {
    const row = async (setup: (s: FakeServer) => void) => {
      const w = await prepared();
      setup(h.server);
      const r = await complete(w);
      expect(r.kit).toBeUndefined();
      expectNoWritesBeyondMarker();
      return r;
    };
    const fresh = () => { reset(); h.server = new FakeServer(); };

    it('409 con richiesta ancora RELEASED -> notApplied/keyringChanged', async () => {
      const r = await row((s) => { s.completeError = apiErr(409, 'errors.vault.staleRev'); });
      expect(r).toMatchObject({ verdict: 'notApplied', reason: 'keyringChanged' });
      expect(h.server.posts).toHaveLength(1);
    });

    it('409 con richiesta COMPLETED -> completedElsewhere', async () => {
      const r = await row((s) => { s.completeError = apiErr(409); s.onPost = () => { s.r!.status = 'COMPLETED'; }; });
      expect(r).toMatchObject({ verdict: 'completedElsewhere' });
    });

    it('409 con richiesta EXPIRED / CANCELLED / REJECTED -> notApplied/requestClosed', async () => {
      for (const status of ['EXPIRED', 'CANCELLED', 'REJECTED']) {
        fresh();
        const r = await row((s) => { s.completeError = apiErr(409); s.onPost = () => { s.r!.status = status; }; });
        expect(r).toMatchObject({ verdict: 'notApplied', reason: 'requestClosed' });
      }
    });

    it('409 e GET /recovery/:id 404 recoveryNotFound -> notApplied/requestClosed', async () => {
      const r = await row((s) => { s.completeError = apiErr(409); s.onPost = () => { s.r = null; }; });
      expect(r).toMatchObject({ verdict: 'notApplied', reason: 'requestClosed' });
    });

    it('409 e GET fallita (rete, 5xx, 401, altro 404) -> unknown', async () => {
      for (const e of [netErr(), apiErr(500), apiErr(401), apiErr(404, 'errors.common.notFound')]) {
        fresh();
        const r = await row((s) => { s.completeError = apiErr(409); s.onPost = () => { s.getRecoveryError = e; }; });
        expect(r).toMatchObject({ verdict: 'unknown' });
      }
    });

    it('404 recoveryNotFound alla POST -> notApplied/requestClosed; altro 404 -> unknown', async () => {
      expect(await row((s) => { s.completeError = apiErr(404, 'errors.vault.recoveryNotFound'); })).toMatchObject({ verdict: 'notApplied', reason: 'requestClosed' });
      fresh();
      expect(await row((s) => { s.completeError = apiErr(404, 'errors.common.notFound'); })).toMatchObject({ verdict: 'unknown' });
    });

    it('400, 403, 413, 422, 503 -> notApplied/rejected, una sola POST', async () => {
      for (const status of [400, 403, 413, 422, 503]) {
        fresh();
        const r = await row((s) => { s.completeError = apiErr(status); });
        expect(r).toMatchObject({ verdict: 'notApplied', reason: 'rejected' });
        expect(h.server.posts).toHaveLength(1);
      }
    });

    it('401 -> unknown, una sola POST (non e transitorio)', async () => {
      const r = await row((s) => { s.completeError = apiErr(401); });
      expect(r).toMatchObject({ verdict: 'unknown' });
      expect(h.server.posts).toHaveLength(1);
    });

    it('i risultati portano la chiave i18n del messaggio', async () => {
      const r = await row((s) => { s.completeError = apiErr(400); });
      expect(r.key).toBe('vault.recovery.errors.rejected');
    });
  });

  describe('cambio utente', () => {
    it('durante la POST: nessuno sblocco, Kit azzerato (errore notReady), marker presente', async () => {
      const w = await prepared();
      h.server.onPost = () => useAuthStore.setState({ user: { id: OTHER, email: 'x@y.z' } });
      await expect(complete(w)).rejects.toMatchObject({ code: 'notReady' });
      expect(st().unlockedUserId).toBeNull();
      expect(st().keys).toBeNull();
      expect(MARKER()).toBeDefined();
    });
  });

  describe('Web Lock', () => {
    it('lock preso con il nome notiq-vault-recovery:<userId>, exclusive e ifAvailable; tenuto solo durante la chiamata', async () => {
      const w = await prepared();
      const calls: unknown[][] = [];
      const held = new Set<string>();
      vi.stubGlobal('navigator', { locks: { request: async (n: string, o: unknown, cb: (l: unknown) => unknown) => { calls.push([n, o]); held.add(n); try { return await cb({ name: n }); } finally { held.delete(n); } } } });
      let heldAtPost = false;
      h.server.onPost = () => { heldAtPost = held.has(LOCK); };
      applied(await complete(w));
      expect(calls[0]).toEqual([LOCK, { mode: 'exclusive', ifAvailable: true }]);
      expect(heldAtPost).toBe(true);
      expect(held.size).toBe(0);
    });

    it('occupato: busy, 0 chiamate di rete, nessuna scrittura', async () => {
      const w = await prepared();
      fakeLocks().held.add(LOCK);
      await expect(complete(w)).rejects.toMatchObject({ code: 'busy', key: 'vault.recovery.errors.busy' });
      expect(h.server.getRecoveryCalls + h.server.getKeyringCalls + h.server.posts.length).toBe(0);
      expect(MARKER()).toBeUndefined();
    });

    it('dopo un errore (di preparazione o imprevisto) il lock e libero', async () => {
      const locks = fakeLocks();
      const w = await prepared();
      await expect(complete(w, { kit: formatKit(crypto.getRandomValues(new Uint8Array(20))) })).rejects.toMatchObject({ code: 'kitInvalid' });
      expect(locks.held.size).toBe(0);
      h.server.getKeyringError = netErr();
      await expect(complete(w)).rejects.toBeDefined();
      expect(locks.held.size).toBe(0);
      h.server.getKeyringError = null;
      applied(await complete(w));
      expect(locks.held.size).toBe(0);
    });

    it('senza navigator.locks, due chiamate in parallelo contro un server con CAS: una applied, l altra appliedWithoutKit (il vincitore e\' nostro); F5: il banner c\'e\'', async () => {
      const w = await prepared();
      const [a, b] = await Promise.all([complete(w, { newPin: 'pinAAAA' }), complete(w, { newPin: 'pinBBBB' })]);
      expect([a.verdict, b.verdict].sort()).toEqual(['applied', 'appliedWithoutKit']);
      expect(h.server.posts).toHaveLength(2);
      expect((a.verdict === 'applied' ? b : a).kit).toBeUndefined();
      expect(MARKERS()).toHaveLength(2); // uno per tentativo: nessuno sovrascrive l'altro
      expect(await checkPendingOnStart(U)).toBe('kitUnconfirmed'); // F5: il marker del vincitore c'e'
      expect(MARKERS().map((m) => m.escrowHash)).toEqual([h.server.kr.escrowHash]); // il perdente e' stato superato da (epoch, rev)
    });
  });

  describe('verifica del rilascio e Kit (cerimonia crittografica invariata)', () => {
    it('round-trip a runtime fallito: errore, nessun marker, 0 POST', async () => {
      const w = await prepared();
      const real = await vi.importActual<typeof import('../../utils/vaultRecoveryCrypto')>('../../utils/vaultRecoveryCrypto');
      vi.mocked(buildRecoveryPayload).mockImplementationOnce(async (a) => {
        const r = await real.buildRecoveryPayload(a);
        const o = JSON.parse(r.payload);
        const b = Buffer.from(o.wrap.wrappedVkPin, 'base64url');
        b[30] ^= 1;
        o.wrap.wrappedVkPin = b.toString('base64url');
        return { ...r, payload: JSON.stringify(o) };
      });
      await expect(complete(w)).rejects.toThrow();
      expect(MARKER()).toBeUndefined();
      expect(h.server.posts).toHaveLength(0);
    });

    it('firma, FP o chiave root falsi: releaseInvalid, nessuna scrittura, niente Argon2', async () => {
      const w = await prepared();
      vi.mocked(deriveS).mockClear();
      const bad = Buffer.from(F.signature, 'base64url');
      bad[10] ^= 1;
      h.server.r!.sig = bad.toString('base64url');
      await expect(complete(w)).rejects.toMatchObject({ code: 'releaseInvalid' });
      h.server.r!.sig = F.signature;
      h.server.r!.fingerprint = 'AAAAAAAA';
      await expect(complete(w)).rejects.toMatchObject({ code: 'releaseInvalid' });
      h.server.r!.fingerprint = F.fingerprint;
      h.server.kr.rootKeyId = 'rk_sconosciuta000000';
      await expect(complete(w)).rejects.toMatchObject({ code: 'releaseInvalid' });
      h.server.kr.rootKeyId = F.rootKeyId;
      const other = await generateRecoveryKeyPair();
      await device.deleteRecoveryKeyIf(U, { requestId: RID });
      await device.addRecoveryKey(U, other);
      await device.bindRecoveryKeyIf(U, other.publicRaw, RID);
      h.server.r!.fingerprint = await fingerprintOf(other.publicRaw);
      await expect(complete(w)).rejects.toMatchObject({ code: 'releaseInvalid' });
      expect(MARKER()).toBeUndefined();
      expect(deriveS).not.toHaveBeenCalled();
      expect(h.server.posts).toHaveLength(0);
    });

    it('escrow del keyring diverso da quello della richiesta: keyringChanged', async () => {
      const w = await prepared();
      h.server.kr.escrowHash = 'ff'.repeat(32);
      await expect(complete(w)).rejects.toMatchObject({ code: 'keyringChanged' });
      expect(MARKER()).toBeUndefined();
    });

    it('richiesta non ancora rilasciata: notReleased (la richiesta e sana); altra richiesta o senza chiave locale: notThisDevice', async () => {
      const w = await prepared();
      for (const status of ['PENDING_APPROVAL', 'PENDING_CODE', 'WAITING']) {
        h.server.r!.status = status;
        await expect(complete(w)).rejects.toMatchObject({ code: 'notReleased', key: 'vault.recovery.errors.notReleased' });
      }
      expect(h.server.cancelled).toHaveLength(0);
      expect(MARKER()).toBeUndefined();
      h.server.r!.status = 'WAITING';
      await expect(complete(w, { requestId: 'altra' })).rejects.toMatchObject({ code: 'notThisDevice' });
      await device.deleteRecoveryKeyIf(U, { requestId: RID });
      await expect(complete(w)).rejects.toMatchObject({ code: 'notThisDevice' });
      h.server.r = null; // 404
      await expect(complete(w)).rejects.toMatchObject({ code: 'notThisDevice' });
    });

    it('RELEASED senza escrowBlob (keyring non READY): keyringChanged; stato sconosciuto: releaseInvalid', async () => {
      const w = await prepared();
      h.server.kr.escrowBlob = '';
      await expect(complete(w)).rejects.toMatchObject({ code: 'keyringChanged' });
      h.server.kr.escrowBlob = b64uEncode(new Uint8Array(60));
      h.server.r!.status = 'WEIRD';
      await expect(complete(w)).rejects.toMatchObject({ code: 'releaseInvalid' });
      expect(MARKER()).toBeUndefined();
      expect(h.server.posts).toHaveLength(0);
    });

    it('Kit errato o malformato: kitInvalid, nessun marker, 0 POST', async () => {
      const w = await prepared();
      await expect(complete(w, { kit: formatKit(crypto.getRandomValues(new Uint8Array(20))) })).rejects.toMatchObject({ code: 'kitInvalid' });
      await expect(complete(w, { kit: 'ZZZZ' })).rejects.toMatchObject({ code: 'kitInvalid' });
      expect(MARKER()).toBeUndefined();
      expect(h.server.posts).toHaveLength(0);
    });
  });
});

// ================================================================ giro correzioni 1 (PoC F1-F6 del red-team)

const opensWith = async (pin: string) => {
  const salt = b64uDecode(h.server.kr.pinSalt);
  const S = await deriveS(pin, salt, KDF);
  const kek = await deriveKekPin(S, b64uDecode(h.server.kr.serverShare), salt, U);
  try { await unwrapVkPin(kek, b64uDecode(h.server.kr.wrappedVkPin), U, 0, h.server.kr.kdfParams); return true; } catch { return false; }
};
/** Prima POST: (before) poi applica e perde la risposta; le successive lanciano after(). */
function commitThenLose(after: () => unknown, before?: () => Promise<void>) {
  const orig = h.server.completeRecovery.bind(h.server);
  let n = 0;
  h.server.completeRecovery = async (id: string, p: string, v: string) => {
    if (++n === 1) { if (before) await before(); await orig(id, p, v); throw netErr(); }
    h.server.posts.push({ id, payload: p, proof: v });
    throw after();
  };
}
/** Prima POST: errore `first` senza applicare; le successive: after(). */
function failThen(first: unknown, after: () => unknown) {
  let n = 0;
  h.server.completeRecovery = async (id: string, p: string, v: string) => {
    h.server.posts.push({ id, payload: p, proof: v });
    throw ++n === 1 ? first : after();
  };
}

describe('marker kit per escrow (F1, F5, P1)', () => {
  it.each([['con lock', true], ['senza lock', false]])('F1 %s: la scheda B durante la POST non cancella il marker (stesso rev, hash diverso); commit + risposta persa => il banner compare', async (_n, locks) => {
    if (locks) fakeLocks();
    const w = await prepared();
    let tabB = '';
    commitThenLose(netErr, async () => { tabB = await checkPendingOnStart(U); });
    const r = await complete(w);
    expect(r.verdict).toBe('unknown');
    expect(tabB).toBe('none'); // nessun lock da prendere: B legge e lascia stare
    expect(MARKER()).toBeDefined();
    expect(await checkPendingOnStart(U)).toBe('kitUnconfirmed');
    expect(await opensWith(NEW_PIN)).toBe(true);
  });

  it('il marker kit di completeRecovery non ha createdAt ne confirmed, e questo codice non lo cancella mai', async () => {
    const w = await prepared();
    applied(await complete(w));
    expect(Object.keys(MARKER()!).sort()).toEqual(['epoch', 'escrowHash', 'kind', 'origin', 'requestId', 'rev']);
    expect(MARKERS()).toHaveLength(1);
  });

  // P1 (red-team): due tentativi, il primo resta in volo e committa dopo che il secondo ha scritto il suo marker
  it('P1: due tentativi con la POST 1 ancora in rete -> entrambi i marker; riavvio: H1 kitUnconfirmed, H2 cancellato; il tentativo 2 riceve appliedWithoutKit', async () => {
    fakeLocks();
    const w = await prepared();
    const orig = h.server.completeRecovery.bind(h.server);
    let first: { id: string; p: string; v: string } | null = null;
    h.server.completeRecovery = async (id: string, p: string, v: string) => {
      if (!first) first = { id, p, v };
      if (p === first.p) throw netErr(); // la POST 1 non risponde...
      await orig(first.id, first.p, first.v); // ...ma committa mentre il tentativo 2 e' in rete
      return orig(id, p, v);
    };
    const a = await complete(w, { newPin: 'pinAAAA' });
    const hA = MARKER()!.escrowHash;
    const b = await complete(w, { newPin: 'pinBBBB' });
    expect(a.verdict).toBe('unknown');
    expect(MARKERS()).toHaveLength(2);
    expect(h.server.kr.escrowHash).toBe(hA); // ha committato A
    expect(b).toMatchObject({ verdict: 'appliedWithoutKit', key: 'vault.recovery.errors.appliedWithoutKit' });
    expect(b.kit).toBeUndefined();
    expect(await checkPendingOnStart(U)).toBe('kitUnconfirmed');
    expect(MARKERS().map((m) => m.escrowHash)).toEqual([hA]);
    expect(await opensWith('pinAAAA')).toBe(true);
  });

  // F5 (poc3): senza Web Lock, due cerimonie, vince A (risposta persa) e il marker di B non sovrascrive quello di A
  it('F5 senza Web Lock: vince A (risposta persa) mentre B ha scritto il suo marker => il banner c\'e\'', async () => {
    const w = await prepared();
    const orig = h.server.completeRecovery.bind(h.server);
    let first: string | null = null;
    let bDone: Promise<unknown> | null = null;
    let release!: () => void;
    const aApplied = new Promise<void>((r) => { release = r; });
    h.server.completeRecovery = async (id: string, p: string, v: string) => {
      if (first === null) {
        first = p;
        const hA = MARKER()!.escrowHash;
        bDone = complete(w, { newPin: 'pinBBBB' }).then((x) => x.verdict, code);
        await vi.waitFor(() => expect(MARKERS().some((m) => m.escrowHash !== hA)).toBe(true));
        await orig(id, p, v);
        release();
        throw netErr();
      }
      if (p === first) throw netErr();
      await aApplied;
      return orig(id, p, v);
    };
    const a = await complete(w, { newPin: 'pinAAAA' });
    const b = await bDone;
    expect(a.verdict).toBe('unknown');
    expect(b).toBe('appliedWithoutKit');
    expect(await checkPendingOnStart(U)).toBe('kitUnconfirmed');
    expect(await opensWith('pinAAAA')).toBe(true);
  });

  // P4 (poc4): un marker nuovo non porta piu' un'ora (createdAt): non dipende dall'orologio
  it('P4: il marker non dipende dall\'orologio: si cancella per (epoch, rev) anche con l\'ora avanti di 12 ore', async () => {
    seedKit('aa', { rev: 1 });
    h.server.kr = { epoch: 0, rev: 3, escrowHash: 'ff' } as Row;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - 12 * 60 * MIN);
    try {
      expect(await checkPendingOnStart(U)).toBe('none');
    } finally { vi.useRealTimers(); }
    expect(MARKERS()).toHaveLength(0);
  });
});

describe('COMPLETED: il verdetto lo decide il keyring (regola unica)', () => {
  it('dopo la POST: 409 + COMPLETED col nostro payload gia committato -> applied col Kit', async () => {
    const w = await prepared();
    commitThenLose(() => apiErr(409, 'errors.vault.recoveryStateConflict'));
    const kit = applied(await complete(w));
    expect(kit).toHaveLength(20);
    expect(st().unlockedUserId).toBe(U);
    expect(KEY()).toBeUndefined();
    expect(await opensWith(NEW_PIN)).toBe(true);
  });

  it('F2 commit + risposta persa, poi 503 DEL VAULT (fromServer) al retry -> applied (non notApplied)', async () => {
    const w = await prepared();
    commitThenLose(() => apiErr(503, 'errors.vault.unavailable'));
    applied(await complete(w));
    expect(h.server.r!.status).toBe('COMPLETED');
    expect(await opensWith(NEW_PIN)).toBe(true);
  });

  it('F2 commit + risposta persa, poi 503 del PROXY (senza fromServer) -> unknown (mai notApplied); il marker decide al riavvio', async () => {
    const w = await prepared();
    commitThenLose(proxy503);
    const r = await complete(w);
    expect(r).toMatchObject({ verdict: 'unknown' });
    expect(r.kit).toBeUndefined();
    expect(h.server.posts).toHaveLength(3); // il 503 del proxy e' transitorio: si ritenta
    expect(MARKER()).toBeDefined();
    expect(await checkPendingOnStart(U)).toBe('kitUnconfirmed');
  });

  it('F2 un 503 del proxy senza tentativi precedenti: 3 POST e unknown, non notApplied/rejected', async () => {
    const w = await prepared();
    h.server.completeError = proxy503();
    const r = await complete(w);
    expect(r).toMatchObject({ verdict: 'unknown' });
    expect(h.server.posts).toHaveLength(3);
  });

  it('409 / 503 + COMPLETED con keyring di un altro recupero (hash diverso) -> completedElsewhere', async () => {
    for (const e of [() => apiErr(409), () => apiErr(503)]) {
      reset();
      h.server = new FakeServer();
      const w = await prepared();
      commitThenLose(() => { h.server.kr.escrowHash = 'ff'.repeat(32); return e(); });
      const r = await complete(w);
      expect(r).toMatchObject({ verdict: 'completedElsewhere' });
      expect(r.kit).toBeUndefined();
    }
  });

  it('409 / 503 + COMPLETED e GET /keyring fallita -> completedUnverified (non unknown), marker presente', async () => {
    for (const e of [() => apiErr(409), () => apiErr(503)]) {
      reset();
      h.server = new FakeServer();
      const w = await prepared();
      commitThenLose(() => { h.server.getKeyringError = netErr(); return e(); });
      const r = await complete(w);
      expect(r).toMatchObject({ verdict: 'completedUnverified', key: 'vault.recovery.errors.completedUnverified' });
      expect(r.kit).toBeUndefined();
      expect(MARKER()).toBeDefined();
    }
  });

  it('dopo un tentativo ambiguo, 400 con richiesta COMPLETED e GET /keyring fallita -> completedUnverified', async () => {
    const w = await prepared();
    commitThenLose(() => { h.server.getKeyringError = netErr(); return apiErr(400); });
    expect(await complete(w)).toMatchObject({ verdict: 'completedUnverified' });
    expect(MARKER()).toBeDefined();
  });

  it('unknown resta per gli esiti in cui lo stato della richiesta non e noto (GET della richiesta fallita dopo un 409)', async () => {
    const w = await prepared();
    h.server.completeError = apiErr(409);
    h.server.onPost = () => { h.server.getRecoveryError = netErr(); };
    expect(await complete(w)).toMatchObject({ verdict: 'unknown', key: 'vault.recovery.errors.unknown' });
  });

  it('dopo un tentativo ambiguo, 503 del proxy con richiesta ancora RELEASED -> unknown (non notApplied)', async () => {
    const w = await prepared();
    failThen(netErr(), proxy503);
    const r = await complete(w);
    expect(r).toMatchObject({ verdict: 'unknown' });
    expect(h.server.posts).toHaveLength(3);
    expect(MARKER()).toBeDefined();
  });

  it('dopo un tentativo ambiguo, 400 con richiesta RELEASED -> notApplied/rejected come da tabella; GET fallita -> unknown', async () => {
    const w = await prepared();
    failThen(netErr(), () => apiErr(400));
    expect(await complete(w)).toMatchObject({ verdict: 'notApplied', reason: 'rejected' });
    reset();
    h.server = new FakeServer();
    const w2 = await prepared();
    failThen(netErr(), () => { h.server.getRecoveryError = netErr(); return apiErr(400); });
    expect(await complete(w2)).toMatchObject({ verdict: 'unknown' });
  });

  it('senza tentativi ambigui il 503 resta notApplied/rejected e non fa altri GET della richiesta oltre a quello della preparazione', async () => {
    const w = await prepared();
    h.server.completeError = apiErr(503);
    expect(await complete(w)).toMatchObject({ verdict: 'notApplied', reason: 'rejected' });
    expect(h.server.getRecoveryCalls).toBe(1);
  });

  it('F3 in preparazione: dopo un unknown con commit avvenuto il nuovo tentativo trova COMPLETED e il NOSTRO marker -> appliedWithoutKit (mai releaseInvalid), marker intatto', async () => {
    const w = await prepared();
    commitThenLose(netErr);
    expect((await complete(w)).verdict).toBe('unknown');
    const marker = MARKER();
    const posts = h.server.posts.length;
    const r2 = await complete(w);
    expect(r2).toMatchObject({ verdict: 'appliedWithoutKit', key: 'vault.recovery.errors.appliedWithoutKit' });
    expect(r2.kit).toBeUndefined();
    expect(MARKERS()).toEqual([marker]);
    expect(h.server.posts).toHaveLength(posts);
    expect(await opensWith(NEW_PIN)).toBe(true);
  });

  it('F3 con la chiave cancellata da una sync (richiesta COMPLETED): nostro marker -> appliedWithoutKit; senza marker -> completedElsewhere', async () => {
    const w = await prepared();
    commitThenLose(netErr);
    expect((await complete(w)).verdict).toBe('unknown');
    expect(await rec.syncLocalRecovery(U)).toBe('cleared'); // la sync vede COMPLETED e cancella la chiave effimera
    expect(KEY()).toBeUndefined();
    expect(await complete(w)).toMatchObject({ verdict: 'appliedWithoutKit' }); // prima: notThisDevice (falso)
    raw('pending').clear();
    expect(await complete(w)).toMatchObject({ verdict: 'completedElsewhere' });
  });

  it('MAJOR 2: richiesta ancora aperta (o 404) senza chiave locale -> notThisDevice', async () => {
    const w = await prepared();
    await device.deleteRecoveryKeyIf(U, { requestId: RID });
    h.server.r!.status = 'WAITING';
    await expect(complete(w)).rejects.toMatchObject({ code: 'notThisDevice' });
    h.server.r = null;
    await expect(complete(w)).rejects.toMatchObject({ code: 'notThisDevice' });
  });

  it('404 recoveryNotFound in preparazione: con la chiave presente -> notApplied/requestClosed (0 POST, nessun marker); senza chiave -> notThisDevice', async () => {
    const w = await prepared();
    h.server.r = null;
    expect(KEY()).toBeDefined();
    expect(await complete(w)).toMatchObject({ verdict: 'notApplied', reason: 'requestClosed', key: 'vault.recovery.errors.requestClosed' });
    expect(h.server.posts).toHaveLength(0);
    expect(MARKER()).toBeUndefined();
    await device.deleteRecoveryKeyIf(U, { requestId: RID });
    await expect(complete(w)).rejects.toMatchObject({ code: 'notThisDevice' });
  });

  // item 8: richiesta chiusa in preparazione, con chiave presente o gia' pulita da una sync: mai releaseInvalid ne' notThisDevice
  it.each(['EXPIRED', 'CANCELLED', 'REJECTED'])('item 8: richiesta %s in preparazione -> notApplied/requestClosed, con chiave presente e con chiave gia\' pulita; 0 POST, nessun marker', async (status) => {
    const w = await prepared();
    h.server.r!.status = status;
    expect(await complete(w)).toMatchObject({ verdict: 'notApplied', reason: 'requestClosed', key: 'vault.recovery.errors.requestClosed' });
    await device.deleteRecoveryKeyIf(U, { requestId: RID });
    expect(await complete(w)).toMatchObject({ verdict: 'notApplied', reason: 'requestClosed' });
    expect(h.server.posts).toHaveLength(0);
    expect(MARKER()).toBeUndefined();
  });

  it('in preparazione COMPLETED senza il nostro marker (o con un altro hash, o di un\'altra richiesta) -> completedElsewhere', async () => {
    const w = await prepared();
    h.server.r!.status = 'COMPLETED';
    expect(await complete(w)).toMatchObject({ verdict: 'completedElsewhere' });
    seedKit('ab'.repeat(32)); // il nostro marker, ma di un altro escrow
    expect(await complete(w)).toMatchObject({ verdict: 'completedElsewhere' });
    raw('pending').clear();
    seedKit(h.server.kr.escrowHash, { requestId: 'altra-richiesta' }); // stesso escrow ma un'altra richiesta
    expect(await complete(w)).toMatchObject({ verdict: 'completedElsewhere' });
    seedKit(h.server.kr.escrowHash, { origin: 'regenerate', requestId: undefined }); // stesso escrow ma non di un recupero
    expect(await complete(w)).toMatchObject({ verdict: 'completedElsewhere' });
    expect(h.server.posts).toHaveLength(0);
  });

  // P3a (poc4): keyring cambiato tra il commit e il retry; il retry riceve 200 idempotente
  it('P3a: 200 idempotente con il keyring gia\' cambiato -> appliedKitReplaced (PIN appena scelto valido), Kit azzerato (e nessun Kit restituito)', async () => {
    const w = await prepared();
    const orig = h.server.completeRecovery.bind(h.server);
    let n = 0;
    h.server.completeRecovery = async (id: string, p: string, v: string) => {
      if (++n === 1) {
        await orig(id, p, v);
        const other = crypto.getRandomValues(new Uint8Array(60));
        h.server.kr.escrowBlob = b64uEncode(other); h.server.kr.escrowHash = await sha256hexBytes(other); h.server.kr.rev++;
        throw netErr();
      }
      return orig(id, p, v);
    };
    const r = await complete(w);
    expect(r).toMatchObject({ verdict: 'appliedKitReplaced', key: 'vault.recovery.errors.appliedKitReplaced' });
    expect(r.kit).toBeUndefined();
    const sUser = vi.mocked(buildRecoveryPayload).mock.calls[0][0].sUser;
    expect(sUser.every((x) => x === 0)).toBe(true); // il Kit nuovo non vale: azzerato
    expect(st().unlockedUserId).toBe(U); // il 200 e' nostro: il PIN nuovo vale
    expect(KEY()).toBeUndefined();
    expect(await checkPendingOnStart(U)).toBe('none'); // marker superato da (epoch, rev), nessun banner per un Kit che non vale
    expect(MARKERS()).toHaveLength(0);
  });

  // P3b (poc4): come sopra ma il retry riceve 409. U12: residuo accettato, documentato dal test
  it('P3b (residuo U12): 409 con il keyring sostituito tra commit e retry -> completedElsewhere, anche se il PIN nuovo vale', async () => {
    const w = await prepared();
    const orig = h.server.completeRecovery.bind(h.server);
    let n = 0;
    h.server.completeRecovery = async (id: string, p: string, v: string) => {
      if (++n === 1) {
        await orig(id, p, v);
        const other = crypto.getRandomValues(new Uint8Array(60));
        h.server.kr.escrowBlob = b64uEncode(other); h.server.kr.escrowHash = await sha256hexBytes(other); h.server.kr.rev++;
        throw netErr();
      }
      throw apiErr(409, 'errors.vault.staleRev');
    };
    const r = await complete(w);
    expect(r.verdict).toBe('completedElsewhere');
    expect(await opensWith(NEW_PIN)).toBe(true);
  });

  it('A3: 200 ma refresh del keyring fallito, sblocco offline attivo -> share cancellato (mai un share nuovo con la cache vecchia), applied', async () => {
    const w = await prepared(true);
    await device.putShare(U, { epoch: 0, shareEnc: new Uint8Array([1]), wrappedVkSigKey: new Uint8Array([2]) });
    h.server.onPost = () => { h.server.getKeyringError = netErr(); }; // dopo la POST ogni GET /keyring fallisce
    const r = await complete(w);
    expect(r.verdict).toBe('applied'); // senza GET non si puo' smentire il 200
    expect(await device.getShare(U)).toBeNull();
    expect(st().byUser[U]).toMatchObject({ rev: 3 }); // cache vecchia, mai sintetizzata
  });

  it('in preparazione COMPLETED e GET /keyring fallita -> completedUnverified', async () => {
    const w = await prepared();
    h.server.r!.status = 'COMPLETED';
    h.server.getKeyringError = netErr();
    expect(await complete(w)).toMatchObject({ verdict: 'completedUnverified' });
  });
});

describe('utente corrente durante la cerimonia (F4)', () => {
  it('F4 utente cambiato durante la POST: la cache e lo share di A non si toccano, notReady', async () => {
    const w = await prepared(true);
    const before = { ...st().byUser[U] };
    const g = h.server.getKeyring.bind(h.server);
    h.server.onPost = () => {
      useAuthStore.setState({ user: { id: 'B-user', email: 'b@b.c' } });
      h.server.getKeyring = async () => ({ ...(await g()), rev: 99, pinSalt: 'SALT_OF_B', wrappedVkPin: 'WRAP_OF_B' });
    };
    await expect(complete(w)).rejects.toMatchObject({ code: 'notReady' });
    expect(st().byUser[U]).toEqual(before);
    expect(raw('shares').size).toBe(0);
    expect(st().unlockedUserId).toBeNull();
  });

  it('utente cambiato prima del marker: notReady, nessun marker, 0 POST', async () => {
    const w = await prepared();
    h.server.onGetKeyring = async () => { useAuthStore.setState({ user: { id: OTHER, email: 'x@y.z' } }); };
    await expect(complete(w)).rejects.toMatchObject({ code: 'notReady' });
    expect(MARKER()).toBeUndefined();
    expect(h.server.posts).toHaveLength(0);
  });

  it('utente cambiato durante una POST ambigua: il retry non parte (1 sola POST), notReady, marker presente', async () => {
    const w = await prepared();
    h.server.failQueue = [netErr()];
    h.server.onPost = () => useAuthStore.setState({ user: { id: OTHER, email: 'x@y.z' } });
    await expect(complete(w)).rejects.toMatchObject({ code: 'notReady' });
    expect(h.server.posts).toHaveLength(1);
    expect(MARKER()).toBeDefined();
  });
});

describe('utente corrente prima di leggere un 404 (giro 3, Q1)', () => {
  const notFound = () => apiErr(404, 'errors.vault.recoveryNotFound');
  it('Q1 token di un altro utente all\'inizio: notReady, nessun GET della richiesta, nessuna POST, nessun marker', async () => {
    const w = await prepared();
    useAuthStore.setState({ user: { id: OTHER, email: 'x@y.z' } });
    h.server.getRecoveryError = notFound();
    await expect(complete(w)).rejects.toMatchObject({ code: 'notReady' });
    expect(h.server.getRecoveryCalls).toBe(0);
    expect(h.server.posts).toHaveLength(0);
    expect(MARKER()).toBeUndefined();
  });

  it('utente cambiato durante la preparazione, poi 404 del GET: notReady (non requestClosed)', async () => {
    const w = await prepared();
    h.server.onGetRecovery = () => { useAuthStore.setState({ user: { id: OTHER, email: 'x@y.z' } }); h.server.getRecoveryError = notFound(); };
    await expect(complete(w)).rejects.toMatchObject({ code: 'notReady' });
  });

  it('utente cambiato durante la POST con 404 recoveryNotFound: notReady (non requestClosed), marker presente', async () => {
    const w = await prepared();
    h.server.completeError = notFound();
    h.server.onPost = () => useAuthStore.setState({ user: { id: OTHER, email: 'x@y.z' } });
    await expect(complete(w)).rejects.toMatchObject({ code: 'notReady' });
    expect(MARKER()).toBeDefined();
  });

  it('utente cambiato durante la POST con 409 e 404 del GET: notReady (non requestClosed)', async () => {
    const w = await prepared();
    h.server.completeError = apiErr(409);
    h.server.onPost = () => { useAuthStore.setState({ user: { id: OTHER, email: 'x@y.z' } }); h.server.getRecoveryError = notFound(); };
    await expect(complete(w)).rejects.toMatchObject({ code: 'notReady' });
  });
});

describe('200 che non viene dal vault (giro 3, Q2)', () => {
  const html200 = () => {
    h.server.completeRecovery = async (id: string, p: string, v: string) => { h.server.posts.push({ id, payload: p, proof: v }); h.server.onPost?.(); return '<html>' as never; };
  };
  it('Q2 200 senza commit (richiesta ancora RELEASED, keyring invariato): unknown, nessuno sblocco, chiave effimera intatta, nessun Kit', async () => {
    const w = await prepared();
    html200();
    const r = await complete(w);
    expect(r).toMatchObject({ verdict: 'unknown' });
    expect(r.kit).toBeUndefined();
    expect(st().unlockedUserId).toBeNull();
    expect(KEY()).toMatchObject({ requestId: RID });
    expect(raw('shares').size).toBe(0);
    expect(MARKER()).toBeDefined();
    expect(h.server.r!.status).toBe('RELEASED');
    expect(await opensWith(OLD_PIN)).toBe(true);
    expect(purgeApiCache).not.toHaveBeenCalled();
  });

  it('keyring cambiato ma la richiesta non e COMPLETED e rev < rev+2: unknown', async () => {
    const w = await prepared();
    html200();
    h.server.onPost = () => { h.server.kr.escrowHash = 'ee'.repeat(32); h.server.kr.rev++; };
    expect(await complete(w)).toMatchObject({ verdict: 'unknown' });
    expect(KEY()).toBeDefined();
    expect(st().unlockedUserId).toBeNull();
  });

  it('keyring avanzato di 2 rev con un altro escrow, richiesta non COMPLETED: appliedKitReplaced (il commit e certo)', async () => {
    const w = await prepared();
    html200();
    h.server.onPost = () => { h.server.kr.escrowHash = 'ee'.repeat(32); h.server.kr.rev += 2; };
    const r = await complete(w);
    expect(r).toMatchObject({ verdict: 'appliedKitReplaced' });
    expect(st().unlockedUserId).toBe(U);
    expect(KEY()).toBeUndefined();
  });

  it('keyring cambiato e GET della richiesta fallita: unknown (non si verifica), chiave intatta', async () => {
    const w = await prepared();
    html200();
    h.server.onPost = () => { h.server.kr.escrowHash = 'ee'.repeat(32); h.server.getRecoveryError = netErr(); };
    expect(await complete(w)).toMatchObject({ verdict: 'unknown' });
    expect(KEY()).toBeDefined();
    expect(st().unlockedUserId).toBeNull();
  });
});

describe('codici e messaggi', () => {
  it('VaultRecoveryError usa vault.recovery.errors.<code>, tranne alreadyOpen', () => {
    for (const code of ['releaseInvalid', 'kitInvalid', 'notThisDevice', 'keyringChanged', 'busy', 'requestClosed', 'rejected', 'completedElsewhere', 'appliedWithoutKit', 'appliedKitReplaced', 'completedUnverified', 'notReleased', 'unknown', 'retryLater'] as const) {
      expect(new rec.VaultRecoveryError(code).key).toBe(`vault.recovery.errors.${code}`);
    }
    expect(new rec.VaultRecoveryError('alreadyOpen').key).toBe('errors.vault.recoveryAlreadyOpen');
  });

  // item 3: il PIN valido dopo appliedWithoutKit e' quello del tentativo PRECEDENTE (che ha applicato), non quello dell'ultimo
  it('appliedWithoutKit: EN e IT mandano al PIN scelto nel tentativo precedente e alla rigenerazione del Kit', () => {
    const en = enLocale.vault.recovery.errors.appliedWithoutKit;
    const it_ = itLocale.vault.recovery.errors.appliedWithoutKit;
    expect(en).toMatch(/earlier attempt/i);
    expect(en).toMatch(/PIN you chose in that attempt/i);
    expect(en).toMatch(/regenerate/i);
    expect(en).not.toMatch(/new PIN/i);
    expect(it_).toMatch(/tentativo precedente/i);
    expect(it_).toMatch(/PIN scelto in quel tentativo/i);
    expect(it_).toMatch(/rigenera/i);
    expect(it_).not.toMatch(/nuovo PIN/i);
  });

  it('appliedKitReplaced: EN e IT dicono PIN appena scelto, vault sbloccato, Kit sostituito da un\'altra sessione e rigenerazione; non parlano di tentativo precedente', () => {
    const en = enLocale.vault.recovery.errors.appliedKitReplaced;
    const it_ = itLocale.vault.recovery.errors.appliedKitReplaced;
    expect(en).toMatch(/PIN you just chose/i);
    expect(en).toMatch(/unlocked/i);
    expect(en).toMatch(/another session/i);
    expect(en).toMatch(/regenerate/i);
    expect(en).not.toMatch(/earlier attempt|previous attempt|that attempt/i);
    expect(it_).toMatch(/PIN che hai appena scelto/i);
    expect(it_).toMatch(/sbloccato/i);
    expect(it_).toMatch(/un'altra sessione/i);
    expect(it_).toMatch(/rigenera/i);
    expect(it_).not.toMatch(/tentativo precedente|quel tentativo/i);
    // il testo dell'altro caso non deve contraddire il suo: niente "PIN che hai appena scelto"
    expect(enLocale.vault.recovery.errors.appliedWithoutKit).not.toMatch(/just chose/i);
    expect(itLocale.vault.recovery.errors.appliedWithoutKit).not.toMatch(/appena scelto/i);
  });

  it('completedUnverified e notReleased: EN e IT', () => {
    const en = enLocale.vault.recovery.errors.completedUnverified;
    const it_ = itLocale.vault.recovery.errors.completedUnverified;
    expect(en).toMatch(/completed/i);
    expect(en).toMatch(/last attempt made from this device/i);
    expect(en).toMatch(/another session/i);
    expect(en).toMatch(/previous Recovery Kit is no longer valid/i);
    expect(it_).toMatch(/completato/i);
    expect(it_).toMatch(/ultimo tentativo fatto da questo dispositivo/i);
    expect(it_).toMatch(/un'altra sessione/i);
    expect(it_).toMatch(/Kit di recupero precedente non vale più/i);
    expect(enLocale.vault.recovery.errors.notReleased).toMatch(/not been released/i);
    expect(itLocale.vault.recovery.errors.notReleased).toMatch(/non è ancora stata rilasciata/i);
  });
});

describe('utente corrente dopo la GET del keyring in un verdetto COMPLETED', () => {
  it('utente cambiato durante la GET /keyring: notReady (non completedElsewhere ne applied), nessuna scrittura', async () => {
    const w = await prepared(true);
    const before = { ...st().byUser[U] };
    h.server.completeError = apiErr(409, 'errors.vault.recoveryStateConflict');
    h.server.onPost = () => { h.server.r!.status = 'COMPLETED'; };
    // la GET del keyring dopo la POST e' del token di un altro utente (il suo escrowHash non dice nulla del nostro commit)
    h.server.onGetKeyring = async () => { if (h.server.posts.length) useAuthStore.setState({ user: { id: OTHER, email: 'x@y.z' } }); };
    await expect(complete(w)).rejects.toMatchObject({ code: 'notReady' });
    expect(st().byUser[U]).toEqual(before);
    expect(st().unlockedUserId).toBeNull();
    expect(raw('shares').size).toBe(0);
    expect(KEY()).toBeDefined();
  });
});

// Un 2xx con un body che non e' del vault (portale, proxy, errore IIS con 200) passa dalla guardia di forma di vaultApi (VERA, via importActual):
// diventa un errore di rete, quindi un esito ambiguo, mai un successo, un rifiuto o un fatto ("niente openRecovery", "keyring invariato").
describe('risposta 2xx non del vault (guardia di forma)', () => {
  const BODIES: [string, unknown][] = [['html', '<html>portal</html>'], ['vuoto', {}], ['rev stringa', { status: 'READY', epoch: 0, rev: 'x' }]];
  const realApi = async (body: unknown) => {
    const real = await vi.importActual<typeof import('../vaultApi')>('../vaultApi');
    h.apiRequest.mockReset();
    h.apiRequest.mockResolvedValue({ data: body });
    return real;
  };
  /** Dopo la POST (`apply`: il server committa davvero) tutte le risposte sono spazzatura. Ritorna il ripristino del server sano. */
  const garbageAfterPost = async (body: unknown, apply: boolean) => {
    const real = await realApi(body);
    const orig = h.server.completeRecovery.bind(h.server);
    const gk = h.server.getKeyring.bind(h.server);
    const gr = h.server.getRecovery.bind(h.server);
    h.server.completeRecovery = async (id: string, p: string, v: string) => {
      if (apply) await orig(id, p, v);
      else h.server.posts.push({ id, payload: p, proof: v });
      h.server.getKeyring = () => real.getKeyring();
      h.server.getRecovery = (i: string) => real.getRecovery(i) as never;
      return real.completeRecovery(id, p, v);
    };
    return () => { h.server.getKeyring = gk; h.server.getRecovery = gr; };
  };

  describe.each([[true, 'POST committata'], [false, 'POST non committata']])('%s (%s)', (apply) => {
    it.each(BODIES)('X1/X2 200 non del vault su POST, GET /keyring e GET /recovery (%s): unknown, nessun Kit, nessuno sblocco, chiave e marker intatti', async (_n, body) => {
      const w = await prepared(true);
      await device.putShare(U, { epoch: 0, shareEnc: new Uint8Array(60), wrappedVkSigKey: new Uint8Array(10) });
      const healthy = await garbageAfterPost(body, apply as boolean);
      const r = await complete(w);
      expect(r).toMatchObject({ verdict: 'unknown' });
      expect(r.kit).toBeUndefined();
      expect(st().unlockedUserId).toBeNull();
      expect(KEY()).toMatchObject({ requestId: RID });
      expect(MARKER()).toBeDefined();
      expect(h.server.posts.length).toBeGreaterThan(0);
      // al riavvio, col server di nuovo sano, decide il marker: commit avvenuto -> banner, altrimenti il marker resta senza esito
      healthy();
      expect(await checkPendingOnStart(U)).toBe(apply ? 'kitUnconfirmed' : 'none');
      expect(MARKER()).toBeDefined();
    });
  });

  it.each(BODIES)('X6 200 non del vault su GET /recovery/:id in preparazione (%s): errore di rete, 0 POST, nessun marker, nessuno sblocco', async (_n, body) => {
    const w = await prepared(true);
    const real = await realApi(body);
    h.server.getRecovery = (id: string) => real.getRecovery(id) as never;
    await expect(complete(w)).rejects.toMatchObject({ status: 0 });
    expect(h.server.posts).toHaveLength(0);
    expect(MARKER()).toBeUndefined();
    expect(st().unlockedUserId).toBeNull();
    expect(KEY()).toMatchObject({ requestId: RID });
  });

  it.each(BODIES)('X7 chiave orfana oltre la grazia, richiesta aperta sul server, GET /keyring 200 non del vault (%s): unknown, la chiave non si cancella', async (_n, body) => {
    const { fp } = await orphan(20 * MIN);
    h.server.openRecovery = openFor(fp);
    const real = await realApi(body);
    const gk = h.server.getKeyring.bind(h.server);
    h.server.getKeyring = () => real.getKeyring();
    expect(await rec.syncLocalRecovery(U)).toBe('unknown');
    expect(KEY()).toMatchObject({ requestId: null });
    h.server.getKeyring = gk; // server sano: la richiesta aperta con lo stesso FP si lega
    expect(await rec.syncLocalRecovery(U)).toBe('active');
    expect(KEY()).toMatchObject({ requestId: RID });
  });
});

describe('testi neutri sul recupero gia applicato', () => {
  it('completedElsewhere: vale il PIN scelto al completamento, anche se da questo dispositivo', () => {
    const en = enLocale.vault.recovery.errors.completedElsewhere;
    const it_ = itLocale.vault.recovery.errors.completedElsewhere;
    expect(en).toMatch(/already completed/i);
    expect(en).toMatch(/PIN chosen when it was completed/i);
    expect(en).toMatch(/even if that was from this device/i);
    expect(en).not.toMatch(/another session/i);
    expect(it_).toMatch(/già completato/i);
    expect(it_).toMatch(/PIN scelto quando è stato completato/i);
    expect(it_).toMatch(/anche se è stato da questo dispositivo/i);
    expect(it_).not.toMatch(/un'altra sessione/i);
  });

  it('pinChangedElsewhere: il PIN risulta gia cambiato (anche da un tentativo precedente), si prova il nuovo PIN', () => {
    const en = enLocale.errors.vault.pinChangedElsewhere;
    const it_ = itLocale.errors.vault.pinChangedElsewhere;
    expect(en).toMatch(/already appears to be changed/i);
    expect(en).toMatch(/earlier attempt/i);
    expect(en).toMatch(/another device/i);
    expect(en).toMatch(/try the new PIN/i);
    expect(en).not.toMatch(/current PIN/i);
    expect(it_).toMatch(/risulta già cambiato/i);
    expect(it_).toMatch(/tentativo precedente/i);
    expect(it_).toMatch(/un altro dispositivo/i);
    expect(it_).toMatch(/prova il nuovo PIN/i);
    expect(it_).not.toMatch(/PIN attuale/i);
  });
});
