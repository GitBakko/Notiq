import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getFriends,
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  getPendingRequests,
  getSentRequests,
  blockFriend,
  unblockFriend,
  getAutoFriendCandidates,
} from '../services/friendship.service';

const userIdSchema = z.object({
  userId: z.string().uuid(),
});

const idParamSchema = z.object({
  id: z.string().uuid(),
});

export default async function friendshipRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // List active friends
  fastify.get('/', async (request) => {
    return getFriends(request.user.id);
  });

  // Pending incoming requests
  fastify.get('/requests', async (request) => {
    return getPendingRequests(request.user.id);
  });

  // Pending outgoing requests
  fastify.get('/requests/sent', async (request) => {
    return getSentRequests(request.user.id);
  });

  // Send friend request
  fastify.post('/request', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { userId } = userIdSchema.parse(request.body);
    const result = await sendFriendRequest(request.user.id, userId);
    return reply.status(201).send(result);
  });

  // Accept friend request
  fastify.post('/request/:id/accept', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return acceptFriendRequest(id, request.user.id);
  });

  // Decline friend request
  fastify.post('/request/:id/decline', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return declineFriendRequest(id, request.user.id);
  });

  // Block friend
  fastify.post('/:id/block', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    await blockFriend(request.user.id, id);
    return { success: true };
  });

  // Unblock
  fastify.post('/:id/unblock', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    await unblockFriend(request.user.id, id);
    return { success: true };
  });

  // Auto-friend candidates (suggestions)
  fastify.get('/suggestions', async (request) => {
    return getAutoFriendCandidates(request.user.id);
  });
}
