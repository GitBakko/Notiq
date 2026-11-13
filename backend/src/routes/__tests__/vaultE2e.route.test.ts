import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

vi.mock('../../services/vault.service', async () => {
  const actual = await vi.importActual<typeof import('../../services/vault.service')>('../../services/vault.service');
  return { b64url: actual.b64url, pepperStatus: actual.pepperStatus, KDF_T_MIN: actual.KDF_T_MIN, getKeyring: vi.fn() };
});
vi.mock('../../services/vaultRecovery.service', () => ({ getOpenRecovery: vi.fn(), kitRotationRequired: vi.fn() }));

const RID = '11111111-1111-4111-8111-111111111111';
const OTHER_RID = '22222222-2222-4222-8222-222222222222';
const PEPPER = Buffer.alloc(32, 7).toString('base64url');
const TEST_KEY_ID = 'rk_42f37978a7909b3e';

// Le env si leggono a ogni chiamata, ma VAULT_ROOT_KEYS e la registrazione delle route no: ogni caso riparte da moduli nuovi.
async function setup(env: { NODE_ENV: string; VAULT_E2E?: string }, userId = 'user-1') {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', env.NODE_ENV);
  vi.stubEnv('VAULT_E2E', env.VAULT_E2E ?? '');
  vi.stubEnv('VAULT_PEPPER_KEY', PEPPER);
  const prisma = (await import('../../plugins/prisma')).default as any;
  const e2e = await import('../../utils/vaultE2e');
  const keys = await import('../../utils/vaultRootKeys');
  const { default: vaultRoutes } = await import('../vault');
  const app: FastifyInstance = Fastify();
  app.register(jwt, { secret: 'test-secret' });
  app.decorate('authenticate', async (request: any, reply: any) => {
    try { await request.jwtVerify(); } catch { return reply.code(401).send({ message: 'Unauthorized' }); }
  });
  app.register(vaultRoutes, { prefix: '/api/vault' });
  await app.ready();
  const token = app.jwt.sign({ id: userId, email: 'a@b.c', role: 'USER', tokenVersion: 0 });
  const call = (method: 'GET' | 'POST', url: string) => app.inject({ method, url: `/api/vault/__e2e${url}`, headers: { authorization: `Bearer ${token}` } });
  return { app, prisma, e2e, keys, call };
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
  ['solo VAULT_E2E=1 (NODE_ENV=development)', { NODE_ENV: 'development', VAULT_E2E: '1' }],
  ['VAULT_E2E diverso da 1 con NODE_ENV=test', { NODE_ENV: 'test', VAULT_E2E: 'true' }],
])('hook E2E spenti (%s)', (_label, env) => {
  it('route __e2e 404, chiave di test assente, outbox vuoto', async () => {
    const s = await setup(env);
    current = s.app;
    expect(s.e2e.isVaultE2E()).toBe(false);
    expect((await s.call('GET', `/recovery/${RID}/code-b`)).statusCode).toBe(404);
    expect((await s.call('POST', `/recovery/${RID}/advance`)).statusCode).toBe(404);
    expect(Object.keys(s.keys.VAULT_ROOT_KEYS)).not.toContain(TEST_KEY_ID);
    expect(Object.isFrozen(s.keys.VAULT_ROOT_KEYS)).toBe(true);
    s.e2e.putE2eCodeB(RID, 'ABCDEFGH');
    expect(s.e2e.getE2eCodeB(RID)).toBeUndefined();
  });
});

describe('hook E2E accesi (NODE_ENV=test e VAULT_E2E=1)', () => {
  const ON = { NODE_ENV: 'test', VAULT_E2E: '1' };

  it('la chiave di test e in VAULT_ROOT_KEYS (congelata), la produzione resta', async () => {
    const s = await setup(ON);
    current = s.app;
    expect(Object.keys(s.keys.VAULT_ROOT_KEYS)).toEqual(expect.arrayContaining([TEST_KEY_ID, 'rk_68a265761e7e37c7']));
    expect(s.keys.VAULT_E2E_ROOT_KEYS[TEST_KEY_ID]).toBeDefined();
    expect(Object.isFrozen(s.keys.VAULT_ROOT_KEYS)).toBe(true);
  });

  it('outbox: put/get senza consumare', async () => {
    const s = await setup(ON);
    current = s.app;
    s.e2e.putE2eCodeB(RID, 'ABCDEFGH');
    expect(s.e2e.getE2eCodeB(RID)).toBe('ABCDEFGH');
    expect(s.e2e.getE2eCodeB(RID)).toBe('ABCDEFGH');
  });

  it('code-b: 404 se la richiesta non e dell utente o manca il codice, 200 con codice', async () => {
    const s = await setup(ON);
    current = s.app;
    s.prisma.vaultRequest.findFirst.mockResolvedValue(null);
    s.e2e.putE2eCodeB(RID, 'ABCDEFGH');
    expect((await s.call('GET', `/recovery/${RID}/code-b`)).statusCode).toBe(404);
    expect(s.prisma.vaultRequest.findFirst.mock.calls[0][0].where).toMatchObject({ id: RID, userId: 'user-1', type: 'RECOVERY' });
    s.prisma.vaultRequest.findFirst.mockResolvedValue({ id: RID });
    const ok = await s.call('GET', `/recovery/${RID}/code-b`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ codeB: 'ABCDEFGH' });
    expect((await s.call('GET', `/recovery/${OTHER_RID}/code-b`)).statusCode).toBe(404);
  });

  it('advance: solo proprietario e solo WAITING, porta notBefore nel passato', async () => {
    const s = await setup(ON);
    current = s.app;
    s.prisma.vaultRequest.updateMany.mockResolvedValue({ count: 0 });
    expect((await s.call('POST', `/recovery/${RID}/advance`)).statusCode).toBe(409);
    s.prisma.vaultRequest.updateMany.mockResolvedValue({ count: 1 });
    const before = Date.now();
    expect((await s.call('POST', `/recovery/${RID}/advance`)).statusCode).toBe(200);
    const q = s.prisma.vaultRequest.updateMany.mock.calls[1][0];
    expect(q.where).toEqual({ id: RID, userId: 'user-1', type: 'RECOVERY', status: 'WAITING' });
    expect(q.data.notBefore.getTime()).toBeLessThan(before);
    expect(q.data.notBefore.getTime()).toBeGreaterThan(before - 5000);
  });

  it('senza token 401', async () => {
    const s = await setup(ON);
    current = s.app;
    const res = await s.app.inject({ method: 'GET', url: `/api/vault/__e2e/recovery/${RID}/code-b` });
    expect(res.statusCode).toBe(401);
  });
});
