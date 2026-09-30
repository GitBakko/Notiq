import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import crypto from 'crypto';
import prisma from '../plugins/prisma';
import {
  pepperStatus,
  verifierKey,
  shareWrapKey,
  sha256hex,
  parseEnvelope,
  getVaultGuard,
  assertVaultContent,
  verifyVkProof,
} from '../services/vault.service';

const mockPrisma = prisma as any;
const ORIGINAL_PEPPER = process.env.VAULT_PEPPER_KEY;

afterEach(() => {
  if (ORIGINAL_PEPPER === undefined) delete process.env.VAULT_PEPPER_KEY;
  else process.env.VAULT_PEPPER_KEY = ORIGINAL_PEPPER;
});

const b64 = (n: number, fill = 1) => Buffer.alloc(n, fill).toString('base64url');

describe('pepper', () => {
  it('assente -> missing', () => {
    delete process.env.VAULT_PEPPER_KEY;
    expect(pepperStatus()).toEqual({ status: 'missing' });
  });

  it('stringa vuota -> missing', () => {
    process.env.VAULT_PEPPER_KEY = '';
    expect(pepperStatus().status).toBe('missing');
  });

  it('31 e 33 byte -> invalid', () => {
    process.env.VAULT_PEPPER_KEY = b64(31);
    expect(pepperStatus().status).toBe('invalid');
    process.env.VAULT_PEPPER_KEY = b64(33);
    expect(pepperStatus().status).toBe('invalid');
  });

  it('43 char con + o / -> invalid', () => {
    process.env.VAULT_PEPPER_KEY = 'A'.repeat(42) + '+';
    expect(pepperStatus().status).toBe('invalid');
    process.env.VAULT_PEPPER_KEY = 'A'.repeat(42) + '/';
    expect(pepperStatus().status).toBe('invalid');
  });

  it('valido -> ok, keyId di 16 hex stabile', () => {
    process.env.VAULT_PEPPER_KEY = b64(32, 5);
    const a = pepperStatus();
    const b = pepperStatus();
    expect(a.status).toBe('ok');
    expect(a.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(b.keyId).toBe(a.keyId);
  });

  it('due pepper diversi -> verifierKey e keyId diversi', () => {
    process.env.VAULT_PEPPER_KEY = b64(32, 1);
    const k1 = verifierKey();
    const hmac1 = crypto.createHmac('sha256', k1).update('x').digest('hex');
    const id1 = pepperStatus().keyId;
    process.env.VAULT_PEPPER_KEY = b64(32, 2);
    const k2 = verifierKey();
    const hmac2 = crypto.createHmac('sha256', k2).update('x').digest('hex');
    expect(hmac1).not.toBe(hmac2);
    expect(pepperStatus().keyId).not.toBe(id1);
    expect(shareWrapKey().equals(k2)).toBe(false);
    expect(shareWrapKey()).toHaveLength(32);
  });

  describe('HKDF known-answer', () => {
    const P = Buffer.alloc(32, 5);
    const hk = (info: string) => Buffer.from(crypto.hkdfSync('sha256', P, '', info, 32));
    beforeEach(() => {
      process.env.VAULT_PEPPER_KEY = P.toString('base64url');
    });

    it('verifierKey', () => {
      expect(verifierKey().equals(hk('notiq/vault/v3/verifier'))).toBe(true);
    });

    it('shareWrapKey', () => {
      expect(shareWrapKey().equals(hk('notiq/vault/v3/sharewrap'))).toBe(true);
    });

    it('keyId', () => {
      expect(pepperStatus().keyId).toBe(hk('notiq/vault/v3/pepper-id').subarray(0, 8).toString('hex'));
    });
  });

  it('verifierKey/shareWrapKey con pepper mancante -> AppError 503', () => {
    delete process.env.VAULT_PEPPER_KEY;
    for (const fn of [verifierKey, shareWrapKey]) {
      try {
        fn();
        expect.unreachable();
      } catch (e: any) {
        expect(e.statusCode).toBe(503);
        expect(e.message).toBe('errors.vault.unavailable');
      }
    }
  });
});

describe('sha256hex', () => {
  it('vettore noto per stringa vuota', () => {
    expect(sha256hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('parseEnvelope', () => {
  const iv = 'A'.repeat(16);
  const ct22 = 'B'.repeat(22);

  it('accetta envelope validi', () => {
    expect(parseEnvelope(`nv3.0.${iv}.${ct22}`)).toEqual({ epoch: 0 });
    expect(parseEnvelope(`nv3.12.${iv}.${'C'.repeat(40)}`)).toEqual({ epoch: 12 });
  });

  it.each([
    ['epoch non numerico', `nv3.x.${iv}.${ct22}`],
    ['epoch con zero iniziale', `nv3.01.${iv}.${ct22}`],
    ['prefisso nv2', `nv2.0.${iv}.${ct22}`],
    ['IV 15 char', `nv3.0.${'A'.repeat(15)}.${ct22}`],
    ['IV 17 char', `nv3.0.${'A'.repeat(17)}.${ct22}`],
    ['ct 21 char', `nv3.0.${iv}.${'B'.repeat(21)}`],
    ['JSON TipTap', '{"type":"doc"}'],
    ['stringa vuota', ''],
  ])('rifiuta %s', (_n, s) => {
    expect(parseEnvelope(s)).toBeNull();
  });

  it('rifiuta null e numeri', () => {
    expect(parseEnvelope(null)).toBeNull();
    expect(parseEnvelope(42)).toBeNull();
  });
});

describe('getVaultGuard', () => {
  beforeEach(() => mockPrisma.vaultKeyring.findUnique.mockReset());

  it('nessuna riga -> null', async () => {
    mockPrisma.vaultKeyring.findUnique.mockResolvedValue(null);
    expect(await getVaultGuard('u1')).toBeNull();
    expect(mockPrisma.vaultKeyring.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1' } }),
    );
  });

  it.each([
    ['NONE', 0, null],
    ['READY', 3, { epoch: 3, ready: true }],
    ['RESET_PENDING', 1, { epoch: 1, ready: false }],
    ['NONE', 1, { epoch: 1, ready: false }],
  ])('%s/%i', async (status, epoch, expected) => {
    mockPrisma.vaultKeyring.findUnique.mockResolvedValue({ status, epoch });
    expect(await getVaultGuard('u1')).toEqual(expected);
  });

  it('userId vuoto -> throw', async () => {
    await expect(getVaultGuard('')).rejects.toThrow();
  });
});

describe('assertVaultContent', () => {
  const env = (epoch: number) => `nv3.${epoch}.${'A'.repeat(16)}.${'B'.repeat(30)}`;

  function expectErr(fn: () => void, message: string) {
    try {
      fn();
      expect.unreachable();
    } catch (e: any) {
      expect(e.statusCode).toBe(422);
      expect(e.message).toBe(message);
    }
  }

  it('notReady prima di tutto', () => {
    expectErr(() => assertVaultContent(env(1), { epoch: 1, ready: false }), 'errors.vault.notReady');
  });

  it('plaintext rifiutato', () => {
    expectErr(() => assertVaultContent('{"type":"doc"}', { epoch: 1, ready: true }), 'errors.vault.plaintextRejected');
  });

  it('epoch diverso -> stale', () => {
    expectErr(() => assertVaultContent(env(1), { epoch: 2, ready: true }), 'errors.vault.stale');
  });

  it('update con baseHash sbagliato -> conflict', () => {
    expectErr(
      () => assertVaultContent(env(1), { epoch: 1, ready: true }, 'f'.repeat(64), env(1)),
      'errors.vault.conflict',
    );
  });

  it('update senza baseHash -> conflict', () => {
    expectErr(() => assertVaultContent(env(1), { epoch: 1, ready: true }, undefined, env(1)), 'errors.vault.conflict');
  });

  it('update con baseHash corretto -> ok', () => {
    const current = env(1);
    expect(() => assertVaultContent(env(1), { epoch: 1, ready: true }, sha256hex(current), current)).not.toThrow();
  });

  it('ordine fisso: notReady vince su plaintext/baseHash', () => {
    expectErr(
      () => assertVaultContent('{"type":"doc"}', { epoch: 2, ready: false }, 'bad', 'x'),
      'errors.vault.notReady',
    );
  });

  it('ordine fisso: plaintextRejected vince su baseHash', () => {
    expectErr(
      () => assertVaultContent('{"type":"doc"}', { epoch: 2, ready: true }, 'bad', 'x'),
      'errors.vault.plaintextRejected',
    );
  });

  it('ordine fisso: stale vince su baseHash', () => {
    expectErr(() => assertVaultContent(env(1), { epoch: 2, ready: true }, 'bad', 'x'), 'errors.vault.stale');
  });

  it('create con envelope giusto -> ok', () => {
    expect(() => assertVaultContent(env(1), { epoch: 1, ready: true })).not.toThrow();
  });
});

describe('verifyVkProof', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const method = 'PUT';
  const path = '/api/vault/keyring';
  const payload = '{"rev":4}';
  const row = { userId: 'u1', epoch: 2, vkSigPub: new Uint8Array(spki) };

  const msgFor = (o: { path?: string; rev?: number; payload?: string; epoch?: number; userId?: string } = {}) =>
    Buffer.from(
      `notiq/vault/v3/proof|${method} ${o.path ?? path}|${o.userId ?? 'u1'}|${o.epoch ?? 2}|${o.rev ?? 4}|${sha256hex(o.payload ?? payload)}`,
      'utf8',
    );
  const sign = (msg: Buffer, dsaEncoding: 'ieee-p1363' | 'der' = 'ieee-p1363') =>
    crypto.sign('sha256', msg, { key: privateKey, dsaEncoding });
  const sig = sign(msgFor());

  function expectInvalid(fn: () => void) {
    try {
      fn();
      expect.unreachable();
    } catch (e: any) {
      expect(e.statusCode).toBe(403);
      expect(e.message).toBe('errors.vault.invalidProof');
    }
  }

  it('firma valida -> ok', () => {
    expect(() => verifyVkProof(row, method, path, payload, 4, sig)).not.toThrow();
  });

  it('altro path', () => expectInvalid(() => verifyVkProof(row, method, '/api/vault/other', payload, 4, sig)));
  it('altro rev', () => expectInvalid(() => verifyVkProof(row, method, path, payload, 5, sig)));
  it('payload modificato', () => expectInvalid(() => verifyVkProof(row, method, path, '{"rev":5}', 4, sig)));
  it('altro epoch', () => expectInvalid(() => verifyVkProof({ ...row, epoch: 3 }, method, path, payload, 4, sig)));
  it('altro userId', () => expectInvalid(() => verifyVkProof({ ...row, userId: 'u2' }, method, path, payload, 4, sig)));
  it('firma DER invece di p1363', () =>
    expectInvalid(() => verifyVkProof(row, method, path, payload, 4, sign(msgFor(), 'der'))));
  it('vkSigPub null', () => expectInvalid(() => verifyVkProof({ ...row, vkSigPub: null }, method, path, payload, 4, sig)));
  it('vkSigPub spazzatura', () =>
    expectInvalid(() =>
      verifyVkProof({ ...row, vkSigPub: new Uint8Array([1, 2, 3, 4]) }, method, path, payload, 4, sig),
    ));
});

describe('createKeyring: P1 lock', () => {
  // P1 lock: rimuovere in P2 quando VAULT_ROOT_KEYS viene popolato
  it('mappa root vuota -> 503, nessuna lettura, nessun bcrypt', async () => {
    const bcrypt = (await import('bcrypt')).default;
    const spy = vi.spyOn(bcrypt, 'compare');
    vi.clearAllMocks();
    const { createKeyring } = await import('../services/vault.service');
    const b = Buffer.alloc(4);
    await expect(
      createKeyring('u1', {
        expectedEpoch: 0, password: 'pw', kdf: 'argon2id', kdfParams: { m: 65536, t: 3, p: 1 },
        pinSalt: b, wrappedVkPin: b, authKey: b, serverShare: b, vkSigPub: b, wrappedVkSigKey: b,
        escrowBlob: b, sealedRootShare: b, rootKeyId: 'rk_x', userShareUnderVk: b,
      }),
    ).rejects.toMatchObject({ statusCode: 503, message: 'errors.vault.unavailable' });
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.vaultKeyring.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.vaultKeyring.create).not.toHaveBeenCalled();
    expect(mockPrisma.vaultKeyring.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.note.count).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('VAULT_ROOT_KEYS is frozen', async () => {
    const { VAULT_ROOT_KEYS } = await import('../utils/vaultRootKeys');
    expect(Object.isFrozen(VAULT_ROOT_KEYS)).toBe(true);
  });
});
