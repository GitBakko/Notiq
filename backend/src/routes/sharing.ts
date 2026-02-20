import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as sharingService from '../services/sharing.service';
import { Permission } from '@prisma/client';

const shareSchema = z.object({
  email: z.string().email(),
  permission: z.nativeEnum(Permission).optional().default('READ'),
});

const respondSchema = z.object({
  token: z.string().min(1),
  action: z.enum(['accept', 'decline']),
});

const respondByIdSchema = z.object({
  itemId: z.string().uuid(),
  type: z.enum(['NOTE', 'NOTEBOOK']),
  action: z.enum(['accept', 'decline']),
});

import * as noteService from '../services/note.service';
import * as groupService from '../services/group.service';

export default async function sharingRoutes(fastify: FastifyInstance) {
  // Public Note Access
  fastify.get('/public/:shareId', async (request, reply) => {
    const { shareId } = request.params as { shareId: string };
    const note = await noteService.getPublicNote(shareId);
    if (!note) return reply.status(404).send({ message: 'Note not found' });
    return note;
  });

  // Respond to Share Invitation
  fastify.post('/respond', async (request, reply) => {
    const { token, action } = respondSchema.parse(request.body);

    try {
      const result = await sharingService.respondToShare(token, action);
      return result;
    } catch (error: any) {
      if (error.message === 'Invalid or expired token') {
        return reply.status(400).send({ message: 'Invalid or expired invitation' });
      }
      throw error;
    }
  });

  fastify.addHook('onRequest', fastify.authenticate);

  // Respond to Share by ID (Directly from dashboard)
  fastify.post('/respond-id', async (request, reply) => {
    const { itemId, type, action } = respondByIdSchema.parse(request.body);

    try {
      const result = await sharingService.respondToShareById(request.user.id, itemId, type, action);
      return result;
    } catch (error: any) {
      if (error.message === 'Invitation not found') {
        return reply.status(404).send({ message: 'Invitation not found' });
      }
      throw error;
    }
  });

  // Share Note
  fastify.post('/notes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { email, permission } = shareSchema.parse(request.body);

    try {
      const result = await sharingService.shareNote(request.user.id, id, email, permission);
      return result;
    } catch (error: any) {
      if (error.message === 'User not found') {
        return reply.status(404).send({ message: 'User not found' });
      }
      if (error.message === 'Note not found or access denied') {
        return reply.status(403).send({ message: 'Access denied' });
      }
      if (error.message === 'Cannot share with yourself') {
        return reply.status(400).send({ message: 'Cannot share with yourself' });
      }
      request.log.error(error, 'Share Note Error');
      return reply.status(500).send({ message: 'An internal error occurred' });
    }
  });

  // Revoke Note Share
  fastify.delete('/notes/:id/:userId', async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };

    try {
      await sharingService.revokeNoteShare(request.user.id, id, userId);
      return { success: true };
    } catch (error: any) {
      if (error.code === 'P2025') { // Record to delete does not exist
        return { success: true };
      }
      request.log.error(error, 'Revoke Share Error');
      return reply.status(500).send({ message: 'An internal error occurred' });
    }
  });

  // Get Shared Notes (all statuses — for SharedWithMePage)
  fastify.get('/notes', async (request, reply) => {
    const notes = await sharingService.getSharedNotes(request.user.id);
    return notes;
  });

  // Get Accepted Shared Notes (for sync into main notes list)
  fastify.get('/notes/accepted', async (request) => {
    return sharingService.getAcceptedSharedNotes(request.user.id);
  });

  // Share Notebook
  fastify.post('/notebooks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { email, permission } = shareSchema.parse(request.body);

    try {
      const result = await sharingService.shareNotebook(request.user.id, id, email, permission);
      return result;
    } catch (error: any) {
      if (error.message === 'User not found') {
        return reply.status(404).send({ message: 'User not found' });
      }
      if (error.message === 'Notebook not found or access denied') {
        return reply.status(403).send({ message: 'Access denied' });
      }
      if (error.message === 'Cannot share with yourself') {
        return reply.status(400).send({ message: 'Cannot share with yourself' });
      }
      request.log.error(error, 'Share Notebook Error');
      return reply.status(500).send({ message: 'An internal error occurred' });
    }
  });

  // Revoke Notebook Share
  fastify.delete('/notebooks/:id/:userId', async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };

    try {
      await sharingService.revokeNotebookShare(request.user.id, id, userId);
      return { success: true };
    } catch (error: any) {
      if (error.code === 'P2025') {
        return { success: true };
      }
      throw error;
    }
  });

  // Get Shared Notebooks
  fastify.get('/notebooks', async (request, reply) => {
    const notebooks = await sharingService.getSharedNotebooks(request.user.id);
    return notebooks;
  });

  // Share Note with Group
  fastify.post('/notes/:id/group', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { groupId, permission } = z.object({
      groupId: z.string(),
      permission: z.nativeEnum(Permission).optional().default('READ'),
    }).parse(request.body);

    try {
      const group = await groupService.getGroup(groupId, request.user.id);
      const results = [];
      const errors = [];
      for (const member of group.members) {
        if (member.userId === request.user.id) continue;
        try {
          const r = await sharingService.shareNote(request.user.id, id, member.user.email, permission);
          results.push(r);
        } catch (e: any) {
          errors.push({ userId: member.userId, error: e.message });
        }
      }
      return { shared: results.length, errors };
    } catch (error: any) {
      if (error.message === 'Access denied') return reply.status(403).send({ message: 'Access denied' });
      if (error.message === 'Group not found') return reply.status(404).send({ message: 'Group not found' });
      return reply.status(500).send({ message: 'An internal error occurred' });
    }
  });

  // Share Notebook with Group
  fastify.post('/notebooks/:id/group', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { groupId, permission } = z.object({
      groupId: z.string(),
      permission: z.nativeEnum(Permission).optional().default('READ'),
    }).parse(request.body);

    try {
      const group = await groupService.getGroup(groupId, request.user.id);
      const results = [];
      const errors = [];
      for (const member of group.members) {
        if (member.userId === request.user.id) continue;
        try {
          const r = await sharingService.shareNotebook(request.user.id, id, member.user.email, permission);
          results.push(r);
        } catch (e: any) {
          errors.push({ userId: member.userId, error: e.message });
        }
      }
      return { shared: results.length, errors };
    } catch (error: any) {
      if (error.message === 'Access denied') return reply.status(403).send({ message: 'Access denied' });
      if (error.message === 'Group not found') return reply.status(404).send({ message: 'Group not found' });
      return reply.status(500).send({ message: 'An internal error occurred' });
    }
  });
}
