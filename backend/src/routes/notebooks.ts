import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as notebookService from '../services/notebook.service';

const createNotebookSchema = z.object({
  name: z.string().min(1),
  id: z.string().uuid().optional(),
});

const updateNotebookSchema = z.object({
  name: z.string().min(1),
});

export default async function notebookRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.post('/', async (request, reply) => {
    const { name, id } = createNotebookSchema.parse(request.body);
    const notebook = await notebookService.createNotebook(request.user.id, name, id);
    return notebook;
  });

  fastify.get('/', async (request, reply) => {
    const notebooks = await notebookService.getNotebooks(request.user.id);
    return notebooks;
  });

  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const notebook = await notebookService.getNotebook(request.user.id, id);
    if (!notebook) return reply.status(404).send({ message: 'errors.notebooks.notFound' });
    return notebook;
  });

  fastify.put('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { name } = updateNotebookSchema.parse(request.body);
    await notebookService.updateNotebook(request.user.id, id, name);
    return { message: 'Notebook updated' };
  });

  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await notebookService.deleteNotebook(request.user.id, id);
    return { message: 'Notebook deleted' };
  });
}
