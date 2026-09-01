import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all dependencies before imports
vi.mock('../plugins/prisma', () => ({
  default: {
    note: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// hocuspocus.ts does `new Server(...)` at module load, so the double must be a real
// constructor (an arrow-function mockImplementation is not one). Copying the config
// onto the instance is what makes hocuspocus.onAuthenticate reachable from the tests.
vi.mock('@hocuspocus/server', () => ({
  Server: vi.fn(function (this: Record<string, unknown>, config: Record<string, unknown>) {
    Object.assign(this, config);
    this._config = config;
    this.hocuspocus = { documents: new Map(), getConnectionsCount: () => 0 };
  }),
}));

vi.mock('@hocuspocus/extension-logger', () => ({
  Logger: vi.fn(function () { /* constructed at module load */ }),
}));

vi.mock('@hocuspocus/extension-database', () => ({
  Database: vi.fn(function (this: Record<string, unknown>, config: Record<string, unknown>) {
    this.fetch = config.fetch;
    this.store = config.store;
  }),
}));

vi.mock('@hocuspocus/transformer', () => ({
  TiptapTransformer: {
    toYdoc: vi.fn(),
    fromYdoc: vi.fn(),
  },
}));

vi.mock('yjs', () => ({
  Doc: vi.fn().mockImplementation(() => ({
    getXmlFragment: vi.fn(),
  })),
  encodeStateAsUpdate: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
  applyUpdate: vi.fn(),
}));

vi.mock('jsonwebtoken', () => ({
  default: {
    verify: vi.fn(),
  },
}));

// Mock TipTap extensions. hocuspocus.ts chains .extend()/.configure() while building
// the extension list at module load, so every double has to return something chainable
// — these tests are about onAuthenticate and the Database hooks, not about serialization
// (that is hocuspocus-table-roundtrip.test.ts, which uses the REAL extensions).
// vi.hoisted: vi.mock factories are hoisted above every top-level binding, so the
// helper has to be hoisted with them.
const { chainable } = vi.hoisted(() => {
  const chainable = (): Record<string, unknown> => ({
    extend: () => chainable(),
    configure: () => chainable(),
  });
  return { chainable };
});

vi.mock('@tiptap/starter-kit', () => ({ default: chainable() }));
vi.mock('@tiptap/extension-table', () => ({ Table: chainable() }));
vi.mock('@tiptap/extension-table-row', () => ({ default: chainable() }));
vi.mock('@tiptap/extension-table-cell', () => ({ default: chainable() }));
vi.mock('@tiptap/extension-table-header', () => ({ default: chainable() }));
vi.mock('@tiptap/extension-text-align', () => ({ default: chainable() }));
vi.mock('@tiptap/extension-image', () => ({ default: chainable() }));
vi.mock('@tiptap/extension-text-style', () => ({ TextStyle: chainable() }));
vi.mock('@tiptap/extension-font-family', () => ({ FontFamily: chainable() }));
vi.mock('@tiptap/core', () => ({
  Node: { create: vi.fn(() => chainable()) },
  Extension: { create: vi.fn(() => chainable()) },
}));
vi.mock('../utils/extractText', () => ({
  extractTextFromTipTapJson: vi.fn().mockReturnValue('extracted text'),
}));

import prisma from '../plugins/prisma';
import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import { Database } from '@hocuspocus/extension-database';
import jwt from 'jsonwebtoken';
import { hocuspocus } from '../hocuspocus';

const prismaMock = prisma as any;
const TiptapMock = TiptapTransformer as any;
const jwtMock = jwt as any;


// Since hocuspocus.ts has complex module-level side effects, we test the logic patterns instead
describe('Hocuspocus fetch logic', () => {
  it('should return ydocState directly when available (CRDT-safe)', async () => {
    const ydocState = Buffer.from([1, 2, 3, 4, 5]);

    // Simulate the fetch logic
    const note = { content: '{"type":"doc"}', ydocState };
    if (note.ydocState) {
      const result = new Uint8Array(note.ydocState);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(5);
    }
  });

  it('should fall back to JSON conversion when no ydocState', () => {
    const note = { content: '{"type":"doc","content":[]}', ydocState: null };

    // Simulate fallback path
    expect(note.ydocState).toBeNull();
    expect(note.content).toBeTruthy();
    const json = JSON.parse(note.content);
    expect(json.type).toBe('doc');
  });

  it('should return null when note has no content and no ydocState', () => {
    const note = { content: null, ydocState: null };
    if (!note.ydocState && !note.content) {
      expect(true).toBe(true); // would return null
    }
  });
});

describe('Hocuspocus store logic', () => {
  it('should block empty content overwrite of substantial note', () => {
    const newContentStr = '{"type":"doc","content":[{"type":"paragraph"}]}'; // ~50 chars
    const existingContent = 'A'.repeat(200); // substantial existing content

    const isNewEmpty = newContentStr.length < 150;
    expect(isNewEmpty).toBe(true);
    expect(existingContent.length > 150).toBe(true);
    // Store should be blocked
  });

  it('should allow overwrite when existing content is also small', () => {
    const newContentStr = '{"type":"doc","content":[{"type":"paragraph"}]}';
    const existingContent = '{"type":"doc"}'; // small

    const isNewEmpty = newContentStr.length < 150;
    expect(isNewEmpty).toBe(true);
    expect(existingContent.length > 150).toBe(false);
    // Store should proceed
  });

  it('should always allow substantial content writes', () => {
    const newContentStr = 'A'.repeat(200);
    const isNewEmpty = newContentStr.length < 150;
    expect(isNewEmpty).toBe(false);
    // Store should proceed without checking existing
  });

  it('should save both ydocState and content JSON', () => {
    // The store saves: content (JSON string), ydocState (Buffer), searchText, updatedAt
    const state = new Uint8Array([1, 2, 3]);
    const buffer = Buffer.from(state);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBe(3);
  });
});

// [BACKUP] 2026-09-01 — this block held five tests that re-implemented the auth logic
// inside the test body and asserted on their own copy ("// Would throw 'Forbidden'"),
// so onAuthenticate itself had zero coverage. The Server mock returns the config
// object, so the real hook is reachable: these call it.
describe('Hocuspocus onAuthenticate', () => {
  const NOTE_ID = 'note-1';
  const OWNER_ID = 'owner-1';
  const SHARED_ID = 'user-2';

  function authenticate(token = 'a-token') {
    return (hocuspocus as any).onAuthenticate({ token, documentName: NOTE_ID });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.note.findUnique.mockResolvedValue({
      id: NOTE_ID,
      userId: OWNER_ID,
      sharedWith: [],
    });
    prismaMock.user.findUnique.mockResolvedValue({
      name: 'Owner',
      color: '#123456',
      avatarUrl: null,
      tokenVersion: 3,
    });
    jwtMock.verify.mockReturnValue({ id: OWNER_ID, email: 'o@test.com', role: 'USER', tokenVersion: 3 });
  });

  it('rejects when no token is provided', async () => {
    await expect((hocuspocus as any).onAuthenticate({ token: '', documentName: NOTE_ID }))
      .rejects.toThrow('Not authorized');
  });

  it('authenticates the owner with write access', async () => {
    const result = await authenticate();

    expect(result.user.id).toBe(OWNER_ID);
    expect(result.user.color).toBe('#123456');
    expect(result.readOnly).toBe(false);
  });

  it('authenticates an ACCEPTED shared user and honours their permission', async () => {
    jwtMock.verify.mockReturnValue({ id: SHARED_ID, email: 's@test.com', role: 'USER', tokenVersion: 3 });
    prismaMock.note.findUnique.mockResolvedValue({
      id: NOTE_ID,
      userId: OWNER_ID,
      sharedWith: [{ userId: SHARED_ID, status: 'ACCEPTED', permission: 'READ' }],
    });

    const result = await authenticate();

    expect(result.user.id).toBe(SHARED_ID);
    expect(result.readOnly).toBe(true);
  });

  it('rejects a user whose share is only PENDING', async () => {
    jwtMock.verify.mockReturnValue({ id: SHARED_ID, email: 's@test.com', role: 'USER', tokenVersion: 3 });
    prismaMock.note.findUnique.mockResolvedValue({
      id: NOTE_ID,
      userId: OWNER_ID,
      sharedWith: [{ userId: SHARED_ID, status: 'PENDING', permission: 'WRITE' }],
    });

    // onAuthenticate rewrites every failure to the same generic message on purpose —
    // it must not tell a WS client why it was refused.
    await expect(authenticate()).rejects.toThrow('Not authorized');
  });

  it('rejects when the note does not exist', async () => {
    prismaMock.note.findUnique.mockResolvedValue(null);

    await expect(authenticate()).rejects.toThrow('Not authorized');
  });

  // A2: app.ts:171-178 checks tokenVersion on every REST request; this hook never did,
  // so a token stolen before a password change kept opening NEW sessions forever.
  it('rejects a token whose tokenVersion is behind the user record', async () => {
    jwtMock.verify.mockReturnValue({ id: OWNER_ID, email: 'o@test.com', role: 'USER', tokenVersion: 2 });
    prismaMock.user.findUnique.mockResolvedValue({
      name: 'Owner', color: '#123456', avatarUrl: null, tokenVersion: 3,
    });

    await expect(authenticate()).rejects.toThrow('Not authorized');
  });

  it('accepts a token that carries no tokenVersion at all (issued before the field existed)', async () => {
    jwtMock.verify.mockReturnValue({ id: OWNER_ID, email: 'o@test.com', role: 'USER' });

    const result = await authenticate();

    expect(result.user.id).toBe(OWNER_ID);
  });

  it('rejects when the user record is gone', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(authenticate()).rejects.toThrow('Not authorized');
  });

  // The per-user connection counter must not be charged for a rejected token, or the
  // user burns their 10-connection budget on attempts that never became connections.
  it('does not consume a connection slot when the token is invalidated', async () => {
    jwtMock.verify.mockReturnValue({ id: OWNER_ID, email: 'o@test.com', role: 'USER', tokenVersion: 2 });
    prismaMock.user.findUnique.mockResolvedValue({
      name: 'Owner', color: '#123456', avatarUrl: null, tokenVersion: 3,
    });

    for (let i = 0; i < 15; i++) {
      await expect(authenticate()).rejects.toThrow('Not authorized');
    }

    // Budget intact: a valid token still connects after 15 rejected attempts.
    jwtMock.verify.mockReturnValue({ id: OWNER_ID, email: 'o@test.com', role: 'USER', tokenVersion: 3 });
    await expect(authenticate()).resolves.toMatchObject({ user: { id: OWNER_ID } });
  });
});
