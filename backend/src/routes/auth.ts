
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import prisma from '../plugins/prisma';
import '../types';
import * as settingsService from '../services/settings.service';
import { registerUser, loginUser, verifyEmail, requestPasswordReset, resetPassword } from '../services/auth.service';

const registerSchema = z.object({
  email: z.string().email('auth.errors.invalidEmail'),
  password: z.string().min(6, 'auth.errors.passwordTooShort'),
  name: z.string().optional(),
  invitationCode: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email('auth.errors.invalidEmail'),
  password: z.string().min(1, 'auth.errors.passwordRequired'),
});

const verifyEmailSchema = z.object({
  token: z.string().min(1, 'auth.errors.tokenRequired'),
});

const forgotPasswordSchema = z.object({
  email: z.string().email('auth.errors.invalidEmail'),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(6, 'auth.errors.passwordTooShort'),
});

export default async function authRoutes(fastify: FastifyInstance) {

  fastify.get('/config', async (request, reply) => {
    const invitationSystemEnabled = await settingsService.getBooleanSetting('invitation_system_enabled', true);
    return { invitationSystemEnabled };
  });

  fastify.post('/register', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      const data = registerSchema.parse(request.body);
      const user = await registerUser(data);

      // Do NOT sign token. Return success message.
      return reply.code(201).send({
        message: 'Registration successful. Please check your email to verify your account.',
        userId: user.id
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : '';
      if (msg) {
        // Handle specific service errors
        if (msg === 'auth.errors.userExists' || msg.startsWith('auth.errors')) {
          return reply.status(400).send({ message: msg });
        }
        if (msg === 'Invalid invitation code' || msg === 'Invitation code already used') {
          return reply.status(400).send({ message: 'auth.errors.invalidInvite' });
        }
      }
      return reply.status(400).send({ message: msg || 'Registration failed' });
    }
  });

  fastify.post('/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      const { email, password } = loginSchema.parse(request.body);
      const user = await loginUser(email, password);

      const token = fastify.jwt.sign(
        { id: user.id, email: user.email, role: user.role, tokenVersion: user.tokenVersion },
        { expiresIn: '24h' }
      );

      return {
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          surname: user.surname,
          role: user.role,
          invitesAvailable: user.invitesAvailable,
          avatarUrl: user.avatarUrl,
          color: user.color,
          createdAt: user.createdAt
        }
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Invalid credentials';
      return reply.status(401).send({ message: msg });
    }
  });

  fastify.post('/verify-email', async (request, reply) => {
    try {
      const { token } = verifyEmailSchema.parse(request.body);
      await verifyEmail(token);
      return { message: 'Email verified successfully' };
    } catch (_error: unknown) {
      return reply.status(400).send({ message: 'Invalid or expired token' });
    }
  });

  fastify.post('/forgot-password', { config: { rateLimit: { max: 3, timeWindow: '5 minutes' } } }, async (request, reply) => {
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

  fastify.post('/refresh', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: { id: true, email: true, role: true, tokenVersion: true }
    });
    if (!user) return reply.status(401).send({ message: 'User not found' });
    const token = fastify.jwt.sign(
      { id: user.id, email: user.email, role: user.role, tokenVersion: user.tokenVersion },
      { expiresIn: '24h' }
    );
    return { token };
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
        createdAt: true,
        role: true,
        invitesAvailable: true
      }
    });
    return user;
  });
}
