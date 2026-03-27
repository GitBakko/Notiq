
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createAnnouncement,
  getActiveAnnouncements,
  getAnnouncementHistory,
  dismissAnnouncement,
  deactivateAnnouncement,
  deleteAnnouncement,
} from '../services/announcement.service';

const idParamSchema = z.object({
  id: z.string().uuid(),
});

const historyQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const createAnnouncementSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  category: z.enum(['MAINTENANCE', 'FEATURE', 'URGENT']),
  customColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
  customIcon: z.string().max(50).optional().nullable(),
});

// User-facing routes (prefix: /api/announcements)
export default async function announcementRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // Get active announcements not dismissed by current user
  fastify.get('/active', async (request, reply) => {
    const announcements = await getActiveAnnouncements(request.user.id);
    return announcements;
  });

  // Dismiss an announcement
  fastify.post('/:id/dismiss', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    await dismissAnnouncement(id, request.user.id);
    return { success: true };
  });

  // Paginated history
  fastify.get('/history', async (request, reply) => {
    const { page, limit } = historyQuerySchema.parse(request.query);
    const history = await getAnnouncementHistory(page, limit);
    return history;
  });
}

// Admin-only routes (prefix: /api/admin/announcements)
export async function adminAnnouncementRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // Create announcement
  fastify.post('/', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    if (request.user.role !== 'SUPERADMIN') {
      return reply.code(403).send({ message: 'errors.common.forbidden' });
    }
    const body = createAnnouncementSchema.parse(request.body);
    const announcement = await createAnnouncement(request.user.id, body);
    return announcement;
  });

  // Deactivate announcement
  fastify.put('/:id/deactivate', async (request, reply) => {
    if (request.user.role !== 'SUPERADMIN') {
      return reply.code(403).send({ message: 'errors.common.forbidden' });
    }
    const { id } = idParamSchema.parse(request.params);
    const announcement = await deactivateAnnouncement(id);
    return announcement;
  });

  // Delete announcement
  fastify.delete('/:id', async (request, reply) => {
    if (request.user.role !== 'SUPERADMIN') {
      return reply.code(403).send({ message: 'errors.common.forbidden' });
    }
    const { id } = idParamSchema.parse(request.params);
    await deleteAnnouncement(id);
    return { success: true };
  });
}
