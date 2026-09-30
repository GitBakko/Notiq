import crypto from 'crypto';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../utils/errors';
import * as vaultService from '../services/vault.service';
import { b64url, pepperStatus } from '../services/vault.service';

const bytes = (v: string) => Buffer.from(v, 'base64url');

const keyringSchema = z.object({
  expectedEpoch: z.number().int().min(0).max(2147483647),
  password: z.string().min(1).max(1024),
  kdf: z.literal('argon2id'),
  kdfParams: z.object({
    m: z.number().int().min(65536).max(1048576),
    t: z.number().int().min(3).max(10),
    p: z.literal(1),
  }),
  pinSalt: b64url(16),
  wrappedVkPin: b64url(60),
  authKey: b64url(32),
  serverShare: b64url(32),
  vkSigPub: b64url(91),
  wrappedVkSigKey: b64url([80, 220]),
  escrowBlob: b64url(60),
  sealedRootShare: b64url(157),
  rootKeyId: z.string().min(1).max(64),
  userShareUnderVk: b64url(48),
});

const unlockSchema = z.object({ authKey: b64url(32) });
const updateSchema = z.object({ payload: z.string().max(65536), vkProof: b64url(64) });
const itemsSchema = z.object({ ids: z.array(z.string().uuid()).max(200).optional(), after: z.string().uuid().optional() });
const migrateSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        baseHash: z.string().regex(/^[0-9a-f]{64}$/),
        content: z.string().max(2 * 1024 * 1024),
        noteType: z.enum(['NOTE', 'CREDENTIAL']),
      }),
    )
    .min(1)
    .max(200),
});
const finalizeSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });

// Fallimento = 400 fisso, senza issues: il gestore globale di app.ts rimanda gli issues Zod (RT-13).
function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new AppError(400, 'errors.vault.invalidPayload');
  return r.data;
}

function assertP256(der: Buffer) {
  try {
    const k = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (k.asymmetricKeyType === 'ec' && k.asymmetricKeyDetails?.namedCurve === 'prime256v1') return;
  } catch {
    // cade nel 400 sotto
  }
  throw new AppError(400, 'errors.vault.invalidPayload');
}

// Per-utente (non per IP spoofabile via X-Forwarded-For); fase onRequest di default: dopo authenticate (hook di istanza), prima del parsing del body.
const limit = (max: number, timeWindow: string) => ({
  config: {
    rateLimit: { max, timeWindow, keyGenerator: (req: FastifyRequest) => req.user.id },
  },
});

export default async function vaultRoutes(fastify: FastifyInstance) {
  // Defense in depth (RT-13): Fastify 5.7.x restituisce gia' un messaggio FST_ERR_CTP costante; questo handler garantisce
  // un body fisso a prescindere da parser/versione, mantenendo lo status originale (413, 415).
  fastify.setErrorHandler((err: Error & { code?: string; statusCode?: number }, _request, reply) => {
    if (err instanceof SyntaxError || String(err.code ?? '').startsWith('FST_ERR_CTP')) {
      return reply.status(err.statusCode ?? 400).send({ message: 'errors.vault.invalidPayload' });
    }
    throw err;
  });
  fastify.addHook('onRequest', fastify.authenticate);
  fastify.addHook('preHandler', async () => {
    if (pepperStatus().status !== 'ok') throw new AppError(503, 'errors.vault.unavailable');
  });

  fastify.get('/keyring', limit(60, '1 minute'), async (request) => {
    return vaultService.getKeyring(request.user.id);
  });

  fastify.post('/keyring', limit(5, '1 hour'), async (request, reply) => {
    const b = parse(keyringSchema, request.body);
    const vkSigPub = bytes(b.vkSigPub);
    assertP256(vkSigPub);
    const result = await vaultService.createKeyring(request.user.id, {
      expectedEpoch: b.expectedEpoch,
      password: b.password,
      kdf: b.kdf,
      kdfParams: b.kdfParams,
      pinSalt: bytes(b.pinSalt),
      wrappedVkPin: bytes(b.wrappedVkPin),
      authKey: bytes(b.authKey),
      serverShare: bytes(b.serverShare),
      vkSigPub,
      wrappedVkSigKey: bytes(b.wrappedVkSigKey),
      escrowBlob: bytes(b.escrowBlob),
      sealedRootShare: bytes(b.sealedRootShare),
      rootKeyId: b.rootKeyId,
      userShareUnderVk: bytes(b.userShareUnderVk),
    });
    return reply.status(201).send(result);
  });

  fastify.post('/unlock', limit(10, '1 minute'), async (request) => {
    const b = parse(unlockSchema, request.body);
    const { serverShare } = await vaultService.unlock(request.user.id, bytes(b.authKey));
    return { serverShare: serverShare.toString('base64url') };
  });

  fastify.put('/keyring', limit(10, '1 hour'), async (request) => {
    const b = parse(updateSchema, request.body);
    return vaultService.updateKeyring(request.user.id, b.payload, bytes(b.vkProof));
  });

  fastify.post('/items', limit(60, '1 minute'), async (request) => {
    const b = parse(itemsSchema, request.body);
    return vaultService.getItems(request.user.id, b);
  });

  fastify.post('/migrate', { bodyLimit: 16 * 1024 * 1024, ...limit(20, '1 minute') }, async (request) => {
    const b = parse(migrateSchema, request.body);
    return vaultService.migrateItems(request.user.id, b.items);
  });

  fastify.post('/finalize', limit(20, '1 minute'), async (request) => {
    const b = parse(finalizeSchema, request.body);
    return vaultService.finalize(request.user.id, b.ids);
  });
}
