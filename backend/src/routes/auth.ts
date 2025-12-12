import { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import prisma from '../plugins/prisma';
import '../types';

import { requestPasswordReset, resetPassword } from '../services/auth.service';

const registerSchema = z.object({
  email: z.string({ required_error: 'auth.errors.emailRequired' }).email({ message: 'auth.errors.invalidEmail' }),
  password: z.string({ required_error: 'auth.errors.passwordRequired' }).min(6, { message: 'auth.errors.passwordTooShort' }),
  name: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string({ required_error: 'auth.errors.emailRequired' }).email({ message: 'auth.errors.invalidEmail' }),
  password: z.string({ required_error: 'auth.errors.passwordRequired' }),
});

const forgotPasswordSchema = z.object({
  email: z.string({ required_error: 'auth.errors.emailRequired' }).email({ message: 'auth.errors.invalidEmail' }),
});

const resetPasswordSchema = z.object({
  token: z.string(),
  newPassword: z.string({ required_error: 'auth.errors.passwordRequired' }).min(6, { message: 'auth.errors.passwordTooShort' }),
});

export default async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/register', async (request, reply) => {
    // Custom error handling for Zod parsing to return just the first message or array?
    // Using default parse for now, frontend handles array.
    const { email, password, name } = registerSchema.parse(request.body);

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return reply.status(400).send({ message: 'auth.errors.userExists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        notebooks: {
          create: {
            name: 'First Notebook',
          }
        }
      },
    });

    const token = fastify.jwt.sign({ id: user.id, email: user.email });
    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        surname: user.surname,
        gender: user.gender,
        dateOfBirth: user.dateOfBirth,
        placeOfBirth: user.placeOfBirth,
        mobile: user.mobile,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt
      }
    };
  });

  fastify.post('/login', async (request, reply) => {
    const { email, password } = loginSchema.parse(request.body);

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return reply.status(401).send({ message: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return reply.status(401).send({ message: 'Invalid credentials' });
    }

    const token = fastify.jwt.sign({ id: user.id, email: user.email });
    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        surname: user.surname,
        gender: user.gender,
        dateOfBirth: user.dateOfBirth,
        placeOfBirth: user.placeOfBirth,
        mobile: user.mobile,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt
      }
    };
  });

  fastify.post('/forgot-password', async (request, reply) => {
    const { email } = forgotPasswordSchema.parse(request.body);
    await requestPasswordReset(email);
    return { message: 'If the email exists, a reset link has been sent.' };
  });

  fastify.post('/reset-password', async (request, reply) => {
    const { token, newPassword } = resetPasswordSchema.parse(request.body);
    try {
      await resetPassword(token, newPassword);
      return { message: 'Password reset successfully' };
    } catch (error) {
      return reply.status(400).send({ message: 'Invalid or expired token' });
    }
  });

  fastify.get('/me', { onRequest: [fastify.authenticate] }, async (request) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: {
        id: true,
        email: true,
        name: true,
        surname: true,
        gender: true,
        dateOfBirth: true,
        placeOfBirth: true,
        mobile: true,
        avatarUrl: true,
        createdAt: true
      }
    });
    return user;
  });
}
