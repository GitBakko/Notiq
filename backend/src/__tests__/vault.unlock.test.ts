import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';

vi.mock('../services/audit.service', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/email.service', () => ({ sendNotificationEmail: vi.fn().mockResolvedValue(true) }));

import prisma from '../plugins/prisma';
import logger from '../utils/logger';
import { logEvent } from '../services/audit.service';
import { sendNotificationEmail } from '../services/email.service';
import { unlock, pepperStatus, shareWrapKey, verifierKey } from '../services/vault.service';

const mp = prisma as any;
const U = 'user-1';
const EPOCH = 2;
const authKey = Buffer.alloc(32, 0xa1);
const wrongKey = Buffer.alloc(32, 0x99);
const serverShare = Buffer.alloc(32, 0xb2);
const ORIGINAL_PEPPER = process.env.VAULT_PEPPER_KEY;

const verifierFor = (k: Buffer) =>
  crypto.createHmac('sha256', verifierKey()).update(U, 'utf8').update('|', 'utf8').update(k).digest();

function seal(): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', shareWrapKey(), iv);
  c.setAAD(Buffer.from(`notiq/vault/v3/servershare|${U}|${EPOCH}`, 'utf8'));
  const ct = Buffer.concat([c.update(serverShare), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}

async function fail(p: Promise<unknown>) {
  try {
    await p;
  } catch (e: any) {
    return e;
  }
  throw new Error('expected rejection');
}

// Testo SQL del template passato a $queryRaw (TemplateStringsArray o oggetto Sql di Prisma)
function sqlText(): string {
  const first = mp.$queryRaw.mock.calls[0][0];
  if (Array.isArray(first)) return first.join('?');
  return String(first.sql ?? (first.strings ?? []).join('?'));
}

let row: any;
let n: number;

beforeAll(() => {
  process.env.VAULT_PEPPER_KEY = crypto.randomBytes(32).toString('base64url');
});
afterAll(() => {
  if (ORIGINAL_PEPPER === undefined) delete process.env.VAULT_PEPPER_KEY;
  else process.env.VAULT_PEPPER_KEY = ORIGINAL_PEPPER;
});

beforeEach(() => {
  vi.clearAllMocks();
  n = 0;
  row = {
    status: 'READY',
    epoch: EPOCH,
    authVerifier: verifierFor(authKey),
    serverShareEnc: seal(),
    pepperKeyId: pepperStatus().keyId,
  };
  mp.vaultKeyring.findUnique.mockImplementation(async () => row);
  mp.vaultKeyring.updateMany.mockResolvedValue({ count: 1 });
  mp.user.findUnique.mockResolvedValue({ email: 'a@b.it', locale: 'it' });
  mp.$queryRaw.mockImplementation(async () => [
    { failedAttempts: ++n, lockedUntil: n % 6 === 0 ? new Date('2030-01-01T00:00:00.000Z') : null },
  ]);
  (sendNotificationEmail as any).mockResolvedValue(true);
});

const lockedCalls = () => (logEvent as any).mock.calls.filter((c: any[]) => c[1] === 'vault.unlock.locked');

describe('unlock: errori e lockout', () => {
  it('errori 1-5: 403 invalidPin, niente email ne audit', async () => {
    for (let i = 1; i <= 5; i++) {
      const e = await fail(unlock(U, wrongKey));
      expect(e.statusCode).toBe(403);
      expect(e.message).toBe('errors.vault.invalidPin');
    }
    expect(sendNotificationEmail).not.toHaveBeenCalled();
    expect(lockedCalls()).toHaveLength(0);
  });

  it('errori 6, 12, 18: audit ed email VAULT_LOCKOUT, sempre 403', async () => {
    for (let i = 1; i <= 18; i++) {
      const e = await fail(unlock(U, wrongKey));
      expect(e.statusCode).toBe(403);
    }
    expect(lockedCalls().map((c: any[]) => c[2].n)).toEqual([6, 12, 18]);
    expect(lockedCalls()[0][2].lockedUntil).toBe('2030-01-01T00:00:00.000Z');
    const calls = (sendNotificationEmail as any).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual([
      'a@b.it',
      'VAULT_LOCKOUT',
      { locale: 'it', lockedUntil: '2030-01-01T00:00:00.000Z', attempts: '6' },
    ]);
    expect(calls[2][2].attempts).toBe('18');
  });

  it('locale assente -> en', async () => {
    mp.user.findUnique.mockResolvedValue({ email: 'a@b.it', locale: null });
    n = 5;
    await fail(unlock(U, wrongKey));
    expect((sendNotificationEmail as any).mock.calls[0][2].locale).toBe('en');
  });

  it('SQL: intervalli, LEAST, predicato lock, UTC, RETURNING', async () => {
    await fail(unlock(U, wrongKey));
    const s = sqlText();
    for (const t of ["'15 minutes'", "'1 hour'", "'24 hours'", 'LEAST(', 'RETURNING']) expect(s).toContain(t);
    expect(s).toContain(`"lockedUntil" IS NULL OR "lockedUntil" <= now() AT TIME ZONE 'UTC'`);
    expect(s.split(`AT TIME ZONE 'UTC'`).length - 1).toBeGreaterThanOrEqual(2);
    expect(mp.$queryRaw.mock.calls[0][1]).toBe(U);
    expect(mp.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('$queryRaw vuoto -> 429 locked', async () => {
    mp.$queryRaw.mockResolvedValue([]);
    const e = await fail(unlock(U, wrongKey));
    expect(e.statusCode).toBe(429);
    expect(e.message).toBe('errors.vault.locked');
    expect(sendNotificationEmail).not.toHaveBeenCalled();
  });

  it('authVerifier di lunghezza diversa o assente -> 403 senza eccezioni', async () => {
    row.authVerifier = Buffer.alloc(16, 1);
    expect((await fail(unlock(U, authKey))).statusCode).toBe(403);
    row.authVerifier = null;
    expect((await fail(unlock(U, authKey))).statusCode).toBe(403);
  });

  it('verifier di un altro utente (HMAC senza userId legato) -> 403', async () => {
    row.authVerifier = crypto.createHmac('sha256', verifierKey()).update(authKey).digest();
    expect((await fail(unlock(U, authKey))).statusCode).toBe(403);
  });

  it('email che rigetta: risposta resta 403, nessun unhandled rejection', async () => {
    (sendNotificationEmail as any).mockRejectedValue(new Error('smtp down'));
    n = 5;
    const e = await fail(unlock(U, wrongKey));
    expect(e.statusCode).toBe(403);
    expect(sendNotificationEmail).toHaveBeenCalledTimes(1);
    await new Promise((r) => setImmediate(r));
    expect(logger.warn).toHaveBeenCalled();
  });

  it('6o errore con user.findUnique che rigetta: resta 403, warn loggato', async () => {
    mp.user.findUnique.mockRejectedValue(new Error('db down'));
    n = 5;
    const e = await fail(unlock(U, wrongKey));
    expect(e.statusCode).toBe(403);
    expect(e.message).toBe('errors.vault.invalidPin');
    await new Promise((r) => setImmediate(r));
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('unlock: successo', () => {
  it('restituisce il serverShare sigillato, con where READY + OR su lockedUntil', async () => {
    const r = await unlock(U, authKey);
    expect(r.serverShare.equals(serverShare)).toBe(true);
    const arg = mp.vaultKeyring.updateMany.mock.calls[0][0];
    expect(arg.where.userId).toBe(U);
    expect(arg.where.status).toBe('READY');
    expect(arg.where.epoch).toBe(row.epoch);
    expect(arg.where.OR[0]).toEqual({ lockedUntil: null });
    expect(arg.where.OR[1].lockedUntil.lte).toBeInstanceOf(Date);
    expect(arg.data).toEqual({ failedAttempts: 0, lockedUntil: null });
    expect(mp.$queryRaw).not.toHaveBeenCalled();
  });

  it('updateMany count 0 -> 429, openServerShare mai eseguito (serverShareEnc spazzatura)', async () => {
    row.serverShareEnc = Buffer.alloc(64, 7);
    mp.vaultKeyring.updateMany.mockResolvedValue({ count: 0 });
    const e = await fail(unlock(U, authKey));
    expect(e.statusCode).toBe(429);
    expect(e.message).toBe('errors.vault.locked');
  });

  it('serverShareEnc corrotto con count 1: l\'errore GCM si propaga', async () => {
    row.serverShareEnc = Buffer.alloc(64, 7);
    const e = await fail(unlock(U, authKey));
    expect(e.statusCode).toBeUndefined();
  });
});

describe('unlock: precondizioni', () => {
  it('pepperKeyId diverso -> 503 pepperMismatch, nessun incremento', async () => {
    row.pepperKeyId = 'ffffffffffffffff';
    const e = await fail(unlock(U, wrongKey));
    expect(e.statusCode).toBe(503);
    expect(e.message).toBe('errors.vault.pepperMismatch');
    expect(mp.$queryRaw).not.toHaveBeenCalled();
    expect(mp.vaultKeyring.updateMany).not.toHaveBeenCalled();
  });

  it('pepper mancante -> 503 unavailable', async () => {
    const saved = process.env.VAULT_PEPPER_KEY;
    delete process.env.VAULT_PEPPER_KEY;
    try {
      const e = await fail(unlock(U, authKey));
      expect(e.statusCode).toBe(503);
      expect(e.message).toBe('errors.vault.unavailable');
    } finally {
      process.env.VAULT_PEPPER_KEY = saved;
    }
  });

  it('riga assente o RESET_PENDING -> 409 notReady', async () => {
    row = null;
    let e = await fail(unlock(U, authKey));
    expect([e.statusCode, e.message]).toEqual([409, 'errors.vault.notReady']);
    row = { status: 'RESET_PENDING' };
    e = await fail(unlock(U, authKey));
    expect([e.statusCode, e.message]).toEqual([409, 'errors.vault.notReady']);
    expect(mp.$queryRaw).not.toHaveBeenCalled();
  });

  it('nessuna risposta e\' 401', async () => {
    const codes: number[] = [];
    for (const k of [wrongKey, wrongKey]) codes.push((await fail(unlock(U, k))).statusCode);
    mp.$queryRaw.mockResolvedValue([]);
    codes.push((await fail(unlock(U, wrongKey))).statusCode);
    expect(codes).not.toContain(401);
  });
});
