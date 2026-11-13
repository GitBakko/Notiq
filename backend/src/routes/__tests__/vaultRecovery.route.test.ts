import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { Writable } from 'stream';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';

vi.mock('../../services/vault.service', async () => {
  const actual = await vi.importActual<typeof import('../../services/vault.service')>('../../services/vault.service');
  return {
    b64url: actual.b64url,
    pepperStatus: actual.pepperStatus,
    KDF_T_MIN: actual.KDF_T_MIN,
    getKeyring: vi.fn(),
    createKeyring: vi.fn(),
    unlock: vi.fn(),
    updateKeyring: vi.fn(),
    getItems: vi.fn(),
    migrateItems: vi.fn(),
    finalize: vi.fn(),
  };
});
vi.mock('../../services/vaultRecovery.service', () => ({
  createRecoveryRequest: vi.fn(),
  getRecovery: vi.fn(),
  confirmRecovery: vi.fn(),
  cancelRecovery: vi.fn(),
  completeRecovery: vi.fn(),
  getOpenRecovery: vi.fn(),
  kitRotationRequired: vi.fn().mockResolvedValue(false),
}));

import * as vaultService from '../../services/vault.service';
import * as recovery from '../../services/vaultRecovery.service';
import { AppError } from '../../utils/errors';
import vaultRoutes from '../vault';

const vs = vaultService as any;
const rs = recovery as any;

const TEST_USER = { id: 'user-1', email: 'test@test.com', role: 'USER', tokenVersion: 0 };
const PEPPER = Buffer.alloc(32, 7).toString('base64url');
const UUID = '11111111-1111-4111-8111-111111111111';
const CODE_A = 'ZZZZ9999';
const CODE_B = 'YYYY8888';

const b = (n: number, fill = 1) => Buffer.alloc(n, fill).toString('base64url');

let app: FastifyInstance;
let authToken: string;
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
  app.register(vaultRoutes, { prefix: '/api/vault' });
  await app.ready();
  authToken = app.jwt.sign(TEST_USER);
});

afterAll(async () => {
  await app.close();
});

