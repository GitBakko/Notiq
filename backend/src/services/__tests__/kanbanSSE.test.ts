import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import {
  addConnection,
  broadcast,
  disconnectUser,
  disconnectUserFromAllBoards,
  getPresenceUsers,
} from '../kanbanSSE';
import type { BoardUser, KanbanEvent } from '../kanbanSSE';
import { assertBoardAccess } from '../kanbanPermissions';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../utils/errors';
import prisma from '../../plugins/prisma';

vi.mock('../kanbanPermissions', () => ({ assertBoardAccess: vi.fn() }));

const mockAssert = vi.mocked(assertBoardAccess);
const mockPrisma = prisma as unknown as {
  user: { findUnique: ReturnType<typeof vi.fn> };
};

/** The heartbeat interval is jittered into [25s, 30s); this clears any of them. */
const ONE_TICK = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a mock ServerResponse that tracks writes and supports 'close' event. */
function createMockResponse(): EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter();
  (emitter as any).write = vi.fn();
  // A real ServerResponse exposes these; addConnection refuses a response already gone
  (emitter as any).destroyed = false;
  (emitter as any).writableEnded = false;
  // A real ServerResponse emits 'close' when ended - and end() on one that is already
  // destroyed or ended is a silent no-op, which is what makes a phantom unclearable.
  (emitter as any).end = vi.fn(() => {
    const e = emitter as any;
    if (e.destroyed || e.writableEnded) return;
    e.writableEnded = true;
    emitter.emit('close');
  });
  return emitter as any;
}

