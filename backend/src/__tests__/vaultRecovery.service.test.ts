import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';

vi.mock('../services/audit.service', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/vaultRecoveryNotify', () => ({ notifyRecovery: vi.fn().mockResolvedValue(undefined), notifySuperadmins: vi.fn().mockResolvedValue(undefined) }));
// sealRecoveryCode resta reale: codeA si ricava solo aprendo il seal. Solo il rilascio (Argon2id + file root) e' mockato.
vi.mock('../services/vaultRootKey.service', async (importOriginal) => ({ ...(await importOriginal<typeof import('../services/vaultRootKey.service')>()), releaseRootShare: vi.fn() }));

import prisma from '../plugins/prisma';
import { AppError } from '../utils/errors';
import { logEvent } from '../services/audit.service';
import { notifyRecovery, notifySuperadmins } from '../services/vaultRecoveryNotify';
import { releaseRootShare } from '../services/vaultRootKey.service';
import { pepperStatus, verifierKey } from '../services/vault.service';
import {
  approveRecovery, cancelRecovery, completeRecovery, confirmRecovery, createRecoveryRequest, expireRecoveryRequests, fingerprintOf,
  getOpenRecovery, getRecovery, getRecoveryForAdmin, listRecoveriesForAdmin, rejectRecovery, releaseRecovery,
  runRecoveryJobs, sendRecoveryReminders,
} from '../services/vaultRecovery.service';

const mp = prisma as any;
const U = 'user-1';
const ADMIN = 'admin-1';
const RID = 'recovery-1';
const ORIGINAL_PEPPER = process.env.VAULT_PEPPER_KEY;

beforeAll(() => { process.env.VAULT_PEPPER_KEY = crypto.randomBytes(32).toString('base64url'); });
afterAll(() => {
  if (ORIGINAL_PEPPER === undefined) delete process.env.VAULT_PEPPER_KEY;
  else process.env.VAULT_PEPPER_KEY = ORIGINAL_PEPPER;
});

function client() {
  const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const jwk = keys.publicKey.export({ format: 'jwk' });
  return { privateKey: keys.privateKey, pub: Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x as string, 'base64url'), Buffer.from(jwk.y as string, 'base64url')]) };
}

function pub(): Buffer {
  return client().pub;
}

/** Apre il seal della meta A come lo fara' il client (info/AAD del contratto di sealRecoveryCode). */
function openSealedCodeA(sealedB64: string, privateKey: crypto.KeyObject, requestId = RID, userId = U): string {
  const sealed = Buffer.from(sealedB64, 'base64url');
  const ephPubRaw = sealed.subarray(0, 97);
  const ephPub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-384', x: ephPubRaw.subarray(1, 49).toString('base64url'), y: ephPubRaw.subarray(49).toString('base64url') }, format: 'jwk' });
  const key = crypto.hkdfSync('sha256', crypto.diffieHellman({ privateKey, publicKey: ephPub }), ephPubRaw, `notiq/vault/v3/recovery-code|${requestId}|${userId}`, 32);
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), sealed.subarray(97, 109));
  d.setAAD(Buffer.from(`notiq/vault/v3/recovery-code|${requestId}`));
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(109, 117)), d.final()]).toString('utf8');
}

function hash(part: 'A' | 'B', code: string): string {
  return crypto.createHmac('sha256', verifierKey()).update(`recovery|${RID}|${part}|${code}`).digest('hex');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(notifyRecovery).mockResolvedValue(undefined);
  vi.mocked(notifySuperadmins).mockResolvedValue(undefined);
  mp.auditLog = { count: vi.fn(), create: vi.fn(), findMany: vi.fn() };
  mp.$transaction = vi.fn();
  mp.vaultRequest.findMany.mockReset().mockResolvedValue([]);
  mp.vaultRequest.findFirst.mockResolvedValue(null);
  mp.vaultRequest.findUnique.mockResolvedValue(null);
  mp.vaultKeyring.findUnique.mockResolvedValue({ status: 'READY', sealedRootShare: Buffer.alloc(157, 1), rootKeyId: 'rk_test' });
  mp.vaultKeyring.updateMany.mockResolvedValue({ count: 1 });
  mp.vaultRequest.count.mockResolvedValue(0);
  mp.vaultRequest.create.mockImplementation(async ({ data }: any) => ({ id: RID, ...data }));
  mp.vaultRequest.updateMany.mockResolvedValue({ count: 1 });
  mp.vaultRequest.update.mockResolvedValue({});
  mp.auditLog.count.mockResolvedValue(0);
  mp.auditLog.create.mockResolvedValue({});
  mp.$executeRaw = vi.fn().mockResolvedValue(1);
  mp.$queryRaw = vi.fn().mockResolvedValue([{ locked: true }]);
  mp.$transaction.mockImplementation(async (fn: any) => fn(mp));
});

describe('fingerprint (G1)', () => {
  it('vettore fisso: pubKey 04|01..60 -> E7E0T7Q5 (40 bit, base32 Crockford, MSB prima)', () => {
    const p = Buffer.alloc(97);
    p[0] = 4;
    for (let i = 1; i < 97; i++) p[i] = i;
    expect(fingerprintOf(p)).toBe('E7E0T7Q5');
  });

  it('su 200 chiavi l\'8o carattere non e\' sempre 0 e la lunghezza e\' 8', () => {
    const fps = Array.from({ length: 200 }, () => fingerprintOf(pub()));
    expect(new Set(fps.map((f) => f[7])).size).toBeGreaterThan(8);
    expect(fps.every((f) => f.length === 8)).toBe(true);
  });
});

