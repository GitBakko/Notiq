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
  fastify.post('/', async (request, reply) => {
    try {
      const data = createGroupSchema.parse(request.body);
      const group = await groupService.createGroup(request.user.id, data);
      return reply.status(201).send(group);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'ZodError') return reply.status(400).send({ message: 'Invalid input' });
      const msg = error instanceof Error ? error.message : 'Failed to create group';
      return reply.status(500).send({ message: msg });
    }
  });

  // List owned + joined groups
  fastify.get('/', async (request, reply) => {
    try {
      const result = await groupService.getMyGroups(request.user.id);
      return result;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({ message: msg });
    }
  });

  // Groups for sharing modal (owned only)
  fastify.get('/for-sharing', async (request, reply) => {
    try {
      const groups = await groupService.getGroupsForSharing(request.user.id);
      return groups;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({ message: msg });
    }
  });

  // Get single group detail
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const group = await groupService.getGroup(id, request.user.id);
      return group;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (msg === 'Group not found') return reply.status(404).send({ message: 'Group not found' });
      if (msg === 'Access denied') return reply.status(403).send({ message: 'Access denied' });
      return reply.status(500).send({ message: msg });
    }
  });

  // Update group metadata
  fastify.put('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const data = updateGroupSchema.parse(request.body);
      const group = await groupService.updateGroup(id, request.user.id, data);
      return group;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (error instanceof Error && error.name === 'ZodError') return reply.status(400).send({ message: 'Invalid input' });
      if (msg.includes('Not found')) return reply.status(404).send({ message: 'Not found' });
      return reply.status(500).send({ message: msg });
    }
  });

  // Delete group
  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await groupService.deleteGroup(id, request.user.id);
      return { success: true };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (msg.includes('Not found')) return reply.status(404).send({ message: 'Not found' });
      return reply.status(500).send({ message: msg });
    }
  });

  // Add member by email
  fastify.post('/:id/members', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const { email } = addMemberSchema.parse(request.body);
      const result = await groupService.addMember(id, request.user.id, email);
      return result;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (error instanceof Error && error.name === 'ZodError') return reply.status(400).send({ message: 'Invalid email' });
      if (msg.includes('Not found')) return reply.status(404).send({ message: 'Group not found' });
      if (msg === 'User is already a member') return reply.status(409).send({ message: msg });
      if (msg === 'Cannot add yourself to a group') return reply.status(400).send({ message: msg });
      return reply.status(500).send({ message: msg });
    }
  });

  // Remove registered member
  fastify.delete('/:id/members/:userId', async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };
    try {
      await groupService.removeMember(id, request.user.id, userId);
      return { success: true };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (msg.includes('Not found')) return reply.status(404).send({ message: 'Not found' });
      if (msg === 'Cannot remove yourself as owner') return reply.status(400).send({ message: msg });
      return reply.status(500).send({ message: msg });
    }
  });

  // Upload group avatar (owner only)
  fastify.post('/:id/avatar', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const data = await request.file();
      if (!data) return reply.status(400).send({ message: 'No file uploaded' });
      const group = await groupService.uploadGroupAvatar(id, request.user.id, data);
      return group;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (msg.includes('Not found')) return reply.status(404).send({ message: 'Not found' });
      if (msg === 'Only image files allowed') return reply.status(400).send({ message: msg });
      return reply.status(500).send({ message: msg });
    }
  });

  // Remove pending invite
  fastify.delete('/:id/pending', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const { email } = z.object({ email: z.string().email() }).parse(request.body);
      await groupService.removePendingInvite(id, request.user.id, email);
      return { success: true };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (error instanceof Error && error.name === 'ZodError') return reply.status(400).send({ message: 'Invalid email' });
      if (msg.includes('Not found')) return reply.status(404).send({ message: 'Not found' });
      return reply.status(500).send({ message: msg });
    }
  });
}
