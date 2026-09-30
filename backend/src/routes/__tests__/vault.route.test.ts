import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';

vi.mock('../../services/vault.service', async () => {
  const actual = await vi.importActual<typeof import('../../services/vault.service')>('../../services/vault.service');
  return {
    b64url: actual.b64url,
    pepperStatus: actual.pepperStatus,
    getKeyring: vi.fn(),
    createKeyring: vi.fn(),
    unlock: vi.fn(),
    updateKeyring: vi.fn(),
    getItems: vi.fn(),
    migrateItems: vi.fn(),
    finalize: vi.fn(),
  };
});

import * as vaultService from '../../services/vault.service';
import { AppError } from '../../utils/errors';
import vaultRoutes from '../vault';

const svc = vaultService as any;

const TEST_USER = { id: 'user-1', email: 'test@test.com', role: 'USER', tokenVersion: 0 };
const PEPPER = Buffer.alloc(32, 7).toString('base64url');
const SECRET = 'SEGRETO_RICONOSCIBILE_' + 'A'.repeat(20);
const UUID = '11111111-1111-4111-8111-111111111111';

const b = (n: number, fill = 1) => Buffer.alloc(n, fill).toString('base64url');
const spki = (curve: string) =>
  crypto.generateKeyPairSync('ec', { namedCurve: curve }).publicKey.export({ format: 'der', type: 'spki' }) as Buffer;

function keyringBody(over: Record<string, unknown> = {}) {
  return {
    expectedEpoch: 0,
    password: 'pw',
    kdf: 'argon2id',
    kdfParams: { m: 65536, t: 3, p: 1 },
    pinSalt: b(16),
    wrappedVkPin: b(60),
    authKey: b(32),
    serverShare: b(32),
    vkSigPub: spki('prime256v1').toString('base64url'),
    wrappedVkSigKey: b(100),
    escrowBlob: b(60),
    sealedRootShare: b(157),
    rootKeyId: 'rk_test',
    userShareUnderVk: b(48),
    ...over,
  };
}

let app: FastifyInstance;
let authToken: string;

beforeAll(async () => {
  app = Fastify();
  app.register(jwt, { secret: 'test-secret' });
  app.decorate('authenticate', async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ message: 'Unauthorized' });
    }
  });

  // Replica di app.ts:75-113, inclusi i details/issues Zod (RT-13 verificato contro l'handler vero)
  app.setErrorHandler((error: any, request, reply) => {
    if (error instanceof AppError) return reply.status(error.statusCode).send({ message: error.message });
    if (error instanceof Error && error.name === 'ZodError') {
      return reply.status(400).send({ message: 'errors.common.validationError', details: error.issues });
    }
    if (error !== null && typeof error === 'object' && 'validation' in error) {
      return reply.status(400).send({ message: error instanceof Error ? error.message : 'errors.common.validationError' });
    }
    const httpStatus = error?.statusCode;
    if (typeof httpStatus === 'number' && httpStatus >= 400 && httpStatus < 500) {
      return reply.status(httpStatus).send({ message: error instanceof Error ? error.message : 'errors.common.error' });
    }
    return reply.status(500).send({ message: 'errors.common.internalError' });
  });

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
  process.env.VAULT_PEPPER_KEY = PEPPER;
});
afterEach(() => {
  if (savedPepper === undefined) delete process.env.VAULT_PEPPER_KEY;
  else process.env.VAULT_PEPPER_KEY = savedPepper;
});

