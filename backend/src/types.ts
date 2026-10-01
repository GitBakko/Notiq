import '@fastify/jwt';
import { FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { id: string; email: string; role: string; tokenVersion?: number; sid?: string };
    user: { id: string; email: string; name?: string; role: string; tokenVersion?: number; iat?: number; jti?: string; sid?: string };
  }
}