function createUser(id: string, name = `User ${id}`): BoardUser {
  return { id, name, color: '#ff0000', avatarUrl: null };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockAssert.mockResolvedValue({ isOwner: true });
  mockPrisma.user.findUnique.mockResolvedValue({ tokenVersion: 1 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// getPresenceUsers
// ---------------------------------------------------------------------------
describe('getPresenceUsers', () => {
  it('returns empty array for a board with no connections', () => {
    const users = getPresenceUsers('board-nonexistent');
    expect(users).toEqual([]);
  });

  it('returns connected users after addConnection', () => {
    const res = createMockResponse();
    const user = createUser('user-1');

    addConnection('board-1', res as any, user);

    const users = getPresenceUsers('board-1');
    expect(users).toHaveLength(1);
    expect(users[0]).toEqual(user);
  });

  it('deduplicates users with multiple connections (multiple tabs)', () => {
    const res1 = createMockResponse();
    const res2 = createMockResponse();
    const user = createUser('user-1');

    addConnection('board-1', res1 as any, user);
    addConnection('board-1', res2 as any, user);

    const users = getPresenceUsers('board-1');
    expect(users).toHaveLength(1);
    expect(users[0].id).toBe('user-1');
  });

  it('returns multiple distinct users', () => {
    const res1 = createMockResponse();
    const res2 = createMockResponse();
    const user1 = createUser('user-1', 'Alice');
    const user2 = createUser('user-2', 'Bob');

    addConnection('board-1', res1 as any, user1);
    addConnection('board-1', res2 as any, user2);

    const users = getPresenceUsers('board-1');
    expect(users).toHaveLength(2);
    const ids = users.map((u) => u.id);
    expect(ids).toContain('user-1');
    expect(ids).toContain('user-2');
  });

  it('isolates presence between different boards', () => {
    const res1 = createMockResponse();
    const res2 = createMockResponse();
    const user1 = createUser('user-1');
    const user2 = createUser('user-2');

    addConnection('board-A', res1 as any, user1);
    addConnection('board-B', res2 as any, user2);

    expect(getPresenceUsers('board-A')).toHaveLength(1);
    expect(getPresenceUsers('board-A')[0].id).toBe('user-1');
    expect(getPresenceUsers('board-B')).toHaveLength(1);
    expect(getPresenceUsers('board-B')[0].id).toBe('user-2');
  });
});

// ---------------------------------------------------------------------------
// addConnection
// ---------------------------------------------------------------------------
describe('addConnection', () => {
  it('sets up heartbeat that writes to response every 30 seconds', () => {
    const res = createMockResponse();
    const user = createUser('user-1');

    addConnection('board-1', res as any, user);

    // Initially no heartbeat writes
    expect(res.write).not.toHaveBeenCalled();

    // After 30s, heartbeat should fire
    vi.advanceTimersByTime(30000);
    expect(res.write).toHaveBeenCalledWith(': heartbeat\n\n');
  });

  it('sends heartbeat repeatedly', () => {
    const res = createMockResponse();
    addConnection('board-1', res as any, createUser('user-1'));

    vi.advanceTimersByTime(90000); // 3 heartbeats
    // Filter out any broadcast writes, count only heartbeat writes
    const heartbeatWrites = res.write.mock.calls.filter(
      (call: any[]) => call[0] === ': heartbeat\n\n'
    );
    expect(heartbeatWrites).toHaveLength(3);
  });

  it('clears heartbeat when write throws', () => {
    const res = createMockResponse();
    addConnection('board-1', res as any, createUser('user-1'));

    // Make write throw on heartbeat
    res.write.mockImplementation(() => { throw new Error('Connection closed'); });

    // Should not propagate the error
    expect(() => vi.advanceTimersByTime(30000)).not.toThrow();
  });

  it('broadcasts presence update shortly after connection', () => {
    const existingRes = createMockResponse();
    addConnection('board-2', existingRes as any, createUser('user-1'));

    // Clear mocks from first connection
    existingRes.write.mockClear();

    const newRes = createMockResponse();
    addConnection('board-2', newRes as any, createUser('user-2'));

    // Advance past the setTimeout(50ms) for presence broadcast
    vi.advanceTimersByTime(50);

    // Both connections should receive presence update
    const existingWrites = existingRes.write.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('presence:update')
    );
    expect(existingWrites.length).toBeGreaterThan(0);
  });

  it('removes connection and broadcasts presence on close', () => {
    const res1 = createMockResponse();
    const res2 = createMockResponse();

    addConnection('board-3', res1 as any, createUser('user-1'));
    addConnection('board-3', res2 as any, createUser('user-2'));

    // Verify both users present
    expect(getPresenceUsers('board-3')).toHaveLength(2);

    // Simulate res1 closing
    res1.emit('close');

    // user-1 should be removed from presence
    const remaining = getPresenceUsers('board-3');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('user-2');
  });

  it('cleans up board entry when last connection closes', () => {
    const res = createMockResponse();
    addConnection('board-cleanup', res as any, createUser('user-1'));

    expect(getPresenceUsers('board-cleanup')).toHaveLength(1);

    res.emit('close');

    expect(getPresenceUsers('board-cleanup')).toEqual([]);
  });

  it('clears heartbeat interval on close', () => {
    const res = createMockResponse();
    addConnection('board-hb', res as any, createUser('user-1'));

    res.emit('close');

    // After close, advancing timers should not trigger more writes
    res.write.mockClear();
    vi.advanceTimersByTime(60000);

    const heartbeats = res.write.mock.calls.filter(
      (call: any[]) => call[0] === ': heartbeat\n\n'
    );
    expect(heartbeats).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// broadcast
// ---------------------------------------------------------------------------
describe('broadcast', () => {
  it('sends event data to all connections on the board', () => {
    const res1 = createMockResponse();
    const res2 = createMockResponse();

    addConnection('board-bc', res1 as any, createUser('user-1'));
    addConnection('board-bc', res2 as any, createUser('user-2'));

    const event: KanbanEvent = {
      type: 'card:created',
      boardId: 'board-bc',
      card: { id: 'card-1', title: 'New Card' },
    };

    broadcast('board-bc', event);

    const expectedData = `data: ${JSON.stringify(event)}\n\n`;
    expect(res1.write).toHaveBeenCalledWith(expectedData);
    expect(res2.write).toHaveBeenCalledWith(expectedData);
  });

  it('does nothing when no connections exist for the board', () => {
    const event: KanbanEvent = {
      type: 'board:updated',
      boardId: 'board-empty',
    };

    // Should not throw
    expect(() => broadcast('board-empty', event)).not.toThrow();
  });

  it('handles write errors gracefully without affecting other connections', () => {
    const failRes = createMockResponse();
    const okRes = createMockResponse();

    addConnection('board-err', failRes as any, createUser('user-1'));
    addConnection('board-err', okRes as any, createUser('user-2'));

    failRes.write.mockImplementation(() => { throw new Error('Broken pipe'); });

    const event: KanbanEvent = {
      type: 'card:deleted',
      boardId: 'board-err',
      cardId: 'card-1',
    };

    // Should not throw despite one connection failing
    expect(() => broadcast('board-err', event)).not.toThrow();

    // The working connection should still receive the event
    const expectedData = `data: ${JSON.stringify(event)}\n\n`;
    expect(okRes.write).toHaveBeenCalledWith(expectedData);
  });

  it('formats event data correctly as SSE', () => {
    const res = createMockResponse();
    addConnection('board-fmt', res as any, createUser('user-1'));

    const event: KanbanEvent = {
      type: 'card:moved',
      boardId: 'board-fmt',
      cardId: 'card-1',
      toColumnId: 'col-2',
      position: 3,
    };

    broadcast('board-fmt', event);

    // SSE format: "data: <json>\n\n"
    const writeCall = res.write.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].startsWith('data:')
    );
    expect(writeCall).toBeDefined();
    const sseData = writeCall![0] as string;
    expect(sseData).toMatch(/^data: .+\n\n$/);

    // Parse the JSON payload
    const jsonStr = sseData.replace('data: ', '').trim();
    const parsed = JSON.parse(jsonStr);
    expect(parsed.type).toBe('card:moved');
    expect(parsed.cardId).toBe('card-1');
    expect(parsed.toColumnId).toBe('col-2');
    expect(parsed.position).toBe(3);
  });

  it('broadcasts different event types correctly', () => {
    const res = createMockResponse();
    addConnection('board-types', res as any, createUser('user-1'));

    const events: KanbanEvent[] = [
      { type: 'column:created', boardId: 'board-types', column: { id: 'col-1', name: 'Todo' } },
      { type: 'column:deleted', boardId: 'board-types', columnId: 'col-1' },
      { type: 'comment:added', boardId: 'board-types', cardId: 'c1', comment: { text: 'hi' } },
      { type: 'chat:message', boardId: 'board-types', message: { content: 'hello' } },
    ];

    for (const event of events) {
      broadcast('board-types', event);
    }

    // Each event should produce one write call (plus any heartbeat/presence writes)
    const dataWrites = res.write.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].startsWith('data:')
    );
    expect(dataWrites.length).toBeGreaterThanOrEqual(events.length);
  });

  it('does not send to connections on other boards', () => {
    const resA = createMockResponse();
    const resB = createMockResponse();

    addConnection('board-A2', resA as any, createUser('user-1'));
    addConnection('board-B2', resB as any, createUser('user-2'));

    // Clear any presence broadcast writes
    vi.advanceTimersByTime(100);
    resA.write.mockClear();
    resB.write.mockClear();

    const event: KanbanEvent = {
      type: 'card:updated',
      boardId: 'board-A2',
      card: { id: 'card-1' },
    };

    broadcast('board-A2', event);

    const expectedData = `data: ${JSON.stringify(event)}\n\n`;
    expect(resA.write).toHaveBeenCalledWith(expectedData);
    expect(resB.write).not.toHaveBeenCalledWith(expectedData);
  });
});

// ---------------------------------------------------------------------------
// Integration: connection lifecycle
// ---------------------------------------------------------------------------
describe('connection lifecycle', () => {
  it('full lifecycle: connect, broadcast, disconnect, verify cleanup', () => {
    const res = createMockResponse();
    const user = createUser('user-lifecycle');

    // Connect
    addConnection('board-life', res as any, user);
    expect(getPresenceUsers('board-life')).toHaveLength(1);

    // Broadcast
    const event: KanbanEvent = { type: 'board:updated', boardId: 'board-life' };
    broadcast('board-life', event);
    const expectedData = `data: ${JSON.stringify(event)}\n\n`;
    expect(res.write).toHaveBeenCalledWith(expectedData);

    // Disconnect
    res.emit('close');
    expect(getPresenceUsers('board-life')).toEqual([]);

    // Broadcasting after disconnect does not write to closed response
    res.write.mockClear();
    broadcast('board-life', event);
    expect(res.write).not.toHaveBeenCalled();
  });

  it('one user disconnects while another remains', () => {
    const res1 = createMockResponse();
    const res2 = createMockResponse();

    addConnection('board-multi', res1 as any, createUser('user-1'));
    addConnection('board-multi', res2 as any, createUser('user-2'));

    // Disconnect user 1
    res1.emit('close');

    // user-2 should still receive broadcasts
    res2.write.mockClear();
    const event: KanbanEvent = { type: 'board:updated', boardId: 'board-multi' };
    broadcast('board-multi', event);
    expect(res2.write).toHaveBeenCalledWith(`data: ${JSON.stringify(event)}\n\n`);

    // Presence should only show user-2
    const users = getPresenceUsers('board-multi');
    expect(users).toHaveLength(1);
    expect(users[0].id).toBe('user-2');
  });
});

// ---------------------------------------------------------------------------
// broadcast: linked-note stripping
// ---------------------------------------------------------------------------
describe('broadcast note stripping', () => {
  function parsePayload(res: { write: ReturnType<typeof vi.fn> }) {
    const call = res.write.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].startsWith('data:')
    );
    return JSON.parse((call![0] as string).replace('data: ', '').trim());
  }

  it('removes the linked note from a card:created payload', () => {
    const res = createMockResponse();
    addConnection('board-note-c', res as any, createUser('user-1'));
    res.write.mockClear();

    broadcast('board-note-c', {
      type: 'card:created',
      boardId: 'board-note-c',
      card: {
        id: 'card-1',
        title: 'Card',
        noteId: 'note-1',
        note: { id: 'note-1', title: 'Secret note title', userId: 'other-user' },
      },
    });

    const parsed = parsePayload(res);
    expect(parsed.card).not.toHaveProperty('note');
    expect(parsed.card.noteId).toBe('note-1');
    expect(parsed.card.title).toBe('Card');
  });

  it('removes the linked note from a card:updated payload', () => {
    const res = createMockResponse();
    addConnection('board-note-u', res as any, createUser('user-1'));
    res.write.mockClear();

    broadcast('board-note-u', {
      type: 'card:updated',
      boardId: 'board-note-u',
      card: { id: 'card-2', note: { id: 'note-2', title: 'Secret' } },
    });

    expect(parsePayload(res).card).not.toHaveProperty('note');
  });

  it('keeps actorId on the serialized payload', () => {
    const res = createMockResponse();
    addConnection('board-actor', res as any, createUser('user-1'));
    res.write.mockClear();

    broadcast('board-actor', {
      type: 'card:deleted',
      boardId: 'board-actor',
      cardId: 'card-3',
      actorId: 'user-7',
    });

    expect(parsePayload(res).actorId).toBe('user-7');
  });
});

