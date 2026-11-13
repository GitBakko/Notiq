// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import nodeCrypto from 'node:crypto';
import fixture from './fixtures/vaultRecoveryVectors.json';
import {
  generateRecoveryKeyPair, fingerprintOf, openSealedCodeA, openRecoveryShare, verifyRelease, buildRecoveryPayload,
} from '../vaultRecoveryCrypto';
import {
  b64uDecode, sha256hexBytes, deriveRk, unwrapEscrow, deriveKekPin, deriveAuthKey, unwrapVkPin, importVk, generateVkRaw, openRootShare,
} from '../vaultCrypto';
import { DEFAULT_KDF } from '../argon2';

const F = fixture;
const P384 = { name: 'ECDH', namedCurve: 'P-384' } as const;
const clientPriv = () => crypto.subtle.importKey('pkcs8', b64uDecode(F.clientPkcs8), P384, false, ['deriveBits']);
const pubRaw = () => b64uDecode(F.clientPubRaw);
const release = () => ({
  rootShareForClient: b64uDecode(F.sealedShare),
  signature: b64uDecode(F.signature),
  requestId: F.requestId,
  userId: F.userId,
  notBefore: F.notBefore,
  ownPubRaw: pubRaw(),
  ecdsaSpki: b64uDecode(F.ecdsaSpki),
});

// Busta verso il client fatta in Node (come sealToClient del backend), per provare plaintext e layout che la fixture non copre.
function nodeSeal(plain: Buffer, clientPub: Uint8Array, info: string, aad: string): Uint8Array {
  const eph = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const jwk = eph.publicKey.export({ format: 'jwk' });
  const ephPub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x as string, 'base64url'), Buffer.from(jwk.y as string, 'base64url')]);
  const cj = { kty: 'EC', crv: 'P-384', x: Buffer.from(clientPub.subarray(1, 49)).toString('base64url'), y: Buffer.from(clientPub.subarray(49)).toString('base64url') };
  const shared = nodeCrypto.diffieHellman({ privateKey: eph.privateKey, publicKey: nodeCrypto.createPublicKey({ key: cj, format: 'jwk' }) });
  const key = Buffer.from(nodeCrypto.hkdfSync('sha256', shared, ephPub, info, 32));
  const iv = nodeCrypto.randomBytes(12);
  const c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return new Uint8Array(Buffer.concat([ephPub, iv, ct, c.getAuthTag()]));
}

describe('vaultRecoveryCrypto: coppia, fingerprint', () => {
  it('fingerprintOf: vettore fisso 04|01..60 -> E7E0T7Q5', async () => {
    const p = new Uint8Array(97);
    p[0] = 4;
    for (let i = 1; i < 97; i++) p[i] = i;
    expect(await fingerprintOf(p)).toBe('E7E0T7Q5');
  });

  it('fingerprintOf: la fixture combacia col backend', async () => {
    expect(await fingerprintOf(pubRaw())).toBe(F.fingerprint);
  });

  it('generateRecoveryKeyPair: privata non-extractable deriveBits, pubblica raw 97 B', async () => {
    const kp = await generateRecoveryKeyPair();
    expect(kp.privateKey.extractable).toBe(false);
    expect(kp.privateKey.usages).toEqual(['deriveBits']);
    expect(kp.privateKey.algorithm).toMatchObject({ name: 'ECDH', namedCurve: 'P-384' });
    expect(kp.publicRaw.length).toBe(97);
    expect(kp.publicRaw[0]).toBe(4);
    await expect(crypto.subtle.exportKey('pkcs8', kp.privateKey)).rejects.toThrow();
  });

  it('busta Node per la coppia generata: openRecoveryShare la apre', async () => {
    const kp = await generateRecoveryKeyPair();
    const sRoot = nodeCrypto.randomBytes(32);
    const blob = nodeSeal(sRoot, kp.publicRaw, `notiq/vault/v3/recovery|${F.requestId}|${F.userId}`, `notiq/vault/v3/recovery-share|${F.requestId}`);
    expect(Buffer.from(await openRecoveryShare(blob, kp.privateKey, F.requestId, F.userId))).toEqual(sRoot);
  });
});

