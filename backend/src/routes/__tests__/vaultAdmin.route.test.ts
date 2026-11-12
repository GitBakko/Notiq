import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { Writable } from 'stream';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import prisma from '../../plugins/prisma';

vi.mock('../../services/vault.service', async () => {
  const actual = await vi.importActual<typeof import('../../services/vault.service')>('../../services/vault.service');
  return { b64url: actual.b64url, pepperStatus: actual.pepperStatus, KDF_T_MIN: actual.KDF_T_MIN };
});
vi.mock('../../services/vaultRecovery.service', () => ({
  listRecoveriesForAdmin: vi.fn(),
  getRecoveryForAdmin: vi.fn(),
  approveRecovery: vi.fn(),
  rejectRecovery: vi.fn(),
  releaseRecovery: vi.fn(),
  getOpenRecovery: vi.fn(),
  createRecoveryRequest: vi.fn(),
  getRecovery: vi.fn(),
  confirmRecovery: vi.fn(),
  cancelRecovery: vi.fn(),
  completeRecovery: vi.fn(),
}));

import * as recovery from '../../services/vaultRecovery.service';
import { AppError } from '../../utils/errors';
import adminRoutes from '../admin';

const rs = recovery as any;
const prismaMock = prisma as any;

const ADMIN = { id: 'admin-1', email: 'admin@test.com', role: 'SUPERADMIN', tokenVersion: 0 };
const PEPPER = Buffer.alloc(32, 7).toString('base64url');
const UUID = '11111111-1111-4111-8111-111111111111';
const PASS = 'PASSPHRASE_SEGRETA_' + 'Q'.repeat(12);

let app: FastifyInstance;
let adminToken: string;
const logs: string[] = [];

function mkAuth(a: FastifyInstance) {
  a.register(jwt, { secret: 'test-secret' });
  a.decorate('authenticate', async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ message: 'Unauthorized' });
    }
  });
}

function mkErrorHandler(a: FastifyInstance) {
  a.setErrorHandler((error: any, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.statusCode).send({ message: error.message });
    if (error instanceof Error && error.name === 'ZodError') {
      return reply.status(400).send({ message: 'errors.common.validationError', details: error.issues });
    }
    const httpStatus = error?.statusCode;
    if (typeof httpStatus === 'number' && httpStatus >= 400 && httpStatus < 500) {
      return reply.status(httpStatus).send({ message: error instanceof Error ? error.message : 'errors.common.error' });
    }
    return reply.status(500).send({ message: 'errors.common.internalError' });
  });
}

beforeAll(async () => {
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  const { loggerOptions } = await vi.importActual<typeof import('../../utils/logger')>('../../utils/logger'); // il setup globale mocka il logger
  app = Fastify({ logger: { ...loggerOptions, level: 'debug', stream } });
  mkAuth(app);
  mkErrorHandler(app);
  app.register(adminRoutes, { prefix: '/api/admin' });
  await app.ready();
  adminToken = app.jwt.sign(ADMIN);
});

afterAll(async () => {
  await app.close();
});

const savedPepper = process.env.VAULT_PEPPER_KEY;
beforeEach(() => {
  vi.clearAllMocks();
  logs.length = 0;
  process.env.VAULT_PEPPER_KEY = PEPPER;
  prismaMock.user.findUnique.mockResolvedValue({ role: 'SUPERADMIN' });
});
afterEach(() => {
  if (savedPepper === undefined) delete process.env.VAULT_PEPPER_KEY;
  else process.env.VAULT_PEPPER_KEY = savedPepper;
});

const call = (method: 'GET' | 'POST', url: string, payload?: unknown, token: string | null = adminToken) =>
  app.inject({
    method,
    url: `/api/admin/vault-recovery${url}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload !== undefined ? { payload: payload as any } : {}),
  });

describe('guardia ruolo', () => {
  it('senza token -> 401', async () => {
    const res = await call('GET', '', undefined, null);
    expect(res.statusCode).toBe(401);
    expect(rs.listRecoveriesForAdmin).not.toHaveBeenCalled();
  });

  it('JWT con role SUPERADMIN falsificato ma ruolo DB USER -> 403, nessun service chiamato', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ role: 'USER' });
    const forged = app.jwt.sign({ ...ADMIN, id: 'user-9', role: 'SUPERADMIN' });
    for (const [method, url, payload] of [
      ['GET', '', undefined],
      ['GET', `/${UUID}`, undefined],
      ['POST', `/${UUID}/approve`, undefined],
      ['POST', `/${UUID}/reject`, { reason: 'x' }],
      ['POST', `/${UUID}/release`, { passphrase: PASS }],
    ] as const) {
      const res = await call(method, url, payload, forged);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ message: 'errors.common.forbidden' });
    }
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({ where: { id: 'user-9' }, select: { role: true } });
    for (const fn of ['listRecoveriesForAdmin', 'getRecoveryForAdmin', 'approveRecovery', 'rejectRecovery', 'releaseRecovery']) {
      expect(rs[fn]).not.toHaveBeenCalled();
    }
  });

  it('utente rimosso dal DB -> 403', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    expect((await call('GET', '')).statusCode).toBe(403);
  });

  it('il 403 viene prima del 503 del pepper', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ role: 'USER' });
    delete process.env.VAULT_PEPPER_KEY;
    expect((await call('GET', '')).statusCode).toBe(403);
  });

  it('superadmin con pepper assente -> 503', async () => {
    delete process.env.VAULT_PEPPER_KEY;
    const res = await call('GET', '');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ message: 'errors.vault.unavailable' });
    expect(rs.listRecoveriesForAdmin).not.toHaveBeenCalled();
  });

  it('le route admin esistenti mantengono la loro guardia (stats per USER -> 403)', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ role: 'USER' });
    const res = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { authorization: `Bearer ${adminToken}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ message: 'errors.common.forbidden' });
  });
});

