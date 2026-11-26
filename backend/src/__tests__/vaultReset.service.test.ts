import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';

vi.mock('bcrypt', () => ({ default: { hash: vi.fn(), compare: vi.fn() } }));
vi.mock('../services/audit.service', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/vaultRecoveryNotify', () => ({
  notifyRecovery: vi.fn().mockResolvedValue(undefined),
  notifySuperadmins: vi.fn().mockResolvedValue(undefined),
  notifyReset: vi.fn().mockResolvedValue(undefined),
  notifySuperadminsReset: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/attachment.service', () => ({ getAttachmentPath: (u: string) => `/uploads/${u}` }));

import bcrypt from 'bcrypt';
import prisma from '../plugins/prisma';
import logger from '../utils/logger';
import { logEvent } from '../services/audit.service';
import { notifyReset, notifySuperadminsReset } from '../services/vaultRecoveryNotify';
import { parseEnvelope, assertVaultContent, verifierKey } from '../services/vault.service';
import { cancelReset, cancelResetByAdmin, confirmReset, createResetChallenge, runResetJobs } from '../services/vaultReset.service';

const mp = prisma as any;
const U = 'user-1';
const ADMIN = 'admin-1';
const RID = 'reset-1';
const CODE = 'ABCD2345EFGH';
const DAY_MS = 24 * 60 * 60 * 1000;
const ORIGINAL_PEPPER = process.env.VAULT_PEPPER_KEY;

beforeAll(() => { process.env.VAULT_PEPPER_KEY = crypto.randomBytes(32).toString('base64url'); });
afterAll(() => {
  if (ORIGINAL_PEPPER === undefined) delete process.env.VAULT_PEPPER_KEY;
  else process.env.VAULT_PEPPER_KEY = ORIGINAL_PEPPER;
});

const hashR = (id: string, code: string) => crypto.createHmac('sha256', verifierKey()).update(`recovery|${id}|R|${code}`).digest('hex');
const flush = () => new Promise((r) => setImmediate(r));

function row(over: Record<string, unknown> = {}) {
  return { id: RID, userId: U, type: 'RESET', status: 'PENDING_CODE', attempts: 1, expiresAt: new Date(Date.now() + 5 * 60 * 1000), codeHash: hashR(RID, CODE), ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mp.$executeRaw = vi.fn().mockResolvedValue(1);
  mp.$transaction = vi.fn(async (fn: any) => fn(mp));
  mp.auditLog.create = vi.fn().mockResolvedValue({});
  mp.vaultKeyring.findUnique.mockReset().mockResolvedValue({ status: 'READY', epoch: 3 });
  mp.vaultKeyring.findMany = vi.fn().mockResolvedValue([]);
  mp.vaultKeyring.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mp.vaultRequest.create.mockReset().mockImplementation(async ({ data }: any) => data);
  mp.vaultRequest.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mp.vaultRequest.findFirst.mockReset().mockResolvedValue(null);
  mp.vaultRequest.findUnique.mockReset().mockResolvedValue(null);
  mp.note.count.mockReset().mockResolvedValue(3);
  mp.note.deleteMany = vi.fn().mockResolvedValue({ count: 3 });
  mp.tag.count = vi.fn().mockResolvedValue(2);
  mp.tag.deleteMany = vi.fn().mockResolvedValue({ count: 2 });
  mp.attachment.count = vi.fn().mockResolvedValue(1);
  mp.attachment.findMany.mockReset().mockResolvedValue([]);
  mp.user.findUnique.mockReset().mockResolvedValue({ password: 'hash' });
  vi.mocked(bcrypt.compare as any).mockResolvedValue(true);
  vi.mocked(logEvent).mockResolvedValue(undefined);
  vi.mocked(notifyReset).mockResolvedValue(undefined);
  vi.mocked(notifySuperadminsReset).mockResolvedValue(undefined);
  vi.spyOn(fs.promises, 'unlink').mockResolvedValue(undefined);
});

describe('createResetChallenge', () => {
  it('READY: richiesta RESET PENDING_CODE con solo l HMAC del codice, scadenza 10 minuti, conteggi esatti', async () => {
    const r = await createResetChallenge(U);
    expect(r.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(r.counts).toEqual({ notes: 3, tags: 2, attachments: 1 });
    const data = mp.vaultRequest.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ id: r.requestId, userId: U, type: 'RESET', status: 'PENDING_CODE', attempts: 0 });
    expect(data.codeHash).toBe(hashR(r.requestId, r.code));
    const ttl = new Date(r.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(data.expiresAt.toISOString()).toBe(r.expiresAt);
    // il codice in chiaro non arriva mai a Prisma, all'audit ne' alle notifiche
    for (const sink of [mp.vaultRequest.create, mp.vaultRequest.updateMany, logEvent, notifyReset, notifySuperadminsReset]) {
      expect(JSON.stringify((sink as any).mock.calls)).not.toContain(r.code);
    }
    expect(logEvent).toHaveBeenCalledWith(U, 'vault.reset.challenge', { requestId: r.requestId });
  });

  it('conteggi: note vault (cestino compreso), tag vault, allegati delle note vault', async () => {
    await createResetChallenge(U);
    expect(mp.note.count).toHaveBeenCalledWith({ where: { userId: U, isVault: true } });
    expect(mp.tag.count).toHaveBeenCalledWith({ where: { userId: U, isVault: true } });
    expect(mp.attachment.count).toHaveBeenCalledWith({ where: { note: { userId: U, isVault: true } } });
  });

  it.each([[null], [{ status: 'NONE', epoch: 0 }], [{ status: 'RESET_PENDING', epoch: 3 }]])('keyring %j: 409 notReady, nessuna richiesta', async (keyring) => {
    mp.vaultKeyring.findUnique.mockResolvedValue(keyring);
    await expect(createResetChallenge(U)).rejects.toMatchObject({ statusCode: 409, message: 'errors.vault.notReady' });
    expect(mp.vaultRequest.create).not.toHaveBeenCalled();
  });

  it('una challenge nuova fa scadere la PENDING_CODE precedente, dentro il lock per utente e prima della create', async () => {
    const order: string[] = [];
    mp.$executeRaw.mockImplementation(async (...a: any[]) => { order.push(`lock:${a[1]}`); return 1; });
    mp.vaultRequest.updateMany.mockImplementation(async () => { order.push('expire'); return { count: 1 }; });
    mp.vaultRequest.create.mockImplementation(async ({ data }: any) => { order.push('create'); return data; });
    await createResetChallenge(U);
    expect(order).toEqual([`lock:vault-reset:${U}`, 'expire', 'create']);
    expect(mp.vaultRequest.updateMany).toHaveBeenCalledWith({ where: { userId: U, type: 'RESET', status: 'PENDING_CODE' }, data: { status: 'EXPIRED' } });
  });
});

describe('confirmReset', () => {
  function stateful(initial: Record<string, unknown> = {}) {
    // simula la CAS condizionata sulla richiesta: l'incremento dei tentativi vale solo se PENDING_CODE, < 5 e non scaduta
    const state = row(initial) as any;
    mp.vaultRequest.findFirst.mockImplementation(async () => ({ ...state }));
    mp.vaultRequest.findUnique.mockImplementation(async () => ({ ...state }));
    mp.vaultRequest.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (data.attempts) {
        if (state.status !== 'PENDING_CODE' || state.attempts >= 5 || state.expiresAt <= new Date()) return { count: 0 };
        state.attempts += 1;
        return { count: 1 };
      }
      if (data.status === 'EXPIRED' && state.status === 'PENDING_CODE') { state.status = 'EXPIRED'; return { count: 1 }; }
      if (data.status === 'WAITING' && state.status === 'PENDING_CODE') { state.status = 'WAITING'; return { count: 1 }; }
      if (where.type === 'RECOVERY') return { count: 0 };
      return { count: 0 };
    });
    return state;
  }

  it('codice e password validi: RESET_PENDING a +7 giorni, richiesta WAITING, recuperi aperti CANCELLED senza materiale di rilascio', async () => {
    stateful();
    const before = Date.now();
    const r = await confirmReset(U, RID, CODE, 'pw');
    const scheduled = new Date(r.scheduledAt).getTime();
    expect(scheduled).toBeGreaterThanOrEqual(before + 7 * DAY_MS);
    expect(scheduled).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS);
    expect(mp.$executeRaw.mock.calls[0].slice(1)).toEqual([`vault-reset:${U}`]);
    expect(mp.vaultKeyring.updateMany).toHaveBeenCalledWith({
      where: { userId: U, status: 'READY' },
      data: { status: 'RESET_PENDING', resetScheduledAt: new Date(scheduled) },
    });
    const calls = mp.vaultRequest.updateMany.mock.calls.map((c: any) => c[0]);
    const waiting = calls.find((c: any) => c.data.status === 'WAITING');
    expect(waiting.where).toEqual({ id: RID, userId: U, type: 'RESET', status: 'PENDING_CODE' });
    expect(waiting.data).toMatchObject({ status: 'WAITING', notBefore: new Date(scheduled), expiresAt: null, codeHash: null });
    const rec = calls.find((c: any) => c.where.type === 'RECOVERY');
    expect(rec.where).toMatchObject({ userId: U, type: 'RECOVERY', status: { in: ['PENDING_APPROVAL', 'PENDING_CODE', 'WAITING', 'RELEASED'] } });
    expect(rec.data).toMatchObject({ status: 'CANCELLED', cancelledBy: U, rootShareForClient: null, rootSignature: null });
    expect(bcrypt.compare).toHaveBeenCalledWith('pw', 'hash');
  });

  it('dopo il commit: audit scheduled con soli conteggi, notifica all utente e agli admin (attore escluso dal notify)', async () => {
    stateful();
    const r = await confirmReset(U, RID, CODE, 'pw');
    await flush();
    expect(logEvent).toHaveBeenCalledWith(U, 'vault.reset.scheduled', { requestId: RID, scheduledAt: r.scheduledAt, counts: { notes: 3, tags: 2, attachments: 1 } });
    expect(notifyReset).toHaveBeenCalledWith(U, 'scheduled', { requestId: RID, scheduledAt: new Date(r.scheduledAt) });
    expect(notifySuperadminsReset).toHaveBeenCalledWith('scheduled', { requestId: RID, ownerId: U, actorId: U });
    expect(JSON.stringify([vi.mocked(logEvent).mock.calls, vi.mocked(notifyReset).mock.calls])).not.toContain(CODE);
  });

  it('maiuscole e trattini sono indifferenti', async () => {
    stateful();
    await expect(confirmReset(U, RID, 'abcd-2345-efgh', 'pw')).resolves.toHaveProperty('scheduledAt');
  });

  it('codice sbagliato: 403 resetInvalidCode, tentativo contato, stato invariato, niente controllo password', async () => {
    const st = stateful();
    await expect(confirmReset(U, RID, 'ZZZZ2345EFGH', 'pw')).rejects.toMatchObject({ statusCode: 403, message: 'errors.vault.resetInvalidCode' });
    expect(st.attempts).toBe(2);
    expect(st.status).toBe('PENDING_CODE');
    expect(mp.vaultKeyring.updateMany).not.toHaveBeenCalled();
    expect(bcrypt.compare).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(U, 'vault.reset.code_failed', { requestId: RID, attempts: 2 });
  });

  it('password sbagliata: 403 resetInvalidPassword (mai 401), tentativo contato, stato invariato', async () => {
    const st = stateful();
    vi.mocked(bcrypt.compare as any).mockResolvedValue(false);
    const e: any = await confirmReset(U, RID, CODE, 'bad').catch((x) => x);
    expect(e.statusCode).toBe(403);
    expect(e.message).toBe('errors.vault.resetInvalidPassword');
    expect(st.attempts).toBe(2);
    expect(st.status).toBe('PENDING_CODE');
    expect(mp.vaultKeyring.updateMany).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(U, 'vault.reset.password_rejected', { requestId: RID, attempts: 2 });
  });

  it('5 errori (misti codice/password) -> EXPIRED; il 6o tentativo e rifiutato con 410 senza toccare la password', async () => {
    const st = stateful({ attempts: 0 });
    for (let i = 0; i < 5; i++) {
      vi.mocked(bcrypt.compare as any).mockResolvedValue(false);
      const code = i % 2 === 0 ? 'ZZZZ2345EFGH' : CODE;
      await expect(confirmReset(U, RID, code, 'bad')).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(st.attempts).toBe(5);
    expect(st.status).toBe('EXPIRED');
    vi.mocked(bcrypt.compare as any).mockClear();
    await expect(confirmReset(U, RID, CODE, 'pw')).rejects.toMatchObject({ statusCode: 410, message: 'errors.vault.resetExpired' });
    expect(bcrypt.compare).not.toHaveBeenCalled();
    expect(mp.vaultKeyring.updateMany).not.toHaveBeenCalled();
  });

  it('la 5a prova, se valida, passa: il limite e 5 tentativi totali', async () => {
    stateful({ attempts: 4 });
    await expect(confirmReset(U, RID, CODE, 'pw')).resolves.toHaveProperty('scheduledAt');
  });

  it('codice scaduto dopo 10 minuti -> 410 resetExpired', async () => {
    stateful({ expiresAt: new Date(Date.now() - 1000) });
    await expect(confirmReset(U, RID, CODE, 'pw')).rejects.toMatchObject({ statusCode: 410, message: 'errors.vault.resetExpired' });
    expect(mp.vaultKeyring.updateMany).not.toHaveBeenCalled();
  });

  it('richiesta inesistente o gia WAITING -> 409 resetStateConflict', async () => {
    mp.vaultRequest.updateMany.mockResolvedValue({ count: 0 });
    mp.vaultRequest.findFirst.mockResolvedValue(null);
    await expect(confirmReset(U, RID, CODE, 'pw')).rejects.toMatchObject({ statusCode: 409, message: 'errors.vault.resetStateConflict' });
    mp.vaultRequest.findFirst.mockResolvedValue({ status: 'WAITING', attempts: 1, expiresAt: null });
    await expect(confirmReset(U, RID, CODE, 'pw')).rejects.toMatchObject({ statusCode: 409, message: 'errors.vault.resetStateConflict' });
  });

  it('keyring non piu READY al momento della conferma: 409, la richiesta non passa a WAITING', async () => {
    stateful();
    mp.vaultKeyring.updateMany.mockResolvedValue({ count: 0 });
    await expect(confirmReset(U, RID, CODE, 'pw')).rejects.toMatchObject({ statusCode: 409, message: 'errors.vault.resetStateConflict' });
    expect(mp.vaultRequest.updateMany.mock.calls.some((c: any) => c[0].data.status === 'WAITING')).toBe(false);
    await flush();
    expect(notifyReset).not.toHaveBeenCalled();
  });
});

