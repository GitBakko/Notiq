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
  fastify.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return taskListService.getTaskList(request.user.id, id);
  });

  // Create task list
  fastify.post('/', async (request) => {
    const { id, title } = createTaskListSchema.parse(request.body);
    return taskListService.createTaskList(request.user.id, title, id);
  });

  // Update task list
  fastify.put('/:id', async (request) => {
    const { id } = request.params as { id: string };
    const data = updateTaskListSchema.parse(request.body);
    return taskListService.updateTaskList(request.user.id, id, data);
  });

  // Delete task list (soft delete)
  fastify.delete('/:id', async (request) => {
    const { id } = request.params as { id: string };
    await taskListService.deleteTaskList(request.user.id, id);
    return { success: true };
  });

  // Add task item
  fastify.post('/:id/items', async (request) => {
    const { id } = request.params as { id: string };
    const data = createTaskItemSchema.parse(request.body);
    return taskListService.addTaskItem(request.user.id, id, data);
  });

  // Update task item
  fastify.put('/:id/items/:itemId', async (request) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const data = updateTaskItemSchema.parse(request.body);
    return taskListService.updateTaskItem(request.user.id, id, itemId, data);
  });

  // Delete task item
  fastify.delete('/:id/items/:itemId', async (request) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    return taskListService.deleteTaskItem(request.user.id, id, itemId);
  });

  // Reorder task items
  fastify.put('/:id/items/reorder', async (request) => {
    const { id } = request.params as { id: string };
    const { items } = reorderSchema.parse(request.body);
    return taskListService.reorderTaskItems(request.user.id, id, items);
  });
}