const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, token: string | null = authToken) =>
  app.inject({
    method,
    url: `/api/vault${url}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload !== undefined ? { payload: payload as any } : {}),
  });

const routes: [('GET' | 'POST' | 'PUT'), string, unknown, string][] = [
  ['GET', '/keyring', undefined, 'getKeyring'],
  ['POST', '/keyring', keyringBody(), 'createKeyring'],
  ['POST', '/unlock', { authKey: b(32) }, 'unlock'],
  ['PUT', '/keyring', { payload: '{}', vkProof: b(64) }, 'updateKeyring'],
  ['POST', '/items', {}, 'getItems'],
  ['POST', '/migrate', { items: [{ id: UUID, baseHash: 'a'.repeat(64), content: 'nv3.x', noteType: 'NOTE' }] }, 'migrateItems'],
  ['POST', '/finalize', { ids: [UUID] }, 'finalize'],
];

describe('vault routes', () => {
  it('GET /keyring senza riga -> 200 forma NONE', async () => {
    svc.getKeyring.mockResolvedValue({ status: 'NONE', epoch: 0, rev: 0, migrationState: 'NONE', legacyCount: 0 });
    const res = await call('GET', '/keyring');
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('NONE');
    expect(svc.getKeyring).toHaveBeenCalledWith('user-1');
  });

  it('senza token -> 401', async () => {
    const res = await call('GET', '/keyring', undefined, null);
    expect(res.statusCode).toBe(401);
    expect(svc.getKeyring).not.toHaveBeenCalled();
  });

  describe.each(routes)('%s %s', (method, url, payload, fn) => {
    it.each([
      ['mancante', undefined],
      ['corto', 'short'],
      ['43 char con carattere non valido', 'A'.repeat(42) + '!'],
    ])('pepper %s -> 503, service non chiamato', async (_label, pepper) => {
      if (pepper === undefined) delete process.env.VAULT_PEPPER_KEY;
      else process.env.VAULT_PEPPER_KEY = pepper;
      const res = await call(method, url, payload);
      expect(res.statusCode).toBe(503);
      expect(res.json().message).toBe('errors.vault.unavailable');
      expect(svc[fn]).not.toHaveBeenCalled();
    });

    it.each([403, 409, 429, 503])('errore %i del service passa invariato con il suo messaggio, mai 401', async (code) => {
      svc[fn].mockRejectedValue(new AppError(code, 'errors.vault.x'));
      const res = await call(method, url, payload);
      expect(res.statusCode).toBe(code);
      expect(res.json()).toEqual({ message: 'errors.vault.x' });
    });
  });

  describe('validazione (RT-13)', () => {
    it('authKey di 31 byte -> 400 senza eco dell input', async () => {
      const res = await call('POST', '/unlock', { authKey: SECRET });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain(SECRET);
      expect(res.json()).toEqual({ message: 'errors.vault.invalidPayload' });
      expect(svc.unlock).not.toHaveBeenCalled();
    });

    it.each([
      ['POST', '/unlock', '{"authKey":"SECRETSECRET', 'unlock'],
      ['POST', '/keyring', '{"password":"SECRETSECRET', 'createKeyring'],
    ] as const)('JSON malformato su %s %s -> 400 senza eco', async (method, url, raw, fn) => {
      const res = await app.inject({
        method,
        url: `/api/vault${url}`,
        headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
        payload: raw,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain('SECRETSECRET');
      expect(res.json()).toEqual({ message: 'errors.vault.invalidPayload' });
      expect(svc[fn]).not.toHaveBeenCalled();
    });

    it('authKey 31 byte validi base64url -> 400', async () => {
      const res = await call('POST', '/unlock', { authKey: b(31) });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe('errors.vault.invalidPayload');
    });

    it('password troppo lunga -> 400 senza eco', async () => {
      const res = await call('POST', '/keyring', keyringBody({ password: SECRET + 'x'.repeat(1100) }));
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain(SECRET);
      expect(res.json()).toEqual({ message: 'errors.vault.invalidPayload' });
      expect(svc.createKeyring).not.toHaveBeenCalled();
    });

    it('payload > 65536 -> 400 senza eco', async () => {
      const res = await call('PUT', '/keyring', { payload: SECRET + 'x'.repeat(65536), vkProof: b(64) });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain(SECRET);
      expect(res.json()).toEqual({ message: 'errors.vault.invalidPayload' });
      expect(svc.updateKeyring).not.toHaveBeenCalled();
    });

    it('expectedEpoch fuori range -> 400', async () => {
      const res = await call('POST', '/keyring', keyringBody({ expectedEpoch: 2147483648 }));
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /keyring', () => {
    it('vkSigPub P-384 -> 400', async () => {
      const res = await call('POST', '/keyring', keyringBody({ vkSigPub: spki('secp384r1').toString('base64url') }));
      expect(res.statusCode).toBe(400);
      expect(svc.createKeyring).not.toHaveBeenCalled();
    });

    it('vkSigPub spazzatura di 91 byte -> 400', async () => {
      const res = await call('POST', '/keyring', keyringBody({ vkSigPub: b(91, 9) }));
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe('errors.vault.invalidPayload');
      expect(svc.createKeyring).not.toHaveBeenCalled();
    });

    it('P-256 valido -> 201 e service chiamato con Buffer decodificati', async () => {
      svc.createKeyring.mockResolvedValue({ status: 'READY', epoch: 1, rev: 1 });
      const res = await call('POST', '/keyring', keyringBody());
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ status: 'READY', epoch: 1, rev: 1 });
      const [uid, dto] = svc.createKeyring.mock.calls[0];
      expect(uid).toBe('user-1');
      expect(dto.expectedEpoch).toBe(0);
      const len = (k: string) => (dto[k] as Buffer).length;
      expect(Buffer.isBuffer(dto.authKey)).toBe(true);
      expect([len('pinSalt'), len('wrappedVkPin'), len('authKey'), len('serverShare'), len('vkSigPub')]).toEqual([16, 60, 32, 32, 91]);
      expect([len('wrappedVkSigKey'), len('escrowBlob'), len('sealedRootShare'), len('userShareUnderVk')]).toEqual([100, 60, 157, 48]);
    });
  });

  it('POST /unlock -> serverShare in base64url', async () => {
    svc.unlock.mockResolvedValue({ serverShare: Buffer.from([251, 255, 254, 250]) });
    const res = await call('POST', '/unlock', { authKey: b(32) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ serverShare: Buffer.from([251, 255, 254, 250]).toString('base64url') });
    expect(res.json().serverShare).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.isBuffer(svc.unlock.mock.calls[0][1])).toBe(true);
    expect(svc.unlock.mock.calls[0][1]).toHaveLength(32);
  });

  it('PUT /keyring passa vkProof come Buffer da 64 byte', async () => {
    svc.updateKeyring.mockResolvedValue({ rev: 2 });
    const res = await call('PUT', '/keyring', { payload: '{"rev":1}', vkProof: b(64) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rev: 2 });
    const [uid, payload, proof] = svc.updateKeyring.mock.calls[0];
    expect([uid, payload, proof.length]).toEqual(['user-1', '{"rev":1}', 64]);
  });

  it('POST /migrate accetta un body da ~2 MiB', async () => {
    svc.migrateItems.mockResolvedValue({ results: [{ id: UUID, status: 'ok' }] });
    const content = 'nv3.1.' + 'A'.repeat(2 * 1024 * 1024 - 6);
    const res = await call('POST', '/migrate', { items: [{ id: UUID, baseHash: 'f'.repeat(64), content, noteType: 'CREDENTIAL' }] });
    expect(res.statusCode).toBe(200);
    expect(svc.migrateItems).toHaveBeenCalledTimes(1);
    expect(svc.migrateItems.mock.calls[0][1][0].content).toHaveLength(2 * 1024 * 1024);
  });

  it('POST /migrate con content di 2 MiB + 1 -> 400', async () => {
    const content = 'A'.repeat(2 * 1024 * 1024 + 1);
    const res = await call('POST', '/migrate', { items: [{ id: UUID, baseHash: 'f'.repeat(64), content, noteType: 'NOTE' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ message: 'errors.vault.invalidPayload' });
    expect(svc.migrateItems).not.toHaveBeenCalled();
  });

  it('rate limit per utente: 11 unlock con X-Forwarded-For in allowList -> almeno un 429', async () => {
    const rl = Fastify({ trustProxy: true });
    rl.register(jwt, { secret: 'test-secret' });
    rl.decorate('authenticate', async (request: any) => {
      await request.jwtVerify();
    });
    await rl.register(rateLimit, { global: true, max: 1000, timeWindow: '1 minute', allowList: ['127.0.0.1'] });
    rl.register(vaultRoutes, { prefix: '/api/vault' });
    await rl.ready();
    svc.unlock.mockResolvedValue({ serverShare: Buffer.alloc(32) });
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await rl.inject({
        method: 'POST',
        url: '/api/vault/unlock',
        headers: { authorization: `Bearer ${authToken}`, 'x-forwarded-for': '127.0.0.1' },
        payload: { authKey: b(32) },
      });
      codes.push(res.statusCode);
    }
    await rl.close();
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(1);
  });

  describe('rate-limit instance (body malformati, 401)', () => {
    let rl: FastifyInstance;
    beforeEach(async () => {
      rl = Fastify({ trustProxy: true });
      rl.register(jwt, { secret: 'test-secret' });
      rl.decorate('authenticate', async (request: any) => {
        await request.jwtVerify();
      });
      await rl.register(rateLimit, { global: true, max: 1000, timeWindow: '1 minute', allowList: ['127.0.0.1'] });
      rl.register(vaultRoutes, { prefix: '/api/vault' });
      await rl.ready();
    });
    afterEach(async () => {
      await rl.close();
    });
    const post = (payload: string, headers: Record<string, string> = {}) =>
      rl.inject({
        method: 'POST',
        url: '/api/vault/unlock',
        headers: { authorization: `Bearer ${authToken}`, 'x-forwarded-for': '127.0.0.1', 'content-type': 'application/json', ...headers },
        payload,
      });

    it('body malformati contano nel limite per utente (11 su max 10) -> almeno un 429', async () => {
      const codes: number[] = [];
      for (let i = 0; i < 11; i++) codes.push((await post('{bad')).statusCode);
      expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(1);
    });

    it('413: body > 1 MiB -> status 413 e body fisso', async () => {
      const res = await post(JSON.stringify({ authKey: 'a'.repeat(1024 * 1024 + 1) }));
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({ message: 'errors.vault.invalidPayload' });
    });

    it('415: content-type non supportato -> status 415 e body fisso', async () => {
      // text/plain ha un parser built-in in Fastify (finirebbe in Zod -> 400): si usa un tipo senza parser.
      const res = await post('x', { 'content-type': 'application/xml' });
      expect(res.statusCode).toBe(415);
      expect(res.json()).toEqual({ message: 'errors.vault.invalidPayload' });
    });

    it('senza token -> 401 (non 500)', async () => {
      const res = await rl.inject({ method: 'POST', url: '/api/vault/unlock', payload: { authKey: b(32) } });
      expect(res.statusCode).toBe(401);
    });
  });

  it('POST /items e /finalize delegano con userId del token', async () => {
    svc.getItems.mockResolvedValue({ items: [], next: null });
    svc.finalize.mockResolvedValue({ finalized: 1 });
    expect((await call('POST', '/items', { ids: [UUID] })).statusCode).toBe(200);
    expect(svc.getItems).toHaveBeenCalledWith('user-1', { ids: [UUID] });
    expect((await call('POST', '/finalize', { ids: [UUID] })).statusCode).toBe(200);
    expect(svc.finalize).toHaveBeenCalledWith('user-1', [UUID]);
  });
});