describe('cancelReset / cancelResetByAdmin', () => {
  it('annullo utente: keyring RESET_PENDING -> READY, richiesta WAITING -> CANCELLED, conteggi dati non toccati', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue({ id: RID });
    await expect(cancelReset(U)).resolves.toEqual({ ok: true });
    expect(mp.$executeRaw.mock.calls[0].slice(1)).toEqual([`vault-reset:${U}`]);
    expect(mp.vaultKeyring.updateMany).toHaveBeenCalledWith({ where: { userId: U, status: 'RESET_PENDING' }, data: { status: 'READY', resetScheduledAt: null } });
    // tutte le WAITING dell'utente, non solo quella trovata: nessuna riga orfana
    expect(mp.vaultRequest.updateMany).toHaveBeenCalledWith({
      where: { userId: U, type: 'RESET', status: 'WAITING' },
      data: { status: 'CANCELLED', cancelledAt: expect.any(Date), cancelledBy: U },
    });
    expect(mp.note.deleteMany).not.toHaveBeenCalled();
    expect(mp.tag.deleteMany).not.toHaveBeenCalled();
    await flush();
    expect(logEvent).toHaveBeenCalledWith(U, 'vault.reset.cancelled', { requestId: RID, byAdmin: false });
    expect(notifyReset).toHaveBeenCalledWith(U, 'cancelled', { requestId: RID });
    expect(notifySuperadminsReset).toHaveBeenCalledWith('cancelled', { requestId: RID, ownerId: U, actorId: U });
  });

  it('nessun reset in attesa (o gia completato: keyring NONE) -> 409 resetNotCancellable, niente audit ne notifiche', async () => {
    mp.vaultKeyring.updateMany.mockResolvedValue({ count: 0 });
    await expect(cancelReset(U)).rejects.toMatchObject({ statusCode: 409, message: 'errors.vault.resetNotCancellable' });
    await flush();
    expect(logEvent).not.toHaveBeenCalled();
    expect(notifyReset).not.toHaveBeenCalled();
  });

  it('annullo admin: ripristina il keyring del proprietario, cancelledBy e l admin, audit byAdmin, utente avvisato, attore escluso', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue({ id: RID, userId: U, status: 'WAITING' });
    await expect(cancelResetByAdmin(ADMIN, RID)).resolves.toEqual({ ok: true });
    expect(mp.vaultRequest.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: RID, type: 'RESET' } }));
    expect(mp.vaultKeyring.updateMany).toHaveBeenCalledWith({ where: { userId: U, status: 'RESET_PENDING' }, data: { status: 'READY', resetScheduledAt: null } });
    expect(mp.vaultRequest.updateMany).toHaveBeenCalledWith({
      where: { userId: U, type: 'RESET', status: 'WAITING' },
      data: { status: 'CANCELLED', cancelledAt: expect.any(Date), cancelledBy: ADMIN },
    });
    await flush();
    expect(logEvent).toHaveBeenCalledWith(U, 'vault.reset.cancelled', { requestId: RID, byAdmin: true });
    expect(notifyReset).toHaveBeenCalledWith(U, 'cancelled', { requestId: RID });
    expect(notifySuperadminsReset).toHaveBeenCalledWith('cancelled', { requestId: RID, ownerId: U, actorId: ADMIN });
  });

  it('annullo admin con l id di un RECOVERY (o inesistente) -> 404: la ricerca e ristretta a type RESET', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue(null);
    await expect(cancelResetByAdmin(ADMIN, 'recovery-id')).rejects.toMatchObject({ statusCode: 404 });
    expect(mp.vaultRequest.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'recovery-id', type: 'RESET' } }));
    expect(mp.vaultKeyring.updateMany).not.toHaveBeenCalled();
  });

  it('annullo: un id vecchio non lascia righe WAITING orfane (annulla tutte le WAITING del proprietario nella stessa transazione)', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue({ id: RID, userId: U, status: 'WAITING' });
    mp.vaultRequest.updateMany.mockResolvedValue({ count: 2 });
    await cancelResetByAdmin(ADMIN, RID);
    expect(mp.$transaction).toHaveBeenCalledTimes(1);
    expect(mp.vaultRequest.updateMany.mock.calls[0][0].where).not.toHaveProperty('id');
  });

  it('annullo admin: richiesta assente -> 404 recoveryNotFound; non piu annullabile -> 409', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue(null);
    await expect(cancelResetByAdmin(ADMIN, RID)).rejects.toMatchObject({ statusCode: 404, message: 'errors.vault.recoveryNotFound' });
    mp.vaultRequest.findFirst.mockResolvedValue({ id: RID, userId: U, status: 'COMPLETED' });
    await expect(cancelResetByAdmin(ADMIN, RID)).rejects.toMatchObject({ statusCode: 409, message: 'errors.vault.resetNotCancellable' });
    mp.vaultRequest.findFirst.mockResolvedValue({ id: RID, userId: U, status: 'WAITING' });
    mp.vaultKeyring.updateMany.mockResolvedValue({ count: 0 });
    await expect(cancelResetByAdmin(ADMIN, RID)).rejects.toMatchObject({ statusCode: 409, message: 'errors.vault.resetNotCancellable' });
  });
});

