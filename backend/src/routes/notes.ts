import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as noteService from '../services/note.service';
import { shareNote } from '../services/sharing.service';

const createNoteSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().default(''),
  notebookId: z.string().uuid(),
  content: z.string().optional(),
});

const updateNoteSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  notebookId: z.string().uuid().optional(),
  isTrashed: z.boolean().optional(),
  reminderDate: z.string().nullable().optional(),
  isReminderDone: z.boolean().optional(),
  isPinned: z.boolean().optional(),
});

export default async function noteRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.post('/', async (request, reply) => {
    const { id, title, notebookId, content } = createNoteSchema.parse(request.body);
    const note = await noteService.createNote(request.user.id, notebookId, title, content, id);
    return note;
  });

  fastify.get('/', async (request, reply) => {
    const { notebookId, search, tagId, reminderFilter } = request.query as {
      notebookId?: string;
      search?: string;
      tagId?: string;
      reminderFilter?: 'all' | 'pending' | 'done';
    };
    const notes = await noteService.getNotes(request.user.id, notebookId, search, tagId, reminderFilter);
    return notes;
  });

  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const note = await noteService.getNote(request.user.id, id);
    if (!note) return reply.status(404).send({ message: 'Note not found' });
    return note;
  });

  fastify.put('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = updateNoteSchema.parse(request.body);
    await noteService.updateNote(request.user.id, id, data);
    return { message: 'Note updated' };
  });

  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await noteService.deleteNote(request.user.id, id);
    return { message: 'Note deleted' };
  });

  fastify.post('/:id/share', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { email, permission } = request.body as { email: string, permission: 'READ' | 'WRITE' };
    const note = await shareNote(request.user.id, id, email, permission);
    return note;
  });
}
