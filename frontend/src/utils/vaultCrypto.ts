// Vault v3: primitive crittografiche del piano P2 §3 (tutto tranne il Kit). Funzioni pure su WebCrypto.
// Errori: 'stale' (epoch dell'envelope diverso), 'invalidEnvelope', 'decryptFailed', 'invalidInput'.
import type { KdfParams } from './argon2';

const P = 'notiq/vault/v3/';
const enc = new TextEncoder();
const subtle = () => crypto.subtle;
// TS 5.9: i BufferSource di WebCrypto vogliono Uint8Array<ArrayBuffer>.
const bs = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;
const utf8 = (s: string) => bs(enc.encode(s));
const EMPTY = new Uint8Array(0) as Uint8Array<ArrayBuffer>;
const fail = (m: string) => new Error(m);

const badPart = (x: unknown) => typeof x !== 'string' || !x || x.includes('|');
/** Unico validatore di AAD/info (stessa regola di encryptItem); epoch null = non usato dal costruttore. */
function checkAad(userId: string, epoch: number | null) {
  if (badPart(userId)) throw fail('invalidInput');
  if (epoch !== null && (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > 999999999)) throw fail('invalidInput');
}
/** Come checkAad, ma rootKeyId e' sempre nell'AAD/info: mancante (undefined/null) = invalidInput. */
function checkRootAad(userId: string, epoch: number | null, rootKeyId: string) {
  checkAad(userId, epoch);
  if (badPart(rootKeyId)) throw fail('invalidInput');
}

export const IV_LEN = 12;
export const TAG_LEN = 16;
/** Uguale a `ENVELOPE_RE` di backend/src/services/vault.service.ts. */
export const ENVELOPE_RE = /^nv3\.(0|[1-9]\d{0,8})\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/;

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function b64uEncode(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw fail('invalidInput');
  let bin: string;
  try { bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')); } catch { throw fail('invalidInput'); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** contentHash / baseHash / vaultBaseHash: hex(sha256(utf8(s))), come `sha256hex` del backend. */
export async function sha256hex(s: string): Promise<string> {
  return toHex(new Uint8Array(await subtle().digest('SHA-256', utf8(s))));
}

/** escrowHash: hex(sha256(byte grezzi di escrowBlob)). */
export async function sha256hexBytes(b: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await subtle().digest('SHA-256', bs(b))));
}

/** Costruita dai numeri, mai dal JSON del server: indipendente dall'ordine delle chiavi. */
export function kdfCanon({ m, t, p }: KdfParams): string {
  if (![m, t, p].every(Number.isInteger)) throw fail('invalidInput');
  return `{"m":${m},"t":${t},"p":${p}}`;
}

// ---------------------------------------------------------------- AES-GCM / HKDF

/** iv || ct || tag */
async function seal(key: CryptoKey, plain: Uint8Array, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  try {
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad), tagLength: 128 }, key, bs(plain));
    return concat(iv, new Uint8Array(ct));
  } catch { throw fail('invalidInput'); }
}

async function open(key: CryptoKey, blob: Uint8Array, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  if (blob.length < IV_LEN + TAG_LEN) throw fail('decryptFailed');
  try {
    const pt = await subtle().decrypt(
      { name: 'AES-GCM', iv: bs(blob.subarray(0, IV_LEN)), additionalData: utf8(aad), tagLength: 128 },
      key,
      bs(blob.subarray(IV_LEN)),
    );
    return new Uint8Array(pt);
  } catch {
    throw fail('decryptFailed');
  }
}

async function hkdfKey(ikm: Uint8Array, usages: KeyUsage[] = ['deriveKey']): Promise<CryptoKey> {
  return subtle().importKey('raw', bs(ikm), 'HKDF', false, usages);
}

const hkdfParams = (salt: Uint8Array, info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: bs(salt), info: utf8(info) });

