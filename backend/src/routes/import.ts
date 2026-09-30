
import { FastifyInstance } from 'fastify';
import * as importService from '../services/import.service';
import * as onenoteImportService from '../services/onenote-import.service';
import { getVaultGuard } from '../services/vault.service';
import { AppError } from '../utils/errors';

export default async function importRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.post<{
    Querystring: { notebookId?: string; isVault?: string }
  }>('/evernote', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { notebookId, isVault } = request.query;
    if (isVault === 'true' && await getVaultGuard(request.user.id)) throw new AppError(422, 'errors.vault.importBlocked');

    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ message: 'errors.attachments.noFileUploaded' });
    }

    try {
      const buffer = await data.toBuffer();
      const result = await importService.importFromEnex(
        buffer,
        request.user.id,
        notebookId,
        isVault === 'true'
      );
      return result;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Import failed';
      return reply.status(400).send({ message: msg });
    }
  });

  fastify.post<{
    Querystring: { notebookId?: string; isVault?: string }
  }>('/onenote', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { notebookId, isVault } = request.query;
    if (isVault === 'true' && await getVaultGuard(request.user.id)) throw new AppError(422, 'errors.vault.importBlocked');

    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ message: 'errors.attachments.noFileUploaded' });
    }

    try {
      const buffer = await data.toBuffer();
      const result = await onenoteImportService.importFromOneNote(
        buffer,
        data.filename,
        request.user.id,
        notebookId,
        isVault === 'true'
      );
      return result;
    } catch (error: unknown) {
      request.log.error(error, 'OneNote import failed');
      const msg = error instanceof Error ? error.message : 'Import failed';
      return reply.status(400).send({ message: msg });
    }
  });
}
