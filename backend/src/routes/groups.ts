import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as groupService from '../services/group.service';

const createGroupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

const updateGroupSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
});

const addMemberSchema = z.object({
  email: z.string().email(),
});

export default async function groupRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // Create group
  fastify.post('/', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const data = createGroupSchema.parse(request.body);
    const group = await groupService.createGroup(request.user.id, data);
    return reply.status(201).send(group);
  });

  // List owned + joined groups
  fastify.get('/', async (request) => {
    return groupService.getMyGroups(request.user.id);
  });

  // Groups for sharing modal (owned only)
  fastify.get('/for-sharing', async (request) => {
    return groupService.getGroupsForSharing(request.user.id);
  });

  // Get single group detail
  fastify.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return groupService.getGroup(id, request.user.id);
  });

  // Update group metadata
  fastify.put('/:id', async (request) => {
    const { id } = request.params as { id: string };
    const data = updateGroupSchema.parse(request.body);
    return groupService.updateGroup(id, request.user.id, data);
  });

  // Delete group
  fastify.delete('/:id', async (request) => {
    const { id } = request.params as { id: string };
    await groupService.deleteGroup(id, request.user.id);
    return { success: true };
  });

  // Add member by email
  fastify.post('/:id/members', async (request) => {
    const { id } = request.params as { id: string };
    const { email } = addMemberSchema.parse(request.body);
    return groupService.addMember(id, request.user.id, email);
  });

  // Remove registered member
  fastify.delete('/:id/members/:userId', async (request) => {
    const { id, userId } = request.params as { id: string; userId: string };
    await groupService.removeMember(id, request.user.id, userId);
    return { success: true };
  });

  // Upload group avatar (owner only)
  fastify.post('/:id/avatar', async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = await request.file();
    if (!data) return reply.status(400).send({ message: 'errors.attachments.noFileUploaded' });
    return groupService.uploadGroupAvatar(id, request.user.id, data);
  });

  // Remove pending invite
  fastify.delete('/:id/pending', async (request) => {
    const { id } = request.params as { id: string };
    const { email } = z.object({ email: z.string().email() }).parse(request.body);
    await groupService.removePendingInvite(id, request.user.id, email);
    return { success: true };
  });
}
