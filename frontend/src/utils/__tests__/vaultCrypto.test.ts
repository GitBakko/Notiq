// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createHash, verify, createPublicKey } from 'node:crypto';
import {
  ENVELOPE_RE, SEALED_ROOT_SHARE_LEN, b64uDecode, b64uEncode, kdfCanon, sha256hex, sha256hexBytes,
  deriveAuthKey, deriveKekPin, generateVkRaw, importVk, wrapVkPin, unwrapVkPin,
  generateSigKey, wrapVkSigKey, unwrapVkSigKey, signVkProof,
  deriveNoteKey, encryptItem, decryptItem, sealRootShare, openRootShare,
  deriveRk, wrapEscrow, unwrapEscrow, wrapUserShare, generateDeviceKey, encryptShare, decryptShare,
} from '../vaultCrypto';
import { DEFAULT_KDF } from '../argon2';

const hex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const U = 'user-1';
const EPOCH = 2;
const PARAMS = { ...DEFAULT_KDF };

// Letterali copiati da backend/src/__tests__/vaultSeal.test.ts (V1, V2): non si importa il file di test backend.
const V1 = {
  rootPrivPkcs8: '3081b6020100301006072a8648ce3d020106052b8104002204819e30819b0201010430101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3fa16403620004e6bc0a30815d358c204c38b0aa265f5ae73c053fc6bea50c435c7a094804f14065e4efa35f49019198bc9f3955201bbfa426a9f126b532c127c90c8241bda6490352a8dc8550b2f41f5d1bf26775bc67a1ed05aaee9d690ef83375910eab9315',
  rootEcdhSpki: '3076301006072a8648ce3d020106052b8104002203620004e6bc0a30815d358c204c38b0aa265f5ae73c053fc6bea50c435c7a094804f14065e4efa35f49019198bc9f3955201bbfa426a9f126b532c127c90c8241bda6490352a8dc8550b2f41f5d1bf26775bc67a1ed05aaee9d690ef83375910eab9315',
  rootPubX: '5rwKMIFdNYwgTDiwqiZfWuc8BT_GvqUMQ1x6CUgE8UBl5O-jX0kBkZi8nzlVIBu_',
  rootPubY: 'pCap8Sa1MsEnyQyCQb2mSQNSqNyFULL0H10b8md1vGeh7QWq7p1pDvgzdZEOq5MV',
  sRoot: '808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f',
  userId: 'user-v1',
  epoch: 3,
  rootKeyId: 'rk_0123456789abcdef',
  sealed: '040f3b4e71292f2de3a7c7befb785008417858f3cffe8192345e11735f4e75ed8a20218bddfd9c6656943b2db8cabf2e40b3348bbbecff8a7b144d73259b20018e9f44f4dac25be0069344c0c70ef4ba5d830080a52f8a05a423b6e83b93e8923ea0a1a2a3a4a5a6a7a8a9aaaba29ee45dc9f9b44717853c6efb31537a20ba4b840e413a722f3f28b3a3e7b9db615d64bb8f607aee6e313f7fe8af9247',
};
// V2: sealed prodotto da sealRootShare di vaultCrypto.ts (WebCrypto) per la stessa chiave root di V1.
const V2 = {
  sRoot: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  userId: 'user-v2',
  epoch: 5,
  rootKeyId: 'rk_0123456789abcdef',
  sealed: '04c2e9292994719fb0d3b81987e90bcdbc2a9bfc0dc9d04b4c28f1f64b9337d55f0b90359340119a92ba6bcfc1e9d25d6afb7c29f890e86e4cdef9773093a94d347883cb3567d685c026773cc0fb4b48d0c9e6a73ab67f2ef1af97b2c618da1f5fdb6857a7a547a0ab2d0cc1a4371fb373344211d854c2a8e0fb6cb3c3fb5c40f7afdb0bfe5068304e0573249e4d22c74bb03222931871af208e78a5f9',
};

const rootPriv = () => crypto.subtle.importKey('pkcs8', hex(V1.rootPrivPkcs8), { name: 'ECDH', namedCurve: 'P-384' }, false, ['deriveBits']);