describe('GET / e GET /:id', () => {
  it('lista: default page 1 e limit 20, filtri passati al service', async () => {
    rs.listRecoveriesForAdmin.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });
    expect((await call('GET', '')).statusCode).toBe(200);
    expect(rs.listRecoveriesForAdmin).toHaveBeenLastCalledWith({ page: 1, limit: 20 });
    await call('GET', `?page=2&limit=100&status=WAITING&userId=${UUID}`);
    expect(rs.listRecoveriesForAdmin).toHaveBeenLastCalledWith({ page: 2, limit: 100, status: 'WAITING', userId: UUID });
  });

  it.each(['limit=101', 'page=0', 'status=BOH', 'userId=non-uuid'])('query %s -> 400', async (q) => {
    const res = await call('GET', `?${q}`);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ message: 'errors.vault.invalidPayload' });
    expect(rs.listRecoveriesForAdmin).not.toHaveBeenCalled();
  });

  it('lista senza campi segreti (la forma arriva dalla vista admin del service)', async () => {
    rs.listRecoveriesForAdmin.mockResolvedValue({
      items: [{ id: UUID, userId: 'u', userEmail: 'e@x.it', status: 'WAITING', fingerprint: 'ABCD1234', readyForRelease: false }],
      total: 1, page: 1, limit: 20,
    });
    const body = (await call('GET', '')).body;
    for (const k of ['clientEphPub', 'codeAHash', 'codeBHash', 'rootShareForClient', 'rootSignature', 'sealedCodeA', 'passphrase']) {
      expect(body).not.toContain(k);
    }
  });

  it('dettaglio: id non uuid -> 400; 404 del service passa', async () => {
    expect((await call('GET', '/non-uuid')).statusCode).toBe(400);
    rs.getRecoveryForAdmin.mockRejectedValue(new AppError(404, 'errors.vault.recoveryNotFound'));
    const res = await call('GET', `/${UUID}`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ message: 'errors.vault.recoveryNotFound' });
  });

  it('dettaglio: 200 con il risultato del service', async () => {
    rs.getRecoveryForAdmin.mockResolvedValue({ id: UUID, audit: [] });
    const res = await call('GET', `/${UUID}`);
    expect(res.json()).toEqual({ id: UUID, audit: [] });
    expect(rs.getRecoveryForAdmin).toHaveBeenCalledWith(UUID);
  });
});

