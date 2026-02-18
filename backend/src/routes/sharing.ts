import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as sharingService from '../services/sharing.service';
import { Permission } from '@prisma/client';

const shareSchema = z.object({
  email: z.string().email(),
  permission: z.nativeEnum(Permission).optional().default('READ'),
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
    const { token, action } = request.body as { token: string; action: 'accept' | 'decline' };

    // No auth middleware required for this, as it depends on the token?
    // Actually, usually users should be logged in to accept, so we know who is accepting?
    // But the token contains the userId. So technically we can trust the token.
    // However, for security, maybe require login?
    // The requirement says "Link in email". If they click it, they might not be logged in.
    // Ideally, the token validates them.
    // But our route hook `fastify.addHook('onRequest', fastify.authenticate);` is applied to ALL routes in this file because of line 22!
    // We need to support unauthenticated access OR move this route above the hook.
    // Line 15 (public note) is above the hook.
    // I should move this route above the hook or ensure the user logs in.
    // For specific user-based sharing, they MUST be logged in as the correct user to avoid confusion?
    // But the JWT encodes userId. If I use the token to identify them, I don't need the session.
    // However, `respondToShare` updates `SharedNote` which is linked to a user.
    // Use the token.

    // BUT wait, line 22 applies to everything below.
    // I probably want to allow responding without being logged in (e.g. on mobile/different device).
    // So I should place this route ABOVE line 22.

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
    const { itemId, type, action } = request.body as { itemId: string; type: 'NOTE' | 'NOTEBOOK'; action: 'accept' | 'decline' };

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
      console.error('Share Note Error:', error);
      return reply.status(500).send({ message: error.message || 'Internal Server Error' });
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
      console.error('Revoke Share Error:', error);
      return reply.status(500).send({ message: error.message || 'Internal Server Error' });
    }
  });

  // Get Shared Notes
  fastify.get('/notes', async (request, reply) => {
    const notes = await sharingService.getSharedNotes(request.user.id);
    return notes;
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
      console.error('Share Notebook Error:', error);
      return reply.status(500).send({ message: error.message || 'Internal Server Error' });
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
      return reply.status(500).send({ message: error.message });
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
      return reply.status(500).send({ message: error.message });
    }
  });
}
