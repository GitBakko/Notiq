import { FastifyInstance } from 'fastify';
import { getUserNotifications, markNotificationAsRead, markAllNotificationsAsRead, deleteNotification } from '../services/notification.service';
import { subscribeUser } from '../services/push.service';

export default async function notificationRoutes(fastify: FastifyInstance) {
  fastify.get('/', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const userId = request.user.id;
    const notifications = await getUserNotifications(userId);
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
    const subscription = request.body;
    await subscribeUser(userId, subscription);
    return { success: true };
  });
}
