import { ServerResponse } from 'http';

// ─── Types ─────────────────────────────────────────────────────

export interface BoardUser {
  id: string;
  name: string | null;
  color: string | null;
  avatarUrl: string | null;
}

interface BoardConnection {
  res: ServerResponse;
  user: BoardUser;
  heartbeat: ReturnType<typeof setInterval>;
}

const boardConnections = new Map<string, Map<ServerResponse, BoardConnection>>();

export type KanbanEvent =
  | { type: 'card:moved'; boardId: string; cardId: string; toColumnId: string; position: number }
  | { type: 'card:created'; boardId: string; card: Record<string, unknown> }
  | { type: 'card:updated'; boardId: string; card: Record<string, unknown> }
  | { type: 'card:deleted'; boardId: string; cardId: string }
  | { type: 'column:created'; boardId: string; column: Record<string, unknown> }
  | { type: 'column:updated'; boardId: string; column: Record<string, unknown> }
  | { type: 'column:deleted'; boardId: string; columnId: string }
  | { type: 'columns:reordered'; boardId: string; columns: { id: string; position: number }[] }
  | { type: 'comment:added'; boardId: string; cardId: string; comment: Record<string, unknown> }
  | { type: 'comment:deleted'; boardId: string; cardId: string; commentId: string }
  | { type: 'chat:message'; boardId: string; message: Record<string, unknown> }
  | { type: 'board:updated'; boardId: string }
  | { type: 'presence:update'; boardId: string; users: BoardUser[] };

// ─── Presence helpers ──────────────────────────────────────────

export function getPresenceUsers(boardId: string): BoardUser[] {
  const connections = boardConnections.get(boardId);
  if (!connections) return [];

  // Deduplicate by user ID (same user might have multiple tabs)
  const seen = new Map<string, BoardUser>();
  for (const conn of connections.values()) {
    if (!seen.has(conn.user.id)) {
      seen.set(conn.user.id, conn.user);
    }
  }
  return Array.from(seen.values());
}

function broadcastPresence(boardId: string): void {
  const users = getPresenceUsers(boardId);
  broadcast(boardId, { type: 'presence:update', boardId, users });
}

// ─── Connection management ─────────────────────────────────────

export function addConnection(boardId: string, res: ServerResponse, user: BoardUser): void {
  if (!boardConnections.has(boardId)) {
    boardConnections.set(boardId, new Map());
  }

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 30000);

  const conn: BoardConnection = { res, user, heartbeat };
  boardConnections.get(boardId)!.set(res, conn);

  res.on('close', () => {
    const conns = boardConnections.get(boardId);
    if (conns) {
      const existing = conns.get(res);
      if (existing) clearInterval(existing.heartbeat);
      conns.delete(res);
      if (conns.size === 0) {
        boardConnections.delete(boardId);
      }
    }
    // Broadcast updated presence after disconnect
    broadcastPresence(boardId);
  });

  // Broadcast updated presence to all (including newly connected user)
  // Use setTimeout to ensure the connected event is sent first
  setTimeout(() => broadcastPresence(boardId), 50);
}

export function broadcast(boardId: string, event: KanbanEvent): void {
  const connections = boardConnections.get(boardId);
  if (!connections) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const conn of connections.values()) {
    try {
      conn.res.write(data);
    } catch {
      /* will be cleaned up on close */
    }
  }
}