describe('richiesta e approvazione', () => {
  it('crea PENDING_APPROVAL con fingerprint e metadati limitati; notify requested', async () => {
    const result = await createRecoveryRequest(U, pub(), 'forgot', '192.0.2.1', 'agent');
    expect(result.id).toBe(RID);
    expect(result.fingerprint).toHaveLength(8);
    const data = mp.vaultRequest.create.mock.calls[0][0].data;
    expect(data.status).toBe('PENDING_APPROVAL');
    expect(data.clientEphPub).toHaveLength(97);
    expect(data.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    expect(notifyRecovery).toHaveBeenCalledWith(U, 'requested', { requestId: RID, fingerprint: result.fingerprint });
  });

  it('F2: advisory lock per utente eseguito nella transazione prima delle letture e della create', async () => {
    const order: string[] = [];
    let lockArgs: any[] = [];
    mp.$transaction.mockImplementation(async (fn: any) => { order.push('tx'); return fn(mp); });
    mp.$executeRaw.mockImplementation(async (...args: any[]) => { order.push('lock'); lockArgs = args; return 1; });
    mp.vaultRequest.findFirst.mockImplementation(async () => { order.push('findFirst'); return null; });
    mp.vaultRequest.count.mockImplementation(async () => { order.push('count'); return 0; });
    mp.vaultRequest.create.mockImplementation(async ({ data }: any) => { order.push('create'); return { id: RID, ...data }; });
    await createRecoveryRequest(U, pub(), undefined, 'ip', 'ua');
    expect(order).toEqual(['tx', 'lock', 'findFirst', 'count', 'create']);
    const [strings, ...values] = lockArgs;
    expect(strings.join('?')).toContain('pg_advisory_xact_lock');
    expect(values).toEqual([`vault-recovery:${U}`]);
  });

  it('M1: create scade le righe gia scadute dell\'utente dentro il lock, prima del controllo "una aperta"; audit e notify expired dopo il commit', async () => {
    const order: string[] = [];
    const past = new Date(Date.now() - 1000);
    mp.$transaction.mockImplementation(async (fn: any) => { order.push('tx'); const r = await fn(mp); order.push('commit'); return r; });
    mp.$executeRaw.mockImplementation(async () => { order.push('lock'); return 1; });
    mp.vaultRequest.findMany.mockImplementation(async () => { order.push('findMany'); return [{ id: 'old', userId: U, status: 'WAITING', expiresAt: past, releaseExpiresAt: null }]; });
    mp.vaultRequest.updateMany.mockImplementation(async () => { order.push('expire'); return { count: 1 }; });
    mp.vaultRequest.findFirst.mockImplementation(async () => { order.push('findFirst'); return null; });
    vi.mocked(logEvent).mockImplementation(async () => { order.push('audit'); });
    await createRecoveryRequest(U, pub(), undefined, 'ip', 'ua');
    expect(order.slice(0, 6)).toEqual(['tx', 'lock', 'findMany', 'expire', 'findFirst', 'commit']);
    expect(mp.vaultRequest.findMany.mock.calls[0][0].where).toMatchObject({ userId: U, type: 'RECOVERY' });
    expect(mp.vaultRequest.updateMany).toHaveBeenCalledWith({ where: { id: 'old', type: 'RECOVERY', status: 'WAITING', expiresAt: past }, data: { status: 'EXPIRED' } });
    expect(order.indexOf('audit')).toBeGreaterThan(order.indexOf('commit'));
    expect(logEvent).toHaveBeenCalledWith(U, 'vault.recovery.expired', { requestId: 'old', reason: 'waiting' });
    expect(notifyRecovery).toHaveBeenCalledWith(U, 'expired', { requestId: 'old' });
  });

  it('M1: riga scaduta che un job concorrente ha gia marcato (count 0) -> nessuna audit ne notify expired', async () => {
    mp.vaultRequest.findMany.mockResolvedValue([{ id: 'old', userId: U, status: 'PENDING_CODE', expiresAt: new Date(Date.now() - 1000), releaseExpiresAt: null }]);
    mp.vaultRequest.updateMany.mockResolvedValue({ count: 0 });
    await createRecoveryRequest(U, pub(), undefined, 'ip', 'ua');
    expect(logEvent).not.toHaveBeenCalledWith(U, 'vault.recovery.expired', expect.anything());
    expect(notifyRecovery).not.toHaveBeenCalledWith(U, 'expired', expect.anything());
  });

  it('F4: la quota non conta CANCELLED, REJECTED ed EXPIRED per tentativi esauriti; conta EXPIRED per tempo', async () => {
    const rows = [
      { status: 'CANCELLED', attempts: 0 }, { status: 'REJECTED', attempts: 0 },
      { status: 'EXPIRED', attempts: 5 }, { status: 'EXPIRED', attempts: 5 },
      { status: 'EXPIRED', attempts: 0 }, { status: 'COMPLETED', attempts: 1 },
    ];
    // Valutatore minimo della where usata dal service: notIn su status e NOT { status, attempts.gte }.
    mp.vaultRequest.count.mockImplementation(async ({ where }: any) => rows.filter((r) => {
      if (where.status?.notIn?.includes(r.status)) return false;
      const n = where.NOT;
      if (n && r.status === n.status && r.attempts >= n.attempts.gte) return false;
      return true;
    }).length);
    await expect(createRecoveryRequest(U, pub(), undefined, 'ip', 'ua')).resolves.toMatchObject({ id: RID }); // contate: 2 (< 3)
    rows.push({ status: 'EXPIRED', attempts: 2 });
    await expect(createRecoveryRequest(U, pub(), undefined, 'ip', 'ua')).rejects.toMatchObject({ statusCode: 429, message: 'errors.vault.recoveryRateLimited' }); // contate: 3
  });

  it('F6: punto 0x04 + 96 byte fuori curva -> 400 invalidPayload, nessuna riga', async () => {
    const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(96, 1)]);
    await expect(createRecoveryRequest(U, offCurve, undefined, 'ip', 'ua')).rejects.toMatchObject({ statusCode: 400, message: 'errors.vault.invalidPayload' });
    expect(mp.vaultRequest.create).not.toHaveBeenCalled();
    expect(notifyRecovery).not.toHaveBeenCalled();
  });

  it('non crea una seconda richiesta aperta', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue({ id: RID });
    await expect(createRecoveryRequest(U, pub(), undefined, 'ip', 'ua')).rejects.toMatchObject({ statusCode: 409 });
    expect(mp.vaultRequest.create).not.toHaveBeenCalled();
  });

  it('G4: senza keyring READY con escrow -> 409 recoveryNoKeyring, nessuna riga', async () => {
    for (const keyring of [null, { status: 'NONE', sealedRootShare: null, rootKeyId: null }, { status: 'READY', sealedRootShare: null, rootKeyId: 'rk' }, { status: 'READY', sealedRootShare: Buffer.alloc(157), rootKeyId: null }, { status: 'RESET_PENDING', sealedRootShare: Buffer.alloc(157), rootKeyId: 'rk' }]) {
      mp.vaultKeyring.findUnique.mockResolvedValue(keyring);
      await expect(createRecoveryRequest(U, pub(), undefined, 'ip', 'ua')).rejects.toMatchObject({ statusCode: 409, message: 'errors.vault.recoveryNoKeyring' });
    }
    expect(mp.vaultRequest.create).not.toHaveBeenCalled();
    expect(notifyRecovery).not.toHaveBeenCalled();
  });

  function pendingApprovalRow(c: ReturnType<typeof client>, userId = U) {
    return { id: RID, userId, clientEphPub: c.pub, fingerprint: 'FP123456' };
  }

  it('G2/G8: hash dei codici nella stessa updateMany della transizione, ritorno solo {status}, codice A solo nel seal', async () => {
    const c = client();
    mp.vaultRequest.findFirst.mockResolvedValue(pendingApprovalRow(c));
    const result = await approveRecovery(ADMIN, RID);
    expect(result).toEqual({ status: 'PENDING_CODE' });
    expect(mp.vaultRequest.update).not.toHaveBeenCalled();
    const call = mp.vaultRequest.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: RID, status: 'PENDING_APPROVAL' });
    expect(call.data.status).toBe('PENDING_CODE');

    expect(notifyRecovery).toHaveBeenCalledTimes(1);
    const [uid, event, args] = vi.mocked(notifyRecovery).mock.calls[0] as any;
    expect(uid).toBe(U);
    expect(event).toBe('code');
    expect(args.requestId).toBe(RID);
    expect(args.codeB).toHaveLength(8);
    const codeA = openSealedCodeA(args.sealedCodeA, c.privateKey);
    expect(codeA).toHaveLength(8);
    expect(call.data.codeAHash).toBe(hash('A', codeA));
    expect(call.data.codeBHash).toBe(hash('B', args.codeB));
    expect(JSON.stringify(call.data)).not.toContain(codeA);
    expect(JSON.stringify(call.data)).not.toContain(args.codeB);
    expect(JSON.stringify(vi.mocked(logEvent).mock.calls)).not.toContain(codeA);
    expect(() => openSealedCodeA(args.sealedCodeA, client().privateKey)).toThrow();
  });

  it('approve: richiesta non in PENDING_APPROVAL o transizione persa -> 409, nessuna notify', async () => {
    await expect(approveRecovery(ADMIN, RID)).rejects.toMatchObject({ statusCode: 409 });
    mp.vaultRequest.findFirst.mockResolvedValue(pendingApprovalRow(client()));
    mp.vaultRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(approveRecovery(ADMIN, RID)).rejects.toMatchObject({ statusCode: 409 });
    expect(notifyRecovery).not.toHaveBeenCalled();
  });

  it('approve: un notify che lancia (sync o async) non fa fallire la transizione', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue(pendingApprovalRow(client()));
    vi.mocked(notifyRecovery).mockRejectedValueOnce(new Error('smtp down'));
    await expect(approveRecovery(ADMIN, RID)).resolves.toEqual({ status: 'PENDING_CODE' });
    vi.mocked(notifyRecovery).mockImplementationOnce(() => { throw new Error('sync boom'); });
    await expect(approveRecovery(ADMIN, RID)).resolves.toEqual({ status: 'PENDING_CODE' });
  });

  it('F3: un notify che non risolve mai non blocca approve, reject, confirm, cancel, release', async () => {
    vi.mocked(notifyRecovery).mockImplementation(() => new Promise(() => {}));
    mp.vaultRequest.findFirst.mockResolvedValue(pendingApprovalRow(client()));
    await expect(approveRecovery(ADMIN, RID)).resolves.toEqual({ status: 'PENDING_CODE' });
    mp.vaultRequest.findUnique.mockResolvedValue({ userId: U, attempts: 1, fingerprint: 'FP', codeAHash: hash('A', 'AAAAAAAA'), codeBHash: hash('B', 'BBBBBBBB') });
    await expect(rejectRecovery(ADMIN, RID, 'no')).resolves.toEqual({ status: 'REJECTED' });
    await expect(confirmRecovery(U, RID, 'AAAAAAAA', 'BBBBBBBB')).resolves.toMatchObject({ status: 'WAITING' });
    await expect(cancelRecovery(U, RID)).resolves.toEqual({ status: 'CANCELLED' });
    const clientPub = pub();
    mp.vaultRequest.findFirst.mockResolvedValue({ userId: U, clientEphPub: clientPub, fingerprint: fingerprintOf(clientPub), notBefore: new Date(Date.now() - 1000), user: { vaultKeyring: { epoch: 2, rootKeyId: 'rk_test', sealedRootShare: Buffer.alloc(157, 1) } } });
    (releaseRootShare as any).mockResolvedValue({ rootShareForClient: Buffer.alloc(157, 2), rootSignature: Buffer.alloc(64, 3) });
    await expect(releaseRecovery(ADMIN, RID, 'p')).resolves.toEqual({ status: 'RELEASED' });
    expect(notifyRecovery).toHaveBeenCalledTimes(5);
  });

  it('U3: approve della propria richiesta -> audit self:true e notifySuperadmins(selfAction)', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue(pendingApprovalRow(client(), ADMIN));
    await approveRecovery(ADMIN, RID);
    expect(logEvent).toHaveBeenCalledWith(ADMIN, 'vault.recovery.approved', { requestId: RID, self: true });
    expect(notifySuperadmins).toHaveBeenCalledWith('selfAction', { requestId: RID, actorId: ADMIN });
  });

  it('approve di una richiesta altrui: niente self', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue(pendingApprovalRow(client()));
    await approveRecovery(ADMIN, RID);
    expect(logEvent).toHaveBeenCalledWith(ADMIN, 'vault.recovery.approved', { requestId: RID });
    expect(notifySuperadmins).not.toHaveBeenCalled();
  });
});