describe('vaultRecoveryCrypto: buste della fixture', () => {
  it('openRecoveryShare apre la share (32 B = sRootHex)', async () => {
    const s = await openRecoveryShare(b64uDecode(F.sealedShare), await clientPriv(), F.requestId, F.userId);
    expect(s.length).toBe(32);
    expect(Buffer.from(s).toString('hex')).toBe(F.sRootHex);
  });

  it('openSealedCodeA apre il codice A', async () => {
    expect(await openSealedCodeA(b64uDecode(F.sealedCode), await clientPriv(), F.requestId, F.userId)).toBe(F.codeA);
  });

  it('requestId o userId diversi -> decryptFailed', async () => {
    const priv = await clientPriv();
    const share = b64uDecode(F.sealedShare);
    const code = b64uDecode(F.sealedCode);
    await expect(openRecoveryShare(share, priv, 'altro', F.userId)).rejects.toThrow('decryptFailed');
    await expect(openRecoveryShare(share, priv, F.requestId, 'altro')).rejects.toThrow('decryptFailed');
    await expect(openSealedCodeA(code, priv, 'altro', F.userId)).rejects.toThrow('decryptFailed');
    await expect(openSealedCodeA(code, priv, F.requestId, 'altro')).rejects.toThrow('decryptFailed');
  });

  it('busta del codice data a openRecoveryShare e viceversa -> decryptFailed', async () => {
    const priv = await clientPriv();
    await expect(openRecoveryShare(b64uDecode(F.sealedCode), priv, F.requestId, F.userId)).rejects.toThrow('decryptFailed');
    await expect(openSealedCodeA(b64uDecode(F.sealedShare), priv, F.requestId, F.userId)).rejects.toThrow('decryptFailed');
  });

  it('chiave privata di un altro client, busta manomessa o troncata -> decryptFailed', async () => {
    const other = await generateRecoveryKeyPair();
    const share = b64uDecode(F.sealedShare);
    await expect(openRecoveryShare(share, other.privateKey, F.requestId, F.userId)).rejects.toThrow('decryptFailed');
    const bad = share.slice();
    bad[120] ^= 1;
    const priv = await clientPriv();
    await expect(openRecoveryShare(bad, priv, F.requestId, F.userId)).rejects.toThrow('decryptFailed');
    await expect(openRecoveryShare(share.slice(0, 156), priv, F.requestId, F.userId)).rejects.toThrow('decryptFailed');
    await expect(openRecoveryShare(new Uint8Array(0), priv, F.requestId, F.userId)).rejects.toThrow('decryptFailed');
  });

  it('codice A fuori alfabeto (I, L, O, U, minuscole, simboli) -> errore', async () => {
    const priv = await clientPriv();
    for (const bad of ['K7M2Q9XI', 'K7M2Q9XL', 'K7M2Q9XO', 'K7M2Q9XU', 'k7m2q9xa', 'K7M2-9XA']) {
      const blob = nodeSeal(Buffer.from(bad), pubRaw(), `notiq/vault/v3/recovery-code|${F.requestId}|${F.userId}`, `notiq/vault/v3/recovery-code|${F.requestId}`);
      await expect(openSealedCodeA(blob, priv, F.requestId, F.userId)).rejects.toThrow('invalidInput');
    }
  });
});

describe('vaultRecoveryCrypto: verifyRelease', () => {
  it('true sulla fixture', async () => {
    expect(await verifyRelease(release())).toBe(true);
  });

  it('notBefore in altro formato ma stesso istante: true (normalizzato con toISOString)', async () => {
    expect(await verifyRelease({ ...release(), notBefore: F.notBefore.replace('Z', '+00:00') })).toBe(true);
  });

  it('false con FP (pubblica) diverso, notBefore +1 ms, busta o firma o SPKI diversi', async () => {
    const r = release();
    const other = await generateRecoveryKeyPair();
    expect(await verifyRelease({ ...r, ownPubRaw: other.publicRaw })).toBe(false);
    expect(await verifyRelease({ ...r, notBefore: new Date(new Date(F.notBefore).getTime() + 1).toISOString() })).toBe(false);
    const share = r.rootShareForClient.slice();
    share[150] ^= 1;
    expect(await verifyRelease({ ...r, rootShareForClient: share })).toBe(false);
    const sig = r.signature.slice();
    sig[10] ^= 1;
    expect(await verifyRelease({ ...r, signature: sig })).toBe(false);
    const otherRoot = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ type: 'spki', format: 'der' });
    expect(await verifyRelease({ ...r, ecdsaSpki: new Uint8Array(otherRoot) })).toBe(false);
    expect(await verifyRelease({ ...r, requestId: 'altro' })).toBe(false);
    expect(await verifyRelease({ ...r, userId: 'altro' })).toBe(false);
  });

  it('mai eccezioni sui dati: SPKI, firma, pubblica, notBefore, busta malformati -> false', async () => {
    const r = release();
    expect(await verifyRelease({ ...r, ecdsaSpki: new Uint8Array(5) })).toBe(false);
    expect(await verifyRelease({ ...r, signature: new Uint8Array(0) })).toBe(false);
    expect(await verifyRelease({ ...r, signature: r.signature.slice(0, 95) })).toBe(false);
    expect(await verifyRelease({ ...r, ownPubRaw: new Uint8Array(0) })).toBe(false);
    expect(await verifyRelease({ ...r, notBefore: 'non una data' })).toBe(false);
    expect(await verifyRelease({ ...r, rootShareForClient: new Uint8Array(0) })).toBe(false);
  });
});

