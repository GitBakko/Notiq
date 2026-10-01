import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as noteService from '../services/note.service';
import { shareNote } from '../services/sharing.service';
import { listNoteVersions, restoreNoteVersion } from '../services/noteVersion.service';
import { flushLiveDoc, replaceLiveDocContent } from '../hocuspocus';

const createNoteSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().default(''),
  notebookId: z.string().uuid(),
  content: z.string().optional(),
  isVault: z.boolean().optional(),
  isEncrypted: z.boolean().optional(),
  noteType: z.enum(['NOTE', 'CREDENTIAL']).optional().default('NOTE'),
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
  baseHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  tags: z.array(z.object({
    tag: z.object({
      id: z.string().uuid(),
      name: z.string().optional()
    })
  })).optional(),
});

const getNotesQuerySchema = z.object({
  notebookId: z.string().uuid().optional(),
  search: z.string().optional(),
  tagId: z.string().uuid().optional(),
  reminderFilter: z.enum(['all', 'pending', 'done']).optional(),
  includeTrashed: z.string().optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(50),
});

export default async function (fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.post('/', async (request, reply) => {
    const { notebookId, title, content, id, isVault, isEncrypted, noteType } = createNoteSchema.parse(request.body);
    const note = await noteService.createNote(request.user.id, title, (content || ''), notebookId, isVault, isEncrypted, id, noteType);
    return note;
  });

  fastify.get('/', async (request, reply) => {
    const { notebookId, search, tagId, reminderFilter, includeTrashed, page, limit } = getNotesQuerySchema.parse(request.query);
    const notes = await noteService.getNotes(
      request.user.id, notebookId, search, tagId, reminderFilter,
      includeTrashed === 'true',
      page,
      limit
    );
    return notes;
  });

  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const note = await noteService.getNote(request.user.id, id);
    if (!note) return reply.status(404).send({ message: 'errors.notes.notFound' });
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

  fastify.get('/:id/size', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return await noteService.getNoteSizeBreakdown(request.user.id, id);
  });

  fastify.get('/:id/versions', async (request, _reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return listNoteVersions(request.user.id, id);
  });

  fastify.post('/:id/versions/:versionId/restore', async (request, _reply) => {
    const { id, versionId } = z.object({
      id: z.string().uuid(),
      versionId: z.string().uuid(),
    }).parse(request.params);
    // Persist unsaved live edits (after ownership/version checks) so restore's forced snapshot archives them. Never blocks the restore.
    const { restoredContent } = await restoreNoteVersion(request.user.id, id, versionId, {
      beforeRestore: async () => {
        try {
          await flushLiveDoc(id);
        } catch (err) {
          request.log.warn({ err, noteId: id }, 'restore: live collab doc not flushed — unsaved edits may not be archived');
        }
      },
    });
    // An open collab session keeps the OLD Y doc in memory; its next store() would undo the restore.
    if (restoredContent) {
      try {
        await replaceLiveDocContent(id, restoredContent);
      } catch (err) {
        request.log.error({ err, noteId: id }, 'restore: live collab doc not updated — open sessions may overwrite it');
      }
    }
    return { ok: true };
  });
}
