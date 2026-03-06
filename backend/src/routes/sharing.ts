import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as sharingService from '../services/sharing.service';
import * as taskListSharingService from '../services/tasklist-sharing.service';
import * as taskListService from '../services/tasklist.service';
import { Permission } from '@prisma/client';
import prisma from '../plugins/prisma';

const shareSchema = z.object({
  email: z.string().email(),
  permission: z.nativeEnum(Permission).optional().default('READ'),
});

const respondByIdSchema = z.object({
  itemId: z.string().uuid(),
  type: z.enum(['NOTE', 'NOTEBOOK', 'TASKLIST', 'KANBAN']),
  action: z.enum(['accept', 'decline']),
});

import * as noteService from '../services/note.service';
import * as groupService from '../services/group.service';

export default async function sharingRoutes(fastify: FastifyInstance) {
  // Public Note Access
  fastify.get('/public/:shareId', async (request, reply) => {
    const { shareId } = request.params as { shareId: string };
    const note = await noteService.getPublicNote(shareId);
    if (!note) return reply.status(404).send({ message: 'errors.notes.notFound' });
    return note;
  });

  fastify.addHook('onRequest', fastify.authenticate);

  // Get Sent Shares (all types, for "My Invitations" panel)
  fastify.get('/sent', async (request) => {
    return sharingService.getSentShares(request.user.id);
  });

  // Resend share invitation email
  fastify.post('/resend/:type/:id', { config: { rateLimit: { max: 3, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const { type, id } = request.params as { type: string; id: string };
    const validTypes = ['NOTE', 'NOTEBOOK', 'TASKLIST', 'KANBAN'];
    if (!validTypes.includes(type.toUpperCase())) {
      return reply.status(400).send({ message: 'errors.sharing.invalidType' });
    }

    const result = await sharingService.resendShareInvitation(
      request.user.id,
      type.toUpperCase() as 'NOTE' | 'NOTEBOOK' | 'TASKLIST' | 'KANBAN',
      id
    );
    return result;
  });

  // Respond to Share by ID (Directly from dashboard)
  fastify.post('/respond-id', async (request) => {
    const { itemId, type, action } = respondByIdSchema.parse(request.body);

    if (type === 'TASKLIST') {
      return taskListSharingService.respondToTaskListShareById(request.user.id, itemId, action);
    }
    if (type === 'KANBAN') {
      return sharingService.respondToShareById(request.user.id, itemId, 'KANBAN', action);
    }
    return sharingService.respondToShareById(request.user.id, itemId, type, action);
  });

  // Share Note
  fastify.post('/notes/:id', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const { id } = request.params as { id: string };
    const { email, permission } = shareSchema.parse(request.body);
    return sharingService.shareNote(request.user.id, id, email, permission);
  });

  // Revoke Note Share
  fastify.delete('/notes/:id/:userId', async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };

    try {
      await sharingService.revokeNoteShare(request.user.id, id, userId);
      return { success: true };
    } catch (error: unknown) {
      // Prisma P2025: record already deleted — treat as idempotent success
      if (error instanceof Object && 'code' in error && error.code === 'P2025') {
        return { success: true };
      }
      throw error;
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

  // Update recipient's metadata for a shared note (notebook assignment)
  fastify.put('/notes/:noteId/metadata', async (request, reply) => {
    const { noteId } = z.object({ noteId: z.string().uuid() }).parse(request.params);
    const { recipientNotebookId } = z.object({
      recipientNotebookId: z.string().uuid().nullable(),
    }).parse(request.body);

    const share = await prisma.sharedNote.findUnique({
      where: { noteId_userId: { noteId, userId: request.user.id } },
    });
    if (!share || share.status !== 'ACCEPTED') {
      return reply.status(404).send({ message: 'errors.sharing.notFound' });
    }

    if (recipientNotebookId) {
      const notebook = await prisma.notebook.findFirst({
        where: { id: recipientNotebookId, userId: request.user.id },
      });
      if (!notebook) {
        return reply.status(404).send({ message: 'errors.notebooks.notFound' });
      }
    }

    return prisma.sharedNote.update({
      where: { noteId_userId: { noteId, userId: request.user.id } },
      data: { recipientNotebookId },
    });
  });

  // Save shared note content/title (REST fallback for when Hocuspocus doesn't persist in time)
  fastify.put('/notes/:noteId/content', async (request, reply) => {
    const { noteId } = z.object({ noteId: z.string().uuid() }).parse(request.params);
    const { content, title } = z.object({
      content: z.string().optional(),
      title: z.string().optional(),
    }).parse(request.body);

    if (!content && !title) {
      return reply.status(400).send({ message: 'errors.validation.required' });
    }

    const share = await prisma.sharedNote.findUnique({
      where: { noteId_userId: { noteId, userId: request.user.id } },
    });
    if (!share || share.status !== 'ACCEPTED' || share.permission !== 'WRITE') {
      return reply.status(403).send({ message: 'errors.sharing.forbidden' });
    }

    const note = await prisma.note.findUnique({ where: { id: noteId }, select: { content: true, title: true } });
    if (!note) return reply.status(404).send({ message: 'errors.notes.notFound' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: any = { updatedAt: new Date() };

    if (content && note.content !== content) {
      const { extractTextFromTipTapJson } = await import('../utils/extractText');
      updateData.content = content;
      updateData.searchText = extractTextFromTipTapJson(content);
      // Clear ydocState so Hocuspocus fetch falls through to content field.
      // The stale Yjs binary would otherwise take priority over updated content.
      updateData.ydocState = null;
    }

    if (title && note.title !== title) {
      updateData.title = title;
    }

    // Only write if something actually changed
    if (Object.keys(updateData).length > 1) {
      await prisma.note.update({ where: { id: noteId }, data: updateData });
    }

    return { ok: true };
  });

  // Share Notebook
  fastify.post('/notebooks/:id', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const { id } = request.params as { id: string };
    const { email, permission } = shareSchema.parse(request.body);
    return sharingService.shareNotebook(request.user.id, id, email, permission);
  });

  // Revoke Notebook Share
  fastify.delete('/notebooks/:id/:userId', async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };

    try {
      await sharingService.revokeNotebookShare(request.user.id, id, userId);
      return { success: true };
    } catch (error: unknown) {
      if (error instanceof Object && 'code' in error && error.code === 'P2025') {
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
  fastify.post('/notes/:id/group', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    const { id } = request.params as { id: string };
    const { groupId, permission } = z.object({
      groupId: z.string(),
      permission: z.nativeEnum(Permission).optional().default('READ'),
    }).parse(request.body);

    const group = await groupService.getGroup(groupId, request.user.id);
    const results = [];
    const errors = [];
    for (const member of group.members) {
      if (member.userId === request.user.id) continue;
      try {
        // Per-member catch: collect individual failures for partial success response
        const r = await sharingService.shareNote(request.user.id, id, member.user.email, permission);
        results.push(r);
      } catch (e: unknown) {
        errors.push({ userId: member.userId, error: e instanceof Error ? e.message : 'Unknown error' });
      }
    }
    return { shared: results.length, errors };
  });

  // Share Notebook with Group
  fastify.post('/notebooks/:id/group', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    const { id } = request.params as { id: string };
    const { groupId, permission } = z.object({
      groupId: z.string(),
      permission: z.nativeEnum(Permission).optional().default('READ'),
    }).parse(request.body);

    const group = await groupService.getGroup(groupId, request.user.id);
    const results = [];
    const errors = [];
    for (const member of group.members) {
      if (member.userId === request.user.id) continue;
      try {
        // Per-member catch: collect individual failures for partial success response
        const r = await sharingService.shareNotebook(request.user.id, id, member.user.email, permission);
        results.push(r);
      } catch (e: unknown) {
        errors.push({ userId: member.userId, error: e instanceof Error ? e.message : 'Unknown error' });
      }
    }
    return { shared: results.length, errors };
  });

  // ── Task List Sharing ─────────────────────────────────────────

  // Share Task List
  fastify.post('/tasklists/:id', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const { id } = request.params as { id: string };
    const { email, permission } = shareSchema.parse(request.body);
    return taskListSharingService.shareTaskList(request.user.id, id, email, permission);
  });

  // Revoke Task List Share
  fastify.delete('/tasklists/:id/:userId', async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };

    try {
      await taskListSharingService.revokeTaskListShare(request.user.id, id, userId);
      return { success: true };
    } catch (error: unknown) {
      if (error instanceof Object && 'code' in error && error.code === 'P2025') {
        return { success: true };
      }
      throw error;
    }
  });

  // Get Shared Task Lists (all statuses)
  fastify.get('/tasklists', async (request) => {
    return taskListSharingService.getSharedTaskLists(request.user.id);
  });

  // Get Accepted Shared Task Lists (for sync)
  fastify.get('/tasklists/accepted', async (request) => {
    return taskListService.getAcceptedSharedTaskLists(request.user.id);
  });

  // Share Task List with Group
  fastify.post('/tasklists/:id/group', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    const { id } = request.params as { id: string };
    const { groupId, permission } = z.object({
      groupId: z.string(),
      permission: z.nativeEnum(Permission).optional().default('READ'),
    }).parse(request.body);

    const group = await groupService.getGroup(groupId, request.user.id);
    const results = [];
    const errors = [];
    for (const member of group.members) {
      if (member.userId === request.user.id) continue;
      try {
        // Per-member catch: collect individual failures for partial success response
        const r = await taskListSharingService.shareTaskList(request.user.id, id, member.user.email, permission);
        results.push(r);
      } catch (e: unknown) {
        errors.push({ userId: member.userId, error: e instanceof Error ? e.message : 'Unknown error' });
      }
    }
    return { shared: results.length, errors };
  });

  // ── Kanban Board Sharing ────────────────────────────────────

  // Share Kanban Board
  fastify.post('/kanbans/:id', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const { id } = request.params as { id: string };
    const { email, permission } = shareSchema.parse(request.body);
    return sharingService.shareKanbanBoard(request.user.id, id, email, permission);
  });

  // Revoke Kanban Board Share
  fastify.delete('/kanbans/:id/:userId', async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };
    await sharingService.revokeKanbanBoardShare(request.user.id, id, userId);
    return { success: true };
  });

  // Share Kanban Board with Group
  fastify.post('/kanbans/:id/group', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    const { id } = request.params as { id: string };
    const { groupId, permission } = z.object({
      groupId: z.string(),
      permission: z.nativeEnum(Permission).optional().default('READ'),
    }).parse(request.body);

    const group = await groupService.getGroup(groupId, request.user.id);
    const results = [];
    const errors = [];
    for (const member of group.members) {
      if (member.userId === request.user.id) continue;
      try {
        // Per-member catch: collect individual failures for partial success response
        const r = await sharingService.shareKanbanBoard(request.user.id, id, member.user.email, permission);
        results.push(r);
      } catch (e: unknown) {
        errors.push({ userId: member.userId, error: e instanceof Error ? e.message : 'Unknown error' });
      }
    }
    return { shared: results.length, errors };
  });

  // Get Accepted Shared Kanban Boards (for sync)
  fastify.get('/kanbans/accepted', async (request) => {
    const shares = await prisma.sharedKanbanBoard.findMany({
      where: { userId: request.user.id, status: 'ACCEPTED' },
      include: {
        board: {
          include: {
            owner: { select: { id: true, name: true, email: true, avatarUrl: true } },
            columns: {
              orderBy: { position: 'asc' },
              include: {
                cards: {
                  orderBy: { position: 'asc' },
                  include: {
                    assignee: { select: { id: true, name: true, email: true, avatarUrl: true } },
                    _count: { select: { comments: true } },
                  },
                },
              },
            },
            _count: { select: { columns: true } },
          },
        },
      },
    });
    return shares.map(s => ({
      ...s.board,
      _sharedPermission: s.permission,
    }));
  });

  // Get Shared Kanban Boards (all statuses)
  fastify.get('/kanbans', async (request) => {
    const shares = await prisma.sharedKanbanBoard.findMany({
      where: { userId: request.user.id },
      include: {
        board: {
          select: {
            id: true,
            title: true,
            description: true,
            ownerId: true,
            owner: { select: { id: true, name: true, email: true, avatarUrl: true } },
          },
        },
      },
    });
    return shares;
  });
}
