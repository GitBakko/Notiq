import { FastifyInstance } from 'fastify';
import { searchNotes } from '../services/search.service';

export default async function searchRoutes(fastify: FastifyInstance) {
  // GET /api/search?q=term&page=1&limit=20&notebookId=optional
  fastify.get('/', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const { q, page, limit, notebookId } = request.query as {
      q?: string;
      page?: string;
      limit?: string;
      notebookId?: string;
    };

    if (!q || q.trim().length < 2) {
      return reply.status(400).send({ error: 'Query must be at least 2 characters' });
    }

    const pageNum = Math.max(1, parseInt(page || '1', 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit || '20', 10) || 20));

    const results = await searchNotes(
      request.user.id,
      q.trim(),
      pageNum,
      limitNum,
      notebookId
    );

    return results;
  });
}
