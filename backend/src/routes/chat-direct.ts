import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getConversations,
  getOrCreateDirectConversation,
  createGroupConversation,
  getMessages,
  searchMessages,
  getUnreadCount,
} from '../services/chat-direct.service';

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

export default async function chatDirectRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

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
}
