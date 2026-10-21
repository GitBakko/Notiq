import { createCipheriv, createDecipheriv, createECDH, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';

// sealedRootShare = ephPubRaw(97) || iv(12) || AES-GCM(Kseal, S_root 32 B) || tag(16) = 157 B (piano P2 §3).
const CURVE = 'secp384r1';
const PUB_LEN = 97;
const IV_LEN = 12;
const SECRET_LEN = 32;
const TAG_LEN = 16;
export const SEALED_ROOT_SHARE_LEN = PUB_LEN + IV_LEN + SECRET_LEN + TAG_LEN;

const ERR_INPUT = 'errors.vault.invalidSealInput';
const ERR_SEAL = 'errors.vault.invalidSeal';

const b64u = (s: string) => Buffer.from(s, 'base64url');

function rawPoint(spkiDer: Buffer): Buffer {
  const jwk = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' }).export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([0x04]), b64u(jwk.x as string), b64u(jwk.y as string)]);
}

function kdf(shared: Buffer, ephPubRaw: Buffer, userId: string, rootKeyId: string): Buffer {
  const info = Buffer.from(`notiq/vault/v3/rootseal|${userId}|${rootKeyId}`, 'utf8');
  return Buffer.from(hkdfSync('sha256', shared, ephPubRaw, info, 32));
}

function aad(userId: string, epoch: number, rootKeyId: string): Buffer {
  return Buffer.from(`notiq/vault/v3/rootshare|${userId}|${epoch}|${rootKeyId}`, 'utf8');
}

function checkContext(userId: string, epoch: number, rootKeyId: string): void {
  if (!userId || !rootKeyId || userId.includes('|') || rootKeyId.includes('|')) throw new Error(ERR_INPUT); // '|' separa AAD e info
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error(ERR_INPUT);
}

/** `inject` (d scalare 48 B effimero, iv 12 B) solo per i vettori di test: ammesso solo con NODE_ENV=test (pm2 non imposta NODE_ENV). */
export function sealRootShare(
  sRoot: Uint8Array,
  rootEcdhSpki: Buffer,
  userId: string,
  epoch: number,
  rootKeyId: string,
  inject?: { ephemeralPriv?: Buffer; iv?: Buffer },
): Buffer {
  checkContext(userId, epoch, rootKeyId);
  if (!(sRoot instanceof Uint8Array) || sRoot.length !== SECRET_LEN) throw new Error(ERR_INPUT);
  if (inject && process.env.NODE_ENV !== 'test') throw new Error(ERR_INPUT);
  if (inject?.iv && inject.iv.length !== IV_LEN) throw new Error(ERR_INPUT);
  try {
    const eph = createECDH(CURVE);
    if (inject?.ephemeralPriv) eph.setPrivateKey(inject.ephemeralPriv);
    else eph.generateKeys();
    const ephPubRaw = eph.getPublicKey();
    const iv = inject?.iv ?? randomBytes(IV_LEN);
    const key = kdf(eph.computeSecret(rawPoint(rootEcdhSpki)), ephPubRaw, userId, rootKeyId);
    const c = createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(aad(userId, epoch, rootKeyId));
    const ct = Buffer.concat([c.update(Buffer.from(sRoot.buffer, sRoot.byteOffset, sRoot.length)), c.final()]);
    return Buffer.concat([ephPubRaw, iv, ct, c.getAuthTag()]);
  } catch {
    throw new Error(ERR_INPUT);
  }
}

/**
 * Lancia se il sigillo e alterato o il contesto (userId/epoch/rootKeyId/chiave) non coincide.
 * `rootPrivateKey`: KeyObject, oppure PKCS#8 DER. La scalare privata non viene mai esportata.
 */
export function openRootShare(
  sealed: Uint8Array,
  rootPrivateKey: KeyObject | Buffer,
  userId: string,
  epoch: number,
  rootKeyId: string,
): Buffer {
  checkContext(userId, epoch, rootKeyId);
  // Un sealed di lunghezza sbagliata conta come seal corrotto, non come input non valido.
  if (!(sealed instanceof Uint8Array) || sealed.length !== SEALED_ROOT_SHARE_LEN) throw new Error(ERR_SEAL);
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.length);
  try {
    const ephPubRaw = buf.subarray(0, PUB_LEN);
    const iv = buf.subarray(PUB_LEN, PUB_LEN + IV_LEN);
    const ct = buf.subarray(PUB_LEN + IV_LEN, PUB_LEN + IV_LEN + SECRET_LEN);
    const tag = buf.subarray(SEALED_ROOT_SHARE_LEN - TAG_LEN);
    if (ephPubRaw[0] !== 0x04) throw new Error(ERR_SEAL);
    const privateKey = Buffer.isBuffer(rootPrivateKey)
      ? createPrivateKey({ key: rootPrivateKey, format: 'der', type: 'pkcs8' })
      : rootPrivateKey;
    const publicKey = createPublicKey({
      key: { kty: 'EC', crv: 'P-384', x: ephPubRaw.subarray(1, 49).toString('base64url'), y: ephPubRaw.subarray(49).toString('base64url') },
      format: 'jwk',
    });
    const key = kdf(diffieHellman({ privateKey, publicKey }), ephPubRaw, userId, rootKeyId);
    const dc = createDecipheriv('aes-256-gcm', key, iv);
    dc.setAAD(aad(userId, epoch, rootKeyId));
    dc.setAuthTag(tag);
    return Buffer.concat([dc.update(ct), dc.final()]);
  } catch {
    throw new Error(ERR_SEAL);
  }
}
