import 'dotenv/config';
import fastify, { FastifyRequest, FastifyReply } from 'fastify';
import prisma from './plugins/prisma';
import { AppError, isPrismaError } from './utils/errors';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import fastifyMultipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';

import { metrics } from './utils/metrics';
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
import healthRoutes from './routes/health';
import announcementRoutes, { adminAnnouncementRoutes } from './routes/announcements';


// ... ensure start
import './types';

const server = fastify({
  logger: true,
  trustProxy: true, // IIS ARR reverse proxy — read X-Forwarded-For for real client IP
});

// Plugins
server.register(cors, {
  origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:5173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
});

// Security headers
server.addHook('onSend', (request, reply, payload, done) => {
  reply.header('X-Frame-Options', 'DENY');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('X-XSS-Protection', '1; mode=block');
  reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  reply.header('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",       // Tailwind + TipTap inject styles
    "img-src 'self' data: https: blob:",       // avatars, inline images, external link previews
    "font-src 'self'",
    "connect-src 'self' wss: ws:",             // WebSocket for Hocuspocus collab
    "media-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; '));
  done();
});

// Global error handler — maps typed errors to HTTP responses
server.setErrorHandler((error, request, reply) => {
  // Typed application errors (AppError hierarchy)
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({ message: error.message });
  }

  // Zod validation errors (thrown by schema.parse in routes)
  if (error instanceof Error && error.name === 'ZodError') {
    return reply.status(400).send({
      message: 'errors.common.validationError',
      details: (error as { issues?: unknown }).issues,
    });
  }

  // Prisma P2025 — record not found (unhandled by service)
  if (isPrismaError(error, 'P2025')) {
    return reply.status(404).send({ message: 'errors.common.recordNotFound' });
  }

  // Fastify validation errors (schema validation)
  if (error !== null && typeof error === 'object' && 'validation' in error) {
    return reply.status(400).send({ message: error instanceof Error ? error.message : 'errors.common.validationError' });
  }

  // Fallback — log and return 500
  request.log.error({ err: error }, 'Unhandled error');
  return reply.status(500).send({ message: 'errors.common.internalError' });
});

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required');
  process.exit(1);
}
server.register(jwt, { secret: JWT_SECRET });

server.register(rateLimit, {
  global: true,
  max: 100,           // 100 requests per window per IP
  timeWindow: '1 minute',
  allowList: ['127.0.0.1', '::1'], // localhost exempt (health checks, internal)
});

import path from 'path';
import fs from 'fs';

// Safe MIME type map — prevents MIME injection via malicious file extensions
const IMAGE_MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
};
const ATTACHMENT_MIME_MAP: Record<string, string> = {
  ...IMAGE_MIME_MAP,
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
};

function safeImageType(filename: string): string {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return IMAGE_MIME_MAP[ext] || 'application/octet-stream';
}

function serveFile(filepath: string, contentType: string, request: FastifyRequest, reply: FastifyReply) {
  const stream = fs.createReadStream(filepath);
  stream.on('error', (err) => {
    request.log.warn({ err, filepath }, 'File stream error');
    if (!reply.raw.headersSent) {
      reply.code(404).send({ message: 'errors.common.notFound' });
    }
  });
  return reply.type(contentType).send(stream);
}

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
        return reply.code(401).send({ message: 'auth.errors.tokenInvalidated' });
      }
    }
  } catch (err) {
    return reply.code(401).send({ message: 'auth.errors.unauthorized' });
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
      }).catch((err) => {
        request.log.warn({ err, userId: request.user.id }, 'lastActiveAt update failed');
      }); // fire-and-forget
    }
  }
});

// Request metrics collection (in-memory, rolling 60-min window)
server.addHook('onResponse', (request, reply, done) => {
  const route = request.routeOptions?.url || request.url;
  metrics.recordRequest(route, request.method, reply.statusCode, reply.elapsedTime);
  done();
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
server.register(announcementRoutes, { prefix: '/api/announcements' });
server.register(adminAnnouncementRoutes, { prefix: '/api/admin/announcements' });
server.register(healthRoutes);

// Uploads base directory — consistent with attachment.service.ts
const UPLOADS_DIR = path.join(__dirname, '../uploads');

// Public avatar serving (no auth required)
server.get('/uploads/avatars/:filename', async (request, reply) => {
  const { filename } = request.params as { filename: string };
  const safeName = path.basename(filename);
  const filepath = path.join(UPLOADS_DIR, 'avatars', safeName);
  if (!fs.existsSync(filepath)) return reply.code(404).send({ message: 'errors.common.notFound' });
  return serveFile(filepath, safeImageType(safeName), request, reply);
});

// Public group avatar serving (no auth required)
server.get('/uploads/groups/:filename', async (request, reply) => {
  const { filename } = request.params as { filename: string };
  const safeName = path.basename(filename);
  const filepath = path.join(UPLOADS_DIR, 'groups', safeName);
  if (!fs.existsSync(filepath)) return reply.code(404).send({ message: 'errors.common.notFound' });
  return serveFile(filepath, safeImageType(safeName), request, reply);
});

// Public kanban board avatar serving (no auth required)
server.get('/uploads/kanban/avatars/:filename', async (request, reply) => {
  const { filename } = request.params as { filename: string };
  const safeName = path.basename(filename);
  const filepath = path.join(UPLOADS_DIR, 'kanban', 'avatars', safeName);
  if (!fs.existsSync(filepath)) return reply.code(404).send({ message: 'errors.common.notFound' });
  return serveFile(filepath, safeImageType(safeName), request, reply);
});

// Public kanban board cover serving (no auth required)
server.get('/uploads/kanban/:filename', async (request, reply) => {
  const { filename } = request.params as { filename: string };
  const safeName = path.basename(filename);
  const filepath = path.join(UPLOADS_DIR, 'kanban', safeName);
  if (!fs.existsSync(filepath)) return reply.code(404).send({ message: 'errors.common.notFound' });
  return serveFile(filepath, safeImageType(safeName), request, reply);
});

// Attachment file serving (note attachments stored in uploads root)
server.get('/uploads/:filename', async (request, reply) => {
  const { filename } = request.params as { filename: string };
  const safeName = path.basename(filename);
  const filepath = path.join(UPLOADS_DIR, safeName);
  if (!fs.existsSync(filepath)) return reply.code(404).send({ message: 'errors.common.notFound' });
  const ext = path.extname(safeName).slice(1).toLowerCase();
  const contentType = ATTACHMENT_MIME_MAP[ext] || 'application/octet-stream';
  return serveFile(filepath, contentType, request, reply);
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

// Graceful shutdown — close connections before exit
async function shutdown(signal: string) {
  server.log.info(`${signal} received, shutting down gracefully`);
  try {
    await server.close();           // stop accepting new requests, finish in-flight
    await prisma.$disconnect();     // close DB connection pool
    server.log.info('Shutdown complete');
    process.exit(0);
  } catch (err) {
    server.log.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.log.info('Starting server...');
start();
