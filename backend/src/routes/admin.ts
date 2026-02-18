
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import prisma from '../plugins/prisma';
import * as settingsService from '../services/settings.service';
import * as adminService from '../services/admin.service';

const updateSettingSchema = z.object({
  key: z.string(),
  value: z.string(),
});

const paginatedQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(10),
  search: z.string().optional(),
});

const auditLogQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
});

const userIdParamSchema = z.object({
  id: z.string().uuid(),
});

export default async function adminRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.post('/settings', async (request, reply) => {
    // Check if user is SUPERADMIN
    const user = await prisma.user.findUnique({ where: { id: request.user.id } });
    if (user?.role !== 'SUPERADMIN') {
      return reply.status(403).send({ message: 'Forbidden' });
    }

    const { key, value } = updateSettingSchema.parse(request.body);
    await settingsService.setSetting(key, value);
    return { message: 'Setting updated' };
  });

  fastify.get('/stats', async (request, reply) => {
    // Check SUPERADMIN
    const user = await prisma.user.findUnique({ where: { id: request.user.id } });
    if (user?.role !== 'SUPERADMIN') {
      return reply.status(403).send({ message: 'Forbidden' });
    }

    const stats = await adminService.getDashboardStats();
    return stats;
  });

  fastify.get('/users', async (request, reply) => {
    const { page, limit, search } = paginatedQuerySchema.parse(request.query);
    const user = await prisma.user.findUnique({ where: { id: request.user.id } });
    if (user?.role !== 'SUPERADMIN') return reply.status(403).send({ message: 'Forbidden' });

    return adminService.getUsers(page, limit, search);
  });

  fastify.put('/users/:id', async (request, reply) => {
    const { id } = userIdParamSchema.parse(request.params);
    const updateSchema = z.object({
      role: z.enum(['USER', 'SUPERADMIN']).optional(),
      isVerified: z.boolean().optional()
    });
    const body = updateSchema.parse(request.body);

    const user = await prisma.user.findUnique({ where: { id: request.user.id } });
    if (user?.role !== 'SUPERADMIN') return reply.status(403).send({ message: 'Forbidden' });

    await adminService.updateUser(id, body);
    return { message: 'User updated' };
  });

  fastify.get('/audit-logs', async (request, reply) => {
    const { page, limit } = auditLogQuerySchema.parse(request.query);
    const user = await prisma.user.findUnique({ where: { id: request.user.id } });
    if (user?.role !== 'SUPERADMIN') return reply.status(403).send({ message: 'Forbidden' });

    return adminService.getAuditLogs(page, limit);
  });

  // AI Configuration
  fastify.get('/ai-config', async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.user.id } });
    if (user?.role !== 'SUPERADMIN') return reply.status(403).send({ message: 'Forbidden' });

    const [enabled, provider, apiKey, model, maxTokens, temperature] = await Promise.all([
      settingsService.getSetting('ai_enabled', 'false'),
      settingsService.getSetting('ai_provider', 'anthropic'),
      settingsService.getSetting('ai_api_key', ''),
      settingsService.getSetting('ai_model', 'claude-sonnet-4-20250514'),
      settingsService.getSetting('ai_max_tokens', '4096'),
      settingsService.getSetting('ai_temperature', '0.7'),
    ]);

    return {
      enabled: enabled === 'true',
      provider,
      apiKeySet: !!apiKey,
      model,
      maxTokens: parseInt(maxTokens, 10) || 4096,
      temperature: parseFloat(temperature) || 0.7,
    };
  });
}