describe('vaultRecoveryCrypto: buildRecoveryPayload', () => {
  const U = F.userId;
  const EPOCH = 3;
  const REV = 9;

  async function build() {
    const rootEcdh = await crypto.subtle.generateKey(P384, true, ['deriveBits']);
    const rootSpki = new Uint8Array(await crypto.subtle.exportKey('spki', rootEcdh.publicKey));
    const args = {
      userId: U, epoch: EPOCH, rev: REV,
      vkRaw: generateVkRaw(),
      S: crypto.getRandomValues(new Uint8Array(32)),
      pinSalt: crypto.getRandomValues(new Uint8Array(16)),
      serverShare: crypto.getRandomValues(new Uint8Array(32)),
      kdf: { ...DEFAULT_KDF },
      sRoot: crypto.getRandomValues(new Uint8Array(32)),
      sUser: crypto.getRandomValues(new Uint8Array(20)),
      rootKey: { id: 'rk_test000000000000', ecdhSpki: rootSpki },
    };
    return { args, rootPriv: rootEcdh.privateKey, out: await buildRecoveryPayload(args) };
  }

  it('schema del payload: chiavi esatte e lunghezze decodificate come recoveryCompletePayloadSchema', async () => {
    const { out } = await build();
    const p = JSON.parse(out.payload);
    expect(Object.keys(p).sort()).toEqual(['escrow', 'rev', 'wrap']);
    expect(p.rev).toBe(REV);
    expect(Object.keys(p.wrap).sort()).toEqual(['authKey', 'kdf', 'kdfParams', 'pinSalt', 'serverShare', 'wrappedVkPin']);
    expect(Object.keys(p.escrow).sort()).toEqual(['escrowBlob', 'rootKeyId', 'sealedRootShare', 'userShareUnderVk']);
    expect(p.wrap.kdf).toBe('argon2id');
    expect(p.wrap.kdfParams).toEqual({ m: DEFAULT_KDF.m, t: DEFAULT_KDF.t, p: 1 });
    expect(p.wrap.kdfParams.m).toBeGreaterThanOrEqual(65536);
    expect(p.wrap.kdfParams.t).toBeGreaterThanOrEqual(10);
    const len = (s: string) => { expect(s).toMatch(/^[A-Za-z0-9_-]+$/); return b64uDecode(s).length; };
    expect(len(p.wrap.pinSalt)).toBe(16);
    expect(len(p.wrap.wrappedVkPin)).toBe(60);
    expect(len(p.wrap.authKey)).toBe(32);
    expect(len(p.wrap.serverShare)).toBe(32);
    expect(len(p.escrow.escrowBlob)).toBe(60);
    expect(len(p.escrow.sealedRootShare)).toBe(157);
    expect(len(p.escrow.userShareUnderVk)).toBe(48);
    expect(p.escrow.rootKeyId).toBe('rk_test000000000000');
    expect(out.payload.length).toBeLessThanOrEqual(65536);
  });

  it('hash: escrowHash e wrappedVkPinHash = sha256 hex dei byte decodificati', async () => {
    const { out } = await build();
    const p = JSON.parse(out.payload);
    expect(out.escrowHash).toBe(await sha256hexBytes(b64uDecode(p.escrow.escrowBlob)));
    expect(out.wrappedVkPinHash).toBe(await sha256hexBytes(b64uDecode(p.wrap.wrappedVkPin)));
  });

  it('round trip: nuovo wrap (S + serverShare) e nuovo escrow (S_root + S_user) restituiscono la stessa VK', async () => {
    const { args, rootPriv, out } = await build();
    const p = JSON.parse(out.payload);
    // il builder non azzera i buffer del chiamante (sono suoi)
    expect(args.vkRaw.some((b) => b !== 0)).toBe(true);
    expect(args.sRoot.some((b) => b !== 0)).toBe(true);
    const kek = await deriveKekPin(args.S, b64uDecode(p.wrap.serverShare), b64uDecode(p.wrap.pinSalt), U);
    expect(b64uDecode(p.wrap.serverShare)).toEqual(args.serverShare);
    expect(await unwrapVkPin(kek, b64uDecode(p.wrap.wrappedVkPin), U, EPOCH, p.wrap.kdfParams)).toEqual(args.vkRaw);
    const rk = await deriveRk(args.sRoot, args.sUser, U);
    expect(await unwrapEscrow(rk, b64uDecode(p.escrow.escrowBlob), U, EPOCH, p.escrow.rootKeyId)).toEqual(args.vkRaw);
    const rootPrivDerive = await crypto.subtle.importKey('pkcs8', await crypto.subtle.exportKey('pkcs8', rootPriv), P384, false, ['deriveBits']);
    expect(await openRootShare(b64uDecode(p.escrow.sealedRootShare), rootPrivDerive, U, EPOCH, p.escrow.rootKeyId)).toEqual(args.sRoot);
    // userShareUnderVk si apre con la VK ed e' S_user
    const vk = await importVk(args.vkRaw);
    const sealed = b64uDecode(p.escrow.userShareUnderVk);
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.subarray(0, 12), additionalData: new TextEncoder().encode(`usershare|${U}|${EPOCH}`), tagLength: 128 },
      vk.aes, sealed.subarray(12),
    ));
    expect(plain).toEqual(args.sUser);
  });

  it('un altro S_user (Kit vecchio) non apre il nuovo escrowBlob; authKey = deriveAuthKey(S)', async () => {
    const { args, out } = await build();
    const p = JSON.parse(out.payload);
    const oldRk = await deriveRk(args.sRoot, crypto.getRandomValues(new Uint8Array(20)), U);
    await expect(unwrapEscrow(oldRk, b64uDecode(p.escrow.escrowBlob), U, EPOCH, p.escrow.rootKeyId)).rejects.toThrow('decryptFailed');
    expect(b64uDecode(p.wrap.authKey)).toEqual(await deriveAuthKey(args.S, U));
  });

  it('un errore dopo la derivazione (sigillo della share root) lascia authKey azzerato', async () => {
    const { args } = await build();
    const real = crypto.subtle.deriveBits.bind(crypto.subtle);
    const authBufs: ArrayBuffer[] = [];
    const spy = vi.spyOn(crypto.subtle, 'deriveBits').mockImplementation(async (alg, key, len) => {
      const out = await real(alg, key, len);
      if (len === 256) authBufs.push(out); // HKDF a 256 bit: solo deriveAuthKey
      return out;
    });
    try {
      await expect(buildRecoveryPayload({ ...args, rootKey: { id: 'rk_test000000000000', ecdhSpki: new Uint8Array(10) } })).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(authBufs).toHaveLength(1);
    expect(new Uint8Array(authBufs[0]).every((x) => x === 0)).toBe(true);
  });

  it('input invalidi -> invalidInput (lunghezze, userId con "|")', async () => {
    const { args } = await build();
    await expect(buildRecoveryPayload({ ...args, serverShare: new Uint8Array(31) })).rejects.toThrow('invalidInput');
    await expect(buildRecoveryPayload({ ...args, pinSalt: new Uint8Array(15) })).rejects.toThrow('invalidInput');
    await expect(buildRecoveryPayload({ ...args, sUser: new Uint8Array(19) })).rejects.toThrow('invalidInput');
    await expect(buildRecoveryPayload({ ...args, userId: 'a|b' })).rejects.toThrow('invalidInput');
  });
});
