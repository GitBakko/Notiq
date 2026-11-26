import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';

vi.mock('../../services/vault.service', async () => {
  const actual = await vi.importActual<typeof import('../../services/vault.service')>('../../services/vault.service');
  return { b64url: actual.b64url, pepperStatus: actual.pepperStatus, KDF_T_MIN: actual.KDF_T_MIN, isRootKey: actual.isRootKey, getKeyring: vi.fn() };
});
vi.mock('../../services/vaultRecovery.service', () => ({ getOpenRecovery: vi.fn(), kitRotationRequired: vi.fn().mockResolvedValue(false) }));
vi.mock('../../services/vaultReset.service', () => ({
  createResetChallenge: vi.fn(),
  confirmReset: vi.fn(),
  cancelReset: vi.fn(),
  runResetJobs: vi.fn(),
}));

import * as reset from '../../services/vaultReset.service';
import * as vaultService from '../../services/vault.service';
import * as recovery from '../../services/vaultRecovery.service';
import { AppError } from '../../utils/errors';
import vaultRoutes from '../vault';

const rs = reset as any;
const vs = vaultService as any;
const rec = recovery as any;

const PEPPER = Buffer.alloc(32, 7).toString('base64url');
const UUID = '11111111-1111-4111-8111-111111111111';
const USER = { id: 'user-1', email: 'test@test.com', role: 'USER', tokenVersion: 0 };

// Come app.ts: gestore errori con AppError e rate limit globale.
async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(jwt, { secret: 'test-secret' });
  app.decorate('authenticate', async (request: any, reply: any) => {
    try { await request.jwtVerify(); } catch { return reply.code(401).send({ message: 'Unauthorized' }); }
  });
  app.setErrorHandler((error: any, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.statusCode).send({ message: error.message });
    return reply.status(error?.statusCode ?? 500).send({ message: error?.message });
  });
  await app.register(rateLimit, { global: true, max: 1000, timeWindow: '1 minute' });
  app.register(vaultRoutes, { prefix: '/api/vault' });
  await app.ready();
  return app;
}

let app: FastifyInstance;
let token: string;
const saved = process.env.VAULT_PEPPER_KEY;
// App nuova a ogni test: il rate limit reale non deve passare da un test all'altro.
beforeEach(async () => { vi.clearAllMocks(); process.env.VAULT_PEPPER_KEY = PEPPER; app = await build(); token = app.jwt.sign(USER); });
afterEach(async () => { await app.close(); if (saved === undefined) delete process.env.VAULT_PEPPER_KEY; else process.env.VAULT_PEPPER_KEY = saved; });

const call = (url: string, payload?: unknown, tk: string | null = token, a: FastifyInstance = app) =>
  a.inject({ method: 'POST', url: `/api/vault${url}`, headers: tk ? { authorization: `Bearer ${tk}` } : {}, ...(payload !== undefined ? { payload: payload as any } : {}) });

