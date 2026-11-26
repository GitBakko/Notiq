import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

vi.mock('../../services/vault.service', async () => {
  const actual = await vi.importActual<typeof import('../../services/vault.service')>('../../services/vault.service');
  return { b64url: actual.b64url, pepperStatus: actual.pepperStatus, KDF_T_MIN: actual.KDF_T_MIN, isRootKey: actual.isRootKey, getKeyring: vi.fn() };
});
vi.mock('../../services/vaultRecovery.service', () => ({ getOpenRecovery: vi.fn(), kitRotationRequired: vi.fn() }));
vi.mock('../../services/vaultReset.service', () => ({ runResetJobs: vi.fn(), createResetChallenge: vi.fn(), confirmReset: vi.fn(), cancelReset: vi.fn() }));

const PEPPER = Buffer.alloc(32, 7).toString('base64url');

// Le env si leggono alla registrazione delle route: ogni caso riparte da moduli nuovi (come vaultE2e.route.test).
async function setup(env: { NODE_ENV: string; VAULT_E2E?: string }) {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', env.NODE_ENV);
  vi.stubEnv('VAULT_E2E', env.VAULT_E2E ?? '');
  vi.stubEnv('VAULT_PEPPER_KEY', PEPPER);
  const prisma = (await import('../../plugins/prisma')).default as any;
  const resetService = (await import('../../services/vaultReset.service')) as any;
  const { default: vaultRoutes } = await import('../vault');
  const app: FastifyInstance = Fastify();
  app.register(jwt, { secret: 'test-secret' });
  app.decorate('authenticate', async (request: any, reply: any) => {
    try { await request.jwtVerify(); } catch { return reply.code(401).send({ message: 'Unauthorized' }); }
  });
  app.register(vaultRoutes, { prefix: '/api/vault' });
  await app.ready();
  const token = app.jwt.sign({ id: 'user-1', email: 'a@b.c', role: 'USER', tokenVersion: 0 });
  const advance = (tk: string | null = token) => app.inject({ method: 'POST', url: '/api/vault/__e2e/reset/advance', headers: tk ? { authorization: `Bearer ${tk}` } : {} });
  return { app, prisma, resetService, advance };
}

let current: FastifyInstance | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
  vi.unstubAllEnvs();
});
beforeEach(() => vi.clearAllMocks());

describe.each([
  ['solo NODE_ENV=test', { NODE_ENV: 'test' }],
  ['solo VAULT_E2E=1 (NODE_ENV=production)', { NODE_ENV: 'production', VAULT_E2E: '1' }],
])('hook reset spento (%s)', (_label, env) => {
  it('/__e2e/reset/advance 404, il job non parte, nessuna scrittura', async () => {
    const s = await setup(env);
    current = s.app;
    expect((await s.advance()).statusCode).toBe(404);
    expect(s.resetService.runResetJobs).not.toHaveBeenCalled();
    expect(s.prisma.vaultKeyring.updateMany).not.toHaveBeenCalled();
  });
});

describe('hook reset acceso (NODE_ENV=test e VAULT_E2E=1)', () => {
  const ON = { NODE_ENV: 'test', VAULT_E2E: '1' };

  it('porta resetScheduledAt nel passato per il solo utente autenticato e lancia il job per lui', async () => {
    const s = await setup(ON);
    current = s.app;
    s.prisma.vaultKeyring.updateMany.mockResolvedValue({ count: 1 });
    s.resetService.runResetJobs.mockResolvedValue(1);
    const before = Date.now();
    const res = await s.advance();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, completed: 1 });
    const q = s.prisma.vaultKeyring.updateMany.mock.calls[0][0];
    expect(q.where).toEqual({ userId: 'user-1', status: 'RESET_PENDING' });
    expect(q.data.resetScheduledAt.getTime()).toBeLessThan(before);
    // poco nel passato (1 min): il job lo cancella invece di rinviarlo come un outage (> 1 h)
    expect(q.data.resetScheduledAt.getTime()).toBeGreaterThan(Date.now() - 5 * 60 * 1000);
    expect(s.resetService.runResetJobs).toHaveBeenCalledWith({ userId: 'user-1' });
  });

  it('nessun reset in attesa -> 409 e il job non parte', async () => {
    const s = await setup(ON);
    current = s.app;
    s.prisma.vaultKeyring.updateMany.mockResolvedValue({ count: 0 });
    const res = await s.advance();
    expect(res.statusCode).toBe(409);
    expect(s.resetService.runResetJobs).not.toHaveBeenCalled();
  });

  it('senza token 401', async () => {
    const s = await setup(ON);
    current = s.app;
    expect((await s.advance(null)).statusCode).toBe(401);
  });
});
