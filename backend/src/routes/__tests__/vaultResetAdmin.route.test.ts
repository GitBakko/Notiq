import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import prisma from '../../plugins/prisma';

vi.mock('../../services/vault.service', async () => {
  const actual = await vi.importActual<typeof import('../../services/vault.service')>('../../services/vault.service');
  return { b64url: actual.b64url, pepperStatus: actual.pepperStatus, KDF_T_MIN: actual.KDF_T_MIN };
});
vi.mock('../../services/vaultRecovery.service', () => ({
  listRecoveriesForAdmin: vi.fn(), getRecoveryForAdmin: vi.fn(), approveRecovery: vi.fn(), rejectRecovery: vi.fn(), releaseRecovery: vi.fn(),
  getOpenRecovery: vi.fn(), createRecoveryRequest: vi.fn(), getRecovery: vi.fn(), confirmRecovery: vi.fn(), cancelRecovery: vi.fn(), completeRecovery: vi.fn(),
}));
vi.mock('../../services/vaultReset.service', () => ({ cancelResetByAdmin: vi.fn(), createResetChallenge: vi.fn(), confirmReset: vi.fn(), cancelReset: vi.fn(), runResetJobs: vi.fn() }));

import * as recovery from '../../services/vaultRecovery.service';
import * as reset from '../../services/vaultReset.service';
import { AppError } from '../../utils/errors';
import adminRoutes from '../admin';

const rs = recovery as any;
const rr = reset as any;
const prismaMock = prisma as any;
const ADMIN = { id: 'admin-1', email: 'admin@test.com', role: 'SUPERADMIN', tokenVersion: 0 };
const UUID = '11111111-1111-4111-8111-111111111111';
const PEPPER = Buffer.alloc(32, 7).toString('base64url');

let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  app = Fastify();
  app.register(jwt, { secret: 'test-secret' });
  app.decorate('authenticate', async (request: any, reply: any) => {
    try { await request.jwtVerify(); } catch { return reply.code(401).send({ message: 'Unauthorized' }); }
  });
  app.setErrorHandler((error: any, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.statusCode).send({ message: error.message });
    return reply.status(error?.statusCode ?? 500).send({ message: error?.message });
  });
  app.register(rateLimit, { global: true, max: 1000, timeWindow: '1 minute' });
  app.register(adminRoutes, { prefix: '/api/admin' });
  await app.ready();
  token = app.jwt.sign(ADMIN);
});
afterAll(async () => { await app.close(); });
beforeEach(() => {
  vi.clearAllMocks();
  process.env.VAULT_PEPPER_KEY = PEPPER;
  prismaMock.user.findUnique.mockResolvedValue({ role: 'SUPERADMIN' });
});

const call = (method: 'GET' | 'POST', url: string, tk: string | null = token) =>
  app.inject({ method, url: `/api/admin/vault-recovery${url}`, headers: tk ? { authorization: `Bearer ${tk}` } : {} });

describe('lista con ?type', () => {
  it('RECOVERY e il default, RESET passa al service', async () => {
    rs.listRecoveriesForAdmin.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });
    await call('GET', '');
    expect(rs.listRecoveriesForAdmin).toHaveBeenLastCalledWith({ page: 1, limit: 20, type: 'RECOVERY' });
    await call('GET', '?type=RESET');
    expect(rs.listRecoveriesForAdmin).toHaveBeenLastCalledWith({ page: 1, limit: 20, type: 'RESET' });
  });

  it('type sconosciuto -> 400', async () => {
    const res = await call('GET', '?type=NOPE');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ message: 'errors.vault.invalidPayload' });
  });
});

describe('POST /:id/cancel-reset', () => {
  it('200 {ok:true}; il service riceve admin e richiesta; no-store', async () => {
    rr.cancelResetByAdmin.mockResolvedValue({ ok: true });
    const res = await call('POST', `/${UUID}/cancel-reset`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(rr.cancelResetByAdmin).toHaveBeenCalledWith('admin-1', UUID);
  });

  it.each([[404, 'errors.vault.recoveryNotFound'], [409, 'errors.vault.resetNotCancellable']])('errore %i %s passa invariato', async (code, message) => {
    rr.cancelResetByAdmin.mockRejectedValue(new AppError(code, message));
    const res = await call('POST', `/${UUID}/cancel-reset`);
    expect(res.statusCode).toBe(code);
    expect(res.json()).toEqual({ message });
  });

  it('id non uuid 400; senza token 401; ruolo dal DB (JWT SUPERADMIN ma DB USER) 403', async () => {
    expect((await call('POST', '/x/cancel-reset')).statusCode).toBe(400);
    expect((await call('POST', `/${UUID}/cancel-reset`, null)).statusCode).toBe(401);
    prismaMock.user.findUnique.mockResolvedValue({ role: 'USER' });
    const res = await call('POST', `/${UUID}/cancel-reset`);
    expect(res.statusCode).toBe(403);
    expect(rr.cancelResetByAdmin).not.toHaveBeenCalled();
  });
});
