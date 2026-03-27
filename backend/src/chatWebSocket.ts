/* eslint-disable @typescript-eslint/no-var-requires */
import jwt from 'jsonwebtoken';
import logger from './utils/logger';
import { sendMessage, editMessage, deleteMessage, setReaction, removeReaction, updateReadReceipt } from './services/chat-direct.service';
import { createNotification } from './services/notification.service';
import prisma from './plugins/prisma';

// Use require to avoid DOM WebSocket type collision (dom lib in tsconfig)
const { WebSocketServer, WebSocket: WsWebSocket } = require('ws') as {
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
  WebSocket: { OPEN: number };
};

// Minimal ws type definitions (avoids @types/ws dependency)
interface WsSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  on(event: string, handler: (...args: any[]) => void): void;
}

interface WsServer {
  on(event: 'connection', handler: (ws: WsSocket) => void): void;
  handleUpgrade(request: any, socket: any, head: any, callback: (ws: WsSocket) => void): void;
  emit(event: string, ...args: any[]): void;
}

const JWT_SECRET = process.env.JWT_SECRET || '';

// ─── State ─────────────────────────────────────────────────
const chatWss: WsServer = new WebSocketServer({ noServer: true });
const userConnections = new Map<string, Set<WsSocket>>();
const MAX_CONNECTIONS_PER_USER = 5;

// ─── Helpers ───────────────────────────────────────────────

function getUserId(ws: WsSocket): string | undefined {
  return (ws as any).__userId;
}

function isUserOnline(userId: string): boolean {
  const conns = userConnections.get(userId);
  return !!conns && conns.size > 0;
}

// Broadcast to all connections of a specific user
function broadcastToUser(userId: string, event: object) {
  const conns = userConnections.get(userId);
  if (!conns) return;
  const data = JSON.stringify(event);
  for (const ws of conns) {
    if (ws.readyState === WsWebSocket.OPEN) {
      ws.send(data);
    }
  }
}

// Broadcast to all participants of a conversation (except excludeUserId)
async function broadcastToConversation(conversationId: string, event: object, excludeUserId?: string) {
  const participants = await prisma.conversationParticipant.findMany({
    where: { conversationId },
    select: { userId: true },
  });
  const data = JSON.stringify(event);
  for (const p of participants) {
    if (p.userId === excludeUserId) continue;
    const conns = userConnections.get(p.userId);
    if (!conns) continue;
    for (const ws of conns) {
      if (ws.readyState === WsWebSocket.OPEN) {
        ws.send(data);
      }
    }
  }
}

// Get online status of friends for a user
async function getOnlineFriendIds(userId: string): Promise<string[]> {
  const friends = await prisma.friendship.findMany({
    where: {
      OR: [{ userAId: userId }, { userBId: userId }],
      status: 'ACTIVE',
    },
    select: { userAId: true, userBId: true },
  });
  return friends
    .map(f => f.userAId === userId ? f.userBId : f.userAId)
    .filter(id => isUserOnline(id));
}

// ─── Connection lifecycle ──────────────────────────────────

chatWss.on('connection', (ws: WsSocket) => {
  const userId = getUserId(ws);
  if (!userId) { ws.close(4001, 'Not authenticated'); return; }

  // Track connection
  let conns = userConnections.get(userId);
  if (!conns) { conns = new Set(); userConnections.set(userId, conns); }

  if (conns.size >= MAX_CONNECTIONS_PER_USER) {
    ws.close(4002, 'Too many connections');
    return;
  }
  conns.add(ws);

  // Send initial online friends list
  getOnlineFriendIds(userId).then(onlineFriends => {
    if (ws.readyState === WsWebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'presence:init', onlineFriends }));
    }
  });

  // Broadcast online status to friends
  broadcastPresence(userId, true);

  // Heartbeat
  const heartbeat = setInterval(() => {
    if (ws.readyState === WsWebSocket.OPEN) ws.ping();
  }, 30000);

  ws.on('pong', () => { (ws as any).__alive = true; });
  (ws as any).__alive = true;

  // Message handler
  ws.on('message', (raw: any) => {
    try {
      const data = JSON.parse(raw.toString());
      handleMessage(ws, userId, data);
    } catch (err) {
      logger.warn({ err }, 'Invalid WS message');
    }
  });

  // Disconnect
  ws.on('close', () => {
    clearInterval(heartbeat);
    conns?.delete(ws);
    if (conns?.size === 0) {
      userConnections.delete(userId);
      broadcastPresence(userId, false);
    }
  });
});

// ─── Presence ──────────────────────────────────────────────