describe('vaultCrypto', () => {
  it('lunghezze uguali agli Zod di P1 (routes/vault.ts, vault.service.ts)', async () => {
    const S = crypto.getRandomValues(new Uint8Array(32));
    const share = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const kek = await deriveKekPin(S, share, salt, U);
    const vkRaw = generateVkRaw();
    const vk = await importVk(vkRaw);
    const sig = await generateSigKey();
    const sUser = crypto.getRandomValues(new Uint8Array(20));
    const rk = await deriveRk(hex(V1.sRoot), sUser, U);
    expect((await deriveAuthKey(S, U)).length).toBe(32);
    expect((await wrapVkPin(kek, vkRaw, U, EPOCH, PARAMS)).length).toBe(60);
    expect(sig.spki.length).toBe(91);
    const w = await wrapVkSigKey(vk, sig.pkcs8, U, EPOCH);
    expect(w.length).toBeGreaterThanOrEqual(80);
    expect(w.length).toBeLessThanOrEqual(220);
    expect((await signVkProof(sig.privateKey, U, EPOCH, 0, '{}')).length).toBe(64);
    expect((await wrapEscrow(rk, vkRaw, U, EPOCH, V1.rootKeyId)).length).toBe(60);
    expect((await wrapUserShare(vk, sUser, U, EPOCH)).length).toBe(48);
    const sealed = await sealRootShare(hex(V1.sRoot), hex(V1.rootEcdhSpki), U, EPOCH, V1.rootKeyId);
    expect(sealed.length).toBe(157);
    expect(SEALED_ROOT_SHARE_LEN).toBe(157);
  });

  it('round-trip wrapVkPin / escrow / vksig / device', async () => {
    const S = crypto.getRandomValues(new Uint8Array(32));
    const share = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const kek = await deriveKekPin(S, share, salt, U);
    const vkRaw = generateVkRaw();
    const wrapped = await wrapVkPin(kek, vkRaw, U, EPOCH, PARAMS);
    expect(await unwrapVkPin(kek, wrapped, U, EPOCH, PARAMS)).toEqual(vkRaw);

    const rk = await deriveRk(hex(V1.sRoot), new Uint8Array(20).fill(7), U);
    const esc = await wrapEscrow(rk, vkRaw, U, EPOCH, 'rk_a');
    expect(await unwrapEscrow(rk, esc, U, EPOCH, 'rk_a')).toEqual(vkRaw);

    const vk = await importVk(vkRaw);
    const sig = await generateSigKey();
    const ws = await wrapVkSigKey(vk, sig.pkcs8, U, EPOCH);
    const back = await unwrapVkSigKey(vk, ws, U, EPOCH);
    expect(back.extractable).toBe(false);
    expect((await signVkProof(back, U, EPOCH, 1, 'x')).length).toBe(64);

    const dev = await generateDeviceKey();
    const se = await encryptShare(dev, share, U, EPOCH);
    expect(await decryptShare(dev, se, U, EPOCH)).toEqual(share);
    await expect(decryptShare(dev, se, U, EPOCH + 1)).rejects.toThrow('decryptFailed');
  });

  it('AAD cambiata -> errore', async () => {
    const kek = await deriveKekPin(new Uint8Array(32), new Uint8Array(32), new Uint8Array(16), U);
    const vkRaw = generateVkRaw();
    const w = await wrapVkPin(kek, vkRaw, U, EPOCH, PARAMS);
    await expect(unwrapVkPin(kek, w, 'user-2', EPOCH, PARAMS)).rejects.toThrow('decryptFailed');
    await expect(unwrapVkPin(kek, w, U, EPOCH + 1, PARAMS)).rejects.toThrow('decryptFailed');
    // kdfParams manomessi (t diverso) -> unwrap fallisce
    await expect(unwrapVkPin(kek, w, U, EPOCH, { ...PARAMS, t: PARAMS.t + 1 })).rejects.toThrow('decryptFailed');
    await expect(unwrapVkPin(kek, w, U, EPOCH, { ...PARAMS, m: PARAMS.m * 2 })).rejects.toThrow('decryptFailed');
    const rk = await deriveRk(new Uint8Array(32), new Uint8Array(20), U);
    const e = await wrapEscrow(rk, vkRaw, U, EPOCH, 'rk_a');
    await expect(unwrapEscrow(rk, e, U, EPOCH, 'rk_b')).rejects.toThrow('decryptFailed');
    const tampered = new Uint8Array(w); tampered[20] ^= 1;
    await expect(unwrapVkPin(kek, tampered, U, EPOCH, PARAMS)).rejects.toThrow('decryptFailed');
  });

  it('kdfCanon indipendente dall ordine delle chiavi', () => {
    const a = JSON.parse('{"m":65536,"t":3,"p":1}');
    const b = JSON.parse('{"p":1,"t":3,"m":65536}');
    expect(kdfCanon(a)).toBe('{"m":65536,"t":3,"p":1}');
    expect(kdfCanon(b)).toBe(kdfCanon(a));
    expect(() => kdfCanon({ m: 1.5, t: 3, p: 1 })).toThrow('invalidInput');
  });

  describe('envelope', () => {
    const ctx = { userId: U, noteId: '11111111-1111-4111-8111-111111111111', noteType: 'NOTE', epoch: EPOCH };
    const keyFor = async (noteId = ctx.noteId) => deriveNoteKey(await importVk(new Uint8Array(32).fill(9)), noteId);

    it('round-trip + regex del backend + HKDF per noteId', async () => {
      const k = await keyFor();
      const env = await encryptItem(k, ctx, { t: 'Titolo àèì', c: '{"a":1}' });
      expect(env).toMatch(ENVELOPE_RE);
      // Copia letterale di ENVELOPE_RE da backend/src/services/vault.service.ts:49
      expect(env).toMatch(/^nv3\.(0|[1-9]\d{0,8})\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/);
      expect(env.split('.')[1]).toBe(String(EPOCH));
      expect(await decryptItem(k, ctx, env)).toEqual({ t: 'Titolo àèì', c: '{"a":1}' });
      const other = await keyFor('22222222-2222-4222-8222-222222222222');
      await expect(decryptItem(other, ctx, env)).rejects.toThrow('decryptFailed');
    });

    it('AAD cambiata (user, noteId, noteType) -> errore', async () => {
      const k = await keyFor();
      const env = await encryptItem(k, ctx, { t: '', c: 'x' });
      await expect(decryptItem(k, { ...ctx, userId: 'u2' }, env)).rejects.toThrow('decryptFailed');
      await expect(decryptItem(k, { ...ctx, noteId: 'other' }, env)).rejects.toThrow('decryptFailed');
      await expect(decryptItem(k, { ...ctx, noteType: 'CREDENTIAL' }, env)).rejects.toThrow('decryptFailed');
    });

    it('epoch diverso -> stale; formato errato -> invalidEnvelope', async () => {
      const k = await keyFor();
      const env = await encryptItem(k, ctx, { t: '', c: '' });
      await expect(decryptItem(k, { ...ctx, epoch: EPOCH + 1 }, env)).rejects.toThrow('stale');
      await expect(decryptItem(k, ctx, 'nv3.2.abc')).rejects.toThrow('invalidEnvelope');
      await expect(decryptItem(k, ctx, '{"plain":"text"}')).rejects.toThrow('invalidEnvelope');
    });

    it('base64url non decodificabile -> invalidEnvelope', async () => {
      const k = await keyFor();
      const iv = 'A'.repeat(16);
      await expect(decryptItem(k, ctx, `nv3.${EPOCH}.${iv}.${'A'.repeat(25)}`)).rejects.toThrow('invalidEnvelope');
      await expect(decryptItem(k, ctx, `nv3.${EPOCH}.${iv}.${'A'.repeat(23)}`)).rejects.toThrow('invalidEnvelope');
    });

    it('encryptItem rifiuta epoch fuori range e "|" nel contesto', async () => {
      const k = await keyFor();
      const it = { t: '', c: '' };
      for (const epoch of [-1, 1.5, 1000000000, Number.NaN]) {
        await expect(encryptItem(k, { ...ctx, epoch }, it)).rejects.toThrow('invalidInput');
      }
      await expect(encryptItem(k, { ...ctx, userId: 'a|b' }, it)).rejects.toThrow('invalidInput');
      await expect(encryptItem(k, { ...ctx, noteId: 'a|b' }, it)).rejects.toThrow('invalidInput');
      await expect(encryptItem(k, { ...ctx, noteType: 'a|b' }, it)).rejects.toThrow('invalidInput');
    });
  });

  it('vkProof verificato con node:crypto.verify (ieee-p1363)', async () => {
    const sig = await generateSigKey();
    const payload = '{"rev":4,"wrap":{}}';
    const proof = await signVkProof(sig.privateKey, U, EPOCH, 4, payload);
    const msg = `notiq/vault/v3/proof|PUT /api/vault/keyring|${U}|${EPOCH}|4|${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
    const key = { key: Buffer.from(sig.spki), format: 'der' as const, type: 'spki' as const, dsaEncoding: 'ieee-p1363' as const };
    expect(verify('sha256', Buffer.from(msg), key, Buffer.from(proof))).toBe(true);
    expect(verify('sha256', Buffer.from(msg + 'x'), key, Buffer.from(proof))).toBe(false);
    expect(createPublicKey({ key: Buffer.from(sig.spki), format: 'der', type: 'spki' }).asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    await expect(signVkProof(sig.privateKey, U, EPOCH, 2147483647, payload)).rejects.toThrow('invalidInput');
    await expect(signVkProof(sig.privateKey, U, EPOCH, -1, payload)).rejects.toThrow('invalidInput');
  });

  it('contentHash / escrowHash = sha256 hex come il backend', async () => {
    const s = 'nv3.2.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB àè';
    expect(await sha256hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex')); // sha256hex del BE
    const raw = crypto.getRandomValues(new Uint8Array(60));
    expect(await sha256hexBytes(raw)).toBe(createHash('sha256').update(Buffer.from(raw)).digest('hex'));
  });

  it('base64url', () => {
    const b = new Uint8Array([251, 255, 254, 0, 1]);
    expect(b64uEncode(b)).toBe(Buffer.from(b).toString('base64url'));
    expect(b64uDecode(b64uEncode(b))).toEqual(b);
  });

  describe('root share', () => {
    it('round-trip + contesto diverso -> errore', async () => {
      const s = await sealRootShare(hex(V1.sRoot), hex(V1.rootEcdhSpki), U, EPOCH, 'rk_a');
      const priv = await rootPriv();
      expect(await openRootShare(s, priv, U, EPOCH, 'rk_a')).toEqual(hex(V1.sRoot));
      await expect(openRootShare(s, priv, 'u2', EPOCH, 'rk_a')).rejects.toThrow('decryptFailed');
      await expect(openRootShare(s, priv, U, EPOCH + 1, 'rk_a')).rejects.toThrow('decryptFailed');
      await expect(openRootShare(s, priv, U, EPOCH, 'rk_b')).rejects.toThrow('decryptFailed');
    });

    it('V1 (prodotto da node) aperto in WebCrypto, con chiave pubblica da SPKI e da JWK x,y', async () => {
      const jwk = { kty: 'EC', crv: 'P-384', x: V1.rootPubX, y: V1.rootPubY };
      const fromJwk = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-384' }, true, []);
      const fromSpki = await crypto.subtle.importKey('spki', hex(V1.rootEcdhSpki), { name: 'ECDH', namedCurve: 'P-384' }, true, []);
      expect(await crypto.subtle.exportKey('raw', fromJwk)).toEqual(await crypto.subtle.exportKey('raw', fromSpki));
      const out = await openRootShare(hex(V1.sealed), await rootPriv(), V1.userId, V1.epoch, V1.rootKeyId);
      expect(Buffer.from(out).toString('hex')).toBe(V1.sRoot);
    });

    it('V2 (prodotto dal frontend) si apre; stesso letterale in backend/src/__tests__/vaultSeal.test.ts', async () => {
      expect(V2.sealed).toHaveLength(SEALED_ROOT_SHARE_LEN * 2);
      const out = await openRootShare(hex(V2.sealed), await rootPriv(), V2.userId, V2.epoch, V2.rootKeyId);
      expect(Buffer.from(out).toString('hex')).toBe(V2.sRoot);
    });

    it('input non validi', async () => {
      await expect(sealRootShare(new Uint8Array(31), hex(V1.rootEcdhSpki), U, EPOCH, 'rk_a')).rejects.toThrow('invalidInput');
      await expect(sealRootShare(hex(V1.sRoot), hex(V1.rootEcdhSpki), 'u|1', EPOCH, 'rk_a')).rejects.toThrow('invalidInput');
      await expect(openRootShare(new Uint8Array(156), await rootPriv(), U, EPOCH, 'rk_a')).rejects.toThrow('decryptFailed');
    });
  });
});
