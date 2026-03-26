import { FastifyInstance } from 'fastify';
import prisma from '../plugins/prisma';
import { metrics } from '../utils/metrics';

export default async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    let dbStatus = 'up';
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'down';
    }

    const mem = process.memoryUsage();
    const status = dbStatus === 'up' ? 'ok' : 'error';

    const result = {
      status,
      db: dbStatus,
      uptime: metrics.getUptime(),
      memory: {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
      },
      timestamp: new Date(),
    };

    if (status === 'error') {
      return reply.code(503).send(result);
    }
    return result;
  });
}