describe('conferma e annullamento', () => {
  function pendingCodeRow(attempts: number) {
    return { attempts, fingerprint: 'FP123456', codeAHash: hash('A', 'AAAAAAAA'), codeBHash: hash('B', 'BBBBBBBB') };
  }

  it('codice corretto -> WAITING dopo 72 ore e hash rimossi; notify waiting con notBefore', async () => {
    mp.vaultRequest.findUnique.mockResolvedValue(pendingCodeRow(1));
    const result = await confirmRecovery(U, RID, 'AAAAAAAA', 'BBBBBBBB');
    expect(result.status).toBe('WAITING');
    expect(result.notBefore.getTime()).toBeGreaterThan(Date.now() + 71 * 60 * 60 * 1000);
    const data = mp.vaultRequest.updateMany.mock.calls[1][0].data;
    expect(data.codeAHash).toBeNull();
    expect(data.codeBHash).toBeNull();
    expect(notifyRecovery).toHaveBeenCalledWith(U, 'waiting', { requestId: RID, fingerprint: 'FP123456', notBefore: result.notBefore });
  });

  it('codice errato -> 403 e notify codeFailed', async () => {
    mp.vaultRequest.findUnique.mockResolvedValue(pendingCodeRow(2));
    await expect(confirmRecovery(U, RID, 'CCCCCCCC', 'BBBBBBBB')).rejects.toMatchObject({ statusCode: 403, message: 'errors.vault.recoveryInvalidCode' });
    expect(notifyRecovery).toHaveBeenCalledWith(U, 'codeFailed', { requestId: RID });
  });

  it('quinto errore -> EXPIRED con transizione condizionata a PENDING_CODE', async () => {
    mp.vaultRequest.findUnique.mockResolvedValue(pendingCodeRow(5));
    await expect(confirmRecovery(U, RID, 'CCCCCCCC', 'BBBBBBBB')).rejects.toMatchObject({ statusCode: 403 });
    expect(mp.vaultRequest.update).not.toHaveBeenCalled();
    expect(mp.vaultRequest.updateMany.mock.calls[1][0]).toEqual({ where: { id: RID, status: 'PENDING_CODE' }, data: { status: 'EXPIRED' } });
  });

  it('F8: al 5o errore con transizione a EXPIRED riuscita -> audit expired(attempts) e notify expired', async () => {
    mp.vaultRequest.findUnique.mockResolvedValue(pendingCodeRow(5));
    await expect(confirmRecovery(U, RID, 'CCCCCCCC', 'BBBBBBBB')).rejects.toMatchObject({ statusCode: 403 });
    expect(logEvent).toHaveBeenCalledWith(U, 'vault.recovery.expired', { requestId: RID, reason: 'attempts' });
    expect(notifyRecovery).toHaveBeenCalledWith(U, 'expired', { requestId: RID });
  });

  it('F8: al 4o errore nessun expired', async () => {
    mp.vaultRequest.findUnique.mockResolvedValue(pendingCodeRow(4));
    await expect(confirmRecovery(U, RID, 'CCCCCCCC', 'BBBBBBBB')).rejects.toMatchObject({ statusCode: 403 });
    expect(logEvent).not.toHaveBeenCalledWith(U, 'vault.recovery.expired', expect.anything());
    expect(notifyRecovery).not.toHaveBeenCalledWith(U, 'expired', expect.anything());
  });

  it('F7: confirm con updateMany a 0 rilegge la riga: assente -> 404', async () => {
    mp.vaultRequest.updateMany.mockResolvedValue({ count: 0 });
    mp.vaultRequest.findFirst.mockResolvedValue(null);
    await expect(confirmRecovery(U, RID, 'AAAAAAAA', 'BBBBBBBB')).rejects.toMatchObject({ statusCode: 404, message: 'errors.vault.recoveryNotFound' });
    expect(mp.vaultRequest.findFirst.mock.calls[0][0].where).toMatchObject({ id: RID, userId: U, type: 'RECOVERY' });
  });

  it.each([
    ['PENDING_CODE con tentativi esauriti', { status: 'PENDING_CODE', attempts: 5, expiresAt: new Date(Date.now() + 60_000) }],
    ['PENDING_CODE scaduta', { status: 'PENDING_CODE', attempts: 1, expiresAt: new Date(Date.now() - 1000) }],
    ['EXPIRED', { status: 'EXPIRED', attempts: 5, expiresAt: new Date(Date.now() - 1000) }],
  ])('F7: confirm su %s -> 410 recoveryExpired', async (_n, row) => {
    mp.vaultRequest.updateMany.mockResolvedValue({ count: 0 });
    mp.vaultRequest.findFirst.mockResolvedValue(row);
    await expect(confirmRecovery(U, RID, 'AAAAAAAA', 'BBBBBBBB')).rejects.toMatchObject({ statusCode: 410, message: 'errors.vault.recoveryExpired' });
  });

  it.each(['WAITING', 'RELEASED', 'CANCELLED', 'COMPLETED', 'PENDING_APPROVAL'])('F7: confirm su %s (retry) -> 409 recoveryStateConflict', async (status) => {
    mp.vaultRequest.updateMany.mockResolvedValue({ count: 0 });
    mp.vaultRequest.findFirst.mockResolvedValue({ status, attempts: 0, expiresAt: new Date(Date.now() + 60_000) });
    await expect(confirmRecovery(U, RID, 'AAAAAAAA', 'BBBBBBBB')).rejects.toMatchObject({ statusCode: 409, message: 'errors.vault.recoveryStateConflict' });
  });

  it('G3: al 5o errore con la richiesta gia\' WAITING (count 0) non si porta in EXPIRED e l\'errore resta 403', async () => {
    mp.vaultRequest.findUnique.mockResolvedValue(pendingCodeRow(5));
    mp.vaultRequest.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await expect(confirmRecovery(U, RID, 'CCCCCCCC', 'BBBBBBBB')).rejects.toMatchObject({ statusCode: 403 });
    expect(mp.vaultRequest.update).not.toHaveBeenCalled();
  });

  it('hash assenti (riga corrotta) -> 403, non RangeError', async () => {
    mp.vaultRequest.findUnique.mockResolvedValue({ attempts: 1, fingerprint: 'FP', codeAHash: null, codeBHash: null });
    await expect(confirmRecovery(U, RID, 'AAAAAAAA', 'BBBBBBBB')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('annullamento di una richiesta aperta; notify cancelled', async () => {
    const result = await cancelRecovery(U, RID);
    expect(result.status).toBe('CANCELLED');
    const data = mp.vaultRequest.updateMany.mock.calls[0][0].data;
    expect(data.rootShareForClient).toBeNull();
    expect(data.rootSignature).toBeNull();
    expect(notifyRecovery).toHaveBeenCalledWith(U, 'cancelled', { requestId: RID });
  });

  it('M1: cancel e condizionata al tempo (expiresAt, o releaseExpiresAt per RELEASED)', async () => {
    await cancelRecovery(U, RID);
    const where = mp.vaultRequest.updateMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: RID, userId: U, type: 'RECOVERY' });
    expect(where.OR).toEqual([
      { status: { in: ['PENDING_APPROVAL', 'PENDING_CODE', 'WAITING'] }, expiresAt: { gt: expect.any(Date) } },
      { status: 'RELEASED', releaseExpiresAt: { gt: expect.any(Date) } },
    ]);
  });

  it.each([
    ['WAITING scaduta per tempo', { status: 'WAITING', expiresAt: new Date(Date.now() - 1000), releaseExpiresAt: null }],
    ['RELEASED con releaseExpiresAt passato', { status: 'RELEASED', expiresAt: null, releaseExpiresAt: new Date(Date.now() - 1000) }],
    ['gia EXPIRED', { status: 'EXPIRED', expiresAt: null, releaseExpiresAt: null }],
  ])('M1: cancel su %s -> 410 recoveryExpired, niente CANCELLED ne notify', async (_n, current) => {
    mp.vaultRequest.updateMany.mockResolvedValue({ count: 0 });
    mp.vaultRequest.findFirst.mockResolvedValue(current);
    await expect(cancelRecovery(U, RID)).rejects.toMatchObject({ statusCode: 410, message: 'errors.vault.recoveryExpired' });
    expect(notifyRecovery).not.toHaveBeenCalled();
  });

  it('annullamento di una richiesta non aperta -> 409, nessuna notify', async () => {
    mp.vaultRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(cancelRecovery(U, RID)).rejects.toMatchObject({ statusCode: 409 });
    expect(notifyRecovery).not.toHaveBeenCalled();
  });
});

describe('rifiuto', () => {
  it('PENDING_APPROVAL -> REJECTED con motivo tagliato a 500; notify rejected', async () => {
    mp.vaultRequest.findUnique.mockResolvedValue({ userId: U });
    const result = await rejectRecovery(ADMIN, RID, 'x'.repeat(600));
    expect(result).toEqual({ status: 'REJECTED' });
    const call = mp.vaultRequest.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: RID, type: 'RECOVERY', status: 'PENDING_APPROVAL' });
    expect(call.data.status).toBe('REJECTED');
    expect(call.data.rejectReason).toHaveLength(500);
    expect(logEvent).toHaveBeenCalledWith(ADMIN, 'vault.recovery.rejected', { requestId: RID });
    expect(notifyRecovery).toHaveBeenCalledWith(U, 'rejected', { requestId: RID, reason: 'x'.repeat(500) });
  });

  it('altro stato -> 409, nessuna notify', async () => {
    mp.vaultRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(rejectRecovery(ADMIN, RID, 'no')).rejects.toMatchObject({ statusCode: 409, message: 'errors.vault.recoveryStateConflict' });
    expect(notifyRecovery).not.toHaveBeenCalled();
  });

  it('la where esclude una PENDING_APPROVAL scaduta (expiresAt > now), come approve', async () => {
    mp.vaultRequest.findUnique.mockResolvedValue({ userId: U });
    await rejectRecovery(ADMIN, RID, 'no');
    const where = mp.vaultRequest.updateMany.mock.calls[0][0].where;
    expect(where.expiresAt).toEqual({ gt: expect.any(Date) });
  });
});

