import { FastifyInstance } from 'fastify';
import prisma from '../plugins/prisma';

export default async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async (request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', db: 'up', timestamp: new Date() };
    } catch (e) {
      return reply.code(503).send({ status: 'error', db: 'down', timestamp: new Date() });
    }
  });
}
