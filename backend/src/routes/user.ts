import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as userService from '../services/user.service';

const updateProfileSchema = z.object({
  name: z.string().optional(),
  surname: z.string().optional(),
  gender: z.string().optional(),
  dateOfBirth: z.string().optional(),
  placeOfBirth: z.string().optional(),
  mobile: z.string().optional(),
  avatarUrl: z.string().optional(),
  emailNotificationsEnabled: z.boolean().optional(),
});

const changePasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(6),
});

export default async function userRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/me', async (request, reply) => {
    const user = await userService.getUser(request.user.id);
    return user;
  });

  fastify.put('/me', async (request, reply) => {
    const data = updateProfileSchema.parse(request.body);
    const user = await userService.updateUser(request.user.id, data);
    return user;
  });

  fastify.post('/change-password', async (request, reply) => {
    const { oldPassword, newPassword } = changePasswordSchema.parse(request.body);
    await userService.changePassword(request.user.id, oldPassword, newPassword);
    return { message: 'Password updated successfully' };
  });

  fastify.post('/me/avatar', async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ message: 'No file uploaded' });
    }
    const user = await userService.uploadAvatar(request.user.id, data);
    return user;
  });
}