describe('approve / reject / release', () => {
  it('approve -> 200 con esattamente la chiave status', async () => {
    rs.approveRecovery.mockResolvedValue({ status: 'PENDING_CODE' });
    const res = await call('POST', `/${UUID}/approve`);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json())).toEqual(['status']);
    expect(res.json().status).toBe('PENDING_CODE');
    expect(rs.approveRecovery).toHaveBeenCalledWith('admin-1', UUID);
  });

  it('approve della propria richiesta passa al service (self gestito li)', async () => {
    rs.approveRecovery.mockResolvedValue({ status: 'PENDING_CODE' });
    expect((await call('POST', `/${UUID}/approve`)).statusCode).toBe(200);
  });

  it('reject -> 200 e motivo passato', async () => {
    rs.rejectRecovery.mockResolvedValue({ status: 'REJECTED' });
    const res = await call('POST', `/${UUID}/reject`, { reason: 'non riconosciuto' });
    expect(res.json()).toEqual({ status: 'REJECTED' });
    expect(rs.rejectRecovery).toHaveBeenCalledWith('admin-1', UUID, 'non riconosciuto');
  });

  it.each([{}, { reason: '' }, { reason: 'x'.repeat(501) }])('reject con body %j -> 400', async (payload) => {
    const res = await call('POST', `/${UUID}/reject`, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ message: 'errors.vault.invalidPayload' });
    expect(rs.rejectRecovery).not.toHaveBeenCalled();
  });

  it.each([['NUL', 'a b'], ['ESC', 'ab'], ['DEL', 'ab']])('L1: reject con %s nel reason -> 400 invalidPayload', async (_n, reason) => {
    const res = await call('POST', `/${UUID}/reject`, { reason });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ message: 'errors.vault.invalidPayload' });
    expect(rs.rejectRecovery).not.toHaveBeenCalled();
  });

  it('release -> 200 {status: RELEASED}, passphrase solo al service', async () => {
    rs.releaseRecovery.mockResolvedValue({ status: 'RELEASED' });
    const res = await call('POST', `/${UUID}/release`, { passphrase: PASS });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'RELEASED' });
    expect(rs.releaseRecovery).toHaveBeenCalledWith('admin-1', UUID, PASS);
    expect(res.body).not.toContain(PASS);
  });

  it.each([{}, { passphrase: '' }, { passphrase: PASS + 'x'.repeat(1100) }])('release con body non valido -> 400 senza eco', async (payload) => {
    const res = await call('POST', `/${UUID}/release`, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ message: 'errors.vault.invalidPayload' });
    expect(res.body).not.toContain(PASS);
    expect(rs.releaseRecovery).not.toHaveBeenCalled();
  });

  it.each([403, 409, 429, 503])('errore %i del release passa invariato', async (code) => {
    rs.releaseRecovery.mockRejectedValue(new AppError(code, 'errors.vault.x'));
    const res = await call('POST', `/${UUID}/release`, { passphrase: PASS });
    expect(res.statusCode).toBe(code);
    expect(res.json()).toEqual({ message: 'errors.vault.x' });
  });

  it('la passphrase non finisce mai nei log, ne con errore 403 ne con 500', async () => {
    rs.releaseRecovery.mockRejectedValueOnce(new AppError(403, 'errors.vault.invalidRootPassphrase'));
    await call('POST', `/${UUID}/release`, { passphrase: PASS });
    rs.releaseRecovery.mockRejectedValueOnce(new Error('boom'));
    const res = await call('POST', `/${UUID}/release`, { passphrase: PASS });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(PASS);
    const all = logs.join('');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(PASS);
  });

  it('le route non notificano nulla (lo fa il service)', async () => {
    rs.approveRecovery.mockResolvedValue({ status: 'PENDING_CODE' });
    await call('POST', `/${UUID}/approve`);
    expect(rs.approveRecovery).toHaveBeenCalledTimes(1);
  });
});

describe('no-store', () => {
  it('su 200, 400, 403, 409', async () => {
    rs.listRecoveriesForAdmin.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });
    expect((await call('GET', '')).headers['cache-control']).toBe('no-store');
    expect((await call('GET', '?limit=999')).headers['cache-control']).toBe('no-store');
    rs.approveRecovery.mockRejectedValue(new AppError(409, 'errors.vault.recoveryStateConflict'));
    const r409 = await call('POST', `/${UUID}/approve`);
    expect(r409.statusCode).toBe(409);
    expect(r409.headers['cache-control']).toBe('no-store');
    prismaMock.user.findUnique.mockResolvedValue({ role: 'USER' });
    const r403 = await call('GET', '');
    expect(r403.statusCode).toBe(403);
    expect(r403.headers['cache-control']).toBe('no-store');
  });
});

describe('rate limit per admin', () => {
  let rl: FastifyInstance;
  beforeEach(async () => {
    rl = Fastify({ trustProxy: true });
    mkAuth(rl);
    mkErrorHandler(rl);
    await rl.register(rateLimit, { global: true, max: 1000, timeWindow: '1 minute', allowList: ['127.0.0.1'] });
    rl.register(adminRoutes, { prefix: '/api/admin' });
    await rl.ready();
  });
  afterEach(async () => {
    await rl.close();
  });
  const hit = async (url: string, payload: unknown, n: number) => {
    const codes: number[] = [];
    for (let i = 0; i < n; i++) {
      const res = await rl.inject({
        method: 'POST',
        url: `/api/admin/vault-recovery${url}`,
        headers: { authorization: `Bearer ${adminToken}`, 'x-forwarded-for': '127.0.0.1' },
        payload: payload as any,
      });
      codes.push(res.statusCode);
    }
    return codes;
  };

  it('4a release in 15 minuti -> 429', async () => {
    rs.releaseRecovery.mockResolvedValue({ status: 'RELEASED' });
    expect(await hit(`/${UUID}/release`, { passphrase: PASS }, 4)).toEqual([200, 200, 200, 429]);
  });

  it('31a approve in un minuto -> 429', async () => {
    rs.approveRecovery.mockResolvedValue({ status: 'PENDING_CODE' });
    const codes = await hit(`/${UUID}/approve`, undefined, 31);
    expect(codes[30]).toBe(429);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
  });
});
