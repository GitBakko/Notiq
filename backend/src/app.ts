import fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import fastifyMultipart from '@fastify/multipart';

import authRoutes from './routes/auth';
import notebookRoutes from './routes/notebooks';
import noteRoutes from './routes/notes';
import tagRoutes from './routes/tags';
import { attachmentRoutes } from './routes/attachments';
import publicRoutes from './routes/public';
import sharingRoutes from './routes/sharing';
import userRoutes from './routes/user';
import './types';

const server = fastify({
  logger: true
});

// Plugins
server.register(cors, {
  origin: true, // Allow all for dev
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});

server.register(jwt, {
  secret: process.env.JWT_SECRET || 'supersecret'
});

import fastifyStatic from '@fastify/static';
import path from 'path';

// ... imports

server.register(fastifyMultipart, {
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  }
});

server.register(fastifyStatic, {
  root: path.join(__dirname, '../uploads'),
  prefix: '/uploads/', // optional: default '/'
});

server.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.send(err);
  }
});

// Routes
server.register(authRoutes, { prefix: '/api/auth' });
server.register(notebookRoutes, { prefix: '/api/notebooks' });
server.register(noteRoutes, { prefix: '/api/notes' });
server.register(tagRoutes, { prefix: '/api/tags' });
server.register(attachmentRoutes, { prefix: '/api/attachments' });
server.register(publicRoutes, { prefix: '/api/public' });
server.register(sharingRoutes, { prefix: '/api/share' });
server.register(userRoutes, { prefix: '/api/user' });

// Health Check
server.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});


import { hocuspocus } from './hocuspocus';

const start = async () => {
  try {
    await server.listen({ port: 3001, host: '0.0.0.0' });
    await hocuspocus.listen();
    console.log('Hocuspocus running on port 1234');
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
