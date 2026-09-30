import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

vi.mock('bcrypt', () => ({
  default: { hash: vi.fn(), compare: vi.fn() },
}));
// Mappa root di test (il modulo reale e' {} in P1)
vi.mock('../utils/vaultRootKeys', () => ({
  VAULT_ROOT_KEYS: { rk_test0000000000: { ecdhSpki: 'x', ecdsaSpki: 'y' } },
}));

vi.mock('../services/audit.service', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

import bcrypt from 'bcrypt';
import prisma from '../plugins/prisma';
import { logEvent } from '../services/audit.service';
import {
  createKeyring,
  getKeyring,
  updateKeyring,
  openServerShare,
  sha256hex,
  pepperStatus,
  verifierKey,
  type CreateKeyringDto,
} from '../services/vault.service';

const mp = prisma as any;
const RK = 'rk_test0000000000';
const PASSWORD = 'correct-horse-password';
const authKey = Buffer.alloc(32, 0xa1);
const serverShare = Buffer.alloc(32, 0xb2);

const dto = (o: Partial<CreateKeyringDto> = {}): CreateKeyringDto => ({
  expectedEpoch: 0,
  password: PASSWORD,
  kdf: 'argon2id',
  kdfParams: { m: 65536, t: 3, p: 1 },
  pinSalt: Buffer.alloc(16, 1),
  wrappedVkPin: Buffer.alloc(60, 2),
  authKey,
  serverShare,
  vkSigPub: Buffer.alloc(91, 3),
  wrappedVkSigKey: Buffer.alloc(100, 4),
  escrowBlob: Buffer.alloc(60, 5),
  sealedRootShare: Buffer.alloc(157, 6),
  rootKeyId: RK,
  userShareUnderVk: Buffer.alloc(48, 7),
  ...o,
});

// Nessun argomento delle chiamate Prisma mockate contiene i byte segreti, in nessuna codifica.
function expectNoSecrets(secrets: Buffer[]) {
  const calls = [mp.user, mp.vaultKeyring, mp.note, mp.auditLog]
    .flatMap((m) => Object.values(m) as any[])
    .flatMap((f) => (f.mock ? f.mock.calls : []));
  const dump = JSON.stringify(calls, (_k, v) =>
    v && v.type === 'Buffer' ? Buffer.from(v.data).toString('hex') + '|' + Buffer.from(v.data).toString('base64') + '|' + Buffer.from(v.data).toString('base64url') : v,
  );
  for (const b of secrets) {
    for (const s of [b.toString('hex'), b.toString('base64'), b.toString('base64url')]) {
      expect(dump).not.toContain(s);
    }
  }
}

async function fail(p: Promise<unknown>) {
  try {
    await p;
  } catch (e: any) {
    return e;
  }
  throw new Error('expected rejection');
}

beforeEach(() => {
  vi.clearAllMocks();
  mp.user.findUnique.mockResolvedValue({ password: 'hash' });
  (bcrypt.compare as any).mockResolvedValue(true);
  mp.note.count.mockResolvedValue(0);
  mp.auditLog.create.mockResolvedValue({});
});

describe('createKeyring', () => {
  it('password errata -> 403, nessuna scrittura', async () => {
    (bcrypt.compare as any).mockResolvedValue(false);
    const e = await fail(createKeyring('u1', dto()));
    expect(e.statusCode).toBe(403);
    expect(e.message).toBe('errors.vault.invalidPassword');
    expect(mp.vaultKeyring.create).not.toHaveBeenCalled();
    expect(mp.vaultKeyring.updateMany).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith('u1', 'vault.keyring.passwordRejected');
  });

  it('utente assente -> 403', async () => {
    mp.user.findUnique.mockResolvedValue(null);
    expect((await fail(createKeyring('u1', dto()))).statusCode).toBe(403);
  });

  it('rootKeyId sconosciuto -> 400', async () => {
    const e = await fail(createKeyring('u1', dto({ rootKeyId: 'rk_unknown' })));
    expect(e.statusCode).toBe(400);
    expect(e.message).toBe('errors.vault.invalidRootKey');
  });

  it('rootKeyId "constructor" (prototype) -> 400', async () => {
    expect((await fail(createKeyring('u1', dto({ rootKeyId: 'constructor' })))).statusCode).toBe(400);
  });

  it('due create concorrenti: 201 poi 409', async () => {
    mp.vaultKeyring.create
      .mockResolvedValueOnce({ rev: 0 })
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
    mp.vaultKeyring.updateMany.mockResolvedValue({ count: 0 });
    await expect(createKeyring('u1', dto())).resolves.toEqual({ status: 'READY', epoch: 0, rev: 0 });
    const e = await fail(createKeyring('u1', dto()));
    expect(e.statusCode).toBe(409);
    expect(e.message).toBe('errors.vault.alreadySetup');
  });

  it('altro errore di create viene rilanciato', async () => {
    mp.vaultKeyring.create.mockRejectedValue(Object.assign(new Error('boom'), { code: 'P2003' }));
    const e = await fail(createKeyring('u1', dto()));
    expect(e.message).toBe('boom');
    expect(mp.vaultKeyring.updateMany).not.toHaveBeenCalled();
  });

  it('fallback P2002 -> updateMany con azzeramenti', async () => {
    mp.vaultKeyring.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    mp.vaultKeyring.updateMany.mockResolvedValue({ count: 1 });
    mp.vaultKeyring.findUnique.mockResolvedValue({ rev: 1 });
    await expect(createKeyring('u1', dto())).resolves.toEqual({ status: 'READY', epoch: 0, rev: 1 });
    const arg = mp.vaultKeyring.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ userId: 'u1', status: 'NONE', epoch: 0 });
    expect(arg.data).toMatchObject({ failedAttempts: 0, lockedUntil: null, resetScheduledAt: null, status: 'READY' });
    expect(arg.data.rev).toEqual({ increment: 1 });
    for (const k of [
      'authVerifier', 'serverShareEnc', 'pepperKeyId', 'escrowBlob', 'sealedRootShare', 'rootKeyId',
      'userShareUnderVk',
    ]) {
      expect(arg.data[k]).toBeDefined();
    }
    expectNoSecrets([authKey, serverShare]);
  });

  it('authVerifier = HMAC(verifierKey, userId|authKey), legato allo userId', async () => {
    mp.vaultKeyring.create.mockResolvedValue({ rev: 0 });
    await createKeyring('u1', dto());
    await createKeyring('u2', dto());
    const v1: Buffer = mp.vaultKeyring.create.mock.calls[0][0].data.authVerifier;
    const v2: Buffer = mp.vaultKeyring.create.mock.calls[1][0].data.authVerifier;
    const expected = crypto
      .createHmac('sha256', verifierKey())
      .update(Buffer.concat([Buffer.from('u1|', 'utf8'), authKey]))
      .digest();
    expect(v1.equals(expected)).toBe(true);
    expect(v1.equals(v2)).toBe(false);
  });

  it('expectedEpoch 2 -> direttamente updateMany, niente create', async () => {
    mp.vaultKeyring.updateMany.mockResolvedValue({ count: 1 });
    mp.vaultKeyring.findUnique.mockResolvedValue({ rev: 5 });
    await expect(createKeyring('u1', dto({ expectedEpoch: 2 }))).resolves.toEqual({
      status: 'READY',
      epoch: 2,
      rev: 5,
    });
    expect(mp.vaultKeyring.create).not.toHaveBeenCalled();
    expect(mp.vaultKeyring.updateMany.mock.calls[0][0].where).toEqual({ userId: 'u1', status: 'NONE', epoch: 2 });
  });

  it('migrationState: 3 legacy -> IN_PROGRESS, 0 -> NONE', async () => {
    mp.vaultKeyring.create.mockResolvedValue({ rev: 0 });
    mp.note.count.mockResolvedValue(3);
    await createKeyring('u1', dto());
    expect(mp.vaultKeyring.create.mock.calls[0][0].data.migrationState).toBe('IN_PROGRESS');
    mp.note.count.mockResolvedValue(0);
    await createKeyring('u1', dto());
    expect(mp.vaultKeyring.create.mock.calls[1][0].data.migrationState).toBe('NONE');
  });

  it('nessun argomento Prisma contiene authKey, serverShare o password', async () => {
    mp.vaultKeyring.create.mockResolvedValue({ rev: 0 });
    await createKeyring('u1', dto());
    const calls = [mp.user, mp.vaultKeyring, mp.note, mp.auditLog]
      .flatMap((m) => Object.values(m) as any[])
      .flatMap((f) => (f.mock ? f.mock.calls : []));
    const dump = JSON.stringify(calls, (_k, v) =>
      v && v.type === 'Buffer' ? Buffer.from(v.data).toString('hex') : v,
    );
    const secrets = [authKey, serverShare].flatMap((b) => [
      b.toString('hex'), b.toString('base64'), b.toString('base64url'),
    ]);
    for (const s of [...secrets, PASSWORD]) expect(dump).not.toContain(s);
    const data = mp.vaultKeyring.create.mock.calls[0][0].data;
    for (const k of ['authKey', 'serverShare', 'password']) expect(data).not.toHaveProperty(k);
  });

  it('serverShareEnc e 60 B e fa round-trip; userId/epoch diversi lanciano', async () => {
    mp.vaultKeyring.create.mockResolvedValue({ rev: 0 });
    await createKeyring('u1', dto());
    const enc: Buffer = mp.vaultKeyring.create.mock.calls[0][0].data.serverShareEnc;
    expect(enc.length).toBe(60);
    expect(openServerShare('u1', 0, enc).equals(serverShare)).toBe(true);
    expect(() => openServerShare('u2', 0, enc)).toThrow();
    expect(() => openServerShare('u1', 1, enc)).toThrow();
  });
});

