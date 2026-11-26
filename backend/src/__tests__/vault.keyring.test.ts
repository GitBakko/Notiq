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
  assertVaultContent,
  KDF_T_MIN,
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
  kdfParams: { m: 65536, t: KDF_T_MIN, p: 1 },
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
  process.env.VAULT_SETUP_USERS = '*';
  mp.user.findUnique.mockResolvedValue({ password: 'hash' });
  (bcrypt.compare as any).mockResolvedValue(true);
  mp.note.count.mockResolvedValue(0);
  mp.auditLog.create.mockResolvedValue({});
});

// Condiviso con T13 (frontend): stesso vettore per l'hash dell'escrowBlob (60 B = 0x00..0x3b)
const ESCROW_VECTOR_HASH = '0ddde28e40838ef6f9853e887f597d6adb5f40eb35d5763c52e1e64d8ba3bfff';

describe('createKeyring', () => {
  it('kill switch: variabile assente -> 503 setupDisabled prima di bcrypt', async () => {
    delete process.env.VAULT_SETUP_USERS;
    const e = await fail(createKeyring('u1', dto()));
    expect(e.statusCode).toBe(503);
    expect(e.message).toBe('errors.vault.setupDisabled');
    expect(bcrypt.compare).not.toHaveBeenCalled();
    expect(mp.user.findUnique).not.toHaveBeenCalled();
  });

  it('kill switch: lista con u1 -> u1 passa, u2 503; "*" -> passa', async () => {
    mp.vaultKeyring.create.mockResolvedValue({ rev: 0 });
    process.env.VAULT_SETUP_USERS = 'x, u1 ,y';
    await expect(createKeyring('u1', dto())).resolves.toMatchObject({ status: 'READY' });
    const e = await fail(createKeyring('u2', dto()));
    expect(e.statusCode).toBe(503);
    expect(e.message).toBe('errors.vault.setupDisabled');
    process.env.VAULT_SETUP_USERS = '*';
    await expect(createKeyring('u2', dto())).resolves.toMatchObject({ status: 'READY' });
  });

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

  it('NONE -> READY (updateMany) azzera prevVkWrap; anche la create lo scrive null', async () => {
    mp.vaultKeyring.updateMany.mockResolvedValue({ count: 1 });
    mp.vaultKeyring.findUnique.mockResolvedValue({ rev: 1 });
    await createKeyring('u1', dto({ expectedEpoch: 2 }));
    const data = mp.vaultKeyring.updateMany.mock.calls[0][0].data;
    expect(data).toHaveProperty('prevVkWrap', null);
    mp.vaultKeyring.create.mockResolvedValue({ rev: 0 });
    await createKeyring('u1', dto());
    expect(mp.vaultKeyring.create.mock.calls[0][0].data).toHaveProperty('prevVkWrap', null);
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
    'authVerifier', 'serverShareEnc', 'sealedRootShare', 'userShareUnderVk',
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

  it('prevVkWrap (base64url, null se assente) e staleCount: note nv3 fuori dall epoch corrente', async () => {
    const base = {
      status: 'READY', epoch: 7, rev: 1, kdf: 'argon2id', kdfParams: { m: 1 }, pinSalt: Buffer.alloc(16, 1),
      wrappedVkPin: Buffer.alloc(60, 2), wrappedVkSigKey: Buffer.alloc(80, 3), rootKeyId: RK,
      migrationState: 'NONE', lockedUntil: null, resetScheduledAt: null,
    };
    mp.note.count.mockImplementation(async ({ where }: any) => (where.content ? 3 : 0));
    mp.vaultKeyring.findUnique.mockResolvedValue({ ...base, prevVkWrap: Buffer.alloc(60, 9) });
    const r: any = await getKeyring('u1');
    expect(r.prevVkWrap).toBe(Buffer.alloc(60, 9).toString('base64url'));
    expect(r.staleCount).toBe(3);
    expect(mp.vaultKeyring.findUnique.mock.calls[0][0].select.prevVkWrap).toBe(true);
    const staleWhere = mp.note.count.mock.calls.map((c: any) => c[0].where).find((w: any) => w.content);
    expect(staleWhere).toEqual({
      userId: 'u1', isVault: true, content: { startsWith: 'nv3.' }, NOT: { content: { startsWith: 'nv3.7.' } },
    });
    mp.vaultKeyring.findUnique.mockResolvedValue({ ...base, prevVkWrap: null });
    mp.note.count.mockResolvedValue(0);
    const r2: any = await getKeyring('u1');
    expect(r2.prevVkWrap).toBeNull();
    expect(r2.staleCount).toBe(0);
  });

  it('senza riga: prevVkWrap null e staleCount 0', async () => {
    mp.vaultKeyring.findUnique.mockResolvedValue(null);
    const r: any = await getKeyring('u1');
    expect(r.prevVkWrap).toBeNull();
    expect(r.staleCount).toBe(0);
  });

  it('escrowHash = sha256 hex dei byte grezzi; escrowBlob mai nella risposta', async () => {
    const blob = Buffer.from(Array.from({ length: 60 }, (_, i) => i));
    mp.vaultKeyring.findUnique.mockResolvedValue({
      status: 'READY', epoch: 0, rev: 1, kdf: 'argon2id', kdfParams: { m: 1 }, pinSalt: Buffer.alloc(16, 1),
      wrappedVkPin: Buffer.alloc(60, 2), wrappedVkSigKey: Buffer.alloc(80, 3), rootKeyId: RK,
      migrationState: 'NONE', lockedUntil: null, resetScheduledAt: null, escrowBlob: new Uint8Array(blob),
    });
    const r: any = await getKeyring('u1');
    expect(r.escrowHash).toBe(ESCROW_VECTOR_HASH);
    expect(r).not.toHaveProperty('escrowBlob');
  });

  it('escrowHash null senza riga o senza blob', async () => {
    mp.vaultKeyring.findUnique.mockResolvedValue(null);
    expect(((await getKeyring('u1')) as any).escrowHash).toBeNull();
    mp.vaultKeyring.findUnique.mockResolvedValue({
      status: 'READY', epoch: 0, rev: 1, kdf: 'argon2id', kdfParams: { m: 1 }, pinSalt: null,
      wrappedVkPin: null, wrappedVkSigKey: null, rootKeyId: null, migrationState: 'NONE',
      lockedUntil: null, resetScheduledAt: null, escrowBlob: null,
    });
    expect(((await getKeyring('u1')) as any).escrowHash).toBeNull();
  });

  it('userId vuoto -> lancia', async () => {
    await expect(getKeyring('')).rejects.toThrow();
  });

  describe('reset (P3): lastResetEpoch e resetScheduledAt', () => {
    const base = {
      status: 'READY', epoch: 4, rev: 1, kdf: 'argon2id', kdfParams: { m: 1 }, pinSalt: null,
      wrappedVkPin: null, wrappedVkSigKey: null, rootKeyId: RK, migrationState: 'NONE', lockedUntil: null, escrowBlob: null,
    };
    const when = new Date('2026-12-03T10:00:00.000Z');

    it('lastResetEpoch viene dall ultimo audit vault.reset.completed dell utente (piu recente per createdAt)', async () => {
      mp.vaultKeyring.findUnique.mockResolvedValue({ ...base, resetScheduledAt: null });
      mp.auditLog.findFirst.mockResolvedValue({ details: { requestId: 'r', epoch: 3, counts: { notes: 1, tags: 0, attachments: 0 } } });
      expect(((await getKeyring('u1')) as any).lastResetEpoch).toBe(3);
      expect(mp.auditLog.findFirst).toHaveBeenCalledWith({ where: { userId: 'u1', event: 'vault.reset.completed' }, orderBy: { createdAt: 'desc' }, select: { details: true } });
    });

    it('lastResetEpoch null senza audit, con details malformati o senza riga keyring (sempre presente)', async () => {
      mp.vaultKeyring.findUnique.mockResolvedValue({ ...base, resetScheduledAt: null });
      mp.auditLog.findFirst.mockResolvedValue(null);
      expect(await getKeyring('u1')).toHaveProperty('lastResetEpoch', null);
      mp.auditLog.findFirst.mockResolvedValue({ details: { epoch: 'x' } });
      expect(((await getKeyring('u1')) as any).lastResetEpoch).toBeNull();
      mp.auditLog.findFirst.mockResolvedValue({ details: null });
      expect(((await getKeyring('u1')) as any).lastResetEpoch).toBeNull();
      mp.vaultKeyring.findUnique.mockResolvedValue(null);
      expect(await getKeyring('u1')).toHaveProperty('lastResetEpoch', null);
    });

    it('resetScheduledAt solo con RESET_PENDING: con altri stati e null anche se la colonna e valorizzata', async () => {
      mp.auditLog.findFirst.mockResolvedValue(null);
      mp.vaultKeyring.findUnique.mockResolvedValue({ ...base, status: 'RESET_PENDING', resetScheduledAt: when });
      expect(((await getKeyring('u1')) as any).resetScheduledAt).toEqual(when);
      mp.vaultKeyring.findUnique.mockResolvedValue({ ...base, status: 'READY', resetScheduledAt: when });
      expect(((await getKeyring('u1')) as any).resetScheduledAt).toBeNull();
    });
  });

  it('setupAllowed segue il kill switch di createKeyring, letto a ogni chiamata (NONE e con riga)', async () => {
    const row = {
      status: 'READY', epoch: 0, rev: 1, kdf: 'argon2id', kdfParams: { m: 1 }, pinSalt: null,
      wrappedVkPin: null, wrappedVkSigKey: null, rootKeyId: null, migrationState: 'NONE',
      lockedUntil: null, resetScheduledAt: null, escrowBlob: null,
    };
    for (const found of [null, row]) {
      mp.vaultKeyring.findUnique.mockResolvedValue(found);
      process.env.VAULT_SETUP_USERS = '*';
      expect(((await getKeyring('u1')) as any).setupAllowed).toBe(true);
      process.env.VAULT_SETUP_USERS = 'x, u1 ,y';
      expect(((await getKeyring('u1')) as any).setupAllowed).toBe(true);
      expect(((await getKeyring('u2')) as any).setupAllowed).toBe(false);
      process.env.VAULT_SETUP_USERS = '';
      expect(((await getKeyring('u1')) as any).setupAllowed).toBe(false);
      delete process.env.VAULT_SETUP_USERS;
      expect(((await getKeyring('u1')) as any).setupAllowed).toBe(false);
    }
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
  const signed = (payloadObj: any, epoch = 2) => {
    const raw = JSON.stringify(payloadObj);
    const msg = `notiq/vault/v3/proof|PUT /api/vault/keyring|u1|${epoch}|${payloadObj.rev}|${sha256hex(raw)}`;
    return { raw, sig: crypto.sign('sha256', Buffer.from(msg), { key: privateKey, dsaEncoding: 'ieee-p1363' }) };
  };
  const rotate = (o: any = {}) => ({ vkSigPub: b64(91, 8), wrappedVkSigKey: b64(100, 9), prevVkWrap: b64(60, 7), ...o });
  const newShare = Buffer.alloc(32, 0x66);
  // rotazione completa: wrap col nuovo serverShare + escrow + rotate (D2: ogni nuovo Kit ruota la VK)
  const rotation = (o: any = {}) => ({
    rev: 4,
    wrap: { ...wrap(), serverShare: newShare.toString('base64url') },
    escrow: escrow(),
    rotate: rotate(),
    ...o,
  });
  const wrap = () => ({
    kdf: 'argon2id', kdfParams: { m: 65536, t: KDF_T_MIN, p: 1 }, pinSalt: b64(16), wrappedVkPin: b64(60),
    authKey: b64(32, 0x55),
  });
  const escrow = (rootKeyId = RK) => ({
    escrowBlob: b64(60), sealedRootShare: b64(157), rootKeyId, userShareUnderVk: b64(48),
  });

  beforeEach(() => {
    mp.vaultKeyring.findUnique.mockResolvedValue(row());
    mp.vaultKeyring.updateMany.mockResolvedValue({ count: 1 });
    mp.note.count.mockResolvedValue(0);
    mp.vaultRequest.findFirst.mockResolvedValue(null);
  });

  it('PUT firmato (cambio PIN) -> CAS con rev nel where, {rev:n+1}, epoch invariata', async () => {
    const { raw, sig } = signed({ rev: 4, wrap: wrap() });
    await expect(updateKeyring('u1', raw, sig)).resolves.toEqual({ rev: 5, epoch: 2 });
    const arg = mp.vaultKeyring.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ userId: 'u1', status: 'READY', epoch: 2, rev: 4 });
    expect(arg.data.rev).toEqual({ increment: 1 });
    expect(arg.data).not.toHaveProperty('epoch');
    expect(arg.data).not.toHaveProperty('serverShareEnc');
    expect(mp.note.count).not.toHaveBeenCalled();
  });

  it('rotate: epoch+1, rev+1 e tutti i campi nuovi in UN solo CAS; unlock aprirebbe il serverShare con la nuova epoch', async () => {
    const { raw, sig } = signed(rotation());
    await expect(updateKeyring('u1', raw, sig)).resolves.toEqual({ rev: 5, epoch: 3 });
    expect(mp.vaultKeyring.updateMany).toHaveBeenCalledTimes(1);
    const arg = mp.vaultKeyring.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ userId: 'u1', status: 'READY', epoch: 2, rev: 4 });
    const d = arg.data;
    expect(d.epoch).toBe(3);
    expect(d.rev).toEqual({ increment: 1 });
    expect(Buffer.from(d.vkSigPub).equals(Buffer.alloc(91, 8))).toBe(true);
    expect(Buffer.from(d.wrappedVkSigKey).equals(Buffer.alloc(100, 9))).toBe(true);
    expect(Buffer.from(d.prevVkWrap).equals(Buffer.alloc(60, 7))).toBe(true);
    expect(d.rootKeyId).toBe(RK);
    expect(Buffer.from(d.escrowBlob).equals(Buffer.alloc(60, 1))).toBe(true);
    expect(Buffer.from(d.pinSalt).length).toBe(16);
    expect(openServerShare('u1', 3, d.serverShareEnc).equals(newShare)).toBe(true);
    expect(() => openServerShare('u1', 2, d.serverShareEnc)).toThrow();
    expect(d.authVerifier.equals(oldVerifier)).toBe(false);
    expectNoSecrets([newShare, Buffer.alloc(32, 0x55)]);
  });

  it('rotate: staleCount > 0 -> 409 rotationPending, nessuna scrittura; conta le nv3 fuori dall epoch corrente (2)', async () => {
    mp.note.count.mockResolvedValue(2);
    const { raw, sig } = signed(rotation());
    const e = await fail(updateKeyring('u1', raw, sig));
    expect(e.statusCode).toBe(409);
    expect(e.message).toBe('errors.vault.rotationPending');
    expect(mp.note.count.mock.calls[0][0].where).toEqual({
      userId: 'u1', isVault: true, content: { startsWith: 'nv3.' }, NOT: { content: { startsWith: 'nv3.2.' } },
    });
    expect(mp.vaultKeyring.updateMany).not.toHaveBeenCalled();
  });

  it('rotate con rilascio di recupero aperto -> 409 recoveryInProgress, nessuna scrittura', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue({ id: 'r1' });
    const { raw, sig } = signed(rotation());
    const e = await fail(updateKeyring('u1', raw, sig));
    expect(e.statusCode).toBe(409);
    expect(e.message).toBe('errors.vault.recoveryInProgress');
    expect(mp.vaultKeyring.updateMany).not.toHaveBeenCalled();
  });

  it('rotate con pepperKeyId diverso -> 503 pepperMismatch, nessuna scrittura', async () => {
    mp.vaultKeyring.findUnique.mockResolvedValue(row({ pepperKeyId: 'deadbeefdeadbeef' }));
    const { raw, sig } = signed(rotation());
    const e = await fail(updateKeyring('u1', raw, sig));
    expect(e.statusCode).toBe(503);
    expect(mp.vaultKeyring.updateMany).not.toHaveBeenCalled();
  });

  it('rotate: concorrenza (rev ok al controllo, CAS fallito per una scrittura concorrente) -> 409 staleRev', async () => {
    mp.vaultKeyring.updateMany.mockResolvedValue({ count: 0 });
    const { raw, sig } = signed(rotation());
    const e = await fail(updateKeyring('u1', raw, sig));
    expect(e.statusCode).toBe(409);
    expect(e.message).toBe('errors.vault.staleRev');
  });

  describe('D8: cancellazione versioni envelope fuori epoch nel CAS di rotazione', () => {
    const expectedDelete = (E: number) => ({
      where: { note: { userId: 'u1' }, content: { startsWith: 'nv3.' }, NOT: { content: { startsWith: `nv3.${E}.` } } },
    });

    it('rotate riuscita: deleteMany sulle versioni nv3 NON dell epoch prima della rotazione (E=2, punto finale incluso), nella transazione del CAS, dopo il CAS', async () => {
      mp.noteVersion.deleteMany.mockClear();
      const order: string[] = [];
      mp.$transaction.mockImplementationOnce(async (fn: any) => { order.push('tx'); const r = await fn(mp); order.push('commit'); return r; });
      mp.vaultKeyring.updateMany.mockImplementationOnce(async () => { order.push('cas'); return { count: 1 }; });
      mp.noteVersion.deleteMany.mockImplementationOnce(async () => { order.push('delete'); return { count: 3 }; });
      const { raw, sig } = signed(rotation());
      await updateKeyring('u1', raw, sig);
      expect(mp.noteVersion.deleteMany).toHaveBeenCalledTimes(1);
      expect(mp.noteVersion.deleteMany.mock.calls[0][0]).toEqual(expectedDelete(2));
      expect(order).toEqual(['tx', 'cas', 'delete', 'commit']);
    });

    it('la transazione di rotazione ha timeout 30 s (delete di molte versioni da 2 MiB)', async () => {
      mp.$transaction.mockClear();
      const { raw, sig } = signed(rotation());
      await updateKeyring('u1', raw, sig);
      expect(mp.$transaction.mock.calls[0][1]).toEqual({ timeout: 30000 });
    });

    it('con E=1 il filtro e nv3.1. (con punto): nv3.10. non e protetta, nv3.1. si', async () => {
      mp.noteVersion.deleteMany.mockClear();
      mp.vaultKeyring.findUnique.mockResolvedValue(row({ epoch: 1 }));
      const { raw, sig } = signed(rotation(), 1);
      await updateKeyring('u1', raw, sig);
      const w = mp.noteVersion.deleteMany.mock.calls[0][0].where;
      expect(w.NOT.content.startsWith).toBe('nv3.1.');
      expect('nv3.10.x.y'.startsWith(w.NOT.content.startsWith)).toBe(false);
      expect('nv3.1.x.y'.startsWith(w.NOT.content.startsWith)).toBe(true);
    });

    it('CAS fallito (count 0): nessuna delete, 409 staleRev', async () => {
      mp.noteVersion.deleteMany.mockClear();
      mp.vaultKeyring.updateMany.mockResolvedValue({ count: 0 });
      const { raw, sig } = signed(rotation());
      const e = await fail(updateKeyring('u1', raw, sig));
      expect(e.message).toBe('errors.vault.staleRev');
      expect(mp.noteVersion.deleteMany).not.toHaveBeenCalled();
    });

    it('cambio PIN senza rotate: nessuna delete', async () => {
      mp.noteVersion.deleteMany.mockClear();
      const { raw, sig } = signed({ rev: 4, wrap: wrap() });
      await updateKeyring('u1', raw, sig);
      expect(mp.noteVersion.deleteMany).not.toHaveBeenCalled();
    });
  });

  it('replay di una rotazione GIA committata (riga a epoch 3, rev 5, chiave nuova; payload rev 4 firmato con la chiave vecchia) -> 409 staleRev, non 403', async () => {
    const fresh = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' });
    mp.vaultKeyring.findUnique.mockResolvedValue(row({ epoch: 3, rev: 5, vkSigPub: new Uint8Array(fresh) }));
    const { raw, sig } = signed(rotation({ rev: 4 }), 2);
    const e = await fail(updateKeyring('u1', raw, sig));
    expect(e.statusCode).toBe(409);
    expect(e.message).toBe('errors.vault.staleRev');
    expect(mp.vaultKeyring.updateMany).not.toHaveBeenCalled();
  });

  it('dopo la rotazione una PUT firmata con la chiave di firma VECCHIA -> 403 invalidProof', async () => {
    const fresh = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' });
    mp.vaultKeyring.findUnique.mockResolvedValue(row({ epoch: 3, rev: 5, vkSigPub: new Uint8Array(fresh) }));
    const { raw, sig } = signed({ rev: 5, wrap: wrap() }, 3);
    const e = await fail(updateKeyring('u1', raw, sig));
    expect(e.statusCode).toBe(403);
    expect(e.message).toBe('errors.vault.invalidProof');
    expect(mp.vaultKeyring.updateMany).not.toHaveBeenCalled();
  });

  it('rotate: il vkProof si verifica con epoch ATTUALE (vecchia): firma sull epoch nuova -> 403', async () => {
    const { raw, sig } = signed(rotation(), 3);
    const e = await fail(updateKeyring('u1', raw, sig));
    expect(e.statusCode).toBe(403);
  });

  describe('regole di forma di rotate (D2): 400 invalidPayload senza scritture', () => {
    const cases: [string, any][] = [
      ['chiavi sconosciute in rotate', rotation({ rotate: rotate({ extra: 'x' }) })],
      ['rotate senza prevVkWrap', rotation({ rotate: { vkSigPub: b64(91), wrappedVkSigKey: b64(100) } })],
      ['prevVkWrap di 59 byte', rotation({ rotate: rotate({ prevVkWrap: b64(59) }) })],
      ['vkSigPub di 90 byte', rotation({ rotate: rotate({ vkSigPub: b64(90) }) })],
      ['wrappedVkSigKey di 79 byte', rotation({ rotate: rotate({ wrappedVkSigKey: b64(79) }) })],
      ['wrappedVkSigKey di 221 byte', rotation({ rotate: rotate({ wrappedVkSigKey: b64(221) }) })],
      ['escrow senza rotate', rotation({ rotate: undefined })],
      ['rotate senza escrow', rotation({ escrow: undefined })],
      ['rotate senza wrap', rotation({ wrap: undefined })],
      ['rotate con wrap senza serverShare', rotation({ wrap: wrap() })],
      ['wrap.serverShare senza rotate (cambio PIN)', { rev: 4, wrap: { ...wrap(), serverShare: b64(32) } }],
    ];
    it.each(cases)('%s', async (_n, body) => {
      const { raw, sig } = signed(body);
      const e = await fail(updateKeyring('u1', raw, sig));
      expect(e.statusCode).toBe(400);
      expect(e.message).toBe('errors.vault.invalidPayload');
      expect(mp.vaultKeyring.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('schema strict a ogni livello (3)', () => {
    const w = () => ({ ...wrap(), serverShare: newShare.toString('base64url') });
    const cases: [string, any][] = [
      ['top-level', rotation({ extra: 1 })],
      ['wrap', rotation({ wrap: { ...w(), extra: 1 } })],
      ['kdfParams', rotation({ wrap: { ...w(), kdfParams: { ...wrap().kdfParams, extra: 1 } } })],
      ['escrow', rotation({ escrow: { ...escrow(), extra: 1 } })],
      ['top-level, cambio PIN', { rev: 4, wrap: wrap(), extra: 1 }],
      ['kdfParams, cambio PIN', { rev: 4, wrap: { ...wrap(), kdfParams: { ...wrap().kdfParams, extra: 1 } } }],
    ];
    it.each(cases)('chiave sconosciuta: %s -> 400 invalidPayload', async (_n, body) => {
      const { raw, sig } = signed(body);
      const e = await fail(updateKeyring('u1', raw, sig));
      expect(e.statusCode).toBe(400);
      expect(e.message).toBe('errors.vault.invalidPayload');
      expect(mp.vaultKeyring.updateMany).not.toHaveBeenCalled();
    });

    it('payload del cambio PIN del client 1.14 ({rev, wrap:{kdf, kdfParams:{m,t,p}, pinSalt, wrappedVkPin, authKey}}) -> ok', async () => {
      const { raw, sig } = signed({
        rev: 4,
        wrap: { kdf: 'argon2id', kdfParams: { m: 65536, t: KDF_T_MIN, p: 1 }, pinSalt: b64(16), wrappedVkPin: b64(60), authKey: b64(32, 0x55) },
      });
      await expect(updateKeyring('u1', raw, sig)).resolves.toEqual({ rev: 5, epoch: 2 });
    });
  });

  it('dopo la rotazione l envelope dell epoch vecchia e rifiutato dalla PUT di una nota: 422 stale', () => {
    const old = `nv3.2.${'A'.repeat(16)}.${'B'.repeat(30)}`;
    let err: any;
    try {
      assertVaultContent(old, { epoch: 3, ready: true });
    } catch (e) {
      err = e;
    }
    expect(err.statusCode).toBe(422);
    expect(err.message).toBe('errors.vault.stale');
  });

  it('wrap con kdfParams.t < KDF_T_MIN -> 400 invalidPayload', async () => {
    const w = wrap();
    const { raw, sig } = signed({ rev: 4, wrap: { ...w, kdfParams: { ...w.kdfParams, t: KDF_T_MIN - 1 } } });
    const e = await fail(updateKeyring('u1', raw, sig));
    expect(e.statusCode).toBe(400);
    expect(e.message).toBe('errors.vault.invalidPayload');
    expect(mp.vaultKeyring.updateMany).not.toHaveBeenCalled();
  });

  it('replay -> 409 staleRev', async () => {
    mp.vaultKeyring.updateMany.mockResolvedValue({ count: 0 });
    const { raw, sig } = signed({ rev: 4, wrap: wrap() });
    const e = await fail(updateKeyring('u1', raw, sig));
    expect(e.statusCode).toBe(409);
    expect(e.message).toBe('errors.vault.staleRev');
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

  it('rev 2**31 firmato -> 400 invalidPayload', async () => {
    const { raw, sig } = signed({ rev: 2 ** 31, escrow: escrow() });
    const e = await fail(updateKeyring('u1', raw, sig));
    expect(e.statusCode).toBe(400);
    expect(e.message).toBe('errors.vault.invalidPayload');
  });

  it('escrow con rootKeyId sconosciuto -> 400 invalidRootKey', async () => {
    const { raw, sig } = signed(rotation({ escrow: escrow('rk_nope') }));
    expect((await fail(updateKeyring('u1', raw, sig))).message).toBe('errors.vault.invalidRootKey');
  });

  it('escrow con la chiave root ritirata (rk_68a265761e7e37c7) -> 400 invalidRootKey, nessuna scrittura', async () => {
    const { raw, sig } = signed(rotation({ escrow: escrow('rk_68a265761e7e37c7') }));
    const e = await fail(updateKeyring('u1', raw, sig));
    expect(e.statusCode).toBe(400);
    expect(e.message).toBe('errors.vault.invalidRootKey');
    expect(mp.vaultKeyring.updateMany).not.toHaveBeenCalled();
  });

  describe('rilascio di recupero aperto', () => {
    it('escrow con RECOVERY RELEASED non scaduta -> 409 recoveryInProgress, nessuna scrittura', async () => {
      mp.vaultRequest.findFirst.mockResolvedValue({ id: 'r1' });
      const { raw, sig } = signed(rotation());
      const e = await fail(updateKeyring('u1', raw, sig));
      expect(e.statusCode).toBe(409);
      expect(e.message).toBe('errors.vault.recoveryInProgress');
      expect(mp.vaultKeyring.updateMany).not.toHaveBeenCalled();
      expect(mp.vaultRequest.findFirst.mock.calls[0][0].where).toMatchObject({
        userId: 'u1', type: 'RECOVERY', status: 'RELEASED', releaseExpiresAt: { gt: expect.any(Date) },
      });
    });

    it('rotate senza rilascio aperto -> 200', async () => {
      mp.vaultRequest.findFirst.mockResolvedValue(null);
      const { raw, sig } = signed(rotation());
      await expect(updateKeyring('u1', raw, sig)).resolves.toEqual({ rev: 5, epoch: 3 });
    });

    it('solo wrap con rilascio aperto -> 200, senza nemmeno cercare il rilascio', async () => {
      mp.vaultRequest.findFirst.mockResolvedValue({ id: 'r1' });
      mp.vaultRequest.findFirst.mockClear();
      const { raw, sig } = signed({ rev: 4, wrap: wrap() });
      await expect(updateKeyring('u1', raw, sig)).resolves.toEqual({ rev: 5, epoch: 2 });
      expect(mp.vaultRequest.findFirst).not.toHaveBeenCalled();
    });
  });
});
