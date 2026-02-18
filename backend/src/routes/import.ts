
import { FastifyInstance } from 'fastify';
import * as importService from '../services/import.service';

export default async function importRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.post<{
    Querystring: { notebookId?: string; isVault?: string }
  }>('/evernote', async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ message: 'No file uploaded' });
    }

    const { notebookId, isVault } = request.query;

    try {
      const buffer = await data.toBuffer();
      const result = await importService.importFromEnex(
        buffer,
        request.user.id,
        notebookId,
        isVault === 'true'
      );
      return result;
    } catch (error: any) {
      return reply.status(400).send({ message: error.message || 'Import failed' });
    }
  });
}
