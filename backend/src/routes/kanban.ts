import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import * as kanbanService from '../services/kanban/index';
import { assertBoardAccess, getColumnWithAccess, getCardWithAccess } from '../services/kanbanPermissions';
import { addConnection } from '../services/kanbanSSE';
import prisma from '../plugins/prisma';

// ─── Zod schemas ────────────────────────────────────────────

const columnTitlesSchema = z.object({
  todo: z.string().min(1).max(100),
  inProgress: z.string().min(1).max(100),
  done: z.string().min(1).max(100),
}).optional();

const createBoardSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  columnTitles: columnTitlesSchema,
});

const updateBoardSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
});

const createColumnSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1).max(100),
});

const reorderColumnsSchema = z.object({
  columns: z.array(z.object({ id: z.string(), position: z.number().int().min(0) })),
});

const createCardSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
});

const updateCardSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  priority: z.enum(['STANDBY', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).nullable().optional(),
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

  fastify.put('/reminders/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { isDone } = updateReminderSchema.parse(request.body);
    const { toggleReminderDone } = await import('../services/kanbanReminder.service');
    await toggleReminderDone(id, request.user.id, isDone);
    return { success: true };
  });

  // ── Boards ──────────────────────────────────────────────

  fastify.get('/boards', async (request) => {
    return kanbanService.listBoards(request.user.id);
  });

  fastify.post('/boards', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const { id, title, description, columnTitles } = createBoardSchema.parse(request.body);
    return await kanbanService.createBoard(request.user.id, title, description, columnTitles, id);
  });

  // Create board from task list
  const fromTaskListSchema = z.object({
    taskListId: z.string().uuid(),
    columnTitles: z.object({
      todo: z.string().min(1).max(100),
      done: z.string().min(1).max(100),
    }).optional(),
  });

  fastify.post('/boards/from-tasklist', async (request) => {
    const { taskListId, columnTitles } = fromTaskListSchema.parse(request.body);
    return await kanbanService.createBoardFromTaskList(request.user.id, taskListId, columnTitles);
  });

  fastify.get('/boards/:id', async (request) => {
    const { id } = request.params as { id: string };
    await assertBoardAccess(id, request.user.id, 'READ');
    return await kanbanService.getBoard(id, request.user.id);
  });

  fastify.put('/boards/:id', async (request) => {
    const { id } = request.params as { id: string };
    await assertBoardAccess(id, request.user.id, 'WRITE');
    const data = updateBoardSchema.parse(request.body);
    return await kanbanService.updateBoard(id, data);
  });

  fastify.delete('/boards/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { isOwner } = await assertBoardAccess(id, request.user.id, 'WRITE');
    if (!isOwner) {
      return reply.status(403).send({ message: 'errors.kanban.onlyOwnerCanDelete' });
    }
    await kanbanService.deleteBoard(id);
    return { success: true };
  });

  // ── Cover Image ───────────────────────────────────────────

  fastify.post('/boards/:id/cover', async (request, reply) => {
    const { id } = request.params as { id: string };
    await assertBoardAccess(id, request.user.id, 'WRITE');

    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ message: 'errors.attachments.noFileUploaded' });
    }
    if (!ALLOWED_IMAGE_TYPES.has(data.mimetype)) {
      return reply.status(400).send({ message: 'errors.common.onlyImageFormatsAllowed' });
    }

    // Read file into buffer and check size
    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of data.file) {
      totalSize += chunk.length;
      if (totalSize > MAX_COVER_SIZE) {
        return reply.status(400).send({ message: 'errors.kanban.coverTooLarge' });
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
  });

  fastify.delete('/boards/:id/cover', async (request) => {
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
  });

  // ── Board Avatar ──────────────────────────────────────────

  fastify.post('/boards/:id/avatar', async (request, reply) => {
    const { id } = request.params as { id: string };
    await assertBoardAccess(id, request.user.id, 'WRITE');

    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ message: 'errors.attachments.noFileUploaded' });
    }
    if (!ALLOWED_IMAGE_TYPES.has(data.mimetype)) {
      return reply.status(400).send({ message: 'errors.common.onlyImageFormatsAllowed' });
    }

    // Read file into buffer and check size
    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of data.file) {
      totalSize += chunk.length;
      if (totalSize > MAX_AVATAR_SIZE) {
        return reply.status(400).send({ message: 'errors.kanban.avatarTooLarge' });
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
  });

  fastify.delete('/boards/:id/avatar', async (request) => {
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
  });

  // ── Board Note Linking ─────────────────────────────────────

  const boardLinkNoteSchema = z.object({
    noteId: z.string().uuid(),
    shareWithUserIds: z.array(z.string().uuid()).optional(),
  });

  fastify.get('/boards/:id/check-note-sharing', async (request) => {
    const { id } = request.params as { id: string };
    await assertBoardAccess(id, request.user.id, 'READ');
    const { noteId } = z.object({ noteId: z.string().uuid() }).parse(request.query);
    return await kanbanService.checkNoteSharingForBoard(noteId, id, request.user.id);
  });

  fastify.post('/boards/:id/link-note', async (request) => {
    const { id } = request.params as { id: string };
    await assertBoardAccess(id, request.user.id, 'WRITE');
    const { noteId, shareWithUserIds } = boardLinkNoteSchema.parse(request.body);
    return await kanbanService.linkNoteToBoard(id, noteId, request.user.id, shareWithUserIds);
  });

  fastify.delete('/boards/:id/link-note', async (request) => {
    const { id } = request.params as { id: string };
    await assertBoardAccess(id, request.user.id, 'WRITE');
    return await kanbanService.unlinkNoteFromBoard(id, request.user.id);
  });

  // ── SSE ─────────────────────────────────────────────────

  fastify.get('/boards/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.id;

    // assertBoardAccess throws typed errors handled by global error handler
    // (called before SSE headers are written, so Fastify can still send JSON error)
    await assertBoardAccess(id, userId, 'READ');

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

  fastify.get('/boards/:id/chat', async (request) => {
    const { id } = request.params as { id: string };
    await assertBoardAccess(id, request.user.id, 'READ');
    const { page, limit } = paginationSchema.parse(request.query);
    return await kanbanService.getBoardChat(id, page, limit);
  });

  fastify.post('/boards/:id/chat', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const { id } = request.params as { id: string };
    await assertBoardAccess(id, request.user.id, 'READ'); // Any participant can chat
    const { content } = chatMessageSchema.parse(request.body);
    return await kanbanService.createBoardChatMessage(id, request.user.id, content);
  });

  // ── Columns ─────────────────────────────────────────────

  fastify.post('/boards/:id/columns', async (request) => {
    const { id } = request.params as { id: string };
    await assertBoardAccess(id, request.user.id, 'WRITE');
    const { id: clientId, title } = createColumnSchema.parse(request.body);
    return await kanbanService.createColumn(id, title, clientId);
  });

  const updateColumnSchema = z.object({
    title: z.string().min(1).max(100).optional(),
    isCompleted: z.boolean().optional(),
  });

  fastify.put('/columns/:id', async (request) => {
    const { id } = request.params as { id: string };
    await getColumnWithAccess(id, request.user.id, 'WRITE');
    const data = updateColumnSchema.parse(request.body);
    return await kanbanService.updateColumn(id, data);
  });

  fastify.put('/boards/:id/columns/reorder', async (request) => {
    const { id } = request.params as { id: string };
    await assertBoardAccess(id, request.user.id, 'WRITE');
    const { columns } = reorderColumnsSchema.parse(request.body);
    await kanbanService.reorderColumns(id, columns);
    return { success: true };
  });

  fastify.delete('/columns/:id', async (request) => {
    const { id } = request.params as { id: string };
    await getColumnWithAccess(id, request.user.id, 'WRITE');
    await kanbanService.deleteColumn(id);
    return { success: true };
  });

  // ── Cards ───────────────────────────────────────────────

  fastify.post('/columns/:id/cards', { config: { rateLimit: { max: 50, timeWindow: '1 minute' } } }, async (request) => {
    const { id } = request.params as { id: string };
    await getColumnWithAccess(id, request.user.id, 'WRITE');
    const { id: clientId, title, description } = createCardSchema.parse(request.body);
    return await kanbanService.createCard(id, title, description, request.user.id, clientId);
  });

  fastify.put('/cards/:id', async (request) => {
    const { id } = request.params as { id: string };
    await getCardWithAccess(id, request.user.id, 'WRITE');
    const data = updateCardSchema.parse(request.body);
    return await kanbanService.updateCard(id, data, request.user.id);
  });

  fastify.put('/cards/:id/move', async (request) => {
    const { id } = request.params as { id: string };
    await getCardWithAccess(id, request.user.id, 'WRITE');
    const { toColumnId, position } = moveCardSchema.parse(request.body);
    const silent = (request.query as { silent?: string }).silent === 'true';
    await kanbanService.moveCard(id, toColumnId, position, request.user.id, silent);
    return { success: true };
  });

  const bulkMoveNotifySchema = z.object({
    moves: z.array(z.object({
      cardId: z.string(),
      fromColumnId: z.string(),
      toColumnId: z.string(),
    })),
  });

  fastify.post('/boards/:boardId/bulk-move-notify', async (request) => {
    const { boardId } = request.params as { boardId: string };
    const { moves } = bulkMoveNotifySchema.parse(request.body);
    await assertBoardAccess(boardId, request.user.id, 'WRITE');
    await kanbanService.bulkMoveNotify(boardId, moves, request.user.id);
    return { success: true };
  });

  fastify.delete('/cards/:id', async (request) => {
    const { id } = request.params as { id: string };
    await getCardWithAccess(id, request.user.id, 'WRITE');
    await kanbanService.deleteCard(id);
    return { success: true };
  });

  // ── Card Activities ─────────────────────────────────────

  fastify.get('/cards/:id/activities', async (request) => {
    const { id } = request.params as { id: string };
    await getCardWithAccess(id, request.user.id, 'READ');
    const { page, limit } = paginationSchema.parse(request.query);
    return await kanbanService.getCardActivities(id, page, limit);
  });

  // ── Comments ────────────────────────────────────────────

  fastify.get('/cards/:id/comments', async (request) => {
    const { id } = request.params as { id: string };
    await getCardWithAccess(id, request.user.id, 'READ');
    const { page, limit } = paginationSchema.parse(request.query);
    return await kanbanService.getComments(id, page, limit);
  });

  fastify.post('/cards/:id/comments', async (request) => {
    const { id } = request.params as { id: string };
    await getCardWithAccess(id, request.user.id, 'WRITE');
    const { content } = createCommentSchema.parse(request.body);
    return await kanbanService.createComment(id, request.user.id, content);
  });

  fastify.delete('/comments/:id', async (request) => {
    const { id } = request.params as { id: string };
    await kanbanService.deleteComment(id, request.user.id);
    return { success: true };
  });

  // ─── Note Linking ────────────────────────────────────────

  const linkNoteSchema = z.object({
    noteId: z.string().uuid(),
    shareWithUserIds: z.array(z.string().uuid()).optional(),
  });

  // Check note sharing gap relative to board participants
  fastify.get('/cards/:id/check-note-sharing', async (request) => {
    const { id } = request.params as { id: string };
    const { noteId } = z.object({ noteId: z.string().uuid() }).parse(request.query);
    const { boardId } = await getCardWithAccess(id, request.user.id, 'READ');
    return await kanbanService.checkNoteSharingForBoard(noteId, boardId, request.user.id);
  });

  // Link a note to a card (optionally auto-share with users)
  fastify.post('/cards/:id/link-note', async (request) => {
    const { id } = request.params as { id: string };
    await getCardWithAccess(id, request.user.id, 'WRITE');
    const { noteId, shareWithUserIds } = linkNoteSchema.parse(request.body);
    return await kanbanService.linkNoteToCard(id, noteId, request.user.id, shareWithUserIds);
  });

  // Unlink a note from a card (only by linker)
  fastify.delete('/cards/:id/link-note', async (request) => {
    const { id } = request.params as { id: string };
    await getCardWithAccess(id, request.user.id, 'WRITE');
    return await kanbanService.unlinkNoteFromCard(id, request.user.id);
  });

  // Search user's notes for the note picker
  fastify.get('/notes/search', async (request) => {
    const { q } = z.object({ q: z.string().optional().default('') }).parse(request.query);
    return await kanbanService.searchUserNotes(request.user.id, q);
  });

  // Get boards linked to a note (for quick-link in note editor)
  fastify.get('/notes/:noteId/linked-boards', async (request) => {
    const { noteId } = request.params as { noteId: string };
    return await kanbanService.getLinkedBoardsForNote(noteId, request.user.id);
  });

  // ── Archived Cards ────────────────────────────────────────

  fastify.get('/boards/:id/archived', async (request) => {
    const { id } = request.params as { id: string };
    await assertBoardAccess(id, request.user.id, 'READ');
    return await kanbanService.getArchivedCards(id);
  });

  fastify.post('/cards/:id/unarchive', async (request) => {
    const { id } = request.params as { id: string };
    await getCardWithAccess(id, request.user.id, 'WRITE');
    return await kanbanService.unarchiveCard(id);
  });

  // ── Task List Linking ─────────────────────────────────────

  const linkTaskListSchema = z.object({
    taskListId: z.string().uuid(),
  });

  fastify.post('/boards/:id/link-tasklist', async (request) => {
    const { id } = request.params as { id: string };
    await assertBoardAccess(id, request.user.id, 'WRITE');
    const { taskListId } = linkTaskListSchema.parse(request.body);
    return await kanbanService.linkTaskListToBoard(id, taskListId, request.user.id);
  });

  fastify.delete('/boards/:id/link-tasklist', async (request) => {
    const { id } = request.params as { id: string };
    await assertBoardAccess(id, request.user.id, 'WRITE');
    return await kanbanService.unlinkTaskListFromBoard(id, request.user.id);
  });

  // Search user's task lists for the task list picker
  fastify.get('/tasklists/search', async (request) => {
    const { q } = z.object({ q: z.string().optional().default('') }).parse(request.query);
    return await kanbanService.searchUserTaskLists(request.user.id, q);
  });
}
