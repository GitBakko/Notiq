import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import * as kanbanService from '../services/kanban.service';
import { assertBoardAccess, getColumnWithAccess, getCardWithAccess } from '../services/kanbanPermissions';
import { addConnection } from '../services/kanbanSSE';
import prisma from '../plugins/prisma';

// ─── Zod schemas ────────────────────────────────────────────

const createBoardSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const updateBoardSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
});

const createColumnSchema = z.object({
  title: z.string().min(1).max(100),
});

const reorderColumnsSchema = z.object({
  columns: z.array(z.object({ id: z.string(), position: z.number().int().min(0) })),
});

const createCardSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
});

const updateCardSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  noteId: z.string().nullable().optional(),
});

const moveCardSchema = z.object({
  toColumnId: z.string(),
  position: z.number().int().min(0),
});

const createCommentSchema = z.object({
  content: z.string().min(1).max(5000),
});

const chatMessageSchema = z.object({
  content: z.string().min(1).max(5000),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(50),
});

// ─── Error handler helper ───────────────────────────────────

function handleKanbanError(error: unknown, reply: any) {
  const msg = error instanceof Error ? error.message : 'Unknown error';
  if (
    msg === 'Board not found' ||
    msg === 'Column not found' ||
    msg === 'Card not found' ||
    msg === 'Comment not found' ||
    msg === 'Reminder not found' ||
    msg === 'TaskList not found'
  ) {
    return reply.status(404).send({ message: msg });
  }
  if (
    msg === 'Access denied' ||
    msg === 'Write access required' ||
    msg === 'Not your comment' ||
    msg === 'Only the note owner can link this note' ||
    msg === 'Only the user who linked the note can unlink it'
  ) {
    return reply.status(403).send({ message: msg });
  }
  if (
    msg === 'Column has cards' ||
    msg === 'Board already has a linked note' ||
    msg === 'Board has no linked note' ||
    msg === 'Card already has a linked note' ||
    msg === 'Card has no linked note'
  ) {
    return reply.status(409).send({ message: msg });
  }
  throw error;
}

// ─── Upload helpers ─────────────────────────────────────────

const UPLOADS_DIR = path.join(__dirname, '../../uploads');
const KANBAN_UPLOADS_DIR = path.join(UPLOADS_DIR, 'kanban');
const KANBAN_AVATARS_DIR = path.join(UPLOADS_DIR, 'kanban', 'avatars');
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_COVER_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2MB

// ─── Route plugin ───────────────────────────────────────────

