import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as noteService from '../services/note.service';
import { shareNote } from '../services/sharing.service';

const createNoteSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().default(''),
  notebookId: z.string().uuid(),
  content: z.string().optional(),
  isVault: z.boolean().optional(),
  isEncrypted: z.boolean().optional(),
});

const updateNoteSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  notebookId: z.string().uuid().optional(),
  isTrashed: z.boolean().optional(),
  reminderDate: z.string().nullable().optional(),
  isReminderDone: z.boolean().optional(),
  isPinned: z.boolean().optional(),
  isVault: z.boolean().optional(),
  isEncrypted: z.boolean().optional(),
  tags: z.array(z.object({
    tag: z.object({
      id: z.string().uuid(),
      name: z.string().optional()
    })
  })).optional(),
});

export default async function (fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.post('/', async (request, reply) => {
    console.log('POST /notes payload:', JSON.stringify(request.body, null, 2));
    const { notebookId, title, content, id, isVault, isEncrypted } = createNoteSchema.parse(request.body);
    const note = await noteService.createNote(request.user.id, notebookId, title, content, id, isVault, isEncrypted);
    console.log('POST /notes created note:', note.id);
    return note;
  });

  fastify.get('/', async (request, reply) => {
    const { notebookId, search, tagId, reminderFilter, includeTrashed } = request.query as {
      notebookId?: string;
      search?: string;
      tagId?: string;
      reminderFilter?: 'all' | 'pending' | 'done';
      includeTrashed?: string;
    };
    console.log('GET /notes params:', { notebookId, search, tagId, reminderFilter, includeTrashed });
    const notes = await noteService.getNotes(request.user.id, notebookId, search, tagId, reminderFilter, includeTrashed === 'true');
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
    const note = await noteService.toggleShare(request.user.id, id);
    return note;
  });
}
