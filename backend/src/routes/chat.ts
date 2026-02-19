import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as chatService from '../services/chat.service';
import { checkNoteAccess } from '../services/note.service';

const createMessageSchema = z.object({
  noteId: z.string().uuid(),
  content: z.string().min(1),
});

export default async function chatRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.post('/', async (request, reply) => {
    const { noteId, content } = createMessageSchema.parse(request.body);
    const access = await checkNoteAccess(request.user.id, noteId);
    if (!access) return reply.code(403).send({ message: 'Forbidden' });
    // Chat is allowed for both READ and WRITE users — it's communication, not note editing
    const message = await chatService.createMessage(request.user.id, noteId, content);
    return message;
  });

  fastify.get('/:noteId', async (request, reply) => {
    const { noteId } = request.params as { noteId: string };
    const access = await checkNoteAccess(request.user.id, noteId);
    if (!access) return reply.code(403).send({ message: 'Forbidden' });
    const messages = await chatService.getMessages(noteId);
    return messages;
  });
}
