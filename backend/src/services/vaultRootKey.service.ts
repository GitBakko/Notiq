import crypto from 'crypto';
import fs from 'fs';
import { AppError } from '../utils/errors';
import { VAULT_ROOT_KEYS } from '../utils/vaultRootKeys';
import { openRootKeyFile } from '../utils/vaultRootKeyFile';
import { openRootShare } from '../utils/vaultSeal';

const CURVE = 'secp384r1';
const RAW_PUB_LEN = 97;
const IV_LEN = 12;
const SHARE_LEN = 32;
const CODE_LEN = 8;

export interface RootReleaseInput {
  requestId: string;
  userId: string;
  epoch: number;
  rootKeyId: string;
  sealedRootShare: Uint8Array;
  clientEphPub: Uint8Array;
  fingerprint: string;
  notBefore: Date;
  passphrase: string;
}

function publicKeyFromRaw(raw: Buffer): crypto.KeyObject {
  return crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-384', x: raw.subarray(1, 49).toString('base64url'), y: raw.subarray(49).toString('base64url') },
    format: 'jwk',
  });
}

/** 400 se la pubblica del client non e' un punto valido di P-384 (lunghezza/prefisso li controlla il chiamante). */
export function assertPointOnCurve(clientEphPub: Uint8Array): void {
  try { publicKeyFromRaw(Buffer.from(clientEphPub)); } catch { throw new AppError(400, 'errors.vault.invalidPayload'); }
}

// Blob per il client = ephPub(97) | iv(12) | AES-256-GCM(ct) | tag(16). Chiave: ECDH con la pubblica effimera del client + HKDF-SHA256 (salt = ephPub, info).
function sealToClient(plain: Uint8Array, clientEphPub: Uint8Array, info: string, aad: string): Buffer {
  const eph = crypto.generateKeyPairSync('ec', { namedCurve: CURVE });
  const jwk = eph.publicKey.export({ format: 'jwk' });
  const ephPubRaw = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x as string, 'base64url'), Buffer.from(jwk.y as string, 'base64url')]);
  let key: Buffer | undefined;
  try {
    const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: publicKeyFromRaw(Buffer.from(clientEphPub)) });
    key = Buffer.from(crypto.hkdfSync('sha256', shared, ephPubRaw, info, 32));
    shared.fill(0);
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]);
    return Buffer.concat([ephPubRaw, iv, ct, cipher.getAuthTag()]);
  } catch {
    throw new AppError(400, 'errors.vault.invalidPayload'); // punto EC fuori curva
  } finally {
    key?.fill(0);
  }
}

function assertClientInput(clientEphPub: Uint8Array, requestId: string, userId: string): void {
  if (clientEphPub.length !== RAW_PUB_LEN || clientEphPub[0] !== 0x04 || !requestId || !userId) throw new AppError(400, 'errors.vault.invalidPayload');
}

export function sealRecoveryShare(sRoot: Uint8Array, clientEphPub: Uint8Array, requestId: string, userId: string): Buffer {
  if (sRoot.length !== SHARE_LEN) throw new AppError(400, 'errors.vault.invalidPayload');
  assertClientInput(clientEphPub, requestId, userId);
  return sealToClient(sRoot, clientEphPub, `notiq/vault/v3/recovery|${requestId}|${userId}`, `notiq/vault/v3/recovery-share|${requestId}`);
}

/** Meta A del codice (8 caratteri) per il solo dispositivo richiedente: blob da 133 byte. Contratto per la Fase 3: info/AAD qui sotto. */
export function sealRecoveryCode(codeA: string, clientEphPub: Uint8Array, requestId: string, userId: string): Buffer {
  const plain = Buffer.from(codeA, 'utf8');
  if (plain.length !== CODE_LEN) throw new AppError(400, 'errors.vault.invalidPayload');
  assertClientInput(clientEphPub, requestId, userId);
  return sealToClient(plain, clientEphPub, `notiq/vault/v3/recovery-code|${requestId}|${userId}`, `notiq/vault/v3/recovery-code|${requestId}`);
}

export function rootReleaseMessage(input: { requestId: string; userId: string; fingerprint: string; notBefore: Date; rootShareForClient: Uint8Array }): Buffer {
  const hash = crypto.createHash('sha256').update(input.rootShareForClient).digest('hex');
  return Buffer.from(`notiq/vault/v3/recovery-release|${input.requestId}|${input.userId}|${input.fingerprint}|${input.notBefore.toISOString()}|${hash}`, 'utf8');
}

export async function releaseRootShare(input: RootReleaseInput): Promise<{ rootShareForClient: Buffer; rootSignature: Buffer }> {
  const rootKeyPath = process.env.VAULT_ROOT_KEY_PATH;
  if (!rootKeyPath) throw new AppError(503, 'errors.vault.rootKeyUnavailable');
  // openRootKeyFile fallisce sempre con lo stesso messaggio: il file mancante o illeggibile (errore fs) si distingue prima, cosi' non conta come passphrase errata.
  try { fs.readFileSync(rootKeyPath); } catch { throw new AppError(503, 'errors.vault.rootKeyUnavailable'); }
  let opened: Awaited<ReturnType<typeof openRootKeyFile>> | undefined;
  let sRoot: Buffer | undefined;
  try {
    try {
      opened = await openRootKeyFile(rootKeyPath, input.passphrase);
    } catch {
      throw new AppError(403, 'errors.vault.invalidRootPassphrase'); // l'unico esito contato dal rate limit
    }
    const entry = opened.keys[input.rootKeyId];
    if (!entry) throw new AppError(400, 'errors.vault.invalidRootKey');
    try {
      sRoot = openRootShare(input.sealedRootShare, entry.ecdhPkcs8, input.userId, input.epoch, input.rootKeyId);
    } catch {
      throw new AppError(500, 'errors.vault.rootShareInvalid');
    }
    const rootShareForClient = sealRecoveryShare(sRoot, input.clientEphPub, input.requestId, input.userId);
    let rootSignature: Buffer;
    let verified = false;
    try {
      const message = rootReleaseMessage({ ...input, rootShareForClient });
      rootSignature = crypto.sign('sha256', message, { key: entry.ecdsaPkcs8, format: 'der', type: 'pkcs8', dsaEncoding: 'ieee-p1363' });
      // G11: prima di salvare, la firma deve verificare con la chiave pubblica fissata nel codice (la stessa che userà il client).
      const pinned = VAULT_ROOT_KEYS[input.rootKeyId];
      verified = !!pinned && crypto.verify('sha256', message, { key: Buffer.from(pinned.ecdsaSpki, 'base64url'), format: 'der', type: 'spki', dsaEncoding: 'ieee-p1363' }, rootSignature);
    } catch {
      throw new AppError(500, 'errors.vault.releaseSignatureInvalid');
    }
    if (!verified) throw new AppError(500, 'errors.vault.releaseSignatureInvalid');
    return { rootShareForClient, rootSignature };

  } finally {
    sRoot?.fill(0);
    if (opened) {
      for (const entry of Object.values(opened.keys)) {
        entry.ecdhPkcs8.fill(0);
        entry.ecdsaPkcs8.fill(0);
      }
    }
  }
}