async function hkdfAes(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<CryptoKey> {
  return subtle().deriveKey(hkdfParams(salt, info), await hkdfKey(ikm), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// ---------------------------------------------------------------- PIN -> authKey, KEK

/** authKey = HKDF(S, salt vuoto, info auth|userId), 32 B. */
export async function deriveAuthKey(S: Uint8Array, userId: string): Promise<Uint8Array<ArrayBuffer>> {
  checkAad(userId, null);
  // chiave HKDF transitoria: qui deriveBits serve, non e' la chiave di VK
  return new Uint8Array(await subtle().deriveBits(hkdfParams(EMPTY, `${P}auth|${userId}`), await hkdfKey(S, ['deriveBits']), 256));
}

/** KEK_pin = HKDF(S || serverShare, salt = pinSalt, info kek|userId) -> AES-GCM non-extractable. */
export async function deriveKekPin(S: Uint8Array, serverShare: Uint8Array, pinSalt: Uint8Array, userId: string): Promise<CryptoKey> {
  checkAad(userId, null);
  const ikm = concat(S, serverShare);
  try {
    return await hkdfAes(ikm, pinSalt, `${P}kek|${userId}`);
  } finally {
    ikm.fill(0);
  }
}

// ---------------------------------------------------------------- VK

export interface VaultKey { hkdf: CryptoKey; aes: CryptoKey }

export function generateVkRaw(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** Le due CryptoKey non-extractable; i byte grezzi restano al chiamante, che li azzera. */
export async function importVk(raw: Uint8Array): Promise<VaultKey> {
  if (raw.length !== 32) throw fail('invalidInput');
  return {
    // Solo deriveKey (non deriveBits). Limite residuo: deriveKey con extractable=true permette comunque di ottenere i byte di K_note.
    hkdf: await hkdfKey(raw, ['deriveKey']),
    aes: await subtle().importKey('raw', bs(raw), 'AES-GCM', false, ['encrypt', 'decrypt']),
  };
}

const vkAad = (userId: string, epoch: number, canon: string) => {
  checkAad(userId, epoch);
  return `vk|${userId}|${epoch}|${canon}`;
};
const sigAad = (userId: string, epoch: number) => {
  checkAad(userId, epoch);
  return `vksig|${userId}|${epoch}`;
};

/** wrappedVkPin, 60 B. Il kdfCanon e' nell'AAD: kdfParams manomessi -> unwrap fallisce. */
export async function wrapVkPin(kek: CryptoKey, vkRaw: Uint8Array, userId: string, epoch: number, params: KdfParams) {
  return seal(kek, vkRaw, vkAad(userId, epoch, kdfCanon(params)));
}

/** VK grezza (32 B): chi chiama la importa e fa fill(0). */
export async function unwrapVkPin(kek: CryptoKey, wrapped: Uint8Array, userId: string, epoch: number, params: KdfParams) {
  return open(kek, wrapped, vkAad(userId, epoch, kdfCanon(params)));
}

// ---------------------------------------------------------------- vkSigKey

export interface SigKeyPair { spki: Uint8Array<ArrayBuffer>; pkcs8: Uint8Array<ArrayBuffer>; privateKey: CryptoKey }

const importSig = (pkcs8: Uint8Array) => subtle().importKey('pkcs8', bs(pkcs8), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

/**
 * ECDSA P-256 extractable solo per esportare PKCS#8 e SPKI; la privateKey restituita e' non-extractable.
 * Il chiamante passa `pkcs8` a wrapVkSigKey e poi fa `pkcs8.fill(0)`.
 */
export async function generateSigKey(): Promise<SigKeyPair> {
  const kp = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', kp.privateKey));
  const spki = new Uint8Array(await subtle().exportKey('spki', kp.publicKey));
  return { spki, pkcs8, privateKey: await importSig(pkcs8) };
}

/** wrappedVkSigKey = AES-GCM(VK, PKCS#8, AAD vksig|userId|epoch). */
export async function wrapVkSigKey(vk: VaultKey, pkcs8: Uint8Array, userId: string, epoch: number) {
  return seal(vk.aes, pkcs8, sigAad(userId, epoch));
}

export async function unwrapVkSigKey(vk: VaultKey, wrapped: Uint8Array, userId: string, epoch: number): Promise<CryptoKey> {
  const pkcs8 = await open(vk.aes, wrapped, sigAad(userId, epoch));
  try {
    return await importSig(pkcs8);
  } catch {
    throw fail('decryptFailed');
  } finally {
    pkcs8.fill(0);
  }
}

/** vkProof, 64 B (r||s, IEEE P1363 come richiede il backend). Path costante, rev <= 2147483646. */
export async function signVkProof(sigKey: CryptoKey, userId: string, epoch: number, rev: number, payloadRaw: string) {
  checkAad(userId, epoch);
  if (!Number.isInteger(rev) || rev < 0 || rev > 2147483646) throw fail('invalidInput');
  const msg = `${P}proof|PUT /api/vault/keyring|${userId}|${epoch}|${rev}|${await sha256hex(payloadRaw)}`;
  return new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, sigKey, utf8(msg)));
}

// ---------------------------------------------------------------- K_note, envelope

/** K_note = HKDF(VK, salt = utf8(noteId), info note) -> AES-GCM non-extractable. */
export async function deriveNoteKey(vk: VaultKey, noteId: string): Promise<CryptoKey> {
  return subtle().deriveKey(hkdfParams(utf8(noteId), `${P}note`), vk.hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export interface ItemCtx { userId: string; noteId: string; noteType: string; epoch: number }
const itemAad = (c: ItemCtx) => {
  checkAad(c.userId, c.epoch);
  if (badPart(c.noteId) || badPart(c.noteType)) throw fail('invalidInput');
  return itemAad0(c);
};
const itemAad0 = (c: ItemCtx) => `${P}item|${c.userId}|${c.noteId}|${c.noteType}|${c.epoch}`;

/** `nv3.<epoch>.<b64u iv>.<b64u ct||tag>`, plaintext JSON {v:1,t,c}. */
export async function encryptItem(noteKey: CryptoKey, ctx: ItemCtx, item: { t: string; c: string }): Promise<string> {
  const blob = await seal(noteKey, utf8(JSON.stringify({ v: 1, t: item.t, c: item.c })), itemAad(ctx));
  return `nv3.${ctx.epoch}.${b64uEncode(blob.subarray(0, IV_LEN))}.${b64uEncode(blob.subarray(IV_LEN))}`;
}

/** Epoch diverso da quello atteso -> 'stale'; formato non valido -> 'invalidEnvelope'. */
export async function decryptItem(noteKey: CryptoKey, ctx: ItemCtx, envelope: string): Promise<{ t: string; c: string }> {
  itemAad(ctx);
  const m = ENVELOPE_RE.exec(envelope);
  if (!m) throw fail('invalidEnvelope');
  if (Number(m[1]) !== ctx.epoch) throw fail('stale');
  const [, , ivB, ctB] = envelope.split('.');
  let blob: Uint8Array<ArrayBuffer>;
  try {
    const iv = b64uDecode(ivB);
    const ct = b64uDecode(ctB);
    // Il plaintext {"v":1,"t":"","c":""} pesa gia' 20+ byte: un ct piu' corto non e' un envelope nostro.
    if (iv.length !== IV_LEN || ct.length < TAG_LEN + 20) throw fail('invalidEnvelope');
    blob = concat(iv, ct);
  } catch { throw fail('invalidEnvelope'); }
  const pt = await open(noteKey, blob, itemAad(ctx));
  try {
    const o = JSON.parse(new TextDecoder().decode(pt));
    if (o?.v !== 1 || typeof o.t !== 'string' || typeof o.c !== 'string') throw fail('invalidEnvelope');
    return { t: o.t, c: o.c };
  } catch {
    throw fail('invalidEnvelope');
  }
}

// ---------------------------------------------------------------- root share, escrow

export const SEALED_ROOT_SHARE_LEN = 157;
const sealInfo = (userId: string, rootKeyId: string) => {
  checkRootAad(userId, null, rootKeyId);
  return `${P}rootseal|${userId}|${rootKeyId}`;
};
const rootAad = (userId: string, epoch: number, rootKeyId: string) => {
  checkRootAad(userId, epoch, rootKeyId);
  return `${P}rootshare|${userId}|${epoch}|${rootKeyId}`;
};
const escrowAad = (userId: string, epoch: number, rootKeyId: string) => {
  checkRootAad(userId, epoch, rootKeyId);
  return `escrow|${userId}|${epoch}|${rootKeyId}`;
};
const P384 = { name: 'ECDH', namedCurve: 'P-384' } as const;

async function ecdhAes(priv: CryptoKey, pub: CryptoKey, ephPubRaw: Uint8Array, userId: string, rootKeyId: string) {
  const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: pub }, priv, 384));
  try {
    return await hkdfAes(shared, ephPubRaw, sealInfo(userId, rootKeyId));
  } finally {
    shared.fill(0);
  }
}

/** sealedRootShare (157 B) = ephPubRaw(97) || iv || AES-GCM(Kseal, S_root) || tag. */
export async function sealRootShare(sRoot: Uint8Array, rootEcdhSpki: Uint8Array, userId: string, epoch: number, rootKeyId: string) {
  checkRootAad(userId, epoch, rootKeyId);
  if (sRoot.length !== 32) throw fail('invalidInput');
  let rootPub: CryptoKey;
  try { rootPub = await subtle().importKey('spki', bs(rootEcdhSpki), P384, false, []); } catch { throw fail('invalidInput'); }
  const eph = await subtle().generateKey(P384, false, ['deriveBits']);
  const ephPubRaw = new Uint8Array(await subtle().exportKey('raw', eph.publicKey));
  const key = await ecdhAes(eph.privateKey, rootPub, ephPubRaw, userId, rootKeyId);
  return concat(ephPubRaw, await seal(key, sRoot, rootAad(userId, epoch, rootKeyId)));
}

/** Apertura lato client (test e P5): rootPrivate = ECDH P-384 con usage deriveBits. */
export async function openRootShare(sealed: Uint8Array, rootPrivate: CryptoKey, userId: string, epoch: number, rootKeyId: string) {
  checkRootAad(userId, epoch, rootKeyId);
  if (sealed.length !== SEALED_ROOT_SHARE_LEN || sealed[0] !== 0x04) throw fail('decryptFailed');
  const ephPubRaw = sealed.subarray(0, 97);
  let eph: CryptoKey;
  try { eph = await subtle().importKey('raw', bs(ephPubRaw), P384, false, []); } catch { throw fail('decryptFailed'); }
  let key: CryptoKey;
  try { key = await ecdhAes(rootPrivate, eph, ephPubRaw, userId, rootKeyId); } catch { throw fail('decryptFailed'); }
  return open(key, sealed.subarray(97), rootAad(userId, epoch, rootKeyId));
}

/** RK = HKDF(S_root || S_user, salt vuoto, info escrow|userId) -> AES-GCM. */
export async function deriveRk(sRoot: Uint8Array, sUser: Uint8Array, userId: string): Promise<CryptoKey> {
  checkAad(userId, null);
  const ikm = concat(sRoot, sUser);
  try {
    return await hkdfAes(ikm, EMPTY, `${P}escrow|${userId}`);
  } finally {
    ikm.fill(0);
  }
}

/** escrowBlob (60 B) = AES-GCM(RK, VK, AAD escrow|userId|epoch|rootKeyId). */
export async function wrapEscrow(rk: CryptoKey, vkRaw: Uint8Array, userId: string, epoch: number, rootKeyId: string) {
  return seal(rk, vkRaw, escrowAad(userId, epoch, rootKeyId));
}

export async function unwrapEscrow(rk: CryptoKey, blob: Uint8Array, userId: string, epoch: number, rootKeyId: string) {
  return open(rk, blob, escrowAad(userId, epoch, rootKeyId));
}

const shareAad = (userId: string, epoch: number) => {
  checkAad(userId, epoch);
  return `usershare|${userId}|${epoch}`;
};

/** userShareUnderVk (48 B) = AES-GCM(VK, S_user, AAD usershare|userId|epoch). */
export async function wrapUserShare(vk: VaultKey, sUser: Uint8Array, userId: string, epoch: number) {
  return seal(vk.aes, sUser, shareAad(userId, epoch));
}

// ---------------------------------------------------------------- dispositivo

export function generateDeviceKey(): Promise<CryptoKey> {
  return subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as Promise<CryptoKey>;
}

const deviceAad = (userId: string, epoch: number) => {
  checkAad(userId, epoch);
  return `${P}device|${userId}|${epoch}`;
};

/** shareEnc = AES-GCM(devKey, serverShare, AAD device|userId|epoch). */
export async function encryptShare(devKey: CryptoKey, serverShare: Uint8Array, userId: string, epoch: number) {
  return seal(devKey, serverShare, deviceAad(userId, epoch));
}

export async function decryptShare(devKey: CryptoKey, shareEnc: Uint8Array, userId: string, epoch: number) {
  return open(devKey, shareEnc, deviceAad(userId, epoch));
}
