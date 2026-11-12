import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateRootKeyPair, sealRootKeyFile } from '../utils/vaultRootKeyFile';
import { sealRootShare } from '../utils/vaultSeal';
import { releaseRootShare, rootReleaseMessage, sealRecoveryCode, sealRecoveryShare } from '../services/vaultRootKey.service';
import { VAULT_ROOT_KEYS } from '../utils/vaultRootKeys';

// Lista pubblica vuota nel test: ci registriamo le coppie generate qui sotto (G11: il rilascio verifica la firma con questa lista).
vi.mock('../utils/vaultRootKeys', () => ({ VAULT_ROOT_KEYS: {} as Record<string, { ecdhSpki: string; ecdsaSpki: string }> }));

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
const PUBLIC_KEYS: Record<string, { ecdhSpki: string; ecdsaSpki: string }> = {
  [pairA.rootKeyId]: { ecdhSpki: pairA.ecdhSpki.toString('base64url'), ecdsaSpki: pairA.ecdsaSpki.toString('base64url') },
  [pairB.rootKeyId]: { ecdhSpki: pairB.ecdhSpki.toString('base64url'), ecdsaSpki: pairB.ecdsaSpki.toString('base64url') },
};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notiq-root-key-'));
  file = path.join(dir, 'root.json');
  fs.writeFileSync(file, await sealRootKeyFile({ [pairA.rootKeyId]: pairA, [pairB.rootKeyId]: pairB }, 'correct horse battery staple'));
  process.env.VAULT_ROOT_KEY_PATH = file;
  Object.assign(VAULT_ROOT_KEYS, PUBLIC_KEYS);
});

afterEach(() => {
  if (OLD_PATH === undefined) delete process.env.VAULT_ROOT_KEY_PATH;
  else process.env.VAULT_ROOT_KEY_PATH = OLD_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(VAULT_ROOT_KEYS)) delete (VAULT_ROOT_KEYS as Record<string, unknown>)[k];
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

  const releaseInput = (clientEphPub: Buffer) => ({
    requestId: REQUEST,
    userId: U,
    epoch: EPOCH,
    rootKeyId: pairA.rootKeyId,
    sealedRootShare,
    clientEphPub,
    fingerprint: FP,
    notBefore: NOT_BEFORE,
    passphrase: 'correct horse battery staple',
  });

  it('F1: passphrase giusta ma sealedRootShare corrotto -> 500 rootShareInvalid, non 403', async () => {
    const corrupt = Buffer.from(sealedRootShare);
    corrupt[corrupt.length - 1] ^= 0xff;
    await expect(releaseRootShare({ ...releaseInput(generateClient().publicRaw), sealedRootShare: corrupt })).rejects.toMatchObject({ statusCode: 500, message: 'errors.vault.rootShareInvalid' });
    // epoch diverso (AAD diversa): stessa causa
    await expect(releaseRootShare({ ...releaseInput(generateClient().publicRaw), epoch: EPOCH + 1 })).rejects.toMatchObject({ statusCode: 500, message: 'errors.vault.rootShareInvalid' });
  });

  it('F1: path impostato ma file mancante -> 503 rootKeyUnavailable, non 403', async () => {
    process.env.VAULT_ROOT_KEY_PATH = path.join(dir, 'missing.json');
    await expect(releaseRootShare(releaseInput(generateClient().publicRaw))).rejects.toMatchObject({ statusCode: 503, message: 'errors.vault.rootKeyUnavailable' });
  });

  it('B2: file leggibile ma malformato (JSON valido di forma sbagliata, header con v errata) -> 503, non 403', async () => {
    const client = generateClient();
    fs.writeFileSync(file, JSON.stringify({ hello: 'world' }));
    await expect(releaseRootShare(releaseInput(client.publicRaw))).rejects.toMatchObject({ statusCode: 503, message: 'errors.vault.rootKeyUnavailable' });
    fs.writeFileSync(file, 'not json');
    await expect(releaseRootShare(releaseInput(client.publicRaw))).rejects.toMatchObject({ statusCode: 503, message: 'errors.vault.rootKeyUnavailable' });
    const sealed = JSON.parse(await sealRootKeyFile({ [pairA.rootKeyId]: pairA }, 'correct horse battery staple')) as { header: string; ct: string };
    fs.writeFileSync(file, JSON.stringify({ header: JSON.stringify({ ...JSON.parse(sealed.header), v: 2 }), ct: sealed.ct }));
    await expect(releaseRootShare(releaseInput(client.publicRaw))).rejects.toMatchObject({ statusCode: 503, message: 'errors.vault.rootKeyUnavailable' });
  });

  it('B2: file corretto con passphrase errata resta 403 (l\'unico esito contato)', async () => {
    await expect(releaseRootShare({ ...releaseInput(generateClient().publicRaw), passphrase: 'wrong' })).rejects.toMatchObject({ statusCode: 403, message: 'errors.vault.invalidRootPassphrase' });
  });

  it('F1: path che punta a una cartella (errore fs) -> 503', async () => {
    process.env.VAULT_ROOT_KEY_PATH = dir;
    await expect(releaseRootShare(releaseInput(generateClient().publicRaw))).rejects.toMatchObject({ statusCode: 503, message: 'errors.vault.rootKeyUnavailable' });
  });

  it('F1: eccezione di crypto.sign -> 500 releaseSignatureInvalid, non 403', async () => {
    const spy = vi.spyOn(crypto, 'sign').mockImplementation(() => { throw new Error('boom'); });
    try {
      await expect(releaseRootShare(releaseInput(generateClient().publicRaw))).rejects.toMatchObject({ statusCode: 500, message: 'errors.vault.releaseSignatureInvalid' });
    } finally {
      spy.mockRestore();
    }
  });

  it('G11: chiave pubblica fissata diversa dalla coppia del file -> 500, niente firma restituita', async () => {
    Object.assign(VAULT_ROOT_KEYS, { [pairA.rootKeyId]: PUBLIC_KEYS[pairB.rootKeyId] });
    await expect(releaseRootShare(releaseInput(generateClient().publicRaw))).rejects.toMatchObject({ statusCode: 500, message: 'errors.vault.releaseSignatureInvalid' });
  });

  it('G11: rootKeyId assente dalla lista pubblica -> 500', async () => {
    delete (VAULT_ROOT_KEYS as Record<string, unknown>)[pairA.rootKeyId];
    await expect(releaseRootShare(releaseInput(generateClient().publicRaw))).rejects.toMatchObject({ statusCode: 500, message: 'errors.vault.releaseSignatureInvalid' });
  });
});