describe('rilascio', () => {
  function waitingRow(userId = U) {
    const clientPub = pub();
    return {
      userId,
      clientEphPub: clientPub,
      fingerprint: fingerprintOf(clientPub),
      notBefore: new Date(Date.now() - 1000),
      user: { vaultKeyring: { epoch: 2, rootKeyId: 'rk_test', sealedRootShare: Buffer.alloc(157, 1) } },
    };
  }

  it('sigilla e salva solo dopo una transizione WAITING -> RELEASED riuscita; notify released', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue(waitingRow());
    (releaseRootShare as any).mockResolvedValue({ rootShareForClient: Buffer.alloc(157, 2), rootSignature: Buffer.alloc(64, 3) });
    const result = await releaseRecovery(ADMIN, RID, 'passphrase');
    expect(result.status).toBe('RELEASED');
    const data = mp.vaultRequest.updateMany.mock.calls[0][0].data;
    expect(data.rootShareForClient).toHaveLength(157);
    expect(data.rootSignature).toHaveLength(64);
    expect(notifyRecovery).toHaveBeenCalledWith(U, 'released', { requestId: RID });
    expect(notifySuperadmins).not.toHaveBeenCalled();
  });

  it('M4: release cerca e aggiorna solo richieste di tipo RECOVERY', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue(waitingRow());
    (releaseRootShare as any).mockResolvedValue({ rootShareForClient: Buffer.alloc(157, 2), rootSignature: Buffer.alloc(64, 3) });
    await releaseRecovery(ADMIN, RID, 'passphrase');
    expect(mp.vaultRequest.findFirst.mock.calls[0][0].where).toMatchObject({ id: RID, type: 'RECOVERY', status: 'WAITING' });
    expect(mp.vaultRequest.updateMany.mock.calls[0][0].where).toMatchObject({ id: RID, type: 'RECOVERY', status: 'WAITING' });
  });

  it('se WAITING non esiste piu\', nessuna scrittura del seal e nessuna notify', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue(waitingRow());
    mp.vaultRequest.updateMany.mockResolvedValue({ count: 0 });
    const released = { rootShareForClient: Buffer.alloc(157, 2), rootSignature: Buffer.alloc(64, 3) };
    (releaseRootShare as any).mockResolvedValue(released);
    await expect(releaseRecovery(ADMIN, RID, 'passphrase')).rejects.toMatchObject({ statusCode: 409 });
    expect(released.rootShareForClient.equals(Buffer.alloc(157, 0))).toBe(true);
    expect(released.rootSignature.equals(Buffer.alloc(64, 0))).toBe(true);
    expect(notifyRecovery).not.toHaveBeenCalled();
  });

  it('F5: fingerprint salvato diverso da quello ricalcolato -> 409 prima di aprire il file root, non contato', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue({ ...waitingRow(), fingerprint: 'ZZZZZZZZ' });
    await expect(releaseRecovery(ADMIN, RID, 'p')).rejects.toMatchObject({ statusCode: 409, message: 'errors.vault.recoveryFingerprintMismatch' });
    expect(releaseRootShare).not.toHaveBeenCalled();
    expect(mp.auditLog.create).not.toHaveBeenCalled();
    expect(notifySuperadmins).not.toHaveBeenCalled();
  });

  it('G6: passphrase errata -> release_failed + notifySuperadmins(releaseFailed)', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue(waitingRow());
    (releaseRootShare as any).mockRejectedValue(new AppError(403, 'errors.vault.invalidRootPassphrase'));
    await expect(releaseRecovery(ADMIN, RID, 'wrong')).rejects.toMatchObject({ statusCode: 403 });
    expect(mp.auditLog.create).toHaveBeenCalledTimes(1);
    expect(mp.auditLog.create.mock.calls[0][0].data).toMatchObject({ userId: ADMIN, event: 'vault.recovery.release_failed' });
    expect(notifySuperadmins).toHaveBeenCalledWith('releaseFailed', { requestId: RID, actorId: ADMIN });
  });

  it('G6/F1: 503 (file root assente), 400, 500 (firma non valida, seal corrotto) non contano come release_failed', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue(waitingRow());
    for (const err of [new AppError(503, 'errors.vault.rootKeyUnavailable'), new AppError(400, 'errors.vault.invalidRootKey'), new AppError(500, 'errors.vault.releaseSignatureInvalid'), new AppError(500, 'errors.vault.rootShareInvalid')]) {
      (releaseRootShare as any).mockRejectedValueOnce(err);
      await expect(releaseRecovery(ADMIN, RID, 'p')).rejects.toBe(err);
    }
    expect(mp.auditLog.create).not.toHaveBeenCalled();
    expect(notifySuperadmins).not.toHaveBeenCalled();
  });

  it('G6: un notifySuperadmins che lancia non cambia l\'errore restituito', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue(waitingRow());
    (releaseRootShare as any).mockRejectedValue(new AppError(403, 'errors.vault.invalidRootPassphrase'));
    vi.mocked(notifySuperadmins).mockImplementationOnce(() => { throw new Error('boom'); });
    await expect(releaseRecovery(ADMIN, RID, 'wrong')).rejects.toMatchObject({ statusCode: 403, message: 'errors.vault.invalidRootPassphrase' });
  });

  it('U3: release della propria richiesta -> audit self:true e notifySuperadmins(selfAction)', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue(waitingRow(ADMIN));
    (releaseRootShare as any).mockResolvedValue({ rootShareForClient: Buffer.alloc(157, 2), rootSignature: Buffer.alloc(64, 3) });
    await releaseRecovery(ADMIN, RID, 'p');
    expect(logEvent).toHaveBeenCalledWith(ADMIN, 'vault.recovery.released', { requestId: RID, self: true });
    expect(notifySuperadmins).toHaveBeenCalledWith('selfAction', { requestId: RID, actorId: ADMIN });
  });
});