export default async function kanbanRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // ── Kanban Reminders ───────────────────────────────────

  fastify.get('/reminders', async (request) => {
    const { getUserKanbanReminders } = await import('../services/kanbanReminder.service');
    const reminders = await getUserKanbanReminders(request.user.id);
    return reminders.map((r) => ({
      id: r.id,
      cardId: r.cardId,
      boardId: r.boardId,
      dueDate: r.dueDate,
      isDone: r.isDone,
      cardTitle: r.card.title,
      boardTitle: r.card.column.board.title,
      columnTitle: r.card.column.title,
      boardAvatarUrl: r.card.column.board.avatarUrl,
    }));
  });

  const updateReminderSchema = z.object({
    isDone: z.boolean(),
  });

  fastify.put('/reminders/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { isDone } = updateReminderSchema.parse(request.body);
      const { toggleReminderDone } = await import('../services/kanbanReminder.service');
      await toggleReminderDone(id, request.user.id, isDone);
      return { success: true };
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  // ── Boards ──────────────────────────────────────────────

  fastify.get('/boards', async (request) => {
    return kanbanService.listBoards(request.user.id);
  });

  fastify.post('/boards', async (request, reply) => {
    try {
      const { title, description } = createBoardSchema.parse(request.body);
      return await kanbanService.createBoard(request.user.id, title, description);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  // Create board from task list
  const fromTaskListSchema = z.object({
    taskListId: z.string().uuid(),
  });

  fastify.post('/boards/from-tasklist', async (request, reply) => {
    try {
      const { taskListId } = fromTaskListSchema.parse(request.body);
      return await kanbanService.createBoardFromTaskList(request.user.id, taskListId);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  fastify.get('/boards/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await assertBoardAccess(id, request.user.id, 'READ');
      return await kanbanService.getBoard(id, request.user.id);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  fastify.put('/boards/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await assertBoardAccess(id, request.user.id, 'WRITE');
      const data = updateBoardSchema.parse(request.body);
      return await kanbanService.updateBoard(id, data);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  fastify.delete('/boards/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { isOwner } = await assertBoardAccess(id, request.user.id, 'WRITE');
      if (!isOwner) {
        return reply.status(403).send({ message: 'Only the owner can delete a board' });
      }
      await kanbanService.deleteBoard(id);
      return { success: true };
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  // ── Cover Image ───────────────────────────────────────────

  fastify.post('/boards/:id/cover', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await assertBoardAccess(id, request.user.id, 'WRITE');

      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ message: 'No file uploaded' });
      }
      if (!ALLOWED_IMAGE_TYPES.has(data.mimetype)) {
        return reply.status(400).send({ message: 'Only JPEG, PNG, GIF, WebP images are allowed' });
      }

      // Read file into buffer and check size
      const chunks: Buffer[] = [];
      let totalSize = 0;
      for await (const chunk of data.file) {
        totalSize += chunk.length;
        if (totalSize > MAX_COVER_SIZE) {
          return reply.status(400).send({ message: 'File too large (max 5MB)' });
        }
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      // Ensure directory exists
      if (!fs.existsSync(KANBAN_UPLOADS_DIR)) {
        fs.mkdirSync(KANBAN_UPLOADS_DIR, { recursive: true });
      }

      // Delete old cover if present
      const currentBoard = await prisma.kanbanBoard.findUnique({
        where: { id },
        select: { coverImage: true },
      });
      if (currentBoard?.coverImage) {
        const oldFile = path.join(UPLOADS_DIR, currentBoard.coverImage.replace(/^\/uploads\//, ''));
        if (fs.existsSync(oldFile)) {
          fs.unlinkSync(oldFile);
        }
      }

      // Save new file
      const ext = path.extname(data.filename || '.jpg').toLowerCase();
      const filename = `${randomUUID()}${ext}`;
      const filepath = path.join(KANBAN_UPLOADS_DIR, filename);
      fs.writeFileSync(filepath, buffer);

      const coverUrl = `/uploads/kanban/${filename}`;
      await prisma.kanbanBoard.update({
        where: { id },
        data: { coverImage: coverUrl },
      });

      return { coverImage: coverUrl };
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  fastify.delete('/boards/:id/cover', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await assertBoardAccess(id, request.user.id, 'WRITE');

      const board = await prisma.kanbanBoard.findUnique({
        where: { id },
        select: { coverImage: true },
      });
      if (board?.coverImage) {
        const oldFile = path.join(UPLOADS_DIR, board.coverImage.replace(/^\/uploads\//, ''));
        if (fs.existsSync(oldFile)) {
          fs.unlinkSync(oldFile);
        }
      }

      await prisma.kanbanBoard.update({
        where: { id },
        data: { coverImage: null },
      });

      return { success: true };
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  // ── Board Avatar ──────────────────────────────────────────

  fastify.post('/boards/:id/avatar', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await assertBoardAccess(id, request.user.id, 'WRITE');

      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ message: 'No file uploaded' });
      }
      if (!ALLOWED_IMAGE_TYPES.has(data.mimetype)) {
        return reply.status(400).send({ message: 'Only JPEG, PNG, GIF, WebP images are allowed' });
      }

      // Read file into buffer and check size
      const chunks: Buffer[] = [];
      let totalSize = 0;
      for await (const chunk of data.file) {
        totalSize += chunk.length;
        if (totalSize > MAX_AVATAR_SIZE) {
          return reply.status(400).send({ message: 'File too large (max 2MB)' });
        }
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      // Ensure directory exists
      if (!fs.existsSync(KANBAN_AVATARS_DIR)) {
        fs.mkdirSync(KANBAN_AVATARS_DIR, { recursive: true });
      }

      // Delete old avatar if present
      const currentBoard = await prisma.kanbanBoard.findUnique({
        where: { id },
        select: { avatarUrl: true },
      });
      if (currentBoard?.avatarUrl) {
        const oldFile = path.join(UPLOADS_DIR, currentBoard.avatarUrl.replace(/^\/uploads\//, ''));
        if (fs.existsSync(oldFile)) {
          fs.unlinkSync(oldFile);
        }
      }

      // Save new file
      const ext = path.extname(data.filename || '.jpg').toLowerCase();
      const filename = `${randomUUID()}${ext}`;
      const filepath = path.join(KANBAN_AVATARS_DIR, filename);
      fs.writeFileSync(filepath, buffer);

      const avatarUrl = `/uploads/kanban/avatars/${filename}`;
      await prisma.kanbanBoard.update({
        where: { id },
        data: { avatarUrl },
      });

      return { avatarUrl };
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  fastify.delete('/boards/:id/avatar', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await assertBoardAccess(id, request.user.id, 'WRITE');

      const board = await prisma.kanbanBoard.findUnique({
        where: { id },
        select: { avatarUrl: true },
      });
      if (board?.avatarUrl) {
        const oldFile = path.join(UPLOADS_DIR, board.avatarUrl.replace(/^\/uploads\//, ''));
        if (fs.existsSync(oldFile)) {
          fs.unlinkSync(oldFile);
        }
      }

      await prisma.kanbanBoard.update({
        where: { id },
        data: { avatarUrl: null },
      });

      return { success: true };
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  // ── Board Note Linking ─────────────────────────────────────

  const boardLinkNoteSchema = z.object({
    noteId: z.string().uuid(),
    shareWithUserIds: z.array(z.string().uuid()).optional(),
  });

  fastify.get('/boards/:id/check-note-sharing', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await assertBoardAccess(id, request.user.id, 'READ');
      const { noteId } = z.object({ noteId: z.string().uuid() }).parse(request.query);
      return await kanbanService.checkNoteSharingForBoard(noteId, id, request.user.id);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  fastify.post('/boards/:id/link-note', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await assertBoardAccess(id, request.user.id, 'WRITE');
      const { noteId, shareWithUserIds } = boardLinkNoteSchema.parse(request.body);
      return await kanbanService.linkNoteToBoard(id, noteId, request.user.id, shareWithUserIds);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  fastify.delete('/boards/:id/link-note', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await assertBoardAccess(id, request.user.id, 'WRITE');
      return await kanbanService.unlinkNoteFromBoard(id, request.user.id);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  // ── SSE ─────────────────────────────────────────────────

  fastify.get('/boards/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.id;

    try {
      await assertBoardAccess(id, userId, 'READ');
    } catch (error) {
      return handleKanbanError(error, reply);
    }

    // Fetch user info for presence
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, color: true, avatarUrl: true },
    });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    addConnection(id, reply.raw, {
      id: userId,
      name: user?.name ?? null,
      color: user?.color ?? null,
      avatarUrl: user?.avatarUrl ?? null,
    });
    reply.raw.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    request.raw.on('close', () => {
      /* cleanup handled by addConnection */
    });
  });

  // ── Board Chat ────────────────────────────────────────────

  fastify.get('/boards/:id/chat', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await assertBoardAccess(id, request.user.id, 'READ');
      const { page, limit } = paginationSchema.parse(request.query);
      return await kanbanService.getBoardChat(id, page, limit);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  fastify.post('/boards/:id/chat', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await assertBoardAccess(id, request.user.id, 'READ'); // Any participant can chat
      const { content } = chatMessageSchema.parse(request.body);
      return await kanbanService.createBoardChatMessage(id, request.user.id, content);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  // ── Columns ─────────────────────────────────────────────

  fastify.post('/boards/:id/columns', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await assertBoardAccess(id, request.user.id, 'WRITE');
      const { title } = createColumnSchema.parse(request.body);
      return await kanbanService.createColumn(id, title);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  fastify.put('/columns/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await getColumnWithAccess(id, request.user.id, 'WRITE');
      const { title } = createColumnSchema.parse(request.body);
      return await kanbanService.updateColumn(id, title);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  fastify.put('/boards/:id/columns/reorder', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await assertBoardAccess(id, request.user.id, 'WRITE');
      const { columns } = reorderColumnsSchema.parse(request.body);
      await kanbanService.reorderColumns(id, columns);
      return { success: true };
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  fastify.delete('/columns/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await getColumnWithAccess(id, request.user.id, 'WRITE');
      await kanbanService.deleteColumn(id);
      return { success: true };
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  // ── Cards ───────────────────────────────────────────────

  fastify.post('/columns/:id/cards', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await getColumnWithAccess(id, request.user.id, 'WRITE');
      const { title, description } = createCardSchema.parse(request.body);
      return await kanbanService.createCard(id, title, description, request.user.id);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  fastify.put('/cards/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await getCardWithAccess(id, request.user.id, 'WRITE');
      const data = updateCardSchema.parse(request.body);
      return await kanbanService.updateCard(id, data, request.user.id);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  fastify.put('/cards/:id/move', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await getCardWithAccess(id, request.user.id, 'WRITE');
      const { toColumnId, position } = moveCardSchema.parse(request.body);
      await kanbanService.moveCard(id, toColumnId, position, request.user.id);
      return { success: true };
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  fastify.delete('/cards/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await getCardWithAccess(id, request.user.id, 'WRITE');
      await kanbanService.deleteCard(id);
      return { success: true };
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  // ── Card Activities ─────────────────────────────────────

  fastify.get('/cards/:id/activities', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await getCardWithAccess(id, request.user.id, 'READ');
      const { page, limit } = paginationSchema.parse(request.query);
      return await kanbanService.getCardActivities(id, page, limit);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  // ── Comments ────────────────────────────────────────────

  fastify.get('/cards/:id/comments', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await getCardWithAccess(id, request.user.id, 'READ');
      const { page, limit } = paginationSchema.parse(request.query);
      return await kanbanService.getComments(id, page, limit);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  fastify.post('/cards/:id/comments', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await getCardWithAccess(id, request.user.id, 'WRITE');
      const { content } = createCommentSchema.parse(request.body);
      return await kanbanService.createComment(id, request.user.id, content);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  fastify.delete('/comments/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await kanbanService.deleteComment(id, request.user.id);
      return { success: true };
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  // ─── Note Linking ────────────────────────────────────────

  const linkNoteSchema = z.object({
    noteId: z.string().uuid(),
    shareWithUserIds: z.array(z.string().uuid()).optional(),
  });

  // Check note sharing gap relative to board participants
  fastify.get('/cards/:id/check-note-sharing', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { noteId } = z.object({ noteId: z.string().uuid() }).parse(request.query);
      const { boardId } = await getCardWithAccess(id, request.user.id, 'READ');
      return await kanbanService.checkNoteSharingForBoard(noteId, boardId, request.user.id);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  // Link a note to a card (optionally auto-share with users)
  fastify.post('/cards/:id/link-note', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await getCardWithAccess(id, request.user.id, 'WRITE');
      const { noteId, shareWithUserIds } = linkNoteSchema.parse(request.body);
      return await kanbanService.linkNoteToCard(id, noteId, request.user.id, shareWithUserIds);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  // Unlink a note from a card (only by linker)
  fastify.delete('/cards/:id/link-note', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await getCardWithAccess(id, request.user.id, 'WRITE');
      return await kanbanService.unlinkNoteFromCard(id, request.user.id);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  // Search user's notes for the note picker
  fastify.get('/notes/search', async (request, reply) => {
    try {
      const { q } = z.object({ q: z.string().optional().default('') }).parse(request.query);
      return await kanbanService.searchUserNotes(request.user.id, q);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });

  // Get boards linked to a note (for quick-link in note editor)
  fastify.get('/notes/:noteId/linked-boards', async (request, reply) => {
    try {
      const { noteId } = request.params as { noteId: string };
      return await kanbanService.getLinkedBoardsForNote(noteId, request.user.id);
    } catch (error) {
      return handleKanbanError(error, reply);
    }
  });
}
