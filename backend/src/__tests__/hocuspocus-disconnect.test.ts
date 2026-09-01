/**
 * A3: onAuthenticate resolves note access ONCE, at connect, and Hocuspocus never
 * re-checks it. Without disconnectUserFromNote, a collaborator whose share is revoked
 * keeps `readOnly === false` on the live Connection and goes on WRITING to the note
 * until they close the tab.
 *
 * These tests exercise the primitive against a fake Document, the same way
 * kanbanSSE.test.ts exercises disconnectUser against fake ServerResponses.
 *
 * @hocuspocus/server and related infra are mocked to prevent module-level side effects
 * when hocuspocus.ts is imported (same pattern as hocuspocus-table-roundtrip.test.ts),
 * but the Server double carries a real `documents` Map so the lookup path is real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must be declared before the import of hocuspocus.ts.
vi.mock('@hocuspocus/server', () => {
  function ServerMock(this: {
    hocuspocus: { documents: Map<string, unknown>; getConnectionsCount: () => number };
  }) {
    this.hocuspocus = { documents: new Map(), getConnectionsCount: () => 0 };
  }
  return { Server: ServerMock };
});
vi.mock('@hocuspocus/extension-logger', () => {
  function LoggerMock() {}
  return { Logger: LoggerMock };
});
vi.mock('@hocuspocus/extension-database', () => {
  function DatabaseMock(this: object, cfg: unknown) { Object.assign(this, cfg as object); }
  return { Database: DatabaseMock };
});
vi.mock('jsonwebtoken', () => ({ default: { verify: vi.fn() } }));

import { hocuspocus, disconnectUserFromNote, disconnectUserEverywhere } from '../hocuspocus';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOTE_ID = 'note-1';

function createConnection(userId: string) {
  return {
    context: { user: { id: userId } },
    readOnly: false,
    close: vi.fn(),
  };
}

/** Minimal stand-in for a Hocuspocus Document: only getConnections() is used. */
function mountDocument(noteId: string, connections: ReturnType<typeof createConnection>[]) {
  const documents = (hocuspocus as unknown as {
    hocuspocus: { documents: Map<string, unknown> };
  }).hocuspocus.documents;
  documents.set(noteId, { getConnections: () => connections });
}

beforeEach(() => {
  vi.clearAllMocks();
  (hocuspocus as unknown as {
    hocuspocus: { documents: Map<string, unknown> };
  }).hocuspocus.documents.clear();
});

// ---------------------------------------------------------------------------
// disconnectUserFromNote
// ---------------------------------------------------------------------------

describe('disconnectUserFromNote', () => {
  it('closes every session of the revoked user and leaves the others open', () => {
    const revokedTab1 = createConnection('user-revoked');
    const revokedTab2 = createConnection('user-revoked');
    const owner = createConnection('user-owner');
    mountDocument(NOTE_ID, [revokedTab1, revokedTab2, owner]);

    disconnectUserFromNote(NOTE_ID, 'user-revoked');

    expect(revokedTab1.close).toHaveBeenCalledTimes(1);
    expect(revokedTab2.close).toHaveBeenCalledTimes(1);
    expect(owner.close).not.toHaveBeenCalled();
  });

  it('closes with a Forbidden close event', () => {
    const revoked = createConnection('user-revoked');
    mountDocument(NOTE_ID, [revoked]);

    disconnectUserFromNote(NOTE_ID, 'user-revoked');

    expect(revoked.close).toHaveBeenCalledWith({ code: 4403, reason: 'Forbidden' });
  });

  it('only touches the note it was given, not the same user on another note', () => {
    const onRevokedNote = createConnection('user-revoked');
    const onOtherNote = createConnection('user-revoked');
    mountDocument(NOTE_ID, [onRevokedNote]);
    mountDocument('note-2', [onOtherNote]);

    disconnectUserFromNote(NOTE_ID, 'user-revoked');

    expect(onRevokedNote.close).toHaveBeenCalled();
    expect(onOtherNote.close).not.toHaveBeenCalled();
  });

  it('does nothing when nobody has the note open', () => {
    expect(() => disconnectUserFromNote('note-nobody-has-open', 'user-x')).not.toThrow();
  });

  it('does not throw when a connection carries no user context', () => {
    const anonymous = { context: undefined, readOnly: false, close: vi.fn() };
    mountDocument(NOTE_ID, [anonymous as unknown as ReturnType<typeof createConnection>]);

    expect(() => disconnectUserFromNote(NOTE_ID, 'user-revoked')).not.toThrow();
    expect(anonymous.close).not.toHaveBeenCalled();
  });

  it('swallows a failure from close() so the revoke itself still succeeds', () => {
    const exploding = createConnection('user-revoked');
    exploding.close.mockImplementation(() => { throw new Error('socket already gone'); });
    mountDocument(NOTE_ID, [exploding]);

    expect(() => disconnectUserFromNote(NOTE_ID, 'user-revoked')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// disconnectUserEverywhere
// ---------------------------------------------------------------------------

describe('disconnectUserEverywhere', () => {
  it('closes the user sessions on every note at once', () => {
    const onNote1 = createConnection('user-compromised');
    const onNote2 = createConnection('user-compromised');
    const onNote3 = createConnection('user-compromised');
    mountDocument('note-1', [onNote1]);
    mountDocument('note-2', [onNote2]);
    mountDocument('note-3', [onNote3]);

    disconnectUserEverywhere('user-compromised');

    expect(onNote1.close).toHaveBeenCalledTimes(1);
    expect(onNote2.close).toHaveBeenCalledTimes(1);
    expect(onNote3.close).toHaveBeenCalledTimes(1);
  });

  it('leaves every other user alone on the same notes', () => {
    const compromised = createConnection('user-compromised');
    const bystanderSameNote = createConnection('user-bystander');
    const bystanderOtherNote = createConnection('user-bystander');
    mountDocument('note-1', [compromised, bystanderSameNote]);
    mountDocument('note-2', [bystanderOtherNote]);

    disconnectUserEverywhere('user-compromised');

    expect(compromised.close).toHaveBeenCalled();
    expect(bystanderSameNote.close).not.toHaveBeenCalled();
    expect(bystanderOtherNote.close).not.toHaveBeenCalled();
  });

  it('does nothing when the user holds no session anywhere', () => {
    mountDocument('note-1', [createConnection('someone-else')]);

    expect(() => disconnectUserEverywhere('user-with-no-sessions')).not.toThrow();
  });

  it('does nothing when no document is loaded at all', () => {
    expect(() => disconnectUserEverywhere('user-x')).not.toThrow();
  });
});