describe('getKeyring', () => {
  const RESERVED = [
    'authVerifier', 'serverShareEnc', 'escrowBlob', 'sealedRootShare', 'userShareUnderVk',
    'vkSigPub', 'pepperKeyId', 'failedAttempts',
  ];

  it('senza riga -> forma NONE, nessuna scrittura', async () => {
    mp.vaultKeyring.findUnique.mockResolvedValue(null);
    mp.note.count.mockResolvedValue(2);
    const r = await getKeyring('u1');
    expect(r).toMatchObject({ status: 'NONE', epoch: 0, rev: 0, migrationState: 'NONE', legacyCount: 2, kdf: null });
    for (const m of ['create', 'update', 'updateMany', 'upsert', 'deleteMany']) {
      expect(mp.vaultKeyring[m]).not.toHaveBeenCalled();
    }
  });

  it('con riga -> nessuna chiave riservata, select senza chiavi riservate', async () => {
    mp.vaultKeyring.findUnique.mockResolvedValue({
      status: 'READY', epoch: 0, rev: 1, kdf: 'argon2id', kdfParams: { m: 1 }, pinSalt: Buffer.alloc(16, 1),
      wrappedVkPin: Buffer.alloc(60, 2), wrappedVkSigKey: Buffer.alloc(80, 3), rootKeyId: RK,
      migrationState: 'NONE', lockedUntil: null, resetScheduledAt: null,
    });
    const r: any = await getKeyring('u1');
    for (const k of RESERVED) expect(r).not.toHaveProperty(k);
    expect(r.pinSalt).toBe(Buffer.alloc(16, 1).toString('base64url'));
    const sel = mp.vaultKeyring.findUnique.mock.calls[0][0].select;
    for (const k of RESERVED) expect(sel).not.toHaveProperty(k);
  });

  it('userId vuoto -> lancia', async () => {
    await expect(getKeyring('')).rejects.toThrow();
  });
});