const savedPepper = process.env.VAULT_PEPPER_KEY;
beforeEach(() => {
  vi.clearAllMocks();
  logs.length = 0;
  process.env.VAULT_PEPPER_KEY = PEPPER;
});
afterEach(() => {
  if (savedPepper === undefined) delete process.env.VAULT_PEPPER_KEY;
  else process.env.VAULT_PEPPER_KEY = savedPepper;
});

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, token: string | null = authToken) =>
  app.inject({
    method,
    url: `/api/vault${url}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload !== undefined ? { payload: payload as any } : {}),
  });

describe('GET /keyring con openRecovery', () => {
  it('aggiunge openRecovery dal service', async () => {
    vs.getKeyring.mockResolvedValue({ status: 'READY', epoch: 1 });
    const open = { id: UUID, status: 'WAITING', fingerprint: 'ABCD1234', createdAt: '2026-11-12T10:00:00.000Z', notBefore: '2026-11-13T10:00:00.000Z' };
    rs.getOpenRecovery.mockResolvedValue(open);
    const res = await call('GET', '/keyring');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'READY', epoch: 1, openRecovery: open, kitRotationRequired: false });
    expect(rs.getOpenRecovery).toHaveBeenCalledWith('user-1');
  });

  it('senza richiesta aperta openRecovery e null', async () => {
    vs.getKeyring.mockResolvedValue({ status: 'NONE' });
    rs.getOpenRecovery.mockResolvedValue(null);
    expect((await call('GET', '/keyring')).json()).toEqual({ status: 'NONE', openRecovery: null, kitRotationRequired: false });
  });

  it('T1: kitRotationRequired dal service con utente ed escrowHash del keyring', async () => {
    vs.getKeyring.mockResolvedValue({ status: 'READY', escrowHash: 'h'.repeat(64) });
    rs.getOpenRecovery.mockResolvedValue(null);
    rs.kitRotationRequired.mockResolvedValueOnce(true);
    expect((await call('GET', '/keyring')).json().kitRotationRequired).toBe(true);
    expect(rs.kitRotationRequired).toHaveBeenCalledWith('user-1', 'h'.repeat(64));
  });
});

describe('POST /recovery', () => {
  it('201 {id, fingerprint}, ip e user agent dalla richiesta', async () => {
    rs.createRecoveryRequest.mockResolvedValue({ id: UUID, fingerprint: 'ABCD1234' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/vault/recovery',
      headers: { authorization: `Bearer ${authToken}`, 'user-agent': 'UA-test' },
      payload: { clientEphPub: b(97), reason: 'ho perso il PIN' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: UUID, fingerprint: 'ABCD1234' });
    const [uid, pub, reason, ip, ua] = rs.createRecoveryRequest.mock.calls[0];
    expect(uid).toBe('user-1');
    expect(Buffer.from(pub)).toEqual(Buffer.alloc(97, 1));
    expect(reason).toBe('ho perso il PIN');
    expect(typeof ip).toBe('string');
    expect(ua).toBe('UA-test');
  });

  it('reason facoltativo', async () => {
    rs.createRecoveryRequest.mockResolvedValue({ id: UUID, fingerprint: 'ABCD1234' });
    expect((await call('POST', '/recovery', { clientEphPub: b(97) })).statusCode).toBe(201);
    expect(rs.createRecoveryRequest.mock.calls[0][2]).toBeUndefined();
  });

  it.each([
    ['clientEphPub di 96 byte', { clientEphPub: b(96) }],
    ['clientEphPub mancante', {}],
    ['reason > 500', { clientEphPub: b(97), reason: 'x'.repeat(501) }],
  ])('%s -> 400 invalidPayload senza issues', async (_n, payload) => {
    const res = await call('POST', '/recovery', payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ message: 'errors.vault.invalidPayload' });
    expect(rs.createRecoveryRequest).not.toHaveBeenCalled();
  });

  it('errori del service (409 gia aperta, 429 quota) passano invariati', async () => {
    rs.createRecoveryRequest.mockRejectedValue(new AppError(409, 'errors.vault.recoveryAlreadyOpen'));
    const res = await call('POST', '/recovery', { clientEphPub: b(97) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ message: 'errors.vault.recoveryAlreadyOpen' });
  });
});

describe('GET /recovery/:id', () => {
  it('Buffer in b64url, Date serializzate, null passano', async () => {
    rs.getRecovery.mockResolvedValue({
      status: 'RELEASED',
      fingerprint: 'ABCD1234',
      notBefore: new Date('2026-11-13T10:00:00.000Z'),
      releaseExpiresAt: new Date('2026-11-13T12:00:00.000Z'),
      sealedCodeA: null,
      rootShareForClient: Buffer.alloc(40, 2),
      rootSignature: Buffer.alloc(64, 3),
      escrowBlob: Buffer.alloc(60, 4),
    });
    const res = await call('GET', `/recovery/${UUID}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'RELEASED',
      fingerprint: 'ABCD1234',
      notBefore: '2026-11-13T10:00:00.000Z',
      releaseExpiresAt: '2026-11-13T12:00:00.000Z',
      sealedCodeA: null,
      rootShareForClient: b(40, 2),
      rootSignature: b(64, 3),
      escrowBlob: b(60, 4),
    });
    expect(rs.getRecovery).toHaveBeenCalledWith('user-1', UUID);
  });

  it('PENDING_CODE: sealedCodeA passa, share e firma null', async () => {
    rs.getRecovery.mockResolvedValue({ status: 'PENDING_CODE', fingerprint: 'F', notBefore: null, releaseExpiresAt: null, sealedCodeA: 'abc_def', rootShareForClient: null, rootSignature: null, escrowBlob: null });
    const j = (await call('GET', `/recovery/${UUID}`)).json();
    expect(j.sealedCodeA).toBe('abc_def');
    expect(j.escrowBlob).toBeNull();
    expect(j.rootShareForClient).toBeNull();
    expect(j.rootSignature).toBeNull();
  });

  it('id non uuid -> 400 e il service non viene chiamato', async () => {
    const res = await call('GET', '/recovery/non-un-uuid');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ message: 'errors.vault.invalidPayload' });
    expect(rs.getRecovery).not.toHaveBeenCalled();
  });

  it('404 del service passa invariato', async () => {
    rs.getRecovery.mockRejectedValue(new AppError(404, 'errors.vault.recoveryNotFound'));
    const res = await call('GET', `/recovery/${UUID}`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ message: 'errors.vault.recoveryNotFound' });
  });
});

