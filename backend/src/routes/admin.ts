
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import prisma from '../plugins/prisma';
import * as settingsService from '../services/settings.service';
import * as adminService from '../services/admin.service';
import * as auditService from '../services/audit.service';
import { metrics } from '../utils/metrics';

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
  event: z.string().optional(),
  userId: z.string().uuid().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

const userIdParamSchema = z.object({
  id: z.string().uuid(),
});

async function requireSuperAdmin(fastify: FastifyInstance, request: { user: { id: string } }) {
  const user = await prisma.user.findUnique({ where: { id: request.user.id }, select: { role: true } });
  return user?.role === 'SUPERADMIN';
}

export default async function adminRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.post('/settings', async (request, reply) => {
    if (!await requireSuperAdmin(fastify, request)) {
      return reply.status(403).send({ message: 'errors.common.forbidden' });
    }

    const { key, value } = updateSettingSchema.parse(request.body);
    await settingsService.setSetting(key, value);
    auditService.logEvent(request.user.id, 'ADMIN_SETTING_CHANGE', { key, value });
    return { message: 'Setting updated' };
  });

  fastify.get('/stats', async (request, reply) => {
    if (!await requireSuperAdmin(fastify, request)) {
      return reply.status(403).send({ message: 'errors.common.forbidden' });
    }

    const stats = await adminService.getDashboardStats();
    return stats;
  });

  fastify.get('/users', async (request, reply) => {
    const { page, limit, search } = paginatedQuerySchema.parse(request.query);
    if (!await requireSuperAdmin(fastify, request)) return reply.status(403).send({ message: 'errors.common.forbidden' });

    return adminService.getUsers(page, limit, search);
  });

  fastify.put('/users/:id', async (request, reply) => {
    const { id } = userIdParamSchema.parse(request.params);
    const updateSchema = z.object({
      role: z.enum(['USER', 'SUPERADMIN']).optional(),
      isVerified: z.boolean().optional()
    });
    const body = updateSchema.parse(request.body);

    if (!await requireSuperAdmin(fastify, request)) return reply.status(403).send({ message: 'errors.common.forbidden' });

    await adminService.updateUser(id, body);
    if (body.role) {
      auditService.logEvent(request.user.id, 'ADMIN_ROLE_CHANGE', { targetUserId: id, newRole: body.role });
    }
    if (body.isVerified !== undefined) {
      auditService.logEvent(request.user.id, 'ADMIN_USER_VERIFY', { targetUserId: id, isVerified: body.isVerified });
    }
    return { message: 'User updated' };
  });

  fastify.delete('/users/:id', async (request, reply) => {
    const { id } = userIdParamSchema.parse(request.params);
    if (!await requireSuperAdmin(fastify, request)) return reply.status(403).send({ message: 'errors.common.forbidden' });

    // Prevent self-deletion
    if (id === request.user.id) {
      return reply.status(400).send({ message: 'errors.admin.cannotDeleteSelf' });
    }

    await adminService.deleteUser(id);
    auditService.logEvent(request.user.id, 'ADMIN_USER_DELETE', { targetUserId: id });
    return { message: 'User deleted' };
  });

  // Cleanup test/e2e users (emails matching @example.com)
  fastify.delete('/users/cleanup/test-users', async (request, reply) => {
    if (!await requireSuperAdmin(fastify, request)) return reply.status(403).send({ message: 'errors.common.forbidden' });

    const testUsers = await prisma.user.findMany({
      where: {
        email: { endsWith: '@example.com' },
        id: { not: request.user.id }, // Never delete self
      },
      select: { id: true, email: true },
    });

    let deleted = 0;
    for (const testUser of testUsers) {
      try {
        await adminService.deleteUser(testUser.id);
        deleted++;
      } catch (e) {
        request.log.warn({ userId: testUser.id, email: testUser.email, err: e }, 'Failed to delete test user');
      }
    }

    auditService.logEvent(request.user.id, 'ADMIN_CLEANUP_TEST_USERS', { count: deleted });
    return { deleted, total: testUsers.length };
  });

  // Enhanced audit-logs with filters
  fastify.get('/audit-logs', async (request, reply) => {
    const { page, limit, event, userId, dateFrom, dateTo } = auditLogQuerySchema.parse(request.query);
    if (!await requireSuperAdmin(fastify, request)) return reply.status(403).send({ message: 'errors.common.forbidden' });

    return auditService.getAuditLogFiltered(page, limit, { event, userId, dateFrom, dateTo });
  });

  // Audit stats (event distribution + timeline)
  fastify.get('/audit-stats', async (request, reply) => {
    if (!await requireSuperAdmin(fastify, request)) return reply.status(403).send({ message: 'errors.common.forbidden' });

    const { days } = z.object({ days: z.coerce.number().int().positive().max(365).optional().default(30) }).parse(request.query);
    return auditService.getAuditStats(days);
  });

  // Request metrics (in-memory, rolling window)
  fastify.get('/metrics', async (request, reply) => {
    if (!await requireSuperAdmin(fastify, request)) return reply.status(403).send({ message: 'errors.common.forbidden' });

    const { window } = z.object({ window: z.coerce.number().int().positive().max(60).optional().default(60) }).parse(request.query);
    return {
      ...metrics.getMetrics(window),
      routes: metrics.getRouteMetrics(window),
    };
  });

  // System health (memory, uptime, connections)
  fastify.get('/system-health', async (request, reply) => {
    if (!await requireSuperAdmin(fastify, request)) return reply.status(403).send({ message: 'errors.common.forbidden' });

    // Lazy imports to avoid circular deps
    const { getWsConnectionCount } = await import('../hocuspocus');
    const { getSSEConnectionCount } = await import('../services/kanbanSSE');

    // DB health check
    let dbStatus = 'ok';
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'error';
    }

    return {
      uptime: metrics.getUptime(),
      memory: metrics.getMemoryUsage(),
      connections: {
        websocket: getWsConnectionCount(),
        sse: getSSEConnectionCount(),
      },
      database: {
        status: dbStatus,
      },
      metrics: metrics.getMetrics(60),
    };
  });

  // AI Configuration
  fastify.get('/ai-config', async (request, reply) => {
    if (!await requireSuperAdmin(fastify, request)) return reply.status(403).send({ message: 'errors.common.forbidden' });

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
