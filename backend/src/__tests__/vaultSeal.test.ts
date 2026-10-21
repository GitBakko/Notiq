import { describe, it, expect, afterEach } from 'vitest';
import { createHash, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from 'node:crypto';
import { sealRootShare, openRootShare, SEALED_ROOT_SHARE_LEN } from '../utils/vaultSeal';

// Vettore V1 (confronto incrociato con il frontend, T7). Tutti i valori sono letterali.
export const V1 = {
  rootPrivPkcs8: '3081b6020100301006072a8648ce3d020106052b8104002204819e30819b0201010430101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3fa16403620004e6bc0a30815d358c204c38b0aa265f5ae73c053fc6bea50c435c7a094804f14065e4efa35f49019198bc9f3955201bbfa426a9f126b532c127c90c8241bda6490352a8dc8550b2f41f5d1bf26775bc67a1ed05aaee9d690ef83375910eab9315',
  rootEcdhSpki: '3076301006072a8648ce3d020106052b8104002203620004e6bc0a30815d358c204c38b0aa265f5ae73c053fc6bea50c435c7a094804f14065e4efa35f49019198bc9f3955201bbfa426a9f126b532c127c90c8241bda6490352a8dc8550b2f41f5d1bf26775bc67a1ed05aaee9d690ef83375910eab9315',
  rootPubX: '5rwKMIFdNYwgTDiwqiZfWuc8BT_GvqUMQ1x6CUgE8UBl5O-jX0kBkZi8nzlVIBu_',
  rootPubY: 'pCap8Sa1MsEnyQyCQb2mSQNSqNyFULL0H10b8md1vGeh7QWq7p1pDvgzdZEOq5MV',
  ephPrivD: '404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f',
  ephPubX: 'DztOcSkvLeOnx777eFAIQXhY88_-gZI0XhFzX0517YogIYvd_ZxmVpQ7LbjKvy5A',
  ephPubY: 'szSLu-z_insUTXMlmyABjp9E9NrCW-AGk0TAxw70ul2DAIClL4oFpCO26DuT6JI-',
  iv: 'a0a1a2a3a4a5a6a7a8a9aaab',
  sRoot: '808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f',
  userId: 'user-v1',
  epoch: 3,
  rootKeyId: 'rk_0123456789abcdef',
  sealed: '040f3b4e71292f2de3a7c7befb785008417858f3cffe8192345e11735f4e75ed8a20218bddfd9c6656943b2db8cabf2e40b3348bbbecff8a7b144d73259b20018e9f44f4dac25be0069344c0c70ef4ba5d830080a52f8a05a423b6e83b93e8923ea0a1a2a3a4a5a6a7a8a9aaaba29ee45dc9f9b44717853c6efb31537a20ba4b840e413a722f3f28b3a3e7b9db615d64bb8f607aee6e313f7fe8af9247',
};

// sha256(bytes di V2.sealed) = 5756b0bea4b86fad9cd3f0151b54bda8eca74a8b6c917ad1107d43bfe0608f09 (stesso valore nel test frontend frontend/src/utils/__tests__/vaultCrypto.test.ts)
// Vettore V2: sealed prodotto dal frontend (utils/vaultCrypto.ts, WebCrypto) per la stessa chiave root di V1.
export const V2 = {
  sRoot: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  userId: 'user-v2',
  epoch: 5,
  rootKeyId: 'rk_0123456789abcdef',
  sealed: '04c2e9292994719fb0d3b81987e90bcdbc2a9bfc0dc9d04b4c28f1f64b9337d55f0b90359340119a92ba6bcfc1e9d25d6afb7c29f890e86e4cdef9773093a94d347883cb3567d685c026773cc0fb4b48d0c9e6a73ab67f2ef1af97b2c618da1f5fdb6857a7a547a0ab2d0cc1a4371fb373344211d854c2a8e0fb6cb3c3fb5c40f7afdb0bfe5068304e0573249e4d22c74bb03222931871af208e78a5f9',
};

const sRoot = Buffer.from(V1.sRoot, 'hex');
const origEnv = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = origEnv; });