describe('runResetJobs', () => {
  function arm(urls: string[] = ['a.png', 'b.pdf']) {
    mp.vaultKeyring.findMany.mockResolvedValue([{ userId: U, resetScheduledAt: new Date(Date.now() - 10 * 60 * 1000) }]);
    mp.vaultKeyring.findUnique.mockResolvedValue({ epoch: 4 });
    mp.vaultRequest.findFirst.mockResolvedValue({ id: RID });
    mp.attachment.findMany.mockResolvedValue(urls.map((url) => ({ url })));
  }

  it('pepper assente o non valido: non cancella niente, non legge nemmeno i keyring, logga un avviso', async () => {
    arm();
    const saved = process.env.VAULT_PEPPER_KEY;
    try {
      for (const bad of [undefined, 'troppo-corto']) {
        if (bad === undefined) delete process.env.VAULT_PEPPER_KEY; else process.env.VAULT_PEPPER_KEY = bad;
        await expect(runResetJobs()).resolves.toBe(0);
      }
    } finally {
      if (saved === undefined) delete process.env.VAULT_PEPPER_KEY; else process.env.VAULT_PEPPER_KEY = saved;
    }
    expect(mp.vaultKeyring.findMany).not.toHaveBeenCalled();
    expect(mp.$transaction).not.toHaveBeenCalled();
    expect(mp.note.deleteMany).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('prima della scadenza non fa nulla: la select chiede solo i keyring RESET_PENDING scaduti', async () => {
    await expect(runResetJobs()).resolves.toBe(0);
    const where = mp.vaultKeyring.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ status: 'RESET_PENDING', resetScheduledAt: { lte: expect.any(Date) } });
    expect(mp.$transaction).not.toHaveBeenCalled();
    expect(mp.note.deleteMany).not.toHaveBeenCalled();
  });

  it('scade le challenge abbandonate (PENDING_CODE oltre i 10 minuti) prima di cercare i reset da completare', async () => {
    await runResetJobs();
    expect(mp.vaultRequest.updateMany).toHaveBeenCalledWith({ where: { type: 'RESET', status: 'PENDING_CODE', expiresAt: { lte: expect.any(Date) } }, data: { status: 'EXPIRED' } });
  });

  it('in ritardo di piu di 1 ora (outage): NON cancella, rinvia di 24 ore con CAS condizionata, aggiorna notBefore, avvisa e scrive l audit', async () => {
    arm();
    mp.vaultKeyring.findMany.mockResolvedValue([{ userId: U, resetScheduledAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }]);
    const before = Date.now();
    await expect(runResetJobs()).resolves.toBe(0);
    await flush();
    const cas = mp.vaultKeyring.updateMany.mock.calls[0][0];
    expect(cas.where).toEqual({ userId: U, status: 'RESET_PENDING', resetScheduledAt: { lt: expect.any(Date) } });
    expect(cas.where.resetScheduledAt.lt.getTime()).toBeLessThanOrEqual(Date.now() - 60 * 60 * 1000);
    const next = cas.data.resetScheduledAt as Date;
    expect(next.getTime()).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
    expect(cas.data).toEqual({ resetScheduledAt: next });
    expect(mp.vaultRequest.updateMany).toHaveBeenCalledWith({ where: { userId: U, type: 'RESET', status: 'WAITING' }, data: { notBefore: next } });
    expect(mp.$executeRaw.mock.calls[0].slice(1)).toEqual([`vault-reset:${U}`]);
    expect(logEvent).toHaveBeenCalledWith(U, 'vault.reset.postponed', { requestId: RID, scheduledAt: next.toISOString() });
    expect(notifyReset).toHaveBeenCalledWith(U, 'scheduled', { requestId: RID, scheduledAt: next });
    expect(notifySuperadminsReset).toHaveBeenCalledWith('scheduled', { requestId: RID, ownerId: U, actorId: U });
    for (const f of [mp.note.deleteMany, mp.tag.deleteMany, mp.attachment.findMany, mp.auditLog.create, fs.promises.unlink]) expect(f).not.toHaveBeenCalled();
  });

  it('rinvio: CAS con count 0 (annullato o gia rinviato da un altro worker) -> nessun audit ne notifica', async () => {
    arm();
    mp.vaultKeyring.findMany.mockResolvedValue([{ userId: U, resetScheduledAt: new Date(Date.now() - 5 * 60 * 60 * 1000) }]);
    mp.vaultKeyring.updateMany.mockResolvedValue({ count: 0 });
    await expect(runResetJobs()).resolves.toBe(0);
    await flush();
    expect(logEvent).not.toHaveBeenCalled();
    expect(notifyReset).not.toHaveBeenCalled();
  });

  it('in ritardo di 10 minuti (tick normale) -> cancella, nessun rinvio', async () => {
    arm();
    await expect(runResetJobs()).resolves.toBe(1);
    expect(mp.note.deleteMany).toHaveBeenCalledTimes(1);
    expect(logEvent).not.toHaveBeenCalledWith(U, 'vault.reset.postponed', expect.anything());
  });

  it('opts.userId restringe la select a un solo utente', async () => {
    await runResetJobs({ userId: U });
    expect(mp.vaultKeyring.findMany.mock.calls[0][0].where).toMatchObject({ userId: U });
  });

  it('transazione da 30 s, ordine: advisory lock per utente, CAS keyring, allegati, note, tag, richiesta, audit; poi unlink, poi notifiche', async () => {
    arm();
    const order: string[] = [];
    let committed = false;
    mp.$transaction.mockImplementation(async (fn: any, opts: any) => {
      expect(opts).toEqual({ timeout: 30000 });
      const r = await fn(mp);
      committed = true;
      order.push('commit');
      return r;
    });
    mp.$executeRaw.mockImplementation(async (...a: any[]) => { order.push(`lock:${a[1]}`); return 1; });
    mp.vaultKeyring.updateMany.mockImplementation(async () => { order.push('cas'); return { count: 1 }; });
    mp.attachment.findMany.mockImplementation(async () => { order.push('attachments'); return [{ url: 'a.png' }, { url: 'b.pdf' }]; });
    mp.note.deleteMany.mockImplementation(async () => { order.push('notes'); return { count: 3 }; });
    mp.tag.deleteMany.mockImplementation(async () => { order.push('tags'); return { count: 2 }; });
    mp.vaultRequest.updateMany.mockImplementation(async ({ where }: any) => { if (where.status === 'WAITING') order.push('request'); return { count: 1 }; });
    mp.auditLog.create.mockImplementation(async () => { order.push('audit'); return {}; });
    vi.mocked(fs.promises.unlink).mockImplementation(async () => { expect(committed).toBe(true); order.push('unlink'); });
    await expect(runResetJobs()).resolves.toBe(1);
    await flush();
    expect(order).toEqual([`lock:vault-reset:${U}`, 'cas', 'attachments', 'notes', 'tags', 'request', 'audit', 'commit', 'unlink', 'unlink']);
    expect(vi.mocked(fs.promises.unlink).mock.calls.map((c) => c[0])).toEqual(['/uploads/a.png', '/uploads/b.pdf']);
    expect(notifyReset).toHaveBeenCalledWith(U, 'completed', { requestId: RID });
    expect(notifySuperadminsReset).toHaveBeenCalledWith('completed', { requestId: RID, ownerId: U, actorId: U });
  });

  it('CAS: keyring azzerato, epoch+1, rev+1, riga conservata; where ristretta a RESET_PENDING scaduto', async () => {
    arm();
    await runResetJobs();
    const q = mp.vaultKeyring.updateMany.mock.calls[0][0];
    expect(q.where).toEqual({ userId: U, status: 'RESET_PENDING', resetScheduledAt: { lte: expect.any(Date) } });
    expect(q.data).toMatchObject({
      status: 'NONE', epoch: { increment: 1 }, rev: { increment: 1 },
      kdf: null, pinSalt: null, wrappedVkPin: null, authVerifier: null, serverShareEnc: null, pepperKeyId: null, vkSigPub: null,
      wrappedVkSigKey: null, escrowBlob: null, sealedRootShare: null, rootKeyId: null, userShareUnderVk: null, prevVkWrap: null,
      failedAttempts: 0, lockedUntil: null, resetScheduledAt: null, migrationState: 'NONE',
    });
    expect(q.data).toHaveProperty('kdfParams');
    expect(mp.vaultKeyring).not.toHaveProperty('delete');
  });

  it('cancella solo i dati vault dell utente (note anche nel cestino, tag vault): le where non toccano il resto', async () => {
    arm();
    await runResetJobs();
    expect(mp.note.deleteMany).toHaveBeenCalledTimes(1);
    expect(mp.note.deleteMany).toHaveBeenCalledWith({ where: { userId: U, isVault: true } });
    expect(mp.tag.deleteMany).toHaveBeenCalledWith({ where: { userId: U, isVault: true } });
    expect(mp.attachment.findMany).toHaveBeenCalledWith({ where: { note: { userId: U, isVault: true } }, select: { url: true } });
    expect(mp.noteVersion.deleteMany).not.toHaveBeenCalled(); // cascata di FK, nessuna cancellazione esplicita
  });

  it('richiesta COMPLETED e audit con la nuova epoch, nella transazione; solo conteggi', async () => {
    arm();
    await runResetJobs();
    expect(mp.vaultRequest.updateMany).toHaveBeenCalledWith({
      where: { id: RID, userId: U, type: 'RESET', status: 'WAITING' },
      data: { status: 'COMPLETED', completedAt: expect.any(Date) },
    });
    expect(mp.auditLog.create).toHaveBeenCalledWith({
      data: { userId: U, event: 'vault.reset.completed', details: { requestId: RID, epoch: 4, counts: { notes: 3, tags: 2, attachments: 2 } } },
    });
    expect(JSON.stringify(mp.auditLog.create.mock.calls)).not.toMatch(/a\.png|b\.pdf/);
  });

  it('unlink best effort: ENOENT ignorato, altri errori contati in un evento a parte, il job non fallisce', async () => {
    arm(['a.png', 'b.pdf', 'c.txt']);
    vi.mocked(fs.promises.unlink).mockImplementation(async (p: any) => {
      if (String(p).endsWith('a.png')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      if (String(p).endsWith('b.pdf')) throw Object.assign(new Error('perm'), { code: 'EACCES' });
    });
    await expect(runResetJobs()).resolves.toBe(1);
    await flush();
    expect(vi.mocked(fs.promises.unlink)).toHaveBeenCalledTimes(3);
    expect(logEvent).toHaveBeenCalledWith(U, 'vault.reset.files_failed', { requestId: RID, filesFailed: 1 });
    expect(notifyReset).toHaveBeenCalledWith(U, 'completed', { requestId: RID });
  });

  it('due run in parallelo: una sola cancellazione (la CAS del secondo ha count 0)', async () => {
    arm();
    let first = true;
    mp.vaultKeyring.updateMany.mockImplementation(async () => { if (first) { first = false; return { count: 1 }; } return { count: 0 }; });
    const [a, b] = await Promise.all([runResetJobs(), runResetJobs()]);
    expect(a + b).toBe(1);
    expect(mp.note.deleteMany).toHaveBeenCalledTimes(1);
    expect(mp.tag.deleteMany).toHaveBeenCalledTimes(1);
    expect(mp.auditLog.create).toHaveBeenCalledTimes(1);
    expect(fs.promises.unlink).toHaveBeenCalledTimes(2);
  });

  it('annullo fra la select e la CAS: count 0, niente cancellato, niente unlink, nessuna notifica', async () => {
    arm();
    mp.vaultKeyring.updateMany.mockResolvedValue({ count: 0 });
    await expect(runResetJobs()).resolves.toBe(0);
    await flush();
    expect(mp.attachment.findMany).not.toHaveBeenCalled();
    expect(mp.note.deleteMany).not.toHaveBeenCalled();
    expect(mp.tag.deleteMany).not.toHaveBeenCalled();
    expect(mp.auditLog.create).not.toHaveBeenCalled();
    expect(fs.promises.unlink).not.toHaveBeenCalled();
    expect(notifyReset).not.toHaveBeenCalled();
  });

  it('transazione fallita: nessun unlink ne notifica; l errore si rilancia dopo aver provato gli altri utenti', async () => {
    const due = new Date(Date.now() - 60_000);
    mp.vaultKeyring.findMany.mockResolvedValue([{ userId: U, resetScheduledAt: due }, { userId: 'user-2', resetScheduledAt: due }]);
    mp.vaultKeyring.findUnique.mockResolvedValue({ epoch: 4 });
    mp.vaultRequest.findFirst.mockResolvedValue({ id: RID });
    mp.attachment.findMany.mockResolvedValue([{ url: 'a.png' }]);
    mp.note.deleteMany.mockRejectedValueOnce(new Error('db down')).mockResolvedValue({ count: 1 });
    await expect(runResetJobs()).rejects.toThrow('db down');
    await flush();
    expect(mp.note.deleteMany).toHaveBeenCalledTimes(2);
    expect(fs.promises.unlink).toHaveBeenCalledTimes(1); // solo l'utente riuscito
    expect(notifyReset).toHaveBeenCalledTimes(1);
  });
});

describe('dopo il reset', () => {
  it('un envelope dell epoch vecchia viene rifiutato (stale), uno dell epoch nuova passa', () => {
    const body = 'A'.repeat(16) + '.' + 'B'.repeat(22);
    expect(parseEnvelope(`nv3.3.${body}`)).toEqual({ epoch: 3 });
    expect(() => assertVaultContent(`nv3.3.${body}`, { epoch: 4, ready: true })).toThrow(expect.objectContaining({ statusCode: 422, message: 'errors.vault.stale' }));
    expect(() => assertVaultContent(`nv3.4.${body}`, { epoch: 4, ready: true })).not.toThrow();
  });
});