function openRecoveryCode(sealed: Buffer, client: crypto.KeyObject, requestId: string, userId: string, aadRequestId = requestId): string {
  const ephPubRaw = sealed.subarray(0, 97);
  const pub = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-384', x: ephPubRaw.subarray(1, 49).toString('base64url'), y: ephPubRaw.subarray(49).toString('base64url') },
    format: 'jwk',
  });
  const key = crypto.hkdfSync('sha256', crypto.diffieHellman({ privateKey: client, publicKey: pub }), ephPubRaw, `notiq/vault/v3/recovery-code|${requestId}|${userId}`, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), sealed.subarray(97, 109));
  decipher.setAAD(Buffer.from(`notiq/vault/v3/recovery-code|${aadRequestId}`, 'utf8'));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([decipher.update(sealed.subarray(109, 117)), decipher.final()]).toString('utf8');
}

describe('sealRecoveryCode', () => {
  it('blob da 133 byte, apribile solo con la privata del client, contratto info/AAD', () => {
    const client = generateClient();
    const sealed = sealRecoveryCode('ABCD2345', client.publicRaw, REQUEST, U);
    expect(sealed).toHaveLength(133);
    expect(sealed[0]).toBe(0x04);
    expect(openRecoveryCode(sealed, client.privateKey, REQUEST, U)).toBe('ABCD2345');
    expect(() => openRecoveryCode(sealed, generateClient().privateKey, REQUEST, U)).toThrow();
  });

  it('AAD con un altro requestId fallisce; ogni seal usa una chiave effimera nuova', () => {
    const client = generateClient();
    const sealed = sealRecoveryCode('ABCD2345', client.publicRaw, REQUEST, U);
    expect(() => openRecoveryCode(sealed, client.privateKey, REQUEST, U, 'request-2')).toThrow();
    expect(sealRecoveryCode('ABCD2345', client.publicRaw, REQUEST, U).equals(sealed)).toBe(false);
  });

  it('blob di share (157 B) e di code (133 B) non sono intercambiabili', () => {
    const client = generateClient();
    const share = sealRecoveryShare(sRoot, client.publicRaw, REQUEST, U);
    const code = sealRecoveryCode('ABCD2345', client.publicRaw, REQUEST, U);
    expect(share).toHaveLength(157);
    expect(() => openRecoveryShare(code, client.privateKey)).toThrow();
    expect(() => openRecoveryCode(share.subarray(0, 133), client.privateKey, REQUEST, U)).toThrow();
  });

  it('rifiuta codice di lunghezza diversa da 8 e chiave client non valida', () => {
    const client = generateClient();
    expect(() => sealRecoveryCode('SHORT', client.publicRaw, REQUEST, U)).toThrow();
    expect(() => sealRecoveryCode('ABCD2345', Buffer.alloc(97, 1), REQUEST, U)).toThrow();
  });
});
