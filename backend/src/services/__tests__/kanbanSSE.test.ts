import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import {
  addConnection,
  broadcast,
  getPresenceUsers,
} from '../kanbanSSE';
import type { BoardUser, KanbanEvent } from '../kanbanSSE';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a mock ServerResponse that tracks writes and supports 'close' event. */
function createMockResponse(): EventEmitter & { write: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter();
  (emitter as any).write = vi.fn();
  return emitter as any;
}

function createUser(id: string, name = `User ${id}`): BoardUser {
  return { id, name, color: '#ff0000', avatarUrl: null };
}

beforeEach(() => {
  vi.useFakeTimers();
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
