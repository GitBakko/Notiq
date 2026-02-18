
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import prisma from '../plugins/prisma';
import * as inviteService from '../services/invite.service';

const sendInviteEmailSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  locale: z.string().optional().default('en'),
});

const requestInviteSchema = z.object({
  email: z.string().email(),
  honeypot: z.string().optional(),
});

const codeParamSchema = z.object({
  code: z.string().min(1),
});

const idParamSchema = z.object({
  id: z.string().uuid(),
});

export default async function inviteRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // Get my invites
  fastify.get('/', async (request, reply) => {
    const invites = await inviteService.getUserInvites(request.user.id);
    return invites;
  });

  // Generate invite
  fastify.post('/', async (request, reply) => {
    try {
      const invite = await inviteService.generateInvite(request.user.id);
      return invite;
    } catch (error: any) {
      return reply.status(400).send({ message: error.message || 'Failed to generate invite' });
    }
  });

  // Send Invite via Email
  fastify.post('/:code/email', async (request, reply) => {
    const { code } = codeParamSchema.parse(request.params);
    const { email, name, locale } = sendInviteEmailSchema.parse(request.body);

    try {
      await inviteService.sendInviteEmail(code, request.user.id, email, name, locale);
      return { success: true };
    } catch (error: any) {
      return reply.status(400).send({ message: error.message || 'Failed to send email' });
    }
  });

  // Resend Verification Email for an invite (Existing)
  fastify.post('/:code/resend', async (request, reply) => {
    const { code } = codeParamSchema.parse(request.params);
    try {
      const result = await (await import('../services/auth.service')).resendVerificationForInvite(code, request.user.id);
      return result;
    } catch (error: any) {
      return reply.status(400).send({ message: error.message || 'Failed to resend email' });
    }
  });
}

// Separate route block for Public Request to avoid Auth Hook issues if mixed locally
export async function publicInviteRoutes(fastify: FastifyInstance) {
  // Request Invitation (Public)
  fastify.post('/request', {
    config: {
      rateLimit: {
        max: 3,
        timeWindow: '1 hour'
      }
    }
  }, async (request, reply) => {
    const { email, honeypot } = requestInviteSchema.parse(request.body);

    if (honeypot) {
      // Silently fail for bots
      return { success: true };
    }

    try {
      await inviteService.createInvitationRequest(email, request.ip);
      return { success: true };
    } catch (error: any) {
      // Don't leak if email exists
      return { success: true };
    }
  });
}

// Admin Routes (to be imported in admin.ts or guarded here)
export async function adminInviteRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/requests', async (request, reply) => {
    if (request.user.role !== 'SUPERADMIN') return reply.status(403).send();
    return inviteService.getInvitationRequests();
  });

  fastify.post('/requests/:id/approve', async (request, reply) => {
    if (request.user.role !== 'SUPERADMIN') return reply.status(403).send();
    const { id } = idParamSchema.parse(request.params);
    try {
      await inviteService.approveInvitationRequest(id, request.user.id);
      return { success: true };
    } catch (e: any) {
      return reply.status(400).send({ message: e.message });
    }
  });

  fastify.post('/requests/:id/reject', async (request, reply) => {
    if (request.user.role !== 'SUPERADMIN') return reply.status(403).send();
    const { id } = idParamSchema.parse(request.params);
    try {
      await inviteService.rejectInvitationRequest(id);
      return { success: true };
    } catch (e: any) {
      return reply.status(400).send({ message: e.message });
    }
  });
}
