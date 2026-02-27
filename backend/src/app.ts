import 'dotenv/config';
import fastify, { FastifyRequest, FastifyReply } from 'fastify';
import prisma from './plugins/prisma';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import fastifyMultipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';

import authRoutes from './routes/auth';
import notebookRoutes from './routes/notebooks';
import noteRoutes from './routes/notes';
import tagRoutes from './routes/tags';
import { attachmentRoutes } from './routes/attachments';
import publicRoutes from './routes/public';
import sharingRoutes from './routes/sharing';
import userRoutes from './routes/user';
import notificationRoutes from './routes/notification.routes';
import chatRoutes from './routes/chat';
import adminRoutes from './routes/admin';
import inviteRoutes, { adminInviteRoutes, publicInviteRoutes } from './routes/invite';
import importRoutes from './routes/import';
import searchRoutes from './routes/search';
import aiRoutes from './routes/ai';
import groupRoutes from './routes/groups';
import urlMetadataRoutes from './routes/url-metadata';
import taskListRoutes from './routes/tasklists';
import kanbanRoutes from './routes/kanban';


// ... ensure start
import './types';

const server = fastify({
  logger: true
});

// Plugins
server.register(cors, {
  origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:5173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
});

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required');
  process.exit(1);
}
server.register(jwt, { secret: JWT_SECRET });

server.register(rateLimit, {
  global: false,
});

import path from 'path';
import fs from 'fs';

server.register(fastifyMultipart, {
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  }
});

server.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await request.jwtVerify();
    // Verify tokenVersion is still valid
    if (request.user.tokenVersion !== undefined) {
      const user = await prisma.user.findUnique({
        where: { id: request.user.id },
        select: { tokenVersion: true }
      });
      if (!user || user.tokenVersion !== request.user.tokenVersion) {
        return reply.code(401).send({ message: 'Token invalidated' });
      }
    }
  } catch (err) {
    return reply.code(401).send({ message: 'Unauthorized' });
  }
});


const lastActiveCache = new Map<string, number>();

server.addHook('onRequest', async (request: FastifyRequest) => {
  if (request.user) {
    const now = Date.now();
    const lastUpdate = lastActiveCache.get(request.user.id) || 0;
    if (now - lastUpdate > 5 * 60 * 1000) { // 5 minutes throttle
      lastActiveCache.set(request.user.id, now);
      prisma.user.update({
        where: { id: request.user.id },
        data: { lastActiveAt: new Date() }
      }).catch(() => {}); // fire-and-forget
    }
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
server.register(notificationRoutes, { prefix: '/api/notifications' });
server.register(chatRoutes, { prefix: '/api/chat' });
server.register(adminRoutes, { prefix: '/api/admin' });
server.register(inviteRoutes, { prefix: '/api/invites' });
server.register(adminInviteRoutes, { prefix: '/api/admin' });
server.register(publicInviteRoutes, { prefix: '/api/auth' });
server.register(importRoutes, { prefix: '/api/import' });
server.register(searchRoutes, { prefix: '/api/search' });
server.register(aiRoutes, { prefix: '/api/ai' });
server.register(groupRoutes, { prefix: '/api/groups' });
server.register(urlMetadataRoutes, { prefix: '/api/url-metadata' });
server.register(taskListRoutes, { prefix: '/api/tasklists' });
server.register(kanbanRoutes, { prefix: '/api/kanban' });

// Uploads base directory — consistent with attachment.service.ts
const UPLOADS_DIR = path.join(__dirname, '../uploads');

// Public avatar serving (no auth required)
server.get('/uploads/avatars/:filename', async (request, reply) => {
  const { filename } = request.params as { filename: string };
  const safeName = path.basename(filename); // prevent path traversal
  const filepath = path.join(UPLOADS_DIR, 'avatars', safeName);
  if (!fs.existsSync(filepath)) {
    return reply.code(404).send({ message: 'Not found' });
  }
  const stream = fs.createReadStream(filepath);
  return reply.type('image/' + path.extname(safeName).slice(1)).send(stream);
});

// Public group avatar serving (no auth required)
server.get('/uploads/groups/:filename', async (request, reply) => {
  const { filename } = request.params as { filename: string };
  const safeName = path.basename(filename);
  const filepath = path.join(UPLOADS_DIR, 'groups', safeName);
  if (!fs.existsSync(filepath)) {
    return reply.code(404).send({ message: 'Not found' });
  }
  const stream = fs.createReadStream(filepath);
  return reply.type('image/' + path.extname(safeName).slice(1)).send(stream);
});

// Public kanban board avatar serving (no auth required)
server.get('/uploads/kanban/avatars/:filename', async (request, reply) => {
  const { filename } = request.params as { filename: string };
  const safeName = path.basename(filename);
  const filepath = path.join(UPLOADS_DIR, 'kanban', 'avatars', safeName);
  if (!fs.existsSync(filepath)) {
    return reply.code(404).send({ message: 'Not found' });
  }
  const stream = fs.createReadStream(filepath);
  return reply.type('image/' + path.extname(safeName).slice(1)).send(stream);
});

// Public kanban board cover serving (no auth required)
server.get('/uploads/kanban/:filename', async (request, reply) => {
  const { filename } = request.params as { filename: string };
  const safeName = path.basename(filename);
  const filepath = path.join(UPLOADS_DIR, 'kanban', safeName);
  if (!fs.existsSync(filepath)) {
    return reply.code(404).send({ message: 'Not found' });
  }
  const stream = fs.createReadStream(filepath);
  return reply.type('image/' + path.extname(safeName).slice(1)).send(stream);
});

// Attachment file serving (note attachments stored in uploads root)
server.get('/uploads/:filename', async (request, reply) => {
  const { filename } = request.params as { filename: string };
  const safeName = path.basename(filename); // prevent path traversal
  const filepath = path.join(UPLOADS_DIR, safeName);
  if (!fs.existsSync(filepath)) {
    return reply.code(404).send({ message: 'Not found' });
  }
  const ext = path.extname(safeName).slice(1).toLowerCase();
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
    txt: 'text/plain', csv: 'text/csv',
  };
  const contentType = mimeMap[ext] || 'application/octet-stream';
  const stream = fs.createReadStream(filepath);
  return reply.type(contentType).send(stream);
});

// Health Check
server.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});


import { hocuspocus } from './hocuspocus';
import type { WebSocket } from 'ws';

const start = async () => {
  try {
    await server.listen({ port: 3001, host: '0.0.0.0' });

    // Attach Hocuspocus to Fastify server
    server.server.on('upgrade', (request, socket, head) => {
      server.log.debug('Upgrade request received for: %s', request.url);
      if (request.url === '/ws' || request.url?.startsWith('/ws?')) {
        server.log.debug('Handling upgrade for /ws');
        hocuspocus.webSocketServer.handleUpgrade(request, socket, head, (ws: WebSocket) => {
          hocuspocus.webSocketServer.emit('connection', ws, request);
        });
      }
    });

    server.log.info('Server running on port 3001');
    server.log.info('Hocuspocus attached to /ws');
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

server.log.info('Starting server...');
start();
