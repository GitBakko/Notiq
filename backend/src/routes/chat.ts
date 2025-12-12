import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as chatService from '../services/chat.service';

const createMessageSchema = z.object({
  noteId: z.string().uuid(),
  content: z.string().min(1),
});

export default async function chatRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.post('/', async (request, reply) => {
    const { noteId, content } = createMessageSchema.parse(request.body);
    const message = await chatService.createMessage(request.user.id, noteId, content);
    return message;
  });

  fastify.get('/:noteId', async (request, reply) => {
    const { noteId } = request.params as { noteId: string };
    // TODO: Check access permission (Is owner or shared)?
    // For now assuming if they know the UUID they might have access, but strictly should check.
    // chatService could check access.
    const messages = await chatService.getMessages(noteId);
    return messages;
  });
}
