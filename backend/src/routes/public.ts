import { FastifyInstance } from 'fastify';
import * as noteService from '../services/note.service';

export default async function publicRoutes(fastify: FastifyInstance) {
  fastify.get('/notes/:shareId', async (request, reply) => {
    const { shareId } = request.params as { shareId: string };
    const note = await noteService.getPublicNote(shareId);
    
    if (!note || !note.isPublic) {
        return reply.status(404).send({ message: 'errors.notes.notFoundOrNotPublic' });
    }
    
    return note;
  });
}
