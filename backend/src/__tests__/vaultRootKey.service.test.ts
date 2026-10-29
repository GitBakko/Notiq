import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateRootKeyPair, sealRootKeyFile } from '../utils/vaultRootKeyFile';
import { sealRootShare } from '../utils/vaultSeal';
import { releaseRootShare, rootReleaseMessage } from '../services/vaultRootKey.service';

const U = 'user-1';
const EPOCH = 2;
const REQUEST = 'request-1';
const FP = 'fp-1';
const NOT_BEFORE = new Date('2026-10-30T12:00:00.000Z');
const OLD_PATH = process.env.VAULT_ROOT_KEY_PATH;

let dir = '';
let file = '';
const pairA = generateRootKeyPair();
const pairB = generateRootKeyPair();
const sRoot = crypto.randomBytes(32);
const sealedRootShare = sealRootShare(sRoot, pairA.ecdhSpki, U, EPOCH, pairA.rootKeyId);

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notiq-root-key-'));
  file = path.join(dir, 'root.json');
  fs.writeFileSync(file, await sealRootKeyFile({ [pairA.rootKeyId]: pairA, [pairB.rootKeyId]: pairB }, 'correct horse battery staple'));
  process.env.VAULT_ROOT_KEY_PATH = file;
});

afterEach(() => {
  if (OLD_PATH === undefined) delete process.env.VAULT_ROOT_KEY_PATH;
  else process.env.VAULT_ROOT_KEY_PATH = OLD_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

function generateClient() {
  const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const jwk = keys.publicKey.export({ format: 'jwk' });
  return { privateKey: keys.privateKey, publicRaw: Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x as string, 'base64url'), Buffer.from(jwk.y as string, 'base64url')]) };
}

function openRecoveryShare(sealed: Buffer, client: crypto.KeyObject): Buffer {
  const ephPubRaw = sealed.subarray(0, 97);
  const pub = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-384', x: ephPubRaw.subarray(1, 49).toString('base64url'), y: ephPubRaw.subarray(49).toString('base64url') },
    format: 'jwk',
  });
  const shared = crypto.diffieHellman({ privateKey: client, publicKey: pub });
  const key = crypto.hkdfSync('sha256', shared, ephPubRaw, `notiq/vault/v3/recovery|${REQUEST}|${U}`, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), sealed.subarray(97, 109));
  decipher.setAAD(Buffer.from(`notiq/vault/v3/recovery-share|${REQUEST}`, 'utf8'));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([decipher.update(sealed.subarray(109, 141)), decipher.final()]);
}

describe('vaultRootKey.service', () => {
  it('apre la chiave richiesta fra due disponibili, sigilla per il client e firma il rilascio', async () => {
    const client = generateClient();
    const result = await releaseRootShare({
      requestId: REQUEST,
      userId: U,
      epoch: EPOCH,
      rootKeyId: pairA.rootKeyId,
      sealedRootShare,
      clientEphPub: client.publicRaw,
      fingerprint: FP,
      notBefore: NOT_BEFORE,
      passphrase: 'correct horse battery staple',
    });

    expect(result.rootShareForClient).toHaveLength(157);
    expect(openRecoveryShare(result.rootShareForClient, client.privateKey).equals(sRoot)).toBe(true);
    expect(crypto.verify('sha256', rootReleaseMessage({ requestId: REQUEST, userId: U, fingerprint: FP, notBefore: NOT_BEFORE, rootShareForClient: result.rootShareForClient }), {
      key: pairA.ecdsaSpki,
      format: 'der',
      type: 'spki',
      dsaEncoding: 'ieee-p1363',
    }, result.rootSignature)).toBe(true);
  });

  it('passphrase errata -> 403 senza dettagli', async () => {
    const client = generateClient();
    await expect(releaseRootShare({
      requestId: REQUEST,
      userId: U,
      epoch: EPOCH,
      rootKeyId: pairA.rootKeyId,
      sealedRootShare,
      clientEphPub: client.publicRaw,
      fingerprint: FP,
      notBefore: NOT_BEFORE,
      passphrase: 'wrong',
    })).rejects.toMatchObject({ statusCode: 403, message: 'errors.vault.invalidRootPassphrase' });
  });

  it('file root assente -> 503', async () => {
    delete process.env.VAULT_ROOT_KEY_PATH;
    const client = generateClient();
    await expect(releaseRootShare({
      requestId: REQUEST,
      userId: U,
      epoch: EPOCH,
      rootKeyId: pairA.rootKeyId,
      sealedRootShare,
      clientEphPub: client.publicRaw,
      fingerprint: FP,
      notBefore: NOT_BEFORE,
      passphrase: 'correct horse battery staple',
    })).rejects.toMatchObject({ statusCode: 503, message: 'errors.vault.rootKeyUnavailable' });
  });
});