describe('POST /reset/challenge', () => {
  it('200 con il risultato del service per l utente del JWT, no-store', async () => {
    const out = { requestId: UUID, code: 'ABCD2345EFGH', expiresAt: '2026-11-26T10:10:00.000Z', counts: { notes: 2, tags: 1, attachments: 0 } };
    rs.createResetChallenge.mockResolvedValue(out);
    const res = await call('/reset/challenge', {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(out);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(rs.createResetChallenge).toHaveBeenCalledWith('user-1');
  });

  it('senza token 401, service non chiamato', async () => {
    expect((await call('/reset/challenge', {}, null)).statusCode).toBe(401);
    expect(rs.createResetChallenge).not.toHaveBeenCalled();
  });

  it('409 notReady passa invariato, no-store anche sull errore', async () => {
    rs.createResetChallenge.mockRejectedValue(new AppError(409, 'errors.vault.notReady'));
    const res = await call('/reset/challenge', {});
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ message: 'errors.vault.notReady' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('pepper assente -> 503', async () => {
    delete process.env.VAULT_PEPPER_KEY;
    expect((await call('/reset/challenge', {})).statusCode).toBe(503);
    expect(rs.createResetChallenge).not.toHaveBeenCalled();
  });

  it('6a challenge in un ora -> 429 errors.vault.resetRateLimited', async () => {
    const a = await build();
    const tk = a.jwt.sign({ ...USER, id: 'user-rl1' });
    rs.createResetChallenge.mockResolvedValue({});
    const codes: number[] = [];
    let last: any;
    for (let i = 0; i < 6; i++) { last = await call('/reset/challenge', {}, tk, a); codes.push(last.statusCode); }
    await a.close();
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    expect(last.json()).toEqual({ message: 'errors.vault.resetRateLimited' });
  });
});

describe('POST /reset', () => {
  const body = { requestId: UUID, code: 'abcd-2345-efgh', password: 'secret' };

  it('200 {scheduledAt}; il service riceve utente, richiesta, codice e password', async () => {
    rs.confirmReset.mockResolvedValue({ scheduledAt: '2026-12-03T10:00:00.000Z' });
    const res = await call('/reset', body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ scheduledAt: '2026-12-03T10:00:00.000Z' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(rs.confirmReset).toHaveBeenCalledWith('user-1', UUID, 'abcd-2345-efgh', 'secret');
  });

  it.each([
    ['requestId non uuid', { ...body, requestId: 'x' }],
    ['codice mancante', { requestId: UUID, password: 'p' }],
    ['password vuota', { ...body, password: '' }],
    ['body vuoto', {}],
  ])('%s -> 400 con messaggio fisso', async (_n, payload) => {
    const res = await call('/reset', payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ message: 'errors.vault.invalidPayload' });
    expect(rs.confirmReset).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'errors.vault.resetInvalidCode'],
    [403, 'errors.vault.resetInvalidPassword'],
    [410, 'errors.vault.resetExpired'],
    [409, 'errors.vault.resetStateConflict'],
  ])('errore %i %s passa invariato, mai 401', async (code, message) => {
    rs.confirmReset.mockRejectedValue(new AppError(code, message));
    const res = await call('/reset', body);
    expect(res.statusCode).toBe(code);
    expect(res.statusCode).not.toBe(401);
    expect(res.json()).toEqual({ message });
  });

  it('4a conferma in 15 minuti -> 429 errors.vault.resetRateLimited (limite 3 per utente)', async () => {
    const a = await build();
    const tk = a.jwt.sign({ ...USER, id: 'user-rl2' });
    rs.confirmReset.mockResolvedValue({ scheduledAt: 'x' });
    const codes: number[] = [];
    let last: any;
    for (let i = 0; i < 4; i++) { last = await call('/reset', body, tk, a); codes.push(last.statusCode); }
    await a.close();
    expect(codes).toEqual([200, 200, 200, 429]);
    expect(last.json()).toEqual({ message: 'errors.vault.resetRateLimited' });
  });

  it('nessun eco della password nell errore di validazione', async () => {
    const res = await call('/reset', { ...body, requestId: 'x', password: 'PASSWORD-SEGRETA' });
    expect(JSON.stringify(res.json())).not.toContain('PASSWORD-SEGRETA');
  });
});

describe('POST /reset/cancel', () => {
  it('200 {ok:true} col solo JWT (nessuna password nel body)', async () => {
    rs.cancelReset.mockResolvedValue({ ok: true });
    const res = await call('/reset/cancel', {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(rs.cancelReset).toHaveBeenCalledWith('user-1');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('409 resetNotCancellable passa invariato', async () => {
    rs.cancelReset.mockRejectedValue(new AppError(409, 'errors.vault.resetNotCancellable'));
    const res = await call('/reset/cancel', {});
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ message: 'errors.vault.resetNotCancellable' });
  });

  it('11a chiamata in un minuto dallo stesso utente e IP -> 429 resetRateLimited', async () => {
    const a = await build();
    const tk = a.jwt.sign({ ...USER, id: 'user-rl3' });
    rs.cancelReset.mockResolvedValue({ ok: true });
    const codes: number[] = [];
    let last: any;
    for (let i = 0; i < 11; i++) { last = await call('/reset/cancel', {}, tk, a); codes.push(last.statusCode); }
    await a.close();
    expect(codes.filter((c) => c === 429)).toHaveLength(1);
    expect(last.json()).toEqual({ message: 'errors.vault.resetRateLimited' });
  });
});

describe('GET /keyring (reset)', () => {
  it('passa lastResetEpoch e resetScheduledAt del service senza alterarli', async () => {
    vs.getKeyring.mockResolvedValue({ status: 'RESET_PENDING', epoch: 3, lastResetEpoch: 2, resetScheduledAt: '2026-12-03T10:00:00.000Z' });
    rec.getOpenRecovery.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/api/vault/keyring', headers: { authorization: `Bearer ${token}` } });
    expect(res.json()).toMatchObject({ status: 'RESET_PENDING', lastResetEpoch: 2, resetScheduledAt: '2026-12-03T10:00:00.000Z' });
  });
});
