import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getConversations,
  getOrCreateDirectConversation,
  createGroupConversation,
  getMessages,
  searchMessages,
  getUnreadCount,
  sendMessage,
} from '../services/chat-direct.service';
import { uploadChatFile } from '../services/chat-file.service';
import prisma from '../plugins/prisma';

const idParamSchema = z.object({
  id: z.string().uuid(),
});

const messagesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
  before: z.string().uuid().optional(),
});

const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
});

const directConversationBodySchema = z.object({
  userId: z.string().uuid(),
});

const groupConversationBodySchema = z.object({
  title: z.string().min(1).max(100),
  participantIds: z.array(z.string().uuid()).min(1),
});

const adminPaginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export default async function chatDirectRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // ── Admin: Chat file stats ──
  fastify.get('/admin/chat-files/stats', async (request, reply) => {
    if (request.user.role !== 'SUPERADMIN') return reply.code(403).send({ message: 'errors.common.forbidden' });
    const { getChatStorageStats } = await import('../services/chat-file.service');
    return getChatStorageStats();
  });

  // ── Admin: List chat files (paginated) ──
  fastify.get('/admin/chat-files', async (request, reply) => {
    if (request.user.role !== 'SUPERADMIN') return reply.code(403).send({ message: 'errors.common.forbidden' });
    const { page, limit } = adminPaginationSchema.parse(request.query);
    const files = await prisma.chatFile.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        message: {
          select: {
            senderId: true,
            sender: { select: { name: true, email: true } },
            conversation: { select: { id: true, type: true, title: true } },
          },
        },
      },
    });
    const total = await prisma.chatFile.count();
    return { data: files, total };
  });

  // ── Admin: Delete chat file ──
  fastify.delete('/admin/chat-files/:id', async (request, reply) => {
    if (request.user.role !== 'SUPERADMIN') return reply.code(403).send({ message: 'errors.common.forbidden' });
    const { id } = idParamSchema.parse(request.params);
    const { deleteChatFile } = await import('../services/chat-file.service');
    await deleteChatFile(id);
    return { success: true };
  });

  // List all conversations with last message + unread count
  fastify.get('/conversations', async (request) => {
    return getConversations(request.user.id);
  });

  // Paginated messages for a conversation
  fastify.get('/conversations/:id/messages', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const { page, limit, before } = messagesQuerySchema.parse(request.query);
    return getMessages(id, request.user.id, { page, limit, before });
  });

  // Search within a conversation
  fastify.get('/conversations/:id/search', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const { q } = searchQuerySchema.parse(request.query);
    return searchMessages(id, request.user.id, q);
  });

  // Get or create direct conversation
  fastify.post('/conversations/direct', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const { userId } = directConversationBodySchema.parse(request.body);
    return getOrCreateDirectConversation(request.user.id, userId);
  });

  // Create group conversation
  fastify.post('/conversations/group', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const { title, participantIds } = groupConversationBodySchema.parse(request.body);
    return createGroupConversation(request.user.id, title, participantIds);
  });

  // Total unread count (for sidebar badge)
  fastify.get('/unread', async (request) => {
    const count = await getUnreadCount(request.user.id);
    return { count };
  });

  // Upload file with optional message text
  fastify.post('/conversations/:id/files', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { id: conversationId } = idParamSchema.parse(request.params);
    const userId = request.user.id;

    // Verify participant
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!participant) return reply.code(403).send({ message: 'errors.chat.notParticipant' });

    const data = await request.file();
    if (!data) return reply.code(400).send({ message: 'errors.chat.noFile' });

    const buffer = await data.toBuffer();
    const messageText = (data.fields as Record<string, { value?: string }>)?.message?.value || '';

    // Create message first
    const message = await sendMessage(conversationId, userId, { content: messageText || data.filename });

    // Upload file linked to message
    const fileResult = await uploadChatFile(message.id, buffer, data.filename, data.mimetype);

    // Return message with files included so sender sees the file
    const fullMessage = {
      ...message,
      files: [{
        id: '', // ChatFile id is inside chat-file.service, we return the relevant data
        url: fileResult.url,
        thumbnailUrl: fileResult.thumbnailUrl,
        filename: fileResult.filename,
        mimeType: fileResult.mimeType,
        size: fileResult.size,
      }],
    };

    return { message: fullMessage, file: fileResult };
  });
}