describe('lettura per l\'utente', () => {
  const base = { id: RID, userId: U, type: 'RECOVERY', fingerprint: 'FP', notBefore: null, releaseExpiresAt: null, rootShareForClient: null, rootSignature: null };

  it('G7: oltre releaseExpiresAt, anche se ancora RELEASED, il seal non viene servito', async () => {
    const row = { ...base, status: 'RELEASED', rootShareForClient: Buffer.alloc(157, 2), rootSignature: Buffer.alloc(64, 3) };
    mp.vaultRequest.findFirst.mockResolvedValue({ ...row, releaseExpiresAt: new Date(Date.now() + 60_000) });
    const live = await getRecovery(U, RID);
    expect(live.rootShareForClient).toHaveLength(157);
    expect(live.rootSignature).toHaveLength(64);
    mp.vaultRequest.findFirst.mockResolvedValue({ ...row, releaseExpiresAt: new Date(Date.now() - 1000) });
    const stale = await getRecovery(U, RID);
    expect(stale.rootShareForClient).toBeNull();
    expect(stale.rootSignature).toBeNull();
  });

  it('G9: sealedCodeA solo in PENDING_CODE, letto dalla notifica code della richiesta (filtro JSON path)', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue({ ...base, status: 'PENDING_CODE' });
    mp.notification.findFirst.mockResolvedValue({ data: { event: 'code', requestId: RID, sealedCodeA: 'SEALED' } });
    expect((await getRecovery(U, RID)).sealedCodeA).toBe('SEALED');
    expect(mp.notification.findFirst.mock.calls[0][0]).toMatchObject({
      where: { userId: U, type: 'VAULT_RECOVERY', AND: [{ data: { path: ['requestId'], equals: RID } }, { data: { path: ['event'], equals: 'code' } }] },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('sealedCodeA null senza notifica o fuori da PENDING_CODE (nessuna query)', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue({ ...base, status: 'PENDING_CODE' });
    mp.notification.findFirst.mockResolvedValue(null);
    expect((await getRecovery(U, RID)).sealedCodeA).toBeNull();
    mp.notification.findFirst.mockClear();
    mp.vaultRequest.findFirst.mockResolvedValue({ ...base, status: 'WAITING' });
    expect((await getRecovery(U, RID)).sealedCodeA).toBeNull();
    expect(mp.notification.findFirst).not.toHaveBeenCalled();
  });

  it('richiesta altrui o inesistente -> 404', async () => {
    await expect(getRecovery(U, RID)).rejects.toMatchObject({ statusCode: 404, message: 'errors.vault.recoveryNotFound' });
    expect(mp.vaultRequest.findFirst.mock.calls[0][0].where).toMatchObject({ id: RID, userId: U, type: 'RECOVERY' });
  });

  it('getOpenRecovery: shape minima, null senza richiesta aperta', async () => {
    expect(await getOpenRecovery(U)).toBeNull();
    const createdAt = new Date();
    mp.vaultRequest.findFirst.mockResolvedValue({ id: RID, status: 'WAITING', fingerprint: 'FP', createdAt, notBefore: createdAt, clientEphPub: Buffer.alloc(97), codeAHash: 'x' });
    const open = await getOpenRecovery(U);
    expect(open).toEqual({ id: RID, status: 'WAITING', fingerprint: 'FP', createdAt, notBefore: createdAt });
    expect(mp.vaultRequest.findFirst.mock.calls[1][0].where).toMatchObject({ userId: U, type: 'RECOVERY', status: { in: ['PENDING_APPROVAL', 'PENDING_CODE', 'WAITING', 'RELEASED'] } });
  });
});

describe('lettura admin (nessun segreto)', () => {
  const FORBIDDEN = ['codeAHash', 'codeBHash', 'clientEphPub', 'rootShareForClient', 'rootSignature', 'codeHash', 'completedPayloadHash'];
  const LIST_KEYS = ['approvedAt', 'approvedById', 'cancelledAt', 'completedAt', 'createdAt', 'expiresAt', 'fingerprint', 'id', 'keyringStatus', 'notBefore', 'readyForRelease', 'reason', 'rejectReason', 'releaseExpiresAt', 'releasedAt', 'releasedById', 'requestIp', 'requestUserAgent', 'rootKeyId', 'status', 'userEmail', 'userId'];
  const secretRow = (over: Record<string, unknown> = {}) => ({
    id: RID, userId: U, type: 'RECOVERY', status: 'WAITING', fingerprint: 'FP', reason: 'forgot', requestIp: '192.0.2.1', requestUserAgent: 'ua',
    createdAt: new Date(), expiresAt: new Date(Date.now() + 7 * 24 * 3600_000), notBefore: new Date(Date.now() - 1000), approvedById: ADMIN, approvedAt: new Date(), rejectReason: null,
    releasedById: null, releasedAt: null, releaseExpiresAt: null, completedAt: null, cancelledAt: null, cancelledBy: null, attempts: 1,
    codeHash: 'h0', codeAHash: 'h1', codeBHash: 'h2', clientEphPub: Buffer.alloc(97), rootShareForClient: Buffer.alloc(157), rootSignature: Buffer.alloc(64), completedPayloadHash: 'h3',
    user: { email: 'a@example.com', vaultKeyring: { status: 'READY', rootKeyId: 'rk_test' } },
    ...over,
  });

  it('lista: shape della §3 del piano, mai i campi segreti; paginazione e filtri', async () => {
    mp.vaultRequest.findMany.mockResolvedValue([secretRow()]);
    mp.vaultRequest.count.mockResolvedValue(41);
    const res = await listRecoveriesForAdmin({ page: 3, limit: 10, status: 'WAITING', userId: U });
    expect(res).toMatchObject({ total: 41, page: 3, limit: 10 });
    const item = res.items[0] as Record<string, unknown>;
    expect(Object.keys(item).sort()).toEqual(LIST_KEYS);
    for (const k of FORBIDDEN) expect(item).not.toHaveProperty(k);
    expect(JSON.stringify(res)).not.toContain('h1');
    expect(item.readyForRelease).toBe(true);
    expect(item.userEmail).toBe('a@example.com');
    expect(item.keyringStatus).toBe('READY');
    expect(item.rootKeyId).toBe('rk_test');
    const q = mp.vaultRequest.findMany.mock.calls[0][0];
    expect(q.where).toEqual({ type: 'RECOVERY', status: 'WAITING', userId: U });
    expect(q.skip).toBe(20);
    expect(q.take).toBe(10);
    expect(q.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('M2: WAITING oltre la scadenza (notBefore + 7 giorni) e EXPIRED e non pronta; RELEASED scaduta idem', async () => {
    const past = new Date(Date.now() - 1000);
    mp.vaultRequest.findMany.mockResolvedValue([secretRow({ expiresAt: past }), secretRow({ status: 'RELEASED', expiresAt: null, releaseExpiresAt: past })]);
    mp.vaultRequest.count.mockResolvedValue(2);
    const { items } = await listRecoveriesForAdmin({ page: 1, limit: 50 });
    expect(items.map((i: any) => [i.status, i.readyForRelease])).toEqual([['EXPIRED', false], ['EXPIRED', false]]);
    mp.vaultRequest.findFirst.mockResolvedValue(secretRow({ expiresAt: past }));
    mp.auditLog.findMany.mockResolvedValue([]);
    expect(await getRecoveryForAdmin(RID)).toMatchObject({ status: 'EXPIRED', readyForRelease: false });
  });

  it('readyForRelease false se notBefore nel futuro o stato diverso da WAITING', async () => {
    mp.vaultRequest.findMany.mockResolvedValue([secretRow({ notBefore: new Date(Date.now() + 60_000) }), secretRow({ status: 'RELEASED' }), secretRow({ user: { email: 'b@example.com', vaultKeyring: null } })]);
    mp.vaultRequest.count.mockResolvedValue(3);
    const { items } = await listRecoveriesForAdmin({ page: 1, limit: 50 });
    expect(items.map((i: any) => i.readyForRelease)).toEqual([false, false, true]);
    expect((items[2] as any).keyringStatus).toBeNull();
    expect(mp.vaultRequest.findMany.mock.calls[0][0].where).toEqual({ type: 'RECOVERY' });
  });

  it('dettaglio: stessi campi + audit per requestId (filtro JSON path), senza segreti', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue(secretRow());
    const audit = [{ event: 'vault.recovery.requested', userId: U, createdAt: new Date(), details: { requestId: RID } }];
    mp.auditLog.findMany.mockResolvedValue(audit);
    const res = await getRecoveryForAdmin(RID) as Record<string, unknown>;
    expect(Object.keys(res).sort()).toEqual([...LIST_KEYS, 'audit'].sort());
    for (const k of FORBIDDEN) expect(res).not.toHaveProperty(k);
    expect(res.audit).toEqual(audit);
    expect(mp.auditLog.findMany.mock.calls[0][0]).toMatchObject({ where: { details: { path: ['requestId'], equals: RID } }, orderBy: { createdAt: 'asc' } });
    expect(Object.keys(mp.auditLog.findMany.mock.calls[0][0].select).sort()).toEqual(['createdAt', 'details', 'event', 'userId']);
  });

  it('dettaglio di id inesistente -> 404', async () => {
    await expect(getRecoveryForAdmin(RID)).rejects.toMatchObject({ statusCode: 404, message: 'errors.vault.recoveryNotFound' });
  });
});

describe('completamento', () => {
  const proofOf = (pair: crypto.KeyPairKeyObjectResult, payload: string) => {
    const msg = `notiq/vault/v3/proof|POST /api/vault/recovery/${RID}/complete|${U}|2|3|${crypto.createHash('sha256').update(payload).digest('hex')}`;
    return crypto.sign('sha256', Buffer.from(msg), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' });
  };
  const wrap = () => ({ kdf: 'argon2id', kdfParams: { m: 65536, t: 10, p: 1 }, pinSalt: Buffer.alloc(16).toString('base64url'), wrappedVkPin: Buffer.alloc(60).toString('base64url'), authKey: Buffer.alloc(32).toString('base64url') });
  const escrow = () => ({ escrowBlob: Buffer.alloc(60).toString('base64url'), sealedRootShare: Buffer.alloc(157).toString('base64url'), rootKeyId: 'rk_68a265761e7e37c7', userShareUnderVk: Buffer.alloc(48).toString('base64url') });
  const setup = () => {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const keyring = { userId: U, status: 'READY', epoch: 2, pepperKeyId: pepperStatus().keyId, vkSigPub: pair.publicKey.export({ type: 'spki', format: 'der' }) };
    mp.vaultRequest.findFirst.mockResolvedValue({ status: 'RELEASED', releaseExpiresAt: new Date(Date.now() + 10000), user: { vaultKeyring: keyring } });
    return pair;
  };

  it('complete valido aggiorna keyring e richiesta nella stessa transazione; U4 azzera il lockout; replay idempotente senza nuova notify', async () => {
    const pair = setup();
    const payload = JSON.stringify({ rev: 3, wrap: wrap(), escrow: escrow() });
    const proof = proofOf(pair, payload);
    const first = await completeRecovery(U, RID, payload, proof);
    expect(first).toEqual({ status: 'COMPLETED', idempotent: false });
    expect(mp.$transaction).toHaveBeenCalledTimes(1);
    expect(mp.vaultKeyring.updateMany).toHaveBeenCalledTimes(1);
    const keyringData = mp.vaultKeyring.updateMany.mock.calls[0][0].data;
    expect(keyringData.failedAttempts).toBe(0);
    expect(keyringData.lockedUntil).toBeNull();
    expect(notifyRecovery).toHaveBeenCalledTimes(1);
    expect(notifyRecovery).toHaveBeenCalledWith(U, 'completed', { requestId: RID });

    mp.vaultRequest.findFirst.mockResolvedValue({ status: 'COMPLETED', completedPayloadHash: crypto.createHash('sha256').update(payload).digest('hex') });
    const replay = await completeRecovery(U, RID, payload, proof);
    expect(replay).toEqual({ status: 'COMPLETED', idempotent: true });
    expect(notifyRecovery).toHaveBeenCalledTimes(1);
  });

  it('G5: payload solo-wrap o solo-escrow o vuoto -> 400, nessuna transazione', async () => {
    const pair = setup();
    for (const body of [{ rev: 3, wrap: wrap() }, { rev: 3, escrow: escrow() }, { rev: 3 }]) {
      const payload = JSON.stringify(body);
      await expect(completeRecovery(U, RID, payload, proofOf(pair, payload))).rejects.toMatchObject({ statusCode: 400, message: 'errors.vault.invalidPayload' });
    }
    expect(mp.$transaction).not.toHaveBeenCalled();
    expect(notifyRecovery).not.toHaveBeenCalled();
  });
});

describe('scadenze (T7)', () => {
  const NOW = new Date('2030-01-01T00:00:00Z');
  const past = new Date('2029-12-31T00:00:00Z');
  const row = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, userId: `u-${id}`, status, expiresAt: past, releaseExpiresAt: null, ...extra });

  /** Store finto: findMany serve le righe non ancora EXPIRED, updateMany applica la transizione solo se id e stato coincidono. */
  function fakeStore(rows: ReturnType<typeof row>[]) {
    mp.vaultRequest.findMany.mockImplementation(async () => rows.filter((r) => r.status !== 'EXPIRED').map((r) => ({ ...r })));
    mp.vaultRequest.updateMany.mockImplementation(async ({ where, data }: any) => {
      const r = rows.find((x) => x.id === where.id && x.status === where.status);
      if (!r) return { count: 0 };
      Object.assign(r, data);
      return { count: 1 };
    });
    return rows;
  }
  const expiredNotifies = () => vi.mocked(notifyRecovery).mock.calls.filter((c) => c[1] === 'expired');

  it('findMany cerca i candidati in ogni stato con scadenza', async () => {
    mp.vaultRequest.findMany.mockResolvedValue([]);
    expect(await expireRecoveryRequests(NOW)).toBe(0);
    expect(mp.vaultRequest.findMany.mock.calls[0][0].where).toEqual({
      type: 'RECOVERY',
      OR: [
        { status: { in: ['PENDING_APPROVAL', 'PENDING_CODE', 'WAITING'] }, expiresAt: { lte: NOW } },
        { status: 'RELEASED', releaseExpiresAt: { lte: NOW } },
      ],
    });
  });

  it('due run consecutive -> una sola audit/notify expired per richiesta; il motivo segue lo stato', async () => {
    fakeStore([row('a', 'PENDING_APPROVAL'), row('b', 'PENDING_CODE'), row('c', 'WAITING'), row('d', 'RELEASED', { releaseExpiresAt: past })]);
    expect(await expireRecoveryRequests(NOW)).toBe(4);
    expect(await expireRecoveryRequests(NOW)).toBe(0);
    await Promise.resolve();
    expect(expiredNotifies()).toHaveLength(4);
    expect(vi.mocked(logEvent).mock.calls.filter((c) => c[1] === 'vault.recovery.expired')).toEqual([
      ['u-a', 'vault.recovery.expired', { requestId: 'a', reason: 'approval' }],
      ['u-b', 'vault.recovery.expired', { requestId: 'b', reason: 'code' }],
      ['u-c', 'vault.recovery.expired', { requestId: 'c', reason: 'waiting' }],
      ['u-d', 'vault.recovery.expired', { requestId: 'd', reason: 'release' }],
    ]);
    expect(notifyRecovery).toHaveBeenCalledWith('u-a', 'expired', { requestId: 'a' });
  });

  it('la transizione e\' condizionata per riga (stato e scadenza letti); WAITING oltre notBefore+7g scade', async () => {
    const waitingExpiry = new Date('2029-12-30T00:00:00Z'); // notBefore (27/12) + 7 giorni, gia' passato
    fakeStore([row('w', 'WAITING', { expiresAt: waitingExpiry })]);
    expect(await expireRecoveryRequests(NOW)).toBe(1);
    expect(mp.vaultRequest.updateMany).toHaveBeenCalledWith({ where: { id: 'w', type: 'RECOVERY', status: 'WAITING', expiresAt: waitingExpiry }, data: { status: 'EXPIRED' } });
  });

  it('un RELEASED scaduto ha il seal azzerato, condizionato a status e releaseExpiresAt', async () => {
    fakeStore([row('r', 'RELEASED', { expiresAt: null, releaseExpiresAt: past })]);
    expect(await expireRecoveryRequests(NOW)).toBe(1);
    expect(mp.vaultRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'r', type: 'RECOVERY', status: 'RELEASED', releaseExpiresAt: past },
      data: { status: 'EXPIRED', rootShareForClient: null, rootSignature: null },
    });
  });

  it('job: se la riga 2 lancia, le righe 1 e 3 sono annunciate e si rilancia il primo errore', async () => {
    mp.vaultRequest.findMany.mockResolvedValue([row('a', 'PENDING_APPROVAL'), row('b', 'PENDING_CODE'), row('c', 'WAITING')]);
    const boom = new Error('db down');
    mp.vaultRequest.updateMany.mockImplementation(async ({ where }: any) => {
      if (where.id === 'b') throw boom;
      return { count: 1 };
    });
    await expect(expireRecoveryRequests(NOW)).rejects.toBe(boom);
    expect(vi.mocked(logEvent).mock.calls.filter((c) => c[1] === 'vault.recovery.expired').map((c) => (c[2] as any).requestId)).toEqual(['a', 'c']);
    expect(expiredNotifies().map((c) => (c[2] as any).requestId)).toEqual(['a', 'c']);
  });

  it('corsa persa (updateMany conta 0): nessun conteggio, audit o notify', async () => {
    mp.vaultRequest.findMany.mockResolvedValue([row('x', 'PENDING_CODE')]);
    mp.vaultRequest.updateMany.mockResolvedValue({ count: 0 });
    expect(await expireRecoveryRequests(NOW)).toBe(0);
    await Promise.resolve();
    expect(logEvent).not.toHaveBeenCalled();
    expect(notifyRecovery).not.toHaveBeenCalled();
  });

  describe('promemoria 24 h prima di notBefore', () => {
    const soon = new Date(NOW.getTime() + 5 * 60 * 60 * 1000);

    it('cerca WAITING con notBefore in (now, now+24h] e scrive il marker prima di notificare', async () => {
      mp.vaultRequest.findMany.mockResolvedValue([{ id: 'p', userId: 'u-p', fingerprint: 'FP1', notBefore: soon }]);
      mp.auditLog.count.mockResolvedValue(0);
      expect(await sendRecoveryReminders(NOW)).toBe(1);
      expect(mp.vaultRequest.findMany.mock.calls[0][0].where).toEqual({
        type: 'RECOVERY', status: 'WAITING', notBefore: { gt: NOW, lte: new Date(NOW.getTime() + 24 * 60 * 60 * 1000) },
      });
      expect(mp.auditLog.count).toHaveBeenCalledWith({ where: { event: 'vault.recovery.reminder_sent', details: { path: ['requestId'], equals: 'p' } } });
      expect(mp.auditLog.create).toHaveBeenCalledWith({ data: { userId: 'u-p', event: 'vault.recovery.reminder_sent', details: { requestId: 'p' } } });
      expect(notifyRecovery).toHaveBeenCalledWith('u-p', 'reminder', { requestId: 'p', fingerprint: 'FP1', notBefore: soon });
    });

    it('M3: lock advisory try (per requestId) come prima istruzione della transazione; notify solo dopo il commit', async () => {
      const order: string[] = [];
      mp.vaultRequest.findMany.mockResolvedValue([{ id: 'p', userId: 'u-p', fingerprint: 'FP1', notBefore: soon }]);
      mp.$transaction.mockImplementation(async (fn: any) => { const r = await fn(mp); order.push('commit'); return r; });
      mp.$queryRaw.mockImplementation(async (...args: any[]) => { order.push('lock'); expect(args[0].join('?')).toContain('pg_try_advisory_xact_lock'); expect(args.slice(1)).toEqual(['vault-recovery-reminder:p']); return [{ locked: true }]; });
      mp.auditLog.count.mockImplementation(async () => { order.push('count'); return 0; });
      mp.auditLog.create.mockImplementation(async () => { order.push('marker'); return {}; });
      vi.mocked(notifyRecovery).mockImplementation(async () => { order.push('notify'); });
      expect(await sendRecoveryReminders(NOW)).toBe(1);
      await Promise.resolve();
      expect(order).toEqual(['lock', 'count', 'marker', 'commit', 'notify']);
    });

    it('M3: lock non preso (altro worker) -> ne marker ne notify', async () => {
      mp.vaultRequest.findMany.mockResolvedValue([{ id: 'p', userId: 'u-p', fingerprint: 'FP1', notBefore: soon }]);
      mp.$queryRaw.mockResolvedValue([{ locked: false }]);
      expect(await sendRecoveryReminders(NOW)).toBe(0);
      await Promise.resolve();
      expect(mp.auditLog.count).not.toHaveBeenCalled();
      expect(mp.auditLog.create).not.toHaveBeenCalled();
      expect(notifyRecovery).not.toHaveBeenCalled();
    });

    it('M3: scrittura del marker fallita -> errore rilanciato e nessuna notify', async () => {
      mp.vaultRequest.findMany.mockResolvedValue([{ id: 'p', userId: 'u-p', fingerprint: 'FP1', notBefore: soon }]);
      mp.auditLog.create.mockRejectedValue(new Error('db down'));
      await expect(sendRecoveryReminders(NOW)).rejects.toThrow('db down');
      await Promise.resolve();
      expect(notifyRecovery).not.toHaveBeenCalled();
    });

    it('con il marker gia\' scritto non rimanda: due run -> un solo reminder', async () => {
      mp.vaultRequest.findMany.mockResolvedValue([{ id: 'p', userId: 'u-p', fingerprint: 'FP1', notBefore: soon }]);
      let sent = 0;
      mp.auditLog.count.mockImplementation(async () => sent);
      mp.auditLog.create.mockImplementation(async () => { sent += 1; return {}; });
      expect(await sendRecoveryReminders(NOW)).toBe(1);
      expect(await sendRecoveryReminders(NOW)).toBe(0);
      await Promise.resolve();
      expect(vi.mocked(notifyRecovery).mock.calls.filter((c) => c[1] === 'reminder')).toHaveLength(1);
    });
  });

  describe('runRecoveryJobs', () => {
    it('esegue entrambe in sequenza e ritorna i conteggi', async () => {
      mp.vaultRequest.findMany.mockResolvedValue([]);
      expect(await runRecoveryJobs()).toEqual({ expired: 0, reminded: 0 });
      expect(mp.vaultRequest.findMany).toHaveBeenCalledTimes(2);
    });

    it('un errore della prima non blocca la seconda; l\'errore viene rilanciato', async () => {
      mp.vaultRequest.findMany.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce([{ id: 'p', userId: 'u-p', fingerprint: 'FP1', notBefore: new Date(Date.now() + 3600_000) }]);
      mp.auditLog.count.mockResolvedValue(0);
      await expect(runRecoveryJobs()).rejects.toThrow('db down');
      expect(notifyRecovery).toHaveBeenCalledWith('u-p', 'reminder', expect.anything());
    });
  });
});

describe('scadenza di WAITING e lettura (B2)', () => {
  const future = () => new Date(Date.now() + 3600_000);
  const past = () => new Date(Date.now() - 1000);

  it('confirm riuscito: expiresAt = notBefore + 7 giorni', async () => {
    mp.vaultRequest.findUnique.mockResolvedValue({ attempts: 1, fingerprint: 'FP', codeAHash: hash('A', 'AAAAAAAA'), codeBHash: hash('B', 'BBBBBBBB') });
    const { notBefore } = await confirmRecovery(U, RID, 'AAAAAAAA', 'BBBBBBBB');
    const data = mp.vaultRequest.updateMany.mock.calls[1][0].data;
    expect(data.expiresAt).toEqual(new Date(notBefore.getTime() + 7 * 24 * 60 * 60 * 1000));
  });

  it('getOpenRecovery esclude a lettura le scadute non ancora marcate dal job', async () => {
    await getOpenRecovery(U);
    const where = mp.vaultRequest.findFirst.mock.calls[0][0].where;
    expect(where.AND).toEqual([{
      OR: [
        { status: { in: ['PENDING_APPROVAL', 'PENDING_CODE', 'WAITING'] }, expiresAt: { gt: expect.any(Date) } },
        { status: 'RELEASED', releaseExpiresAt: { gt: expect.any(Date) } },
      ],
    }]);
  });

  it('getRecovery presenta come EXPIRED (senza seal ne\' sealedCodeA) le scadute per tempo', async () => {
    const seal = { rootShareForClient: Buffer.alloc(157, 2), rootSignature: Buffer.alloc(64, 3) };
    const base = { id: RID, userId: U, type: 'RECOVERY', fingerprint: 'FP', notBefore: null, releaseExpiresAt: null, expiresAt: null, rootShareForClient: null, rootSignature: null };
    for (const stale of [
      { status: 'PENDING_APPROVAL', expiresAt: past() },
      { status: 'PENDING_CODE', expiresAt: past() },
      { status: 'WAITING', expiresAt: past(), notBefore: past() },
      { status: 'RELEASED', releaseExpiresAt: past(), ...seal },
    ]) {
      mp.notification.findFirst.mockClear();
      mp.vaultRequest.findFirst.mockResolvedValue({ ...base, ...stale });
      const r = await getRecovery(U, RID);
      expect(r.status).toBe('EXPIRED');
      expect(r.sealedCodeA).toBeNull();
      expect(r.rootShareForClient).toBeNull();
      expect(r.rootSignature).toBeNull();
      expect(mp.notification.findFirst).not.toHaveBeenCalled();
    }
    mp.vaultRequest.findFirst.mockResolvedValue({ ...base, status: 'WAITING', expiresAt: future(), notBefore: future() });
    expect((await getRecovery(U, RID)).status).toBe('WAITING');
  });

  it('release: una WAITING scaduta per tempo non si rilascia (findFirst e updateMany con expiresAt > now)', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue(null);
    await expect(releaseRecovery(ADMIN, RID, 'p')).rejects.toMatchObject({ statusCode: 409 });
    expect(mp.vaultRequest.findFirst.mock.calls[0][0].where).toMatchObject({ status: 'WAITING', expiresAt: { gt: expect.any(Date) } });
  });
});