describe('vaultSeal', () => {
  const root = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const spki = root.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const pkcs8 = root.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  const seal = () => sealRootShare(sRoot, spki, 'u1', 2, 'rk_a');
  const INPUT = 'errors.vault.invalidSealInput';
  const SEAL = 'errors.vault.invalidSeal';

  it('round-trip, 157 B (chiave come PKCS#8 e come KeyObject)', () => {
    const s = seal();
    expect(s.length).toBe(157);
    expect(SEALED_ROOT_SHARE_LEN).toBe(157);
    expect(openRootShare(s, pkcs8, 'u1', 2, 'rk_a').equals(sRoot)).toBe(true);
    expect(openRootShare(s, root.privateKey, 'u1', 2, 'rk_a').equals(sRoot)).toBe(true);
  });

  it.each([
    ['ephPubRaw', 5], ['iv', 100], ['ciphertext', 120], ['tag', 150],
  ])('alterazione %s -> invalidSeal', (_n, pos) => {
    const s = seal();
    s[pos] ^= 1;
    expect(() => openRootShare(s, pkcs8, 'u1', 2, 'rk_a')).toThrow(SEAL);
  });

  it('prefisso punto diverso da 0x04 -> invalidSeal', () => {
    const s = seal();
    s[0] = 0x02;
    expect(() => openRootShare(s, pkcs8, 'u1', 2, 'rk_a')).toThrow(SEAL);
  });

  it('contesto diverso -> invalidSeal', () => {
    const s = seal();
    expect(() => openRootShare(s, pkcs8, 'u2', 2, 'rk_a')).toThrow(SEAL);
    expect(() => openRootShare(s, pkcs8, 'u1', 3, 'rk_a')).toThrow(SEAL);
    expect(() => openRootShare(s, pkcs8, 'u1', 2, 'rk_b')).toThrow(SEAL);
  });

  it('chiave root diversa -> invalidSeal', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    expect(() => openRootShare(seal(), other.privateKey, 'u1', 2, 'rk_a')).toThrow(SEAL);
  });

  describe('validazione', () => {
    it('sRoot di lunghezza sbagliata', () => {
      expect(() => sealRootShare(Buffer.alloc(31), spki, 'u1', 2, 'rk_a')).toThrow(INPUT);
      expect(() => sealRootShare(Buffer.alloc(33), spki, 'u1', 2, 'rk_a')).toThrow(INPUT);
    });
    it('userId vuoto', () => {
      expect(() => sealRootShare(sRoot, spki, '', 2, 'rk_a')).toThrow(INPUT);
      expect(() => openRootShare(Buffer.alloc(157), pkcs8, '', 2, 'rk_a')).toThrow(INPUT);
    });
    it('rootKeyId vuoto', () => {
      expect(() => sealRootShare(sRoot, spki, 'u1', 2, '')).toThrow(INPUT);
      expect(() => openRootShare(Buffer.alloc(157), pkcs8, 'u1', 2, '')).toThrow(INPUT);
    });
    it.each([[-1], [1.5], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1]])('epoch non valida %s', (e) => {
      expect(() => sealRootShare(sRoot, spki, 'u1', e, 'rk_a')).toThrow(INPUT);
      expect(() => openRootShare(Buffer.alloc(157), pkcs8, 'u1', e, 'rk_a')).toThrow(INPUT);
    });
    it('iv iniettato di lunghezza sbagliata', () => {
      expect(() => sealRootShare(sRoot, spki, 'u1', 2, 'rk_a', { iv: Buffer.alloc(11) })).toThrow(INPUT);
    });
    it('sealed di lunghezza sbagliata in apertura', () => {
      expect(() => openRootShare(Buffer.alloc(156), pkcs8, 'u1', 2, 'rk_a')).toThrow(SEAL);
      expect(() => openRootShare(Buffer.alloc(158), pkcs8, 'u1', 2, 'rk_a')).toThrow(SEAL);
    });
    it('iniezione vietata in production', () => {
      process.env.NODE_ENV = 'production';
      expect(() => sealRootShare(sRoot, spki, 'u1', 2, 'rk_a', { iv: Buffer.from(V1.iv, 'hex') })).toThrow(INPUT);
      expect(() => sealRootShare(sRoot, spki, 'u1', 2, 'rk_a', { ephemeralPriv: Buffer.from(V1.ephPrivD, 'hex') })).toThrow(INPUT);
      expect(seal().length).toBe(157); // senza iniezione resta valido
    });
    it('iniezione vietata con NODE_ENV non impostato', () => {
      delete process.env.NODE_ENV;
      expect(() => sealRootShare(sRoot, spki, 'u1', 2, 'rk_a', { iv: Buffer.from(V1.iv, 'hex') })).toThrow(INPUT);
    });
    it("userId/rootKeyId con '|' rifiutati", () => {
      expect(() => sealRootShare(sRoot, spki, 'u|1', 2, 'rk_a')).toThrow(INPUT);
      expect(() => sealRootShare(sRoot, spki, 'u1', 2, 'rk|a')).toThrow(INPUT);
      expect(() => openRootShare(Buffer.alloc(157), pkcs8, 'u|1', 2, 'rk_a')).toThrow(INPUT);
      expect(() => openRootShare(Buffer.alloc(157), pkcs8, 'u1', 2, 'rk|a')).toThrow(INPUT);
    });
    it('sealed undefined/null -> invalidSeal; sRoot non Uint8Array -> invalidSealInput', () => {
      expect(() => openRootShare(undefined as any, pkcs8, 'u1', 2, 'rk_a')).toThrow(SEAL);
      expect(() => openRootShare(null as any, pkcs8, 'u1', 2, 'rk_a')).toThrow(SEAL);
      expect(() => sealRootShare('x'.repeat(32) as any, spki, 'u1', 2, 'rk_a')).toThrow(INPUT);
    });
  });

  it('vettore V1: seal deterministico + open', () => {
    const s = sealRootShare(sRoot, Buffer.from(V1.rootEcdhSpki, 'hex'), V1.userId, V1.epoch, V1.rootKeyId, {
      ephemeralPriv: Buffer.from(V1.ephPrivD, 'hex'),
      iv: Buffer.from(V1.iv, 'hex'),
    });
    expect(s.toString('hex')).toBe(V1.sealed);
    expect(openRootShare(Buffer.from(V1.sealed, 'hex'), Buffer.from(V1.rootPrivPkcs8, 'hex'), V1.userId, V1.epoch, V1.rootKeyId).toString('hex')).toBe(V1.sRoot);
  });

  it('vettore V1: Uint8Array puro (come le colonne Bytes di Prisma)', () => {
    const pure = new Uint8Array(Buffer.from(V1.sealed, 'hex'));
    expect(Buffer.isBuffer(pure)).toBe(false);
    expect(openRootShare(pure, Buffer.from(V1.rootPrivPkcs8, 'hex'), V1.userId, V1.epoch, V1.rootKeyId).toString('hex')).toBe(V1.sRoot);
    const s = sealRootShare(new Uint8Array(sRoot), Buffer.from(V1.rootEcdhSpki, 'hex'), V1.userId, V1.epoch, V1.rootKeyId, {
      ephemeralPriv: Buffer.from(V1.ephPrivD, 'hex'), iv: Buffer.from(V1.iv, 'hex'),
    });
    expect(s.toString('hex')).toBe(V1.sealed);
  });

  it('vettore V1: chiavi pubbliche coerenti', () => {
    const jwk = createPublicKey({ key: Buffer.from(V1.rootEcdhSpki, 'hex'), format: 'der', type: 'spki' }).export({ format: 'jwk' });
    expect({ x: jwk.x, y: jwk.y }).toEqual({ x: V1.rootPubX, y: V1.rootPubY });
    const sealed = Buffer.from(V1.sealed, 'hex');
    expect(sealed[0]).toBe(0x04);
    expect(sealed.subarray(1, 49).toString('base64url')).toBe(V1.ephPubX);
    expect(sealed.subarray(49, 97).toString('base64url')).toBe(V1.ephPubY);
  });

  it('vettore V1: apertura indipendente con node:crypto', () => {
    const sealed = Buffer.from(V1.sealed, 'hex');
    const ephPubRaw = sealed.subarray(0, 97);
    const privateKey = createPrivateKey({ key: Buffer.from(V1.rootPrivPkcs8, 'hex'), format: 'der', type: 'pkcs8' });
    const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-384', x: V1.ephPubX, y: V1.ephPubY }, format: 'jwk' });
    const shared = diffieHellman({ privateKey, publicKey });
    const key = Buffer.from(hkdfSync('sha256', shared, ephPubRaw, 'notiq/vault/v3/rootseal|user-v1|rk_0123456789abcdef', 32));
    const dc = createDecipheriv('aes-256-gcm', key, sealed.subarray(97, 109));
    dc.setAAD(Buffer.from('notiq/vault/v3/rootshare|user-v1|3|rk_0123456789abcdef', 'utf8'));
    dc.setAuthTag(sealed.subarray(141));
    const out = Buffer.concat([dc.update(sealed.subarray(109, 141)), dc.final()]);
    expect(out.toString('hex')).toBe(V1.sRoot);
  });

  it('vettore V2: sha256 del sealed uguale al commento nel test frontend', () => {
    expect(createHash('sha256').update(Buffer.from(V2.sealed, 'hex')).digest('hex')).toBe('5756b0bea4b86fad9cd3f0151b54bda8eca74a8b6c917ad1107d43bfe0608f09');
  });

  it('vettore V2: sealed prodotto dal frontend aperto con openRootShare', () => {
    expect(openRootShare(Buffer.from(V2.sealed, 'hex'), Buffer.from(V1.rootPrivPkcs8, 'hex'), V2.userId, V2.epoch, V2.rootKeyId).toString('hex')).toBe(V2.sRoot);
    expect(() => openRootShare(Buffer.from(V2.sealed, 'hex'), Buffer.from(V1.rootPrivPkcs8, 'hex'), V2.userId, V2.epoch + 1, V2.rootKeyId)).toThrow(SEAL);
  });
});