describe('updateKeyring', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const b64 = (n: number, f = 1) => Buffer.alloc(n, f).toString('base64url');
  const oldVerifier = Buffer.alloc(32, 9);
  const row = (o: any = {}) => ({
    userId: 'u1', epoch: 2, rev: 4, status: 'READY', vkSigPub: new Uint8Array(spki), authVerifier: oldVerifier,
    pepperKeyId: pepperStatus().keyId, ...o,
  });
  const signed = (payloadObj: any) => {
    const raw = JSON.stringify(payloadObj);
    const msg = `notiq/vault/v3/proof|PUT /api/vault/keyring|u1|2|${payloadObj.rev}|${sha256hex(raw)}`;
    return { raw, sig: crypto.sign('sha256', Buffer.from(msg), { key: privateKey, dsaEncoding: 'ieee-p1363' }) };
  };
  const wrap = () => ({
    kdf: 'argon2id', kdfParams: { m: 65536, t: 3, p: 1 }, pinSalt: b64(16), wrappedVkPin: b64(60),
    authKey: b64(32, 0x55),
  });
  const escrow = (rootKeyId = RK) => ({
    escrowBlob: b64(60), sealedRootShare: b64(157), rootKeyId, userShareUnderVk: b64(48),
  });

  beforeEach(() => {
    mp.vaultKeyring.findUnique.mockResolvedValue(row());
    mp.vaultKeyring.updateMany.mockResolvedValue({ count: 1 });
  });

  it('PUT firmato -> CAS con rev nel where, {rev:n+1}', async () => {
    const { raw, sig } = signed({ rev: 4, escrow: escrow() });
    await expect(updateKeyring('u1', raw, sig)).resolves.toEqual({ rev: 5 });
    const arg = mp.vaultKeyring.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ userId: 'u1', status: 'READY', epoch: 2, rev: 4 });
    expect(arg.data.rev).toEqual({ increment: 1 });
    expect(arg.data.rootKeyId).toBe(RK);
  });

  it('replay -> 409 staleRev', async () => {
    mp.vaultKeyring.updateMany.mockResolvedValue({ count: 0 });
    const { raw, sig } = signed({ rev: 4, wrap: wrap() });
    const e = await fail(updateKeyring('u1', raw, sig));
    expect(e.statusCode).toBe(409);
    expect(e.message).toBe('errors.vault.staleRev');
  });

  it('rotate firmato -> 400 rotateNotSupported', async () => {
    const { raw, sig } = signed({ rev: 4, rotate: {} });
    const e = await fail(updateKeyring('u1', raw, sig));
    expect(e.statusCode).toBe(400);
    expect(e.message).toBe('errors.vault.rotateNotSupported');
  });

  it('firma sbagliata -> 403 invalidProof', async () => {
    const { raw } = signed({ rev: 4, wrap: wrap() });
    const e = await fail(updateKeyring('u1', raw, Buffer.alloc(64, 1)));
    expect(e.statusCode).toBe(403);
    expect(e.message).toBe('errors.vault.invalidProof');
  });

  it('JSON invalido o lunghezza errata -> 400 senza input nel messaggio', async () => {
    const secret = 'SECRETINPUT';
    const raws = [
      '{not json ' + secret,
      JSON.stringify({ rev: 4, wrap: { ...wrap(), pinSalt: b64(15) }, x: secret }),
    ];
    for (const raw of raws) {
      const e = await fail(updateKeyring('u1', raw, Buffer.alloc(64)));
      expect(e.statusCode).toBe(400);
      expect(e.message).toBe('errors.vault.invalidPayload');
      expect(e.message).not.toContain(secret);
    }
  });

  it('riga assente o non READY -> 409 notReady', async () => {
    const { raw, sig } = signed({ rev: 4, wrap: wrap() });
    mp.vaultKeyring.findUnique.mockResolvedValue(null);
    expect((await fail(updateKeyring('u1', raw, sig))).message).toBe('errors.vault.notReady');
    mp.vaultKeyring.findUnique.mockResolvedValue(row({ status: 'RESET_PENDING' }));
    const e = await fail(updateKeyring('u1', raw, sig));
    expect(e.statusCode).toBe(409);
    expect(e.message).toBe('errors.vault.notReady');
  });

  it('wrap -> authVerifier ricalcolato (diverso dal vecchio)', async () => {
    const { raw, sig } = signed({ rev: 4, wrap: wrap() });
    await updateKeyring('u1', raw, sig);
    const data = mp.vaultKeyring.updateMany.mock.calls[0][0].data;
    expect(Buffer.isBuffer(data.authVerifier)).toBe(true);
    expect(data.authVerifier.equals(oldVerifier)).toBe(false);
    expect(data.pepperKeyId).toBeTruthy();
    expect(data).not.toHaveProperty('authKey');
    expectNoSecrets([Buffer.alloc(32, 0x55)]);
  });

  it('wrap con pepperKeyId diverso -> 503 pepperMismatch, nessuna scrittura', async () => {
    mp.vaultKeyring.findUnique.mockResolvedValue(row({ pepperKeyId: 'deadbeefdeadbeef' }));
    const { raw, sig } = signed({ rev: 4, wrap: wrap() });
    const e = await fail(updateKeyring('u1', raw, sig));
    expect(e.statusCode).toBe(503);
    expect(e.message).toBe('errors.vault.pepperMismatch');
    expect(mp.vaultKeyring.updateMany).not.toHaveBeenCalled();
  });

  it('escrow-only con pepperKeyId diverso -> ok', async () => {
    mp.vaultKeyring.findUnique.mockResolvedValue(row({ pepperKeyId: 'deadbeefdeadbeef' }));
    const { raw, sig } = signed({ rev: 4, escrow: escrow() });
    await expect(updateKeyring('u1', raw, sig)).resolves.toEqual({ rev: 5 });
  });

  it('rev 2**31 firmato -> 400 invalidPayload', async () => {
    const { raw, sig } = signed({ rev: 2 ** 31, escrow: escrow() });
    const e = await fail(updateKeyring('u1', raw, sig));
    expect(e.statusCode).toBe(400);
    expect(e.message).toBe('errors.vault.invalidPayload');
  });

  it('escrow con rootKeyId sconosciuto -> 400 invalidRootKey', async () => {
    const { raw, sig } = signed({ rev: 4, escrow: escrow('rk_nope') });
    expect((await fail(updateKeyring('u1', raw, sig))).message).toBe('errors.vault.invalidRootKey');
  });
});