describe('POST /recovery/:id/confirm', () => {
  it('200 {status, notBefore}', async () => {
    rs.confirmRecovery.mockResolvedValue({ status: 'WAITING', notBefore: new Date('2026-11-13T10:00:00.000Z') });
    const res = await call('POST', `/recovery/${UUID}/confirm`, { codeA: CODE_A, codeB: CODE_B });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'WAITING', notBefore: '2026-11-13T10:00:00.000Z' });
    expect(rs.confirmRecovery).toHaveBeenCalledWith('user-1', UUID, CODE_A, CODE_B);
  });

  it.each([
    ['codice corto', { codeA: 'ABC', codeB: CODE_B }],
    ['lettera esclusa (I)', { codeA: 'IIIIIIII', codeB: CODE_B }],
    ['minuscole', { codeA: 'abcd1234', codeB: CODE_B }],
    ['codeB mancante', { codeA: CODE_A }],
  ])('%s -> 400 invalidPayload', async (_n, payload) => {
    const res = await call('POST', `/recovery/${UUID}/confirm`, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ message: 'errors.vault.invalidPayload' });
    expect(rs.confirmRecovery).not.toHaveBeenCalled();
  });

  it.each([404, 409, 410, 429])('errore %i del service passa invariato', async (code) => {
    rs.confirmRecovery.mockRejectedValue(new AppError(code, 'errors.vault.x'));
    const res = await call('POST', `/recovery/${UUID}/confirm`, { codeA: CODE_A, codeB: CODE_B });
    expect(res.statusCode).toBe(code);
    expect(res.json()).toEqual({ message: 'errors.vault.x' });
  });

  it('i codici non finiscono ne nei log ne nella risposta di errore', async () => {
    rs.confirmRecovery.mockRejectedValue(new Error('boom'));
    const res = await call('POST', `/recovery/${UUID}/confirm`, { codeA: CODE_A, codeB: CODE_B });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(CODE_A);
    expect(res.body).not.toContain(CODE_B);
    const all = logs.join('');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(CODE_A);
    expect(all).not.toContain(CODE_B);
  });
});

