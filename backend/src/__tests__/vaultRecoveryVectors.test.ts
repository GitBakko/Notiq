import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { rootReleaseMessage, sealRecoveryCode, sealRecoveryShare } from '../services/vaultRootKey.service';
import { fingerprintOf } from '../services/vaultRecovery.service';

// Vettori di parita' backend -> client (Fase 3 del recupero): la fixture la legge anche il test del frontend.
// VAULT_VECTORS_WRITE=1 la rigenera (chiavi di TEST, mai quelle di produzione).
const FIXTURE = path.resolve(__dirname, '../../../frontend/src/utils/__tests__/fixtures/vaultRecoveryVectors.json');

interface Fixture {
  clientPkcs8: string; clientPubRaw: string; requestId: string; userId: string; sRootHex: string; codeA: string;
  sealedShare: string; sealedCode: string; fingerprint: string; notBefore: string; rootKeyId: string; ecdsaSpki: string; signature: string;
}

const rawPub = (k: crypto.KeyObject) => {
  const jwk = k.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x as string, 'base64url'), Buffer.from(jwk.y as string, 'base64url')]);
};

function generate(): Fixture {
  const client = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const root = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const pub = rawPub(client.publicKey);
  const requestId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const sRoot = crypto.randomBytes(32);
  const codeA = 'K7M2Q9XA';
  const sealedShare = sealRecoveryShare(sRoot, pub, requestId, userId);
  const fingerprint = fingerprintOf(pub);
  const notBefore = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  const signature = crypto.sign('sha256', rootReleaseMessage({ requestId, userId, fingerprint, notBefore: new Date(notBefore), rootShareForClient: sealedShare }), { key: root.privateKey, dsaEncoding: 'ieee-p1363' });
  return {
    clientPkcs8: client.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
    clientPubRaw: pub.toString('base64url'),
    requestId, userId, sRootHex: sRoot.toString('hex'), codeA,
    sealedShare: sealedShare.toString('base64url'),
    sealedCode: sealRecoveryCode(codeA, pub, requestId, userId).toString('base64url'),
    fingerprint, notBefore, rootKeyId: 'rk_test000000000000',
    ecdsaSpki: root.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    signature: signature.toString('base64url'),
  };
}

if (process.env.VAULT_VECTORS_WRITE === '1') {
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, JSON.stringify(generate(), null, 2) + '\n');
}
const fx: Fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const clientPriv = crypto.createPrivateKey({ key: Buffer.from(fx.clientPkcs8, 'base64url'), format: 'der', type: 'pkcs8' });

// Layout del contratto (piano §4), scritto a mano: ephPub(97) | iv(12) | ct | tag(16); ECDH P-384 -> HKDF-SHA256 (salt = ephPub) -> AES-256-GCM.
function openByHand(blobB64: string, ptLen: number, info: string, aad: string, priv = clientPriv): Buffer {
  const blob = Buffer.from(blobB64, 'base64url');
  expect(blob.length).toBe(97 + 12 + ptLen + 16);
  const ephPub = blob.subarray(0, 97);
  const peer = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-384', x: ephPub.subarray(1, 49).toString('base64url'), y: ephPub.subarray(49).toString('base64url') }, format: 'jwk' });
  const key = Buffer.from(crypto.hkdfSync('sha256', crypto.diffieHellman({ privateKey: priv, publicKey: peer }), ephPub, info, 32));
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(97, 109));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([d.update(blob.subarray(109, blob.length - 16)), d.final()]);
}

const shareInfo = (rid: string, uid: string) => `notiq/vault/v3/recovery|${rid}|${uid}`;
const shareAad = (rid: string) => `notiq/vault/v3/recovery-share|${rid}`;
const codeInfo = (rid: string, uid: string) => `notiq/vault/v3/recovery-code|${rid}|${uid}`;
const codeAad = (rid: string) => `notiq/vault/v3/recovery-code|${rid}`;