async function broadcastPresence(userId: string, isOnline: boolean) {
  const event = { type: 'presence:update', userId, isOnline };

  // Get ALL friends (not just online) so offline notifications reach everyone connected
  const friends = await prisma.friendship.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }], status: 'ACTIVE' },
    select: { userAId: true, userBId: true },
  });
  for (const f of friends) {
    const fId = f.userAId === userId ? f.userBId : f.userAId;
    broadcastToUser(fId, event);
  }
}

// ─── Message router ────────────────────────────────────────

async function handleMessage(ws: WsSocket, userId: string, data: any) {
  try {
    switch (data.type) {
      case 'message:send': {
        const msg = await sendMessage(data.conversationId, userId, {
          content: data.content,
          replyToId: data.replyToId,
        });
        // Acknowledge to sender with DB-assigned ID
        ws.send(JSON.stringify({ type: 'message:ack', tempId: data.tempId, message: msg }));
        // Broadcast to others
        await broadcastToConversation(data.conversationId, { type: 'message:new', message: msg }, userId);
        // Push notifications for offline participants
        try {
          const senderName = msg.sender?.name || msg.sender?.email || 'Someone';
          const participants = await prisma.conversationParticipant.findMany({
            where: { conversationId: data.conversationId, userId: { not: userId } },
            select: { userId: true },
          });
          for (const p of participants) {
            if (!isUserOnline(p.userId)) {
              createNotification(p.userId, 'CHAT_MESSAGE', senderName, (data.content as string).slice(0, 100), {
                conversationId: data.conversationId, messageId: msg.id,
              }).catch(() => {});
            }
          }
        } catch (_e) { /* non-critical */ }
        break;
      }
      case 'message:edit': {
        const edited = await editMessage(data.messageId, userId, data.content);
        await broadcastToConversation(edited.conversationId, {
          type: 'message:edited', messageId: edited.id, content: edited.content, editedAt: edited.editedAt,
        });
        break;
      }
      case 'message:delete': {
        const deletedId = await deleteMessage(data.messageId, userId);
        // Need conversationId — get from message
        const msg = await prisma.directMessage.findUnique({ where: { id: data.messageId }, select: { conversationId: true } });
        if (msg) {
          await broadcastToConversation(msg.conversationId, { type: 'message:deleted', messageId: deletedId });
        }
        break;
      }
      case 'reaction:set': {
        const reactions = await setReaction(data.messageId, userId, data.emoji);
        const rMsg = await prisma.directMessage.findUnique({ where: { id: data.messageId }, select: { conversationId: true } });
        if (rMsg) {
          await broadcastToConversation(rMsg.conversationId, { type: 'reaction:updated', messageId: data.messageId, reactions });
        }
        break;
      }
      case 'reaction:remove': {
        const reactions = await removeReaction(data.messageId, userId);
        const rmMsg = await prisma.directMessage.findUnique({ where: { id: data.messageId }, select: { conversationId: true } });
        if (rmMsg) {
          await broadcastToConversation(rmMsg.conversationId, { type: 'reaction:updated', messageId: data.messageId, reactions });
        }
        break;
      }
      case 'typing:start':
      case 'typing:stop': {
        await broadcastToConversation(data.conversationId, {
          type: 'typing:indicator',
          conversationId: data.conversationId,
          userId,
          isTyping: data.type === 'typing:start',
        }, userId);
        break;
      }
      case 'read:update': {
        await updateReadReceipt(data.conversationId, userId);
        await broadcastToConversation(data.conversationId, {
          type: 'read:receipt',
          conversationId: data.conversationId,
          userId,
          lastReadAt: new Date().toISOString(),
        }, userId);
        break;
      }
      default:
        logger.warn({ type: data.type }, 'Unknown chat WS message type');
    }
  } catch (err) {
    logger.error({ err, type: data.type, userId }, 'Chat WS message handler error');
    if (ws.readyState === WsWebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: (err as Error).message || 'Internal error' }));
    }
  }
}

// ─── Authentication ────────────────────────────────────────

function authenticateFromUrl(url: string): string | null {
  try {
    const params = new URL(url, 'http://localhost').searchParams;
    const token = params.get('token');
    if (!token) return null;
    const decoded = jwt.verify(token, JWT_SECRET) as { id?: string; userId?: string };
    return decoded.id || decoded.userId || null;
  } catch {
    return null;
  }
}

// ─── Exports ───────────────────────────────────────────────

export { chatWss, isUserOnline, broadcastToUser, broadcastToConversation, authenticateFromUrl };