describe('DELETE /recovery/:id', () => {
  it('200 {status: CANCELLED}', async () => {
    rs.cancelRecovery.mockResolvedValue({ status: 'CANCELLED' });
    const res = await call('DELETE', `/recovery/${UUID}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'CANCELLED' });
    expect(rs.cancelRecovery).toHaveBeenCalledWith('user-1', UUID);
  });

  it('409 del service passa invariato', async () => {
    rs.cancelRecovery.mockRejectedValue(new AppError(409, 'errors.vault.recoveryStateConflict'));
    expect((await call('DELETE', `/recovery/${UUID}`)).statusCode).toBe(409);
  });
});

describe('POST /recovery/:id/complete', () => {
  it('200 {status, idempotent}; il service riceve utente, id, payload e proof come Buffer', async () => {
    rs.completeRecovery.mockResolvedValue({ status: 'COMPLETED', idempotent: false });
    const res = await call('POST', `/recovery/${UUID}/complete`, { payload: '{"a":1}', vkProof: b(64) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'COMPLETED', idempotent: false });
    const [uid, id, payload, proof] = rs.completeRecovery.mock.calls[0];
    expect([uid, id, payload]).toEqual(['user-1', UUID, '{"a":1}']);
    expect(Buffer.isBuffer(proof)).toBe(true);
    expect(proof).toEqual(Buffer.alloc(64, 1));
  });

  it('payload > 65536 o vkProof di 63 byte -> 400 senza eco', async () => {
    const big = await call('POST', `/recovery/${UUID}/complete`, { payload: 'SEGRETO'.repeat(10000), vkProof: b(64) });
    expect(big.statusCode).toBe(400);
    expect(big.json()).toEqual({ message: 'errors.vault.invalidPayload' });
    expect(big.body).not.toContain('SEGRETO');
    const bad = await call('POST', `/recovery/${UUID}/complete`, { payload: '{}', vkProof: b(63) });
    expect(bad.statusCode).toBe(400);
    expect(rs.completeRecovery).not.toHaveBeenCalled();
  });

  it('il path registrato e esattamente /api/vault/recovery/:id/complete (stringa firmata da verifyVkProof)', () => {
    expect(app.hasRoute({ method: 'POST', url: '/api/vault/recovery/:id/complete' })).toBe(true);
  });
});

describe('guardie comuni', () => {
  it('senza token -> 401, service non chiamato', async () => {
    const res = await call('GET', `/recovery/${UUID}`, undefined, null);
    expect(res.statusCode).toBe(401);
    expect(rs.getRecovery).not.toHaveBeenCalled();
  });

  it('pepper assente -> 503', async () => {
    delete process.env.VAULT_PEPPER_KEY;
    const res = await call('GET', `/recovery/${UUID}`);
    expect(res.statusCode).toBe(503);
    expect(rs.getRecovery).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', '', undefined, 'getRecovery', { status: 'WAITING', rootShareForClient: null, rootSignature: null }],
    ['POST', '/confirm', { codeA: CODE_A, codeB: CODE_B }, 'confirmRecovery', { status: 'WAITING' }],
    ['DELETE', '', undefined, 'cancelRecovery', { status: 'CANCELLED' }],
  ] as const)('no-store su 200, 409 e 400: %s /recovery/:id%s', async (method, suffix, payload, fn, ok) => {
    rs[fn].mockResolvedValue(ok);
    const res200 = await call(method, `/recovery/${UUID}${suffix}`, payload);
    expect(res200.statusCode).toBe(200);
    expect(res200.headers['cache-control']).toBe('no-store');
    rs[fn].mockRejectedValue(new AppError(409, 'errors.vault.x'));
    const res409 = await call(method, `/recovery/${UUID}${suffix}`, payload);
    expect(res409.statusCode).toBe(409);
    expect(res409.headers['cache-control']).toBe('no-store');
    const res400 = await call(method, `/recovery/non-un-uuid${suffix}`, payload);
    expect(res400.statusCode).toBe(400);
    expect(res400.headers['cache-control']).toBe('no-store');
  });
});

describe('rate limit per utente', () => {
  let rl: FastifyInstance;
  beforeEach(async () => {
    rl = Fastify({ trustProxy: true });
    mkAuth(rl);
    await rl.register(rateLimit, { global: true, max: 1000, timeWindow: '1 minute', allowList: ['127.0.0.1'] });
    rl.register(vaultRoutes, { prefix: '/api/vault' });
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
        url: `/api/vault${url}`,
        headers: { authorization: `Bearer ${authToken}`, 'x-forwarded-for': '127.0.0.1' },
        payload: payload as any,
      });
      codes.push(res.statusCode);
    }
    return codes;
  };

  it('6a confirm in 15 minuti -> 429, le prime 5 passano', async () => {
    rs.confirmRecovery.mockResolvedValue({ status: 'WAITING', notBefore: null });
    const codes = await hit(`/recovery/${UUID}/confirm`, { codeA: CODE_A, codeB: CODE_B }, 6);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('4a POST /recovery in un ora -> 429', async () => {
    rs.createRecoveryRequest.mockResolvedValue({ id: UUID, fingerprint: 'F' });
    const codes = await hit('/recovery', { clientEphPub: b(97) }, 4);
    expect(codes).toEqual([201, 201, 201, 429]);
  });

  it('11a complete in un ora -> 429', async () => {
    rs.completeRecovery.mockResolvedValue({ status: 'COMPLETED', idempotent: false });
    const codes = await hit(`/recovery/${UUID}/complete`, { payload: '{}', vkProof: b(64) }, 11);
    expect(codes[10]).toBe(429);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
  });
});

describe('H1: keyring e cancel limitati per utente+IP (un JWT rubato non azzera il banner della vittima)', () => {
  let rl: FastifyInstance;
  beforeEach(async () => {
    rl = Fastify({ trustProxy: true });
    mkAuth(rl);
    await rl.register(rateLimit, { global: true, max: 1000, timeWindow: '1 minute', allowList: ['127.0.0.1'] });
    rl.register(vaultRoutes, { prefix: '/api/vault' });
    await rl.ready();
  });
  afterEach(async () => {
    await rl.close();
  });
  const from = (method: 'GET' | 'DELETE', url: string, ip: string) =>
    rl.inject({ method, url: `/api/vault${url}`, headers: { authorization: `Bearer ${authToken}`, 'x-forwarded-for': ip } }).then((r) => r.statusCode);

  it('GET /keyring: IP A esaurisce 60/min e prende 429, lo stesso utente da IP B riceve 200', async () => {
    vs.getKeyring.mockResolvedValue({ status: 'READY' });
    rs.getOpenRecovery.mockResolvedValue(null);
    for (let i = 0; i < 60; i++) expect(await from('GET', '/keyring', '203.0.113.1')).toBe(200);
    expect(await from('GET', '/keyring', '203.0.113.1')).toBe(429);
    expect(await from('GET', '/keyring', '203.0.113.2')).toBe(200);
  });

  it('DELETE /recovery/:id: IP A esaurisce 10/min e prende 429, lo stesso utente da IP B riceve 200', async () => {
    rs.cancelRecovery.mockResolvedValue({ status: 'CANCELLED' });
    for (let i = 0; i < 10; i++) expect(await from('DELETE', `/recovery/${UUID}`, '203.0.113.1')).toBe(200);
    expect(await from('DELETE', `/recovery/${UUID}`, '203.0.113.1')).toBe(429);
    expect(await from('DELETE', `/recovery/${UUID}`, '203.0.113.2')).toBe(200);
  });

  // stesso utente, stesso IP (NAT/Wi-Fi), sessioni diverse: bucket separati
  const withSid = (method: 'GET' | 'DELETE', url: string, sid: string) =>
    rl
      .inject({
        method,
        url: `/api/vault${url}`,
        headers: { authorization: `Bearer ${app.jwt.sign({ ...TEST_USER, sid })}`, 'x-forwarded-for': '203.0.113.1' },
      })
      .then((r) => r.statusCode);

  it('GET /keyring: stesso utente e IP, sid diversi -> bucket separati', async () => {
    vs.getKeyring.mockResolvedValue({ status: 'READY' });
    rs.getOpenRecovery.mockResolvedValue(null);
    for (let i = 0; i < 60; i++) expect(await withSid('GET', '/keyring', 'sid-a')).toBe(200);
    expect(await withSid('GET', '/keyring', 'sid-a')).toBe(429);
    expect(await withSid('GET', '/keyring', 'sid-b')).toBe(200);
  });

  it('DELETE /recovery/:id: stesso utente e IP, sid diversi -> bucket separati', async () => {
    rs.cancelRecovery.mockResolvedValue({ status: 'CANCELLED' });
    for (let i = 0; i < 10; i++) expect(await withSid('DELETE', `/recovery/${UUID}`, 'sid-a')).toBe(200);
    expect(await withSid('DELETE', `/recovery/${UUID}`, 'sid-a')).toBe(429);
    expect(await withSid('DELETE', `/recovery/${UUID}`, 'sid-b')).toBe(200);
  });
  // Un JWT rubato non deve poter esaurire il limite di rotazione Kit (PUT /keyring) e di completamento: bucket per utente+sessione+IP.
  const postSid = (method: 'PUT' | 'POST', url: string, sid: string, payload: unknown) =>
    rl
      .inject({
        method,
        url: `/api/vault${url}`,
        headers: { authorization: `Bearer ${app.jwt.sign({ ...TEST_USER, sid })}`, 'x-forwarded-for': '203.0.113.1' },
        payload: payload as any,
      })
      .then((r) => r.statusCode);

  it('PUT /keyring: stesso utente e IP, sid diversi -> bucket separati (10/ora)', async () => {
    vs.updateKeyring.mockResolvedValue({ rev: 2 });
    const body = { payload: '{}', vkProof: b(64) };
    for (let i = 0; i < 10; i++) expect(await postSid('PUT', '/keyring', 'sid-a', body)).toBe(200);
    expect(await postSid('PUT', '/keyring', 'sid-a', body)).toBe(429);
    expect(await postSid('PUT', '/keyring', 'sid-b', body)).toBe(200);
  });

  it('POST /recovery/:id/complete: stesso utente e IP, sid diversi -> bucket separati (10/ora)', async () => {
    rs.completeRecovery.mockResolvedValue({ status: 'COMPLETED', idempotent: false });
    const body = { payload: '{}', vkProof: b(64) };
    for (let i = 0; i < 10; i++) expect(await postSid('POST', `/recovery/${UUID}/complete`, 'sid-a', body)).toBe(200);
    expect(await postSid('POST', `/recovery/${UUID}/complete`, 'sid-a', body)).toBe(429);
    expect(await postSid('POST', `/recovery/${UUID}/complete`, 'sid-b', body)).toBe(200);
  });
});

describe('L1: reason con caratteri di controllo', () => {
  it.each([['NUL', 'a\u0000b'], ['ESC', 'a\u001bb'], ['DEL', 'a\u007fb']])('POST /recovery con %s nel reason -> 400 invalidPayload', async (_n, reason) => {
    const res = await call('POST', '/recovery', { clientEphPub: b(97), reason });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ message: 'errors.vault.invalidPayload' });
    expect(rs.createRecoveryRequest).not.toHaveBeenCalled();
  });

  it('tab, newline e a capo restano ammessi', async () => {
    rs.createRecoveryRequest.mockResolvedValue({ id: UUID, fingerprint: 'ABCD1234' });
    expect((await call('POST', '/recovery', { clientEphPub: b(97), reason: 'riga1\r\n\triga2' })).statusCode).toBe(201);
  });
});