describe('vettori di parita recupero (backend <-> client)', () => {
  it('(a) le buste della fixture si aprono col layout documentato', () => {
    expect(openByHand(fx.sealedShare, 32, shareInfo(fx.requestId, fx.userId), shareAad(fx.requestId)).toString('hex')).toBe(fx.sRootHex);
    expect(openByHand(fx.sealedCode, 8, codeInfo(fx.requestId, fx.userId), codeAad(fx.requestId)).toString('utf8')).toBe(fx.codeA);
  });

  it('(b) buste nuove di sealRecoveryShare/sealRecoveryCode sulla stessa pubblica si aprono con lo stesso layout', () => {
    const pub = Buffer.from(fx.clientPubRaw, 'base64url');
    const rid = crypto.randomUUID();
    const uid = crypto.randomUUID();
    const sRoot = crypto.randomBytes(32);
    expect(openByHand(sealRecoveryShare(sRoot, pub, rid, uid).toString('base64url'), 32, shareInfo(rid, uid), shareAad(rid)).equals(sRoot)).toBe(true);
    expect(openByHand(sealRecoveryCode('ABCD1234', pub, rid, uid).toString('base64url'), 8, codeInfo(rid, uid), codeAad(rid)).toString('utf8')).toBe('ABCD1234');
  });

  it('le buste non si aprono con requestId o userId diversi', () => {
    expect(() => openByHand(fx.sealedShare, 32, shareInfo(crypto.randomUUID(), fx.userId), shareAad(fx.requestId))).toThrow();
    expect(() => openByHand(fx.sealedShare, 32, shareInfo(fx.requestId, crypto.randomUUID()), shareAad(fx.requestId))).toThrow();
    expect(() => openByHand(fx.sealedCode, 8, codeInfo(fx.requestId, fx.userId), codeAad(crypto.randomUUID()))).toThrow();
  });

  it('(c) rootReleaseMessage(fixture) + firma verificano con ecdsaSpki (96 B P1363)', () => {
    const sig = Buffer.from(fx.signature, 'base64url');
    expect(sig.length).toBe(96);
    const msg = rootReleaseMessage({ requestId: fx.requestId, userId: fx.userId, fingerprint: fx.fingerprint, notBefore: new Date(fx.notBefore), rootShareForClient: Buffer.from(fx.sealedShare, 'base64url') });
    const key = crypto.createPublicKey({ key: Buffer.from(fx.ecdsaSpki, 'base64url'), format: 'der', type: 'spki' });
    expect(crypto.verify('sha256', msg, { key, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
    expect(crypto.verify('sha256', Buffer.concat([msg, Buffer.from('x')]), { key, dsaEncoding: 'ieee-p1363' }, sig)).toBe(false);
  });

  it('(c2) rootReleaseMessage(fixture) coincide byte per byte col formato fissato a mano (piano §4)', () => {
    const share = Buffer.from(fx.sealedShare, 'base64url');
    expect(share).toHaveLength(157);
    const byHand = `notiq/vault/v3/recovery-release|${fx.requestId}|${fx.userId}|${fx.fingerprint}|${new Date(fx.notBefore).toISOString()}|${crypto.createHash('sha256').update(share).digest('hex')}`;
    const msg = rootReleaseMessage({ requestId: fx.requestId, userId: fx.userId, fingerprint: fx.fingerprint, notBefore: new Date(fx.notBefore), rootShareForClient: share });
    expect(msg.equals(Buffer.from(byHand, 'utf8'))).toBe(true);
  });

  it('(d) fingerprintOf(clientPubRaw) === fingerprint', () => {
    expect(fingerprintOf(Buffer.from(fx.clientPubRaw, 'base64url'))).toBe(fx.fingerprint);
  });

  it('(d2) FP calcolato a mano: primi 5 byte di SHA-256, 8 gruppi da 5 bit dal piu significativo, alfabeto Crockford', () => {
    const crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const hand = (pub: Buffer) => {
      const bits = [...crypto.createHash('sha256').update(pub).digest().subarray(0, 5)].map((b) => b.toString(2).padStart(8, '0')).join('');
      return Array.from({ length: 8 }, (_, i) => crockford[parseInt(bits.slice(i * 5, i * 5 + 5), 2)]).join('');
    };
    const pub = Buffer.from(fx.clientPubRaw, 'base64url');
    expect(hand(pub)).toBe(fx.fingerprint);
    expect(fingerprintOf(pub)).toBe(hand(pub));
    for (let i = 0; i < 20; i++) { const p = crypto.randomBytes(97); expect(fingerprintOf(p)).toBe(hand(p)); }
  });

  it('dimensioni: share 157 B, codice 133 B, privata PKCS8 e pubblica raw 97 B', () => {
    expect(Buffer.from(fx.sealedShare, 'base64url')).toHaveLength(157);
    expect(Buffer.from(fx.sealedCode, 'base64url')).toHaveLength(133);
    expect(Buffer.from(fx.clientPubRaw, 'base64url')).toHaveLength(97);
    expect(fx.sRootHex).toHaveLength(64);
  });
});
