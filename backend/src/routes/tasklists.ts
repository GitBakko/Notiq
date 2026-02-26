import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as taskListService from '../services/tasklist.service';

const createTaskListSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1),
});

const updateTaskListSchema = z.object({
  title: z.string().min(1).optional(),
  isTrashed: z.boolean().optional(),
});

const createTaskItemSchema = z.object({
  id: z.string().uuid().optional(),
  text: z.string().min(1),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional().default('MEDIUM'),
  dueDate: z.string().nullable().optional(),
});

const updateTaskItemSchema = z.object({
  text: z.string().optional(),
  isChecked: z.boolean().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  dueDate: z.string().nullable().optional(),
  position: z.number().int().optional(),
});

const reorderSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    position: z.number().int(),
  })),
});

export default async function taskListRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // Get all task lists
  fastify.get('/', async (request) => {
    return taskListService.getTaskLists(request.user.id);
  });

  // Get single task list
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      return await taskListService.getTaskList(request.user.id, id);
    } catch (error: any) {
      if (error.message === 'TaskList not found') {
        return reply.status(404).send({ message: 'TaskList not found' });
      }
      throw error;
    }
  });

  // Create task list
  fastify.post('/', async (request) => {
    const { id, title } = createTaskListSchema.parse(request.body);
    return taskListService.createTaskList(request.user.id, title, id);
  });

  // Update task list
  fastify.put('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = updateTaskListSchema.parse(request.body);

    try {
      return await taskListService.updateTaskList(request.user.id, id, data);
    } catch (error: any) {
      if (error.message === 'Access denied') {
        return reply.status(404).send({ message: 'TaskList not found' });
      }
      throw error;
    }
  });

  // Delete task list (soft delete)
  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      await taskListService.deleteTaskList(request.user.id, id);
      return { success: true };
    } catch (error: any) {
      if (error.message === 'Access denied') {
        return reply.status(404).send({ message: 'TaskList not found' });
      }
      throw error;
    }
  });

  // Add task item
  fastify.post('/:id/items', async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = createTaskItemSchema.parse(request.body);

    try {
      return await taskListService.addTaskItem(request.user.id, id, data);
    } catch (error: any) {
      if (error.message === 'Access denied' || error.message === 'TaskList not found') {
        return reply.status(404).send({ message: 'TaskList not found' });
      }
      throw error;
    }
  });

  // Update task item
  fastify.put('/:id/items/:itemId', async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const data = updateTaskItemSchema.parse(request.body);

    try {
      return await taskListService.updateTaskItem(request.user.id, id, itemId, data);
    } catch (error: any) {
      if (error.message === 'Access denied' || error.message === 'TaskList not found') {
        return reply.status(404).send({ message: 'TaskList not found' });
      }
      if (error.message === 'TaskItem not found') {
        return reply.status(404).send({ message: 'TaskItem not found' });
      }
      if (error.message === 'Only the user who checked this item can uncheck it') {
        return reply.status(403).send({ message: error.message });
      }
      throw error;
    }
  });

  // Delete task item
  fastify.delete('/:id/items/:itemId', async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };

    try {
      return await taskListService.deleteTaskItem(request.user.id, id, itemId);
    } catch (error: any) {
      if (error.message === 'Access denied' || error.message === 'TaskList not found') {
        return reply.status(404).send({ message: 'TaskList not found' });
      }
      if (error.message === 'TaskItem not found') {
        return reply.status(404).send({ message: 'TaskItem not found' });
      }
      throw error;
    }
  });

  // Reorder task items
  fastify.put('/:id/items/reorder', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { items } = reorderSchema.parse(request.body);

    try {
      return await taskListService.reorderTaskItems(request.user.id, id, items);
    } catch (error: any) {
      if (error.message === 'Access denied' || error.message === 'TaskList not found') {
        return reply.status(404).send({ message: 'TaskList not found' });
      }
      throw error;
    }
  });
}
