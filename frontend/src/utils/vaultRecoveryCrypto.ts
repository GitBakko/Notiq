// Vault v3, recupero con la chiave root (Fase 3): funzioni pure su WebCrypto per le buste del server, la firma del rilascio e il payload
// del `complete`. Contratti byte per byte in docs/superpowers/plans/2026-11-12-vault-p4-fase3-plan.md §4 (copia di vaultRootKey.service.ts).
// Errori: 'decryptFailed' (busta/chiave/contesto sbagliati), 'invalidInput' (codice A fuori alfabeto, input costruttore non valido).
import type { KdfParams } from './argon2';
import {
  b64uEncode, deriveAuthKey, deriveKekPin, deriveRk, importVk, sealRootShare, sha256hexBytes, wrapEscrow, wrapUserShare, wrapVkPin,
} from './vaultCrypto';

const enc = new TextEncoder();
const bs = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;
const fail = (m: string) => new Error(m);
const P384 = { name: 'ECDH', namedCurve: 'P-384' } as const;
const ECDSA384 = { name: 'ECDSA', namedCurve: 'P-384' } as const;
const PUB_LEN = 97;
const IV_LEN = 12;
const TAG_LEN = 16;
const SHARE_BLOB_LEN = 157; // 97 + 12 + 32 + 16
const CODE_BLOB_LEN = 133; // 97 + 12 + 8 + 16
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const FP_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface RecoveryKeyPair { privateKey: CryptoKey; publicRaw: Uint8Array<ArrayBuffer> }

/** Coppia ECDH P-384 effimera del dispositivo richiedente: privata non-extractable (solo deriveBits), pubblica raw 97 B. */
export async function generateRecoveryKeyPair(): Promise<RecoveryKeyPair> {
  const kp = await crypto.subtle.generateKey(P384, false, ['deriveBits']);
  return { privateKey: kp.privateKey, publicRaw: new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)) };
}

/** FP = primi 40 bit di SHA-256(pubblica raw) in 8 simboli da 5 bit, MSB per primo (parita' con vaultRecovery.service.ts). Va calcolato sulla pubblica propria. */
export async function fingerprintOf(publicRaw: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bs(publicRaw)));
  let v = 0n;
  for (let i = 0; i < 5; i++) v = (v << 8n) | BigInt(h[i]);
  let out = '';
  for (let i = 7; i >= 0; i--) out += FP_ALPHABET[Number((v >> BigInt(i * 5)) & 31n)];
  return out;
}

/** Busta del server: ephPub(97) | iv(12) | ct | tag(16). ECDH P-384 -> HKDF-SHA256(salt = ephPub, info) -> AES-256-GCM(AAD). */
async function openFromServer(blob: Uint8Array, expectedLen: number, priv: CryptoKey, info: string, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  if (blob.length !== expectedLen || blob[0] !== 0x04) throw fail('decryptFailed');
  const ephPub = blob.subarray(0, PUB_LEN);
  let shared: Uint8Array | null = null;
  try {
    const eph = await crypto.subtle.importKey('raw', bs(ephPub), P384, false, []);
    shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: eph }, priv, 384));
    const hk = await crypto.subtle.importKey('raw', bs(shared), 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: bs(ephPub), info: bs(enc.encode(info)) },
      hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bs(blob.subarray(PUB_LEN, PUB_LEN + IV_LEN)), additionalData: bs(enc.encode(aad)), tagLength: TAG_LEN * 8 },
      key, bs(blob.subarray(PUB_LEN + IV_LEN)),
    );
    return new Uint8Array(pt);
  } catch {
    throw fail('decryptFailed');
  } finally {
    shared?.fill(0);
  }
}

/** Meta A del codice (8 caratteri Crockford) da `GET /recovery/:id` in PENDING_CODE o da `notification.data.sealedCodeA`. */
export async function openSealedCodeA(blob: Uint8Array, priv: CryptoKey, requestId: string, userId: string): Promise<string> {
  const pt = await openFromServer(blob, CODE_BLOB_LEN, priv, `notiq/vault/v3/recovery-code|${requestId}|${userId}`, `notiq/vault/v3/recovery-code|${requestId}`);
  const code = new TextDecoder().decode(pt);
  if (!CODE_RE.test(code)) throw fail('invalidInput');
  return code;
}

/** S_root (32 B) dalla busta `rootShareForClient`. Il chiamante azzera il risultato. */
export async function openRecoveryShare(blob: Uint8Array, priv: CryptoKey, requestId: string, userId: string): Promise<Uint8Array<ArrayBuffer>> {
  const pt = await openFromServer(blob, SHARE_BLOB_LEN, priv, `notiq/vault/v3/recovery|${requestId}|${userId}`, `notiq/vault/v3/recovery-share|${requestId}`);
  if (pt.length !== 32) { pt.fill(0); throw fail('decryptFailed'); }
  return pt;
}

