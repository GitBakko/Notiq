import { ServerResponse } from 'http';
import prisma from '../plugins/prisma';
import logger from '../utils/logger';
import { ForbiddenError, NotFoundError } from '../utils/errors';
import { assertBoardAccess } from './kanbanPermissions';

// ─── Types ─────────────────────────────────────────────────────

/** Broadcast verbatim inside `presence:update`. Never put a secret in here. */
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

export function getSSEConnectionCount(): number {
  let count = 0;
  for (const conns of boardConnections.values()) {
    count += conns.size;
  }
  return count;
}

/** `actorId` = the user who caused the event; clients drop their own echo. */
export type KanbanEvent = KanbanEventBody & { actorId?: string };

type KanbanEventBody =
  | { type: 'card:moved'; boardId: string; cardId: string; toColumnId: string; position: number }
  | { type: 'card:created'; boardId: string; card: Record<string, unknown> }
  | { type: 'card:updated'; boardId: string; card: Record<string, unknown> }
  | { type: 'card:deleted'; boardId: string; cardId: string }
  | { type: 'card:unarchived'; boardId: string; cardId: string }
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

/**
 * Re-resolve a live stream's authorization.
 *
 * The SSE route resolves access ONCE, before the headers go out, and nothing ever asked
 * again: a deleted account, a deleted board and a bumped tokenVersion all left the stream
 * delivering cards, comments and chat until the tab was closed. This is the chokepoint that
 * asks again, on a clock the connection already pays for.
 *
 * `assertBoardAccess` covers every revocation it can SEE — the board row, the share row —
 * which is why deleteUser and deleteBoard need no call site of their own: the cascade makes
 * the next tick throw. It is structurally blind to `tokenVersion`, hence the second lookup.
 *
 * ponytail: two to three round-trips per tick instead of one hand-written JOIN (measured
 * ~3.7ms worst case against a 30s budget). Reusing assertBoardAccess keeps ONE definition of
 * "may this user read this board"; a merged query would be a second one, free to drift.
 */
async function reauthorize(boardId: string, userId: string, tokenVersion: number | undefined): Promise<void> {
  await assertBoardAccess(boardId, userId, 'READ');

  if (tokenVersion === undefined) return;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { tokenVersion: true } });
  if (!user || user.tokenVersion !== tokenVersion) {
    throw new ForbiddenError('auth.errors.tokenInvalidated');
  }
}

/**
 * `tokenVersion` comes from the JWT the route already verified. It is kept OUT of `BoardUser`
 * on purpose — that object is broadcast verbatim to every peer inside `presence:update`.
 */
export function addConnection(
  boardId: string,
  res: ServerResponse,
  user: BoardUser,
  tokenVersion?: number,
): void {
  // The route awaits assertBoardAccess and a user lookup before getting here, so a client
  // that navigates away in that window arrives with the socket already gone. Registering it
  // anyway is not merely a leak: the close listener below is attached too late to ever fire,
  // so the entry and its heartbeat survive forever, disconnectUser cannot clear them
  // (end() on a dead response is a no-op), and because getPresenceUsers gates notification
  // delivery, that user silently stops receiving every notification for this board.
  if (res.destroyed || res.writableEnded) return;

  if (!boardConnections.has(boardId)) {
    boardConnections.set(boardId, new Map());
  }

  // [BACKUP] 2026-09-02 — the tick used to be only:
  //   const heartbeat = setInterval(() => {
  //     try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  //   }, 30000);
  // The catch was unreachable: res.write() on a destroyed response returns false, it does not
  // throw. Cleanup has always come from res.on('close') below, which does fire and does work.
  let checking = false;
  async function tick(): Promise<void> {
    // Keep-alive FIRST: a stalled database must never starve it, or a proxy reaps the stream.
    // The guard is for the sub-millisecond window between disconnectUser's end() and 'close'
    // clearing this interval — a write landing in there throws ERR_STREAM_WRITE_AFTER_END,
    // which is an uncaught exception in a timer callback, i.e. a dead process.
    if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n');

    // setInterval never awaits its callback, so a hung DB would queue one re-auth per tick
    // per stream, unbounded. Skipping means revocation detection pauses while the DB is
    // stalled — the same fail-open direction as the catch below, deliberately.
    if (checking) return;
    checking = true;
    try {
      await reauthorize(boardId, user.id, tokenVersion);
    } catch (err) {
      // ONLY the two classes assertBoardAccess (and reauthorize) raise for a real denial.
      // Everything else — pool exhaustion, a dropped connection, a timeout — holds the
      // stream: evicting on an infrastructure error would kick every legitimate
      // collaborator at once. Do not widen this to `instanceof AppError`.
      if (err instanceof ForbiddenError || err instanceof NotFoundError) {
        logger.info({ boardId, userId: user.id }, 'SSE stream closed: access no longer valid');
        res.end();
      } else {
        logger.warn({ err, boardId, userId: user.id }, 'SSE re-authorization tick failed — holding the stream open');
      }
    } finally {
      checking = false;
    }
  }

  // Jittered so a pm2 restart or an IIS recycle cannot phase-lock the whole fleet onto one
  // instant. Jitter DOWN from 30s: the keep-alive interval must never grow past the value
  // already proven against the ARR proxy timeout in production.
  const heartbeat = setInterval(() => {
    void tick().catch((err) => logger.error({ err, boardId }, 'SSE heartbeat tick threw'));
  }, 25_000 + Math.floor(Math.random() * 5_000));

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

/** Kick every open stream of a user who just lost access to the board. */
export function disconnectUser(boardId: string, userId: string): void {
  const connections = boardConnections.get(boardId);
  if (!connections) return;
  for (const conn of [...connections.values()]) {
    // res.end() fires 'close', whose handler clears the heartbeat and the map entry
    if (conn.user.id === userId) conn.res.end();
  }
}

/**
 * Kick every board stream a user holds.
 *
 * For the sites where the CREDENTIALS stop being valid rather than one share — a password
 * change or reset bumps tokenVersion. The heartbeat tick would catch these within one tick
 * anyway; this closes them at once, which is what someone who changes their password
 * because they suspect a stolen session expects. Mirrors disconnectUserEverywhere() in
 * hocuspocus.ts, which does the same job for the collaboration sessions.
 *
 * Revocations that assertBoardAccess CAN see (the user row, the board row or the share row
 * disappearing) need no call site here — the tick sees them on its own.
 */
export function disconnectUserFromAllBoards(userId: string): void {
  // Copy the keys: disconnectUser's close handler deletes a board entry once its last
  // connection goes, which would mutate the map mid-iteration.
  for (const boardId of [...boardConnections.keys()]) {
    disconnectUser(boardId, userId);
  }
}

/**
 * `cardWithAssigneeSelect` includes the linked note (id + title). getBoard filters
 * that per requesting user; a broadcast cannot - it writes one payload to every
 * socket on the board. Strip it here, at the single chokepoint, instead of at each
 * of the 21 broadcast call sites.
 */
function stripNote(event: KanbanEvent): KanbanEvent {
  if (event.type === 'card:created' || event.type === 'card:updated') {
    const { note: _note, ...card } = event.card;
    return { ...event, card };
  }
  return event;
}

// [BACKUP] 2026-09-01 — broadcast serialized the raw event; it now serializes stripNote(event).
export function broadcast(boardId: string, event: KanbanEvent): void {
  const connections = boardConnections.get(boardId);
  if (!connections) return;
  const data = `data: ${JSON.stringify(stripNote(event))}\n\n`;
  for (const conn of connections.values()) {
    try {
      conn.res.write(data);
    } catch {
      /* will be cleaned up on close */
    }
  }
}