// ---------------------------------------------------------------------------
// disconnectUser
// ---------------------------------------------------------------------------
describe('disconnectUser', () => {
  it('ends every connection belonging to the user and leaves the others open', () => {
    const revokedTab1 = createMockResponse();
    const revokedTab2 = createMockResponse();
    const otherUser = createMockResponse();

    addConnection('board-kick', revokedTab1 as any, createUser('user-revoked'));
    addConnection('board-kick', revokedTab2 as any, createUser('user-revoked'));
    addConnection('board-kick', otherUser as any, createUser('user-stays'));

    disconnectUser('board-kick', 'user-revoked');

    expect(revokedTab1.end).toHaveBeenCalled();
    expect(revokedTab2.end).toHaveBeenCalled();
    expect(otherUser.end).not.toHaveBeenCalled();

    const remaining = getPresenceUsers('board-kick');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('user-stays');
  });

  it('no longer writes broadcasts to the disconnected user', () => {
    const revoked = createMockResponse();
    const staying = createMockResponse();

    addConnection('board-kick2', revoked as any, createUser('user-revoked'));
    addConnection('board-kick2', staying as any, createUser('user-stays'));

    disconnectUser('board-kick2', 'user-revoked');
    revoked.write.mockClear();
    staying.write.mockClear();

    broadcast('board-kick2', { type: 'board:updated', boardId: 'board-kick2' });

    expect(revoked.write).not.toHaveBeenCalled();
    expect(staying.write).toHaveBeenCalled();
  });

  it('does nothing for a board with no connections', () => {
    expect(() => disconnectUser('board-none', 'user-x')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// addConnection: refuse a response that is already gone
// ---------------------------------------------------------------------------
describe('addConnection on a dead response', () => {
  it('registers nothing when the socket died during the pre-connect awaits', () => {
    const dead = createMockResponse();
    // The route awaits assertBoardAccess + user lookup before calling addConnection.
    // A client that navigates away in that window arrives here already destroyed.
    (dead as any).destroyed = true;

    addConnection('board-ghost', dead as any, createUser('ghost'));

    expect(getPresenceUsers('board-ghost')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no phantom that disconnectUser cannot clear', () => {
    const dead = createMockResponse();
    (dead as any).writableEnded = true;
    const alive = createMockResponse();

    addConnection('board-ghost2', dead as any, createUser('ghost'));
    addConnection('board-ghost2', alive as any, createUser('real'));

    // end() on an already-ended response is a no-op, so 'close' never fires and a
    // phantom would survive disconnectUser forever - and getPresenceUsers gates
    // notification delivery, so the ghost would silently lose every notification.
    disconnectUser('board-ghost2', 'ghost');

    expect(getPresenceUsers('board-ghost2').map((u) => u.id)).toEqual(['real']);
  });
});

// ---------------------------------------------------------------------------
// Heartbeat re-authorization
//
// The SSE route resolves access ONCE, at connect. These tests pin the tick that
// re-resolves it, and - just as important - pin what it must NOT do when the
// failure is infrastructural rather than a real revocation.
// ---------------------------------------------------------------------------
describe('heartbeat re-authorization', () => {
  it('ends the stream when the board is gone (deleteBoard, or a cascade from deleteUser)', async () => {
    const res = createMockResponse();
    addConnection('board-reauth-404', res as any, createUser('user-1'), 1);

    mockAssert.mockRejectedValue(new NotFoundError('errors.kanban.boardNotFound'));
    await vi.advanceTimersByTimeAsync(ONE_TICK);

    expect(res.end).toHaveBeenCalled();
    expect(getPresenceUsers('board-reauth-404')).toEqual([]);
  });

  it('ends the stream when the share is gone (revoke, or a cascade from deleteUser)', async () => {
    const res = createMockResponse();
    addConnection('board-reauth-403', res as any, createUser('user-1'), 1);

    mockAssert.mockRejectedValue(new ForbiddenError('errors.common.accessDenied'));
    await vi.advanceTimersByTimeAsync(ONE_TICK);

    expect(res.end).toHaveBeenCalled();
  });

  it('ends the stream when tokenVersion was bumped after connect', async () => {
    const res = createMockResponse();
    addConnection('board-reauth-tv', res as any, createUser('user-1'), 1);

    // Board access is intact - only the credentials died. assertBoardAccess is
    // structurally blind to this, which is why the tick checks it separately.
    mockPrisma.user.findUnique.mockResolvedValue({ tokenVersion: 2 });
    await vi.advanceTimersByTimeAsync(ONE_TICK);

    expect(res.end).toHaveBeenCalled();
  });

  it('ends the stream when the user row is gone', async () => {
    const res = createMockResponse();
    addConnection('board-reauth-nouser', res as any, createUser('user-1'), 1);

    mockPrisma.user.findUnique.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(ONE_TICK);

    expect(res.end).toHaveBeenCalled();
  });

  it('holds the stream open when the database is unreachable', async () => {
    const res = createMockResponse();
    addConnection('board-reauth-db', res as any, createUser('user-1'), 1);

    mockAssert.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    await vi.advanceTimersByTimeAsync(ONE_TICK);

    // Evicting on an infra error would kick every legitimate collaborator at once.
    expect(res.end).not.toHaveBeenCalled();
    expect(res.write).toHaveBeenCalledWith(': heartbeat\n\n');
  });

  it('holds the stream open on an error class that is not an authorization denial', async () => {
    const res = createMockResponse();
    addConnection('board-reauth-400', res as any, createUser('user-1'), 1);

    // The allowlist is deliberately the two classes assertBoardAccess throws, NOT
    // `instanceof AppError`. Widening it would mass-evict on any future error type.
    mockAssert.mockRejectedValue(new BadRequestError('errors.common.badRequest'));
    await vi.advanceTimersByTimeAsync(ONE_TICK);

    expect(res.end).not.toHaveBeenCalled();
  });

  it('writes the heartbeat before awaiting the re-authorization', async () => {
    const res = createMockResponse();
    addConnection('board-reauth-slow', res as any, createUser('user-1'), 1);

    // A hung DB (lock contention, autovacuum) never rejects, so the allowlist never
    // runs. The keep-alive must not be starved behind it or a proxy reaps the stream.
    mockAssert.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(120_000);

    const heartbeats = res.write.mock.calls.filter((c: any[]) => c[0] === ': heartbeat\n\n');
    expect(heartbeats.length).toBeGreaterThanOrEqual(4);
  });

  it('does not pile up re-authorizations while one is still in flight', async () => {
    const res = createMockResponse();
    addConnection('board-reauth-pileup', res as any, createUser('user-1'), 1);

    mockAssert.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(120_000);

    // setInterval never awaits its callback: without a guard, a stalled DB queues
    // one re-auth per tick per stream, unbounded.
    expect(mockAssert).toHaveBeenCalledTimes(1);
  });

  it('skips the tokenVersion query when the connection carries no tokenVersion', async () => {
    const res = createMockResponse();
    addConnection('board-reauth-notv', res as any, createUser('user-1'));

    await vi.advanceTimersByTimeAsync(ONE_TICK);

    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('re-authorizes with READ, against the board the connection is on', async () => {
    const res = createMockResponse();
    addConnection('board-reauth-args', res as any, createUser('user-42'), 7);

    await vi.advanceTimersByTimeAsync(ONE_TICK);

    expect(mockAssert).toHaveBeenCalledWith('board-reauth-args', 'user-42', 'READ');
  });

  it('does not leak tokenVersion into the presence payload', async () => {
    const res = createMockResponse();
    addConnection('board-reauth-leak', res as any, createUser('user-1'), 9);

    await vi.advanceTimersByTimeAsync(100);

    const presence = res.write.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('presence:update'),
    );
    expect(presence).toBeDefined();
    expect(presence![0]).not.toContain('tokenVersion');
  });
});

// ---------------------------------------------------------------------------
// disconnectUserFromAllBoards
// ---------------------------------------------------------------------------
describe('disconnectUserFromAllBoards', () => {
  it('ends the streams of that user on every board and leaves everyone else connected', () => {
    const tabA = createMockResponse();
    const tabB = createMockResponse();
    const bystander = createMockResponse();

    addConnection('board-all-1', tabA as any, createUser('user-revoked'));
    addConnection('board-all-2', tabB as any, createUser('user-revoked'));
    addConnection('board-all-2', bystander as any, createUser('user-stays'));

    disconnectUserFromAllBoards('user-revoked');

    expect(tabA.end).toHaveBeenCalled();
    expect(tabB.end).toHaveBeenCalled();
    expect(bystander.end).not.toHaveBeenCalled();
    expect(getPresenceUsers('board-all-1')).toEqual([]);
    expect(getPresenceUsers('board-all-2').map((u) => u.id)).toEqual(['user-stays']);
  });

  it('survives the board map shrinking underneath it', () => {
    // disconnectUser's close handler deletes a board entry once its last connection
    // goes, so the keys must be copied before iterating.
    const only1 = createMockResponse();
    const only2 = createMockResponse();

    addConnection('board-shrink-1', only1 as any, createUser('solo'));
    addConnection('board-shrink-2', only2 as any, createUser('solo'));

    expect(() => disconnectUserFromAllBoards('solo')).not.toThrow();
    expect(only1.end).toHaveBeenCalled();
    expect(only2.end).toHaveBeenCalled();
  });

  it('does nothing for a user with no open streams', () => {
    expect(() => disconnectUserFromAllBoards('nobody')).not.toThrow();
  });
});
