import crypto from 'crypto';
import { AppError } from '../utils/errors';
import { openRootKeyFile } from '../utils/vaultRootKeyFile';
import { openRootShare } from '../utils/vaultSeal';

const CURVE = 'secp384r1';
const RAW_PUB_LEN = 97;
const IV_LEN = 12;
const SHARE_LEN = 32;
const TAG_LEN = 16;

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

export function sealRecoveryShare(sRoot: Uint8Array, clientEphPub: Uint8Array, requestId: string, userId: string): Buffer {
  if (sRoot.length !== SHARE_LEN || clientEphPub.length !== RAW_PUB_LEN || clientEphPub[0] !== 0x04 || !requestId || !userId) {
    throw new AppError(400, 'errors.vault.invalidPayload');
  }
  const eph = crypto.generateKeyPairSync('ec', { namedCurve: CURVE });
  const jwk = eph.publicKey.export({ format: 'jwk' });
  const ephPubRaw = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x as string, 'base64url'), Buffer.from(jwk.y as string, 'base64url')]);
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: publicKeyFromRaw(Buffer.from(clientEphPub)) });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, ephPubRaw, `notiq/vault/v3/recovery|${requestId}|${userId}`, 32));
  shared.fill(0);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`notiq/vault/v3/recovery-share|${requestId}`, 'utf8'));
  const ct = Buffer.concat([cipher.update(Buffer.from(sRoot)), cipher.final()]);
  key.fill(0);
  return Buffer.concat([ephPubRaw, iv, ct, cipher.getAuthTag()]);
}

export function rootReleaseMessage(input: { requestId: string; userId: string; fingerprint: string; notBefore: Date; rootShareForClient: Uint8Array }): Buffer {
  const hash = crypto.createHash('sha256').update(input.rootShareForClient).digest('hex');
  return Buffer.from(`notiq/vault/v3/recovery-release|${input.requestId}|${input.userId}|${input.fingerprint}|${input.notBefore.toISOString()}|${hash}`, 'utf8');
}

export async function releaseRootShare(input: RootReleaseInput): Promise<{ rootShareForClient: Buffer; rootSignature: Buffer }> {
  const rootKeyPath = process.env.VAULT_ROOT_KEY_PATH;
  if (!rootKeyPath) throw new AppError(503, 'errors.vault.rootKeyUnavailable');
  let opened: Awaited<ReturnType<typeof openRootKeyFile>> | undefined;
  let sRoot: Buffer | undefined;
  try {
    opened = await openRootKeyFile(rootKeyPath, input.passphrase);
    const entry = opened.keys[input.rootKeyId];
    if (!entry) throw new AppError(400, 'errors.vault.invalidRootKey');
    sRoot = openRootShare(input.sealedRootShare, entry.ecdhPkcs8, input.userId, input.epoch, input.rootKeyId);
    const rootShareForClient = sealRecoveryShare(sRoot, input.clientEphPub, input.requestId, input.userId);
    const rootSignature = crypto.sign('sha256', rootReleaseMessage({ ...input, rootShareForClient }), {
      key: entry.ecdsaPkcs8,
      format: 'der',
      type: 'pkcs8',
      dsaEncoding: 'ieee-p1363',
    });
    return { rootShareForClient, rootSignature };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(403, 'errors.vault.invalidRootPassphrase');
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