export interface ReleaseInput {
  rootShareForClient: Uint8Array;
  signature: Uint8Array;
  requestId: string;
  userId: string;
  notBefore: string;
  /** Pubblica raw del dispositivo: l'FP firmato dalla root deve essere il PROPRIO, mai quello dichiarato dal server. */
  ownPubRaw: Uint8Array;
  ecdsaSpki: Uint8Array;
}

/** Firma ECDSA P-384/SHA-256 (IEEE P1363, 96 B) del rilascio con la chiave root fissata nel bundle. Mai eccezioni sui dati: qualunque anomalia = false. */
export async function verifyRelease(i: ReleaseInput): Promise<boolean> {
  try {
    if (i.signature.length !== 96 || i.rootShareForClient.length !== SHARE_BLOB_LEN || i.ownPubRaw.length !== PUB_LEN) return false;
    const iso = new Date(i.notBefore).toISOString(); // data non valida -> RangeError -> false
    const msg = `notiq/vault/v3/recovery-release|${i.requestId}|${i.userId}|${await fingerprintOf(i.ownPubRaw)}|${iso}|${await sha256hexBytes(i.rootShareForClient)}`;
    const key = await crypto.subtle.importKey('spki', bs(i.ecdsaSpki), ECDSA384, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bs(i.signature), bs(enc.encode(msg)));
  } catch {
    return false;
  }
}

export interface RecoveryPayloadInput {
  userId: string;
  epoch: number;
  /** rev del keyring (CAS del server). */
  rev: number;
  vkRaw: Uint8Array;
  /** Argon2id(nuovo PIN, pinSalt): lo calcola il chiamante (Worker). */
  S: Uint8Array;
  pinSalt: Uint8Array;
  serverShare: Uint8Array;
  kdf: KdfParams;
  sRoot: Uint8Array;
  sUser: Uint8Array;
  rootKey: { id: string; ecdhSpki: Uint8Array };
}

/**
 * Corpo `payload` di `POST /recovery/:id/complete` (schema: recoveryCompletePayloadSchema del backend). Genera niente e non azzera niente:
 * i segreti sono del chiamante. La firma (`signVkProof`) e il round-trip a runtime restano al chiamante.
 */
export async function buildRecoveryPayload(a: RecoveryPayloadInput): Promise<{ payload: string; escrowHash: string; wrappedVkPinHash: string }> {
  if (a.serverShare.length !== 32 || a.pinSalt.length !== 16 || a.sUser.length !== 20 || a.sRoot.length !== 32 || a.kdf.p !== 1) throw fail('invalidInput');
  const vk = await importVk(a.vkRaw);
  let authKey: Uint8Array | null = null;
  try { // authKey si azzera anche se wrap o sigillo falliscono
    authKey = await deriveAuthKey(a.S, a.userId);
    const kek = await deriveKekPin(a.S, a.serverShare, a.pinSalt, a.userId);
    const wrappedVkPin = await wrapVkPin(kek, a.vkRaw, a.userId, a.epoch, a.kdf);
    const rk = await deriveRk(a.sRoot, a.sUser, a.userId);
    const escrowBlob = await wrapEscrow(rk, a.vkRaw, a.userId, a.epoch, a.rootKey.id);
    const sealedRootShare = await sealRootShare(a.sRoot, a.rootKey.ecdhSpki, a.userId, a.epoch, a.rootKey.id);
    const userShareUnderVk = await wrapUserShare(vk, a.sUser, a.userId, a.epoch);
    const payload = JSON.stringify({
      rev: a.rev,
      wrap: {
        kdf: 'argon2id',
        kdfParams: { m: a.kdf.m, t: a.kdf.t, p: a.kdf.p },
        pinSalt: b64uEncode(a.pinSalt),
        wrappedVkPin: b64uEncode(wrappedVkPin),
        authKey: b64uEncode(authKey),
        serverShare: b64uEncode(a.serverShare),
      },
      escrow: {
        escrowBlob: b64uEncode(escrowBlob),
        sealedRootShare: b64uEncode(sealedRootShare),
        rootKeyId: a.rootKey.id,
        userShareUnderVk: b64uEncode(userShareUnderVk),
      },
    });
    return { payload, escrowHash: await sha256hexBytes(escrowBlob), wrappedVkPinHash: await sha256hexBytes(wrappedVkPin) };
  } finally {
    authKey?.fill(0);
  }
}
