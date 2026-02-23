import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getUserNotifications, markNotificationAsRead, markAllNotificationsAsRead, deleteNotification, deleteAllNotifications } from '../services/notification.service';
import { subscribeUser } from '../services/push.service';

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(50),
});

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

export default async function notificationRoutes(fastify: FastifyInstance) {
  fastify.get('/', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const userId = request.user.id;
    const { page, limit } = paginationSchema.parse(request.query);
    const notifications = await getUserNotifications(userId, page, limit);
    return notifications;
  });

  fastify.put('/:id/read', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.id;
    await markNotificationAsRead(id, userId);
    return { success: true };
  });

  fastify.put('/read-all', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const userId = request.user.id;
    await markAllNotificationsAsRead(userId);
    return { success: true };
  });

  fastify.delete('/all', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const userId = request.user.id;
    await deleteAllNotifications(userId);
    return { success: true };
  });

  fastify.delete('/:id', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.id;
    await deleteNotification(id, userId);
    return { success: true };
  });

  fastify.post('/subscribe', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const userId = request.user.id;
    const subscription = pushSubscriptionSchema.parse(request.body);
    await subscribeUser(userId, subscription);
    return { success: true };
  });
}
