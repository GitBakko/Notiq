import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import prisma from '../plugins/prisma';
import { AppError } from '../utils/errors';
import { getE2eCodeB } from '../utils/vaultE2e';

const idSchema = z.object({ id: z.string().uuid() });

// Registrata da routes/vault.ts solo con isVaultE2E(): mai in produzione.
export default async function vaultE2eRoutes(fastify: FastifyInstance) {
  fastify.get('/__e2e/recovery/:id/code-b', { onRequest: [fastify.authenticate] }, async (request) => {
    const p = idSchema.safeParse(request.params);
    if (!p.success) throw new AppError(404, 'errors.vault.recoveryNotFound');
    const own = await prisma.vaultRequest.findFirst({ where: { id: p.data.id, userId: request.user.id, type: 'RECOVERY' }, select: { id: true } });
    const codeB = own ? getE2eCodeB(p.data.id) : undefined;
    if (!codeB) throw new AppError(404, 'errors.vault.recoveryNotFound');
    return { codeB };
  });

  fastify.post('/__e2e/recovery/:id/advance', { onRequest: [fastify.authenticate] }, async (request) => {
    const p = idSchema.safeParse(request.params);
    if (!p.success) throw new AppError(404, 'errors.vault.recoveryNotFound');
    const r = await prisma.vaultRequest.updateMany({
      where: { id: p.data.id, userId: request.user.id, type: 'RECOVERY', status: 'WAITING' },
      data: { notBefore: new Date(Date.now() - 1000) },
    });
    if (r.count !== 1) throw new AppError(409, 'errors.vault.recoveryStateConflict');
    return { ok: true };
  });
}
