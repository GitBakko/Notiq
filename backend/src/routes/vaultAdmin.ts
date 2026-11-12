import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import prisma from '../plugins/prisma';
import { AppError } from '../utils/errors';
import { pepperStatus } from '../services/vault.service';
import * as recoveryService from '../services/vaultRecovery.service';

const idSchema = z.object({ id: z.string().uuid() });
const listSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
  status: z.enum(['PENDING_APPROVAL', 'PENDING_CODE', 'WAITING', 'RELEASED', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'REJECTED']).optional(),
  userId: z.string().uuid().optional(),
});
const NO_CTRL = /^(?:[^\p{Cc}]|[\t\n\r])*$/u; // vieta i caratteri di controllo (NUL, ESC, DEL...) tranne tab, LF, CR: Postgres rifiuta NUL con un 500
const rejectSchema = z.object({ reason: z.string().min(1).max(500).regex(NO_CTRL) });
const releaseSchema = z.object({ passphrase: z.string().min(1).max(1024) });

// Fallimento = 400 fisso, senza issues (mai l'eco della passphrase).
function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new AppError(400, 'errors.vault.invalidPayload');
  return r.data;
}

// Per admin (id utente), non per IP: come vault.ts.
const limit = (max: number, timeWindow: string) => ({
  config: { rateLimit: { max, timeWindow, keyGenerator: (req: FastifyRequest) => req.user.id } },
});

// Registrato dentro admin.ts (prefisso /vault-recovery): l'onRequest authenticate arriva da li'.
export default async function vaultAdminRoutes(fastify: FastifyInstance) {
  fastify.setErrorHandler((err: Error & { code?: string; statusCode?: number }, _request, reply) => {
    if (err instanceof SyntaxError || String(err.code ?? '').startsWith('FST_ERR_CTP')) {
      return reply.status(err.statusCode ?? 400).send({ message: 'errors.vault.invalidPayload' });
    }
    throw err;
  });
  fastify.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  // Ruolo dal DB, mai dal JWT (un token con role falsificato o declassato non deve passare).
  fastify.addHook('preHandler', async (request) => {
    const user = await prisma.user.findUnique({ where: { id: request.user.id }, select: { role: true } });
    if (user?.role !== 'SUPERADMIN') throw new AppError(403, 'errors.common.forbidden');
  });
  fastify.addHook('preHandler', async () => {
    if (pepperStatus().status !== 'ok') throw new AppError(503, 'errors.vault.unavailable');
  });

  fastify.get('/', limit(60, '1 minute'), async (request) => {
    return recoveryService.listRecoveriesForAdmin(parse(listSchema, request.query));
  });

  fastify.get('/:id', limit(60, '1 minute'), async (request) => {
    const { id } = parse(idSchema, request.params);
    return recoveryService.getRecoveryForAdmin(id);
  });

  fastify.post('/:id/approve', limit(30, '1 minute'), async (request) => {
    const { id } = parse(idSchema, request.params);
    return recoveryService.approveRecovery(request.user.id, id);
  });

  fastify.post('/:id/reject', limit(30, '1 minute'), async (request) => {
    const { id } = parse(idSchema, request.params);
    const b = parse(rejectSchema, request.body);
    return recoveryService.rejectRecovery(request.user.id, id, b.reason);
  });

  // Il contatore DB (checkReleaseRate) sopravvive al restart; questo limite ferma le richieste parallele.
  fastify.post('/:id/release', limit(3, '15 minutes'), async (request) => {
    const { id } = parse(idSchema, request.params);
    const b = parse(releaseSchema, request.body);
    return recoveryService.releaseRecovery(request.user.id, id, b.passphrase);
  });
}
