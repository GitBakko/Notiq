import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import prisma from '../../plugins/prisma';
import {
  checkNoteAccess,
  createNote,
  getNotes,
  getNote,
  updateNote,
  deleteNote,
  toggleShare,
  getPublicNote,
  getNoteSizeBreakdown,
} from '../note.service';
import { hocuspocus } from '../../hocuspocus';
import { archiveRestWriteWhileLive, snapshotPreviousVersion, __resetSnapshotStateForTests } from '../noteVersion.service';
import { rebaseYdocState } from '../../utils/ydoc';
import logger from '../../utils/logger';
import { NotFoundError, ConflictError } from '../../utils/errors';

// Additional mocks beyond setup.ts
vi.mock('../../hocuspocus', () => ({
  // `hocuspocus` is a @hocuspocus/server Server: closeConnections lives on its inner
  // Hocuspocus instance (Server.hocuspocus), the same path getWsConnectionCount uses.
  hocuspocus: {
    openDirectConnection: vi.fn(),
    hocuspocus: { closeConnections: vi.fn(), documents: new Map(), loadingDocuments: new Map() },
  },
  extensions: [],
  disconnectUserFromNote: vi.fn(),
}));

vi.mock('../noteVersion.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../noteVersion.service')>();
  return {
    ...actual,
    archiveRestWriteWhileLive: vi.fn(),
    snapshotPreviousVersion: vi.fn(actual.snapshotPreviousVersion),
  };
});

vi.mock('../../utils/ydoc', () => ({
  rebaseYdocState: vi.fn(() => null),
}));

vi.mock('@hocuspocus/transformer', () => ({
  TiptapTransformer: { toYdoc: vi.fn(), fromYdoc: vi.fn() },
}));

vi.mock('yjs', () => ({
  Doc: vi.fn(),
  encodeStateAsUpdate: vi.fn(() => new Uint8Array([1, 2, 3])),
}));

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'mock-uuid-v4'),
}));

vi.mock('../../utils/extractText', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/extractText')>();
  return {
    extractTextFromTipTapJson: vi.fn((content: string) => `extracted:${content}`),
    countDocumentStats: actual.countDocumentStats,
  };
});

const prismaMock = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// checkNoteAccess
// ---------------------------------------------------------------------------
describe('checkNoteAccess', () => {
  it('returns OWNER when the user owns the note', async () => {
    prismaMock.note.findUnique.mockResolvedValue({
      userId: 'user-1',
      sharedWith: [],
    });

    const result = await checkNoteAccess('user-1', 'note-1');
    expect(result).toBe('OWNER');
    expect(prismaMock.note.findUnique).toHaveBeenCalledWith({
      where: { id: 'note-1' },
      select: {
        userId: true,
        isVault: true,
        sharedWith: { where: { userId: 'user-1', status: 'ACCEPTED' }, select: { permission: true } },
      },
    });
  });

  it('returns READ when user has accepted READ share', async () => {
    prismaMock.note.findUnique.mockResolvedValue({
      userId: 'owner-1',
      sharedWith: [{ permission: 'READ' }],
    });

    const result = await checkNoteAccess('user-2', 'note-1');
    expect(result).toBe('READ');
  });

  it('returns WRITE when user has accepted WRITE share', async () => {
    prismaMock.note.findUnique.mockResolvedValue({
      userId: 'owner-1',
      sharedWith: [{ permission: 'WRITE' }],
    });

    const result = await checkNoteAccess('user-2', 'note-1');
    expect(result).toBe('WRITE');
  });

  it('returns null when note does not exist', async () => {
    prismaMock.note.findUnique.mockResolvedValue(null);

    const result = await checkNoteAccess('user-1', 'nonexistent');
    expect(result).toBeNull();
  });

  it('returns null when user is neither owner nor shared', async () => {
    prismaMock.note.findUnique.mockResolvedValue({
      userId: 'owner-1',
      sharedWith: [],
    });

    const result = await checkNoteAccess('stranger', 'note-1');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createNote
// ---------------------------------------------------------------------------
describe('createNote', () => {
  const baseNote = {
    id: 'new-note',
    title: 'Test',
    content: '{"type":"doc"}',
    userId: 'user-1',
    notebookId: 'nb-1',
    isVault: false,
    isEncrypted: false,
  };

  it('creates a note in the specified notebook when it belongs to the user', async () => {
    prismaMock.notebook.findFirst.mockResolvedValueOnce({ id: 'nb-1', userId: 'user-1' });
    prismaMock.note.create.mockResolvedValue(baseNote);

    const result = await createNote('user-1', 'Test', '{"type":"doc"}', 'nb-1');

    expect(prismaMock.notebook.findFirst).toHaveBeenCalledWith({
      where: { id: 'nb-1', userId: 'user-1' },
    });
    expect(prismaMock.note.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: 'Test',
        content: '{"type":"doc"}',
        userId: 'user-1',
        notebookId: 'nb-1',
        isVault: false,
        isEncrypted: false,
        searchText: 'extracted:{"type":"doc"}',
      }),
    });
    expect(result).toEqual(baseNote);
  });

  it('falls back to any user notebook when the specified one is not found', async () => {
    prismaMock.notebook.findFirst
      .mockResolvedValueOnce(null) // specified notebook not found
      .mockResolvedValueOnce({ id: 'nb-fallback', userId: 'user-1' }); // fallback
    prismaMock.note.create.mockResolvedValue({ ...baseNote, notebookId: 'nb-fallback' });

    await createNote('user-1', 'Test', '{"type":"doc"}', 'nb-missing');

    expect(prismaMock.note.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ notebookId: 'nb-fallback' }),
    });
  });

  it('throws when user has no notebooks at all', async () => {
    prismaMock.notebook.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await expect(createNote('user-1', 'Test', '{}', 'nb-missing'))
      .rejects.toThrow('errors.notebooks.notFound');
  });

  it('sets searchText to null when note is encrypted', async () => {
    prismaMock.notebook.findFirst.mockResolvedValueOnce({ id: 'nb-1', userId: 'user-1' });
    prismaMock.note.create.mockResolvedValue({ ...baseNote, isEncrypted: true, searchText: null });

    await createNote('user-1', 'Test', '{"type":"doc"}', 'nb-1', false, true);

    expect(prismaMock.note.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ searchText: null, isEncrypted: true }),
    });
  });

  it('uses the provided id when given', async () => {
    prismaMock.notebook.findFirst.mockResolvedValueOnce({ id: 'nb-1', userId: 'user-1' });
    prismaMock.note.create.mockResolvedValue({ ...baseNote, id: 'custom-id' });

    await createNote('user-1', 'Test', '{}', 'nb-1', false, false, 'custom-id');

    expect(prismaMock.note.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: 'custom-id' }),
    });
  });

  it('handles P2002 duplicate id by returning existing note (idempotency)', async () => {
    const existing = { id: 'dup-id', title: 'Existing' };
    prismaMock.notebook.findFirst.mockResolvedValueOnce({ id: 'nb-1', userId: 'user-1' });
    const p2002Error = new Error('Unique constraint failed') as Error & { code: string };
    p2002Error.code = 'P2002';
    prismaMock.note.create.mockRejectedValue(p2002Error);
    prismaMock.note.findFirst.mockResolvedValue(existing);

    const result = await createNote('user-1', 'Test', '{}', 'nb-1', false, false, 'dup-id');
    expect(result).toEqual(existing);
    expect(prismaMock.note.findFirst).toHaveBeenCalledWith({ where: { id: 'dup-id', userId: 'user-1' } });
  });

  it('P2002 on an id owned by another user throws ConflictError and leaks nothing', async () => {
    prismaMock.notebook.findFirst.mockResolvedValueOnce({ id: 'nb-1', userId: 'user-1' });
    const p2002Error = new Error('Unique constraint failed') as Error & { code: string };
    p2002Error.code = 'P2002';
    prismaMock.note.create.mockRejectedValueOnce(p2002Error);
    // the other user's note is not visible when filtering by userId
    prismaMock.note.findFirst.mockResolvedValueOnce(null);

    const err = await createNote('user-1', 'Test', '{}', 'nb-1', false, false, 'foreign-id').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toBe('errors.notes.idConflict');
    // a findUnique-based lookup would leak the foreign note
    expect(prismaMock.note.findUnique).not.toHaveBeenCalled();
  });

  it('P2002 with no id throws ConflictError without any lookup (no fail-open)', async () => {
    prismaMock.notebook.findFirst.mockResolvedValueOnce({ id: 'nb-1', userId: 'user-1' });
    const p2002Error = new Error('Unique constraint failed') as Error & { code: string };
    p2002Error.code = 'P2002';
    prismaMock.note.create.mockRejectedValueOnce(p2002Error);
    prismaMock.note.findFirst.mockClear();

    await expect(createNote('user-1', 'Test', '{}', 'nb-1')).rejects.toBeInstanceOf(ConflictError);
    expect(prismaMock.note.findFirst).not.toHaveBeenCalled();
  });

  it('rethrows non-P2002 errors', async () => {
    prismaMock.notebook.findFirst.mockResolvedValueOnce({ id: 'nb-1', userId: 'user-1' });
    prismaMock.note.create.mockRejectedValue(new Error('DB connection lost'));

    await expect(createNote('user-1', 'Test', '{}', 'nb-1'))
      .rejects.toThrow('DB connection lost');
  });
});

// ---------------------------------------------------------------------------
// getNotes
// ---------------------------------------------------------------------------
describe('getNotes', () => {
  it('returns notes for the user with default pagination', async () => {
    const notes = [{ id: 'n1' }, { id: 'n2' }];
    prismaMock.note.findMany.mockResolvedValue(notes);

    const result = await getNotes('user-1');

    expect(prismaMock.note.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-1', isTrashed: false }),
        orderBy: { updatedAt: 'desc' },
        skip: 0,
        take: 50,
      })
    );
    expect(result).toEqual(notes);
  });

  it('filters by notebookId when provided', async () => {
    prismaMock.note.findMany.mockResolvedValue([]);

    await getNotes('user-1', 'nb-1');

    expect(prismaMock.note.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ notebookId: 'nb-1' }),
      })
    );
  });

  it('includes search OR clause for title and searchText', async () => {
    prismaMock.note.findMany.mockResolvedValue([]);

    await getNotes('user-1', undefined, 'hello');

    const call = prismaMock.note.findMany.mock.calls[0][0];
    expect(call.where.OR).toEqual([
      { title: { contains: 'hello', mode: 'insensitive' } },
      { searchText: { contains: 'hello', mode: 'insensitive' } },
    ]);
  });

  it('filters by tagId when provided', async () => {
    prismaMock.note.findMany.mockResolvedValue([]);

    await getNotes('user-1', undefined, undefined, 'tag-1');

    const call = prismaMock.note.findMany.mock.calls[0][0];
    expect(call.where.tags).toEqual({ some: { tagId: 'tag-1' } });
  });

  it('applies pending reminder filter', async () => {
    prismaMock.note.findMany.mockResolvedValue([]);

    await getNotes('user-1', undefined, undefined, undefined, 'pending');

    const call = prismaMock.note.findMany.mock.calls[0][0];
    expect(call.where.reminderDate).toEqual({ not: null });
    expect(call.where.isReminderDone).toBe(false);
  });

  it('applies done reminder filter', async () => {
    prismaMock.note.findMany.mockResolvedValue([]);

    await getNotes('user-1', undefined, undefined, undefined, 'done');

    const call = prismaMock.note.findMany.mock.calls[0][0];
    expect(call.where.reminderDate).toEqual({ not: null });
    expect(call.where.isReminderDone).toBe(true);
  });

  it('applies "all" reminder filter (reminderDate not null, no isReminderDone constraint)', async () => {
    prismaMock.note.findMany.mockResolvedValue([]);

    await getNotes('user-1', undefined, undefined, undefined, 'all');

    const call = prismaMock.note.findMany.mock.calls[0][0];
    expect(call.where.reminderDate).toEqual({ not: null });
    expect(call.where.isReminderDone).toBeUndefined();
  });

  it('includes trashed notes when includeTrashed is true', async () => {
    prismaMock.note.findMany.mockResolvedValue([]);

    await getNotes('user-1', undefined, undefined, undefined, undefined, true);

    const call = prismaMock.note.findMany.mock.calls[0][0];
    expect(call.where.isTrashed).toBeUndefined();
  });

  it('respects page and limit for pagination', async () => {
    prismaMock.note.findMany.mockResolvedValue([]);

    await getNotes('user-1', undefined, undefined, undefined, undefined, false, 3, 10);

    expect(prismaMock.note.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 })
    );
  });
});

// ---------------------------------------------------------------------------
// getNote
// ---------------------------------------------------------------------------
describe('getNote', () => {
  it('returns the note when user is owner', async () => {
    const note = { id: 'n1', userId: 'user-1', title: 'My Note' };
    prismaMock.note.findFirst.mockResolvedValue(note);

    const result = await getNote('user-1', 'n1');

    expect(result).toEqual(note);
    expect(prismaMock.note.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'n1',
        OR: [
          { userId: 'user-1' },
          { isVault: false, sharedWith: { some: { userId: 'user-1', status: 'ACCEPTED' } } },
        ],
      },
      // 1.13.3: ydocState (binary Yjs state, can be large) is never sent to the client
      omit: { ydocState: true },
      include: expect.objectContaining({
        tags: { where: { userId: 'user-1' }, include: { tag: true } },
        attachments: { where: { isLatest: true } },
      }),
    });
  });

  it('returns the note when user has shared access', async () => {
    const note = { id: 'n1', userId: 'owner-1', title: 'Shared Note' };
    prismaMock.note.findFirst.mockResolvedValue(note);

    const result = await getNote('user-2', 'n1');
    expect(result).toEqual(note);
  });

  // N1. The share branch had no status filter, so a PENDING or DECLINED recipient
  // received the note whole — title, content and searchText. Reproduced over HTTP:
  // the same user, in the same moment, was told card.note = null by the board
  // endpoint and handed the note's body by this one. checkNoteAccess (:13),
  // getBoard and onAuthenticate all require ACCEPTED; this did not.
  it('only counts an ACCEPTED share as access', async () => {
    prismaMock.note.findFirst.mockResolvedValue(null);

    await getNote('user-2', 'n1');

    const where = prismaMock.note.findFirst.mock.calls[0][0].where;
    expect(where.OR).toContainEqual({
      isVault: false,
      sharedWith: { some: { userId: 'user-2', status: 'ACCEPTED' } },
    });
  });

  it('does not widen access for the note owner', async () => {
    // The status filter must sit on the share branch only: an owner has no
    // SharedNote row at all and must still get their own note.
    prismaMock.note.findFirst.mockResolvedValue({ id: 'n1', userId: 'user-1' });

    await getNote('user-1', 'n1');

    const where = prismaMock.note.findFirst.mock.calls[0][0].where;
    expect(where.OR).toContainEqual({ userId: 'user-1' });
  });

  it('returns null when note does not exist or user has no access', async () => {
    prismaMock.note.findFirst.mockResolvedValue(null);

    const result = await getNote('stranger', 'n1');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateNote
// ---------------------------------------------------------------------------
describe('updateNote', () => {
  const existingNote = {
    id: 'n1',
    userId: 'user-1',
    title: 'Existing',
    content: '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"' + 'A'.repeat(200) + '"}]}]}',
    isEncrypted: false,
  };

  beforeEach(() => { __resetSnapshotStateForTests(); }); // the snapshot throttle is module-level in-memory state

  it('updates note fields and recalculates searchText', async () => {
    prismaMock.note.findFirst.mockResolvedValue(existingNote);
    prismaMock.noteVersion.findFirst.mockResolvedValue(null);
    prismaMock.noteVersion.findMany.mockResolvedValue([]);
    const updatedNote = { ...existingNote, title: 'Updated' };
    prismaMock.note.update.mockResolvedValue(updatedNote);

    const newContent = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"New long content that is definitely more than 150 characters to pass the empty guard check. We need this to be substantial enough."}]}]}';
    const result = await updateNote('user-1', 'n1', { title: 'Updated', content: newContent });

    expect(result).toEqual(updatedNote);
    expect(prismaMock.note.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: expect.objectContaining({
        title: 'Updated',
        content: newContent,
        searchText: `extracted:${newContent}`,
        updatedAt: expect.any(Date),
      }),
    });
  });

  it('1.13.3: snapshots the old content with the REST writer id (rest:<userId>)', async () => {
    prismaMock.note.findFirst.mockResolvedValue(existingNote);
    prismaMock.noteVersion.findFirst.mockResolvedValue(null);
    prismaMock.noteVersion.findMany.mockResolvedValue([]);
    prismaMock.note.update.mockResolvedValue(existingNote);
    const newContent = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"New long content that is definitely more than 150 characters to pass the empty guard check. We need this to be substantial enough."}]}]}';
    await updateNote('user-1', 'n1', { content: newContent });
    expect(snapshotPreviousVersion).toHaveBeenCalledWith(
      expect.anything(), 'n1', existingNote.content, 'Existing', { writer: 'rest:user-1' },
    );
  });

  describe('1.13.3 stale ydocState / live collab doc', () => {
    const body = (c: string) => '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"' + c.repeat(200) + '"}]}]}';
    const newContent = body('B');
    const docs = (hocuspocus as any).hocuspocus.documents as Map<string, unknown>;
    const loading = (hocuspocus as any).hocuspocus.loadingDocuments as Map<string, unknown>;
    // a live doc is the default so the negative cases below are meaningful
    beforeEach(() => {
      docs.clear(); loading.clear(); docs.set('n1', {});
      (archiveRestWriteWhileLive as any).mockReset();
      (archiveRestWriteWhileLive as any).mockResolvedValue('archived');
      prismaMock.noteVersion.findFirst.mockResolvedValue(null);
      prismaMock.noteVersion.findMany.mockResolvedValue([]);
    });
    afterEach(() => { docs.clear(); loading.clear(); });
    const archived = () => (archiveRestWriteWhileLive as any).mock.calls;

    it('live doc + changed content -> no content/ydocState/searchText written, metadata applied, archived once', async () => {
      prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
      prismaMock.note.update.mockResolvedValue({ ...existingNote, title: 'T', noteType: 'NOTE' });
      await updateNote('user-1', 'n1', { title: 'T', isPinned: true, content: newContent });
      const data = prismaMock.note.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('content');
      expect(data).not.toHaveProperty('ydocState');
      expect(data).not.toHaveProperty('searchText');
      expect(data).toMatchObject({ title: 'T', isPinned: true });
      expect(prismaMock.noteVersion.create).not.toHaveBeenCalled(); // no in-tx snapshot of old content either
      expect(archived()).toEqual([['n1', newContent, 'T', 'user-1', undefined]]);
    });

    it('G3: the sessionKey is forwarded to the archive', async () => {
      prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
      prismaMock.note.update.mockResolvedValue({ ...existingNote, title: 'T', noteType: 'NOTE' });
      await updateNote('user-1', 'n1', { content: newContent }, 'iat-42');
      expect(archived()).toEqual([['n1', newContent, 'T', 'user-1', 'iat-42']]);
    });

    it('loading doc -> same live path', async () => {
      docs.clear();
      loading.set('n1', Promise.resolve());
      prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
      prismaMock.note.update.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
      await updateNote('user-1', 'n1', { content: newContent });
      const data = prismaMock.note.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('content');
      expect(data).not.toHaveProperty('ydocState');
      expect(archived()).toHaveLength(1);
    });

    it('no live doc -> content written, ydocState null, not archived', async () => {
      docs.clear();
      prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
      prismaMock.note.update.mockResolvedValue({ ...existingNote, content: newContent, noteType: 'NOTE' });
      await updateNote('user-1', 'n1', { content: newContent });
      const data = prismaMock.note.update.mock.calls[0][0].data;
      expect(data.content).toBe(newContent);
      expect(data.ydocState).toBeNull();
      expect(archived()).toHaveLength(0);
    });

    it('metadata-only write -> no ydocState key, not archived', async () => {
      prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
      prismaMock.note.update.mockResolvedValue({ ...existingNote, title: 'T', noteType: 'NOTE' });
      await updateNote('user-1', 'n1', { title: 'T', isPinned: true });
      expect(prismaMock.note.update.mock.calls[0][0].data).not.toHaveProperty('ydocState');
      expect(archived()).toHaveLength(0);
    });

    it('content equal to stored -> no ydocState key, not archived', async () => {
      prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
      prismaMock.note.update.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
      await updateNote('user-1', 'n1', { content: existingNote.content });
      expect(prismaMock.note.update.mock.calls[0][0].data).not.toHaveProperty('ydocState');
      expect(archived()).toHaveLength(0);
    });

    it('not archived when moving to the vault (connections are closed instead)', async () => {
      prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, isVault: false, noteType: 'NOTE' });
      prismaMock.note.update.mockResolvedValue({ ...existingNote, content: newContent, isVault: true, noteType: 'NOTE' });
      await updateNote('user-1', 'n1', { isVault: true, content: newContent });
      expect(archived()).toHaveLength(0);
      expect(hocuspocus.hocuspocus.closeConnections).toHaveBeenCalledWith('n1');
    });

    it('not archived when moving out of the vault', async () => {
      prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, isVault: true, noteType: 'NOTE' });
      prismaMock.note.update.mockResolvedValue({ ...existingNote, content: newContent, isVault: false, noteType: 'NOTE' });
      await updateNote('user-1', 'n1', { isVault: false, content: newContent });
      expect(archived()).toHaveLength(0);
    });

    it('not archived for an already-vault note', async () => {
      prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, isVault: true, noteType: 'NOTE' });
      prismaMock.note.update.mockResolvedValue({ ...existingNote, content: newContent, isVault: true, noteType: 'NOTE' });
      await updateNote('user-1', 'n1', { content: newContent });
      expect(archived()).toHaveLength(0);
    });

    it('not archived for an encrypted note', async () => {
      prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, isEncrypted: true, noteType: 'NOTE' });
      prismaMock.note.update.mockResolvedValue({ ...existingNote, content: newContent, isEncrypted: true, noteType: 'NOTE' });
      await updateNote('user-1', 'n1', { content: newContent });
      expect(archived()).toHaveLength(0);
    });

    it('not archived for a CREDENTIAL note', async () => {
      prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'CREDENTIAL' });
      prismaMock.note.update.mockResolvedValue({ ...existingNote, content: newContent, noteType: 'CREDENTIAL' });
      await updateNote('user-1', 'n1', { content: newContent });
      expect(archived()).toHaveLength(0);
    });

    it('archive throwing rejects (route answers 5xx, item stays queued) and is logged', async () => {
      prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
      const saved = { ...existingNote, noteType: 'NOTE' };
      prismaMock.note.update.mockResolvedValue(saved);
      (archiveRestWriteWhileLive as any).mockRejectedValueOnce(new Error('boom'));
      await expect(updateNote('user-1', 'n1', { content: newContent })).rejects.toThrow('boom');
      expect((logger as any).error).toHaveBeenCalledWith(expect.objectContaining({ noteId: 'n1' }), expect.stringContaining('REST content not archived'));
    });

    it('empty-overwrite guard dropping the content -> no ydocState key, not archived', async () => {
      prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
      prismaMock.note.update.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
      await updateNote('user-1', 'n1', { content: '{"type":"doc","content":[]}' });
      const data = prismaMock.note.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('content');
      expect(data).not.toHaveProperty('ydocState');
      expect(archived()).toHaveLength(0);
    });

    describe('contentDeferred flag (live doc)', () => {
      it('live doc + archived -> result carries contentDeferred: true', async () => {
        prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
        prismaMock.note.update.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
        const res = await updateNote('user-1', 'n1', { content: newContent });
        expect(res).toMatchObject({ contentDeferred: true });
      });

      it('H4: archive identical -> flag true; skipped -> flag true too (server did not apply the content; FE realigns only if its local text is the pushed one)', async () => {
        prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
        prismaMock.note.update.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
        (archiveRestWriteWhileLive as any).mockResolvedValueOnce('identical');
        expect(await updateNote('user-1', 'n1', { content: newContent })).toMatchObject({ contentDeferred: true });
        (archiveRestWriteWhileLive as any).mockResolvedValueOnce('skipped');
        expect(await updateNote('user-1', 'n1', { content: newContent })).toMatchObject({ contentDeferred: true });
      });

      it('live doc + archive throws -> rejects (the device keeps its text and retries)', async () => {
        prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
        prismaMock.note.update.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
        (archiveRestWriteWhileLive as any).mockRejectedValueOnce(new Error('boom'));
        await expect(updateNote('user-1', 'n1', { content: newContent })).rejects.toThrow('boom');
      });

      it('no live doc -> no flag', async () => {
        docs.clear();
        prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
        prismaMock.note.update.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
        const res = await updateNote('user-1', 'n1', { content: newContent });
        expect(res).not.toHaveProperty('contentDeferred');
      });
    });

    describe('rebaseYdocState on the non-live path', () => {
      const rebase = rebaseYdocState as unknown as ReturnType<typeof vi.fn>;
      beforeEach(() => {
        docs.clear();
        rebase.mockReset();
        rebase.mockReturnValue(null);
      });

      it('plain note, new content -> rebases the RE-READ state and stores the result', async () => {
        const fresh = Buffer.from([9, 9]);
        const rebased = Buffer.from([7, 7, 7]);
        prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
        prismaMock.note.findUnique.mockResolvedValue({ ydocState: fresh });
        prismaMock.note.update.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
        rebase.mockReturnValue(rebased);

        await updateNote('user-1', 'n1', { content: newContent });

        expect(prismaMock.note.findUnique).toHaveBeenCalledWith({ where: { id: 'n1' }, select: { ydocState: true } });
        expect(rebase).toHaveBeenCalledWith(fresh, newContent);
        expect(prismaMock.note.update.mock.calls[0][0].data.ydocState).toBe(rebased);
      });

      it('rebase returning null -> ydocState null', async () => {
        prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
        prismaMock.note.findUnique.mockResolvedValue({ ydocState: Buffer.from([1]) });
        prismaMock.note.update.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
        await updateNote('user-1', 'n1', { content: newContent });
        expect(prismaMock.note.update.mock.calls[0][0].data.ydocState).toBeNull();
      });

      it('the selects on the note never load ydocState (omit)', async () => {
        prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
        prismaMock.note.update.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
        await updateNote('user-1', 'n1', { content: newContent });
        expect(prismaMock.note.findFirst).toHaveBeenCalledWith({ where: { id: 'n1', userId: 'user-1' }, omit: { ydocState: true } });
      });

      const notCalled = (name: string, note: Record<string, unknown>, data: Record<string, unknown>) =>
        it(`NOT called: ${name}`, async () => {
          prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'NOTE', ...note });
          prismaMock.note.update.mockResolvedValue({ ...existingNote, noteType: 'NOTE', ...note });
          await updateNote('user-1', 'n1', { content: newContent, ...data });
          expect(rebase).not.toHaveBeenCalled();
          expect(prismaMock.note.update.mock.calls[0][0].data.ydocState ?? null).toBeNull();
        });
      notCalled('vault note', { isVault: true }, {});
      notCalled('encrypted note', { isEncrypted: true }, {});
      notCalled('moving to the vault', {}, { isVault: true });
      notCalled('moving out of the vault', { isVault: true }, { isVault: false });
      notCalled('CREDENTIAL note', { noteType: 'CREDENTIAL' }, {});

      it('NOT called: content unchanged', async () => {
        prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
        prismaMock.note.update.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
        await updateNote('user-1', 'n1', { content: existingNote.content });
        expect(rebase).not.toHaveBeenCalled();
      });

      it('NOT called: live doc (the live doc wins)', async () => {
        docs.set('n1', {});
        prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
        prismaMock.note.update.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
        await updateNote('user-1', 'n1', { content: newContent });
        expect(rebase).not.toHaveBeenCalled();
      });

      it('m3: doc becomes live INSIDE the transaction -> content was written, so it is archived (no flag)', async () => {
        prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
        prismaMock.note.update.mockResolvedValue({ ...existingNote, title: 'T', noteType: 'NOTE' });
        const original = prismaMock.$transaction.getMockImplementation();
        prismaMock.$transaction.mockImplementationOnce((fn: any) => { docs.set('n1', {}); return fn(prismaMock); });

        const res = await updateNote('user-1', 'n1', { content: newContent });

        expect(prismaMock.note.update.mock.calls[0][0].data.content).toBe(newContent);
        expect(archived()).toEqual([['n1', newContent, 'T', 'user-1', undefined]]);
        expect(res).not.toHaveProperty('contentDeferred');
        if (original) prismaMock.$transaction.mockImplementation(original);
      });

      it('m3: archive throwing does NOT reject (content already written, a retry would be a no-op): warn, no flag', async () => {
        prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, noteType: 'NOTE' });
        prismaMock.note.update.mockResolvedValue({ ...existingNote, title: 'T', noteType: 'NOTE' });
        const original = prismaMock.$transaction.getMockImplementation();
        prismaMock.$transaction.mockImplementationOnce((fn: any) => { docs.set('n1', {}); return fn(prismaMock); });
        (archiveRestWriteWhileLive as any).mockRejectedValueOnce(new Error('boom'));

        const res = await updateNote('user-1', 'n1', { content: newContent });
        expect(res).not.toHaveProperty('contentDeferred');
        expect((logger as any).warn).toHaveBeenCalledWith(expect.objectContaining({ noteId: 'n1' }), expect.stringContaining('REST content not archived'));
        if (original) prismaMock.$transaction.mockImplementation(original);
      });
    });
  });

  it('a plain REST content change on a normal note nulls ydocState (1.13.3, was: untouched)', async () => {
    prismaMock.note.findFirst.mockResolvedValue(existingNote);
    prismaMock.note.update.mockResolvedValue(existingNote);
    const newContent = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"' + 'B'.repeat(200) + '"}]}]}';

    await updateNote('user-1', 'n1', { content: newContent });

    expect(prismaMock.note.update.mock.calls[0][0].data.ydocState).toBeNull();
  });

  it('leaves ydocState alone when the content is unchanged', async () => {
    prismaMock.note.findFirst.mockResolvedValue(existingNote);
    prismaMock.note.update.mockResolvedValue(existingNote);

    await updateNote('user-1', 'n1', { title: 'Only a title', content: existingNote.content });

    expect(prismaMock.note.update.mock.calls[0][0].data).not.toHaveProperty('ydocState');
  });

  it('throws when note does not exist or user is not owner', async () => {
    prismaMock.note.findFirst.mockResolvedValue(null);

    await expect(updateNote('stranger', 'n1', { title: 'Hack' }))
      .rejects.toThrow('errors.notes.notFound');
  });

  it('replaces tags within the transaction', async () => {
    prismaMock.note.findFirst.mockResolvedValue(existingNote);
    prismaMock.tag.findMany.mockResolvedValue([{ id: 'tag-a' }, { id: 'tag-b' }]);
    prismaMock.tagsOnNotes.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.tagsOnNotes.createMany.mockResolvedValue({ count: 2 });
    prismaMock.note.update.mockResolvedValue(existingNote);

    await updateNote('user-1', 'n1', {
      tags: [{ tag: { id: 'tag-a' } }, { tag: { id: 'tag-b' } }],
    });

    expect(prismaMock.tagsOnNotes.deleteMany).toHaveBeenCalledWith({ where: { noteId: 'n1', userId: 'user-1' } });
    expect(prismaMock.tagsOnNotes.createMany).toHaveBeenCalledWith({
      data: [
        { noteId: 'n1', tagId: 'tag-a', userId: 'user-1' },
        { noteId: 'n1', tagId: 'tag-b', userId: 'user-1' },
      ],
    });
  });

  it('handles empty tags array (clears all tags)', async () => {
    prismaMock.note.findFirst.mockResolvedValue(existingNote);
    prismaMock.tagsOnNotes.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.note.update.mockResolvedValue(existingNote);

    await updateNote('user-1', 'n1', { tags: [] });

    expect(prismaMock.tagsOnNotes.deleteMany).toHaveBeenCalledWith({ where: { noteId: 'n1', userId: 'user-1' } });
    expect(prismaMock.tagsOnNotes.createMany).not.toHaveBeenCalled();
  });

  describe('move to vault revokes sharing', () => {
    it('deletes shares, clears the public link and kicks live sessions when isVault goes false -> true', async () => {
      prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, isVault: false, isPublic: true, shareId: 'sid' });
      prismaMock.sharedNote.findMany.mockResolvedValue([{ userId: 'u2' }, { userId: 'u3' }]);
      prismaMock.sharedNote.deleteMany.mockResolvedValue({ count: 2 });
      prismaMock.note.update.mockResolvedValue(existingNote);

      await updateNote('user-1', 'n1', { isVault: true });

      expect(prismaMock.sharedNote.deleteMany).toHaveBeenCalledWith({ where: { noteId: 'n1' } });
      expect(prismaMock.note.update).toHaveBeenCalledWith({
        where: { id: 'n1' },
        data: expect.objectContaining({
          isVault: true,
          isPublic: false,
          shareId: null,
          ydocState: null,
          searchText: null,
        }),
      });
      // EVERY live connection of the document goes, the owner's other devices included.
      expect(hocuspocus.hocuspocus.closeConnections).toHaveBeenCalledTimes(1);
      expect(hocuspocus.hocuspocus.closeConnections).toHaveBeenCalledWith('n1');
    });

    it('nulls searchText even when the same save carries plain content', async () => {
      prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, isVault: false });
      prismaMock.note.update.mockResolvedValue(existingNote);

      await updateNote('user-1', 'n1', { isVault: true, content: '{"type":"doc","content":[]}'.padEnd(300, ' ') });

      const data = prismaMock.note.update.mock.calls[0][0].data;
      expect(data.searchText).toBeNull();
      expect(data.ydocState).toBeNull();
    });

    it('does not touch shares when isVault stays false', async () => {
      prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, isVault: false });
      prismaMock.note.update.mockResolvedValue(existingNote);

      await updateNote('user-1', 'n1', { isVault: false, title: 'x' });

      expect(prismaMock.sharedNote.deleteMany).not.toHaveBeenCalled();
      expect(hocuspocus.hocuspocus.closeConnections).not.toHaveBeenCalled();
      const data = prismaMock.note.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('isPublic');
      expect(data).not.toHaveProperty('shareId');
    });

    it('does not touch shares when the note was already a vault note', async () => {
      prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, isVault: true });
      prismaMock.note.update.mockResolvedValue(existingNote);

      await updateNote('user-1', 'n1', { isVault: true });

      expect(prismaMock.sharedNote.deleteMany).not.toHaveBeenCalled();
      expect(hocuspocus.hocuspocus.closeConnections).not.toHaveBeenCalled();
    });

    describe('searchText around the vault boundary', () => {
      const plain = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hello"}]}]}';

      it('moving OUT of the vault recomputes searchText from the stored content when none is sent', async () => {
        prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, isVault: true, content: plain });
        prismaMock.note.update.mockResolvedValue(existingNote);

        await updateNote('user-1', 'n1', { isVault: false });

        expect(prismaMock.note.update.mock.calls[0][0].data.searchText).toBe(`extracted:${plain}`);
      });

      it('moving OUT with content in the same save uses that content', async () => {
        prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, isVault: true, content: 'old' });
        prismaMock.note.update.mockResolvedValue(existingNote);

        await updateNote('user-1', 'n1', { isVault: false, content: plain });

        expect(prismaMock.note.update.mock.calls[0][0].data.searchText).toBe(`extracted:${plain}`);
      });

      it('moving OUT of an encrypted note does not derive searchText', async () => {
        prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, isVault: true, isEncrypted: true, content: plain });
        prismaMock.note.update.mockResolvedValue(existingNote);

        await updateNote('user-1', 'n1', { isVault: false });

        expect(prismaMock.note.update.mock.calls[0][0].data.searchText).toBeUndefined();
      });

      it('owner saves while the note is in the vault never write searchText (isVault sent or omitted)', async () => {
        prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, isVault: true, content: 'old' });
        prismaMock.note.update.mockResolvedValue(existingNote);

        await updateNote('user-1', 'n1', { content: plain });
        await updateNote('user-1', 'n1', { isVault: true, content: plain });

        for (const call of prismaMock.note.update.mock.calls) {
          expect(call[0].data).not.toHaveProperty('searchText');
        }
      });
    });

    it('a failing session kick never fails the update', async () => {
      prismaMock.note.findFirst.mockResolvedValue({ ...existingNote, isVault: false });
      prismaMock.sharedNote.findMany.mockResolvedValue([{ userId: 'u2' }]);
      prismaMock.note.update.mockResolvedValue(existingNote);
      (hocuspocus.hocuspocus.closeConnections as any).mockImplementationOnce(() => { throw new Error('boom'); });

      await expect(updateNote('user-1', 'n1', { isVault: true })).resolves.toBeDefined();
    });
  });

  describe('notebook and tag ownership (P3, P4)', () => {
    it('rejects a notebookId the user does not own, before any write', async () => {
      prismaMock.note.findFirst.mockResolvedValue(existingNote);
      prismaMock.notebook.findFirst.mockResolvedValue(null);

      // Without the check the note lands in the victim's notebook (Cascade on delete)
      // and inflates the victim's note count.
      const call = updateNote('user-1', 'n1', { notebookId: 'victim-nb' });
      await expect(call).rejects.toBeInstanceOf(NotFoundError);
      await expect(call).rejects.toThrow('errors.notebooks.notFound');
      expect(prismaMock.notebook.findFirst).toHaveBeenCalledWith({
        where: { id: 'victim-nb', userId: 'user-1' },
        select: { id: true },
      });
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      expect(prismaMock.note.update).not.toHaveBeenCalled();
    });

    it('never writes a tag the user does not own, and keeps the owned ones', async () => {
      prismaMock.note.findFirst.mockResolvedValue(existingNote);
      prismaMock.tag.findMany.mockResolvedValue([{ id: 'tag-mine' }]);
      prismaMock.note.update.mockResolvedValue(existingNote);

      // P4: without the check getNote would hand the attacker the victim's whole Tag row.
      // A foreign (or since-deleted) id is dropped rather than failing the whole update:
      // rejecting the list made an offline sync push lose the tag just added along with it.
      await updateNote('user-1', 'n1', {
        tags: [{ tag: { id: 'tag-mine' } }, { tag: { id: 'tag-victim' } }],
      });

      expect(prismaMock.tag.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['tag-mine', 'tag-victim'] }, userId: 'user-1' },
        select: { id: true },
      });
      expect(prismaMock.tagsOnNotes.deleteMany).toHaveBeenCalledWith({ where: { noteId: 'n1', userId: 'user-1' } });
      expect(prismaMock.tagsOnNotes.createMany).toHaveBeenCalledWith({
        data: [{ noteId: 'n1', tagId: 'tag-mine', userId: 'user-1' }],
      });
    });

    it('clears the tags when none of them is owned, writing no foreign row', async () => {
      prismaMock.note.findFirst.mockResolvedValue(existingNote);
      prismaMock.tag.findMany.mockResolvedValue([]);
      prismaMock.note.update.mockResolvedValue(existingNote);

      await updateNote('user-1', 'n1', { tags: [{ tag: { id: 'tag-victim' } }] });

      expect(prismaMock.tagsOnNotes.createMany).not.toHaveBeenCalled();
    });

    it('writes duplicate ids of an owned tag once', async () => {
      prismaMock.note.findFirst.mockResolvedValue(existingNote);
      prismaMock.tag.findMany.mockResolvedValue([{ id: 'tag-mine' }]);
      prismaMock.note.update.mockResolvedValue(existingNote);

      await expect(updateNote('user-1', 'n1', {
        tags: [{ tag: { id: 'tag-mine' } }, { tag: { id: 'tag-mine' } }],
      })).resolves.toEqual(existingNote);
      expect(prismaMock.tagsOnNotes.createMany).toHaveBeenCalledWith({
        data: [{ noteId: 'n1', tagId: 'tag-mine', userId: 'user-1' }],
      });
    });

    it('updates when notebook and tags are the user\'s own', async () => {
      prismaMock.note.findFirst.mockResolvedValue(existingNote);
      prismaMock.notebook.findFirst.mockResolvedValue({ id: 'nb-mine' });
      prismaMock.tag.findMany.mockResolvedValue([{ id: 'tag-mine' }]);
      prismaMock.note.update.mockResolvedValue(existingNote);

      await updateNote('user-1', 'n1', { notebookId: 'nb-mine', tags: [{ tag: { id: 'tag-mine' } }] });

      expect(prismaMock.tagsOnNotes.createMany).toHaveBeenCalledWith({
        data: [{ noteId: 'n1', tagId: 'tag-mine', userId: 'user-1' }],
      });
      expect(prismaMock.note.update).toHaveBeenCalledWith({
        where: { id: 'n1' },
        data: expect.objectContaining({ notebookId: 'nb-mine' }),
      });
    });

    it('adds no query when notebookId and tags are absent (autosave hot path)', async () => {
      prismaMock.note.findFirst.mockResolvedValue(existingNote);
      prismaMock.note.update.mockResolvedValue(existingNote);

      await updateNote('user-1', 'n1', { title: 'Autosave' });

      expect(prismaMock.notebook.findFirst).not.toHaveBeenCalled();
      expect(prismaMock.tag.findMany).not.toHaveBeenCalled();
    });

    it('adds no tag query when tags is empty', async () => {
      prismaMock.note.findFirst.mockResolvedValue(existingNote);
      prismaMock.note.update.mockResolvedValue(existingNote);

      await updateNote('user-1', 'n1', { tags: [] });

      expect(prismaMock.tag.findMany).not.toHaveBeenCalled();
    });
  });

  describe('empty content overwrite guard', () => {
    it('blocks overwriting substantial content (>150 chars) with empty content (<150 chars)', async () => {
      const substantialNote = {
        ...existingNote,
        content: 'X'.repeat(200), // >150 chars
      };
      prismaMock.note.findFirst.mockResolvedValue(substantialNote);
      prismaMock.note.update.mockResolvedValue(substantialNote);

      const emptyContent = '{"type":"doc","content":[]}'; // <150 chars

      await updateNote('user-1', 'n1', { content: emptyContent });

      // The content field should have been stripped from the update
      const updateCall = prismaMock.note.update.mock.calls[0][0];
      expect(updateCall.data.content).toBeUndefined();
    });

    it('allows overwriting substantial content with new substantial content', async () => {
      const substantialNote = {
        ...existingNote,
        content: 'X'.repeat(200),
      };
      prismaMock.note.findFirst.mockResolvedValue(substantialNote);
      prismaMock.noteVersion.findFirst.mockResolvedValue(null);
      prismaMock.noteVersion.findMany.mockResolvedValue([]);
      prismaMock.note.update.mockResolvedValue(substantialNote);

      const newSubstantialContent = 'Y'.repeat(200);

      await updateNote('user-1', 'n1', { content: newSubstantialContent });

      const updateCall = prismaMock.note.update.mock.calls[0][0];
      expect(updateCall.data.content).toBe(newSubstantialContent);
    });

    it('allows overwriting short content with empty content (no guard needed)', async () => {
      const shortNote = {
        ...existingNote,
        content: 'short', // <150 chars
      };
      prismaMock.note.findFirst.mockResolvedValue(shortNote);
      prismaMock.note.update.mockResolvedValue(shortNote);

      const emptyContent = '{"type":"doc"}';

      await updateNote('user-1', 'n1', { content: emptyContent });

      const updateCall = prismaMock.note.update.mock.calls[0][0];
      expect(updateCall.data.content).toBe(emptyContent);
    });

    it('allows overwriting when existing content is null', async () => {
      const nullContentNote = {
        ...existingNote,
        content: null,
      };
      prismaMock.note.findFirst.mockResolvedValue(nullContentNote);
      prismaMock.note.update.mockResolvedValue(nullContentNote);

      const emptyContent = '{"type":"doc"}';

      await updateNote('user-1', 'n1', { content: emptyContent });

      const updateCall = prismaMock.note.update.mock.calls[0][0];
      expect(updateCall.data.content).toBe(emptyContent);
    });
  });

  it('does not recalculate searchText when note is encrypted', async () => {
    const encryptedNote = { ...existingNote, isEncrypted: true };
    prismaMock.note.findFirst.mockResolvedValue(encryptedNote);
    prismaMock.noteVersion.findFirst.mockResolvedValue(null);
    prismaMock.noteVersion.findMany.mockResolvedValue([]);
    prismaMock.note.update.mockResolvedValue(encryptedNote);

    const newContent = 'Y'.repeat(200);
    await updateNote('user-1', 'n1', { content: newContent });

    const updateCall = prismaMock.note.update.mock.calls[0][0];
    expect(updateCall.data.searchText).toBeUndefined();
  });

  it('does not recalculate searchText when content is not provided', async () => {
    prismaMock.note.findFirst.mockResolvedValue(existingNote);
    prismaMock.note.update.mockResolvedValue(existingNote);

    await updateNote('user-1', 'n1', { title: 'New Title' });

    const updateCall = prismaMock.note.update.mock.calls[0][0];
    expect(updateCall.data.searchText).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deleteNote
// ---------------------------------------------------------------------------
describe('deleteNote', () => {
  it('deletes all related records and the note within a transaction', async () => {
    prismaMock.note.findFirst.mockResolvedValue({ id: 'n1', userId: 'user-1' });
    prismaMock.tagsOnNotes.deleteMany.mockResolvedValue({ count: 2 });
    prismaMock.attachment.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.sharedNote.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.chatMessage.deleteMany.mockResolvedValue({ count: 3 });
    prismaMock.note.delete.mockResolvedValue({ id: 'n1' });

    const result = await deleteNote('user-1', 'n1');

    expect(prismaMock.note.findFirst).toHaveBeenCalledWith({ where: { id: 'n1', userId: 'user-1' } });
    expect(prismaMock.tagsOnNotes.deleteMany).toHaveBeenCalledWith({ where: { noteId: 'n1' } });
    expect(prismaMock.attachment.deleteMany).toHaveBeenCalledWith({ where: { noteId: 'n1' } });
    expect(prismaMock.sharedNote.deleteMany).toHaveBeenCalledWith({ where: { noteId: 'n1' } });
    expect(prismaMock.chatMessage.deleteMany).toHaveBeenCalledWith({ where: { noteId: 'n1' } });
    expect(prismaMock.note.delete).toHaveBeenCalledWith({ where: { id: 'n1' } });
    expect(result).toEqual({ id: 'n1' });
  });

  // A3, third door: Hocuspocus resolves note access once, at connect. Without this the
  // collaborators keep an editing session open on a note row that no longer exists.
  it('closes the collaboration sessions left open on the deleted note', async () => {
    prismaMock.note.findFirst.mockResolvedValue({ id: 'n1', userId: 'user-1' });
    prismaMock.note.delete.mockResolvedValue({ id: 'n1' });

    await deleteNote('user-1', 'n1');

    expect(hocuspocus.hocuspocus.closeConnections).toHaveBeenCalledWith('n1');
  });

  it('does not close any session when the ownership guard rejects', async () => {
    prismaMock.note.findFirst.mockResolvedValue(null);

    await expect(deleteNote('stranger', 'n1')).rejects.toThrow('errors.notes.notFound');

    expect(hocuspocus.hocuspocus.closeConnections).not.toHaveBeenCalled();
  });

  it('throws when note does not exist or user is not owner', async () => {
    prismaMock.note.findFirst.mockResolvedValue(null);

    await expect(deleteNote('stranger', 'n1')).rejects.toThrow('errors.notes.notFound');

    // Ensure no deletions occurred
    expect(prismaMock.tagsOnNotes.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.attachment.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.sharedNote.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.chatMessage.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.note.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// toggleShare
// ---------------------------------------------------------------------------
describe('toggleShare', () => {
  it('enables public sharing and generates a shareId', async () => {
    prismaMock.note.findFirst.mockResolvedValue({
      id: 'n1',
      userId: 'user-1',
      isPublic: false,
      isVault: false,
    });
    prismaMock.note.update.mockResolvedValue({
      id: 'n1',
      isPublic: true,
      shareId: 'mock-uuid-v4',
    });

    const result = await toggleShare('user-1', 'n1');

    expect(prismaMock.note.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { isPublic: true, shareId: 'mock-uuid-v4', updatedAt: expect.any(Date) },
    });
    expect(result.isPublic).toBe(true);
    expect(result.shareId).toBe('mock-uuid-v4');
  });

  it('disables public sharing and clears shareId', async () => {
    prismaMock.note.findFirst.mockResolvedValue({
      id: 'n1',
      userId: 'user-1',
      isPublic: true,
      isVault: false,
    });
    prismaMock.note.update.mockResolvedValue({
      id: 'n1',
      isPublic: false,
      shareId: null,
    });

    const result = await toggleShare('user-1', 'n1');

    expect(prismaMock.note.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { isPublic: false, shareId: null, updatedAt: expect.any(Date) },
    });
    expect(result.isPublic).toBe(false);
    expect(result.shareId).toBeNull();
  });

  it('throws when note does not exist or user is not owner', async () => {
    prismaMock.note.findFirst.mockResolvedValue(null);

    await expect(toggleShare('stranger', 'n1')).rejects.toThrow('errors.notes.notFound');
  });

  it('throws when trying to share a vault note', async () => {
    prismaMock.note.findFirst.mockResolvedValue({
      id: 'n1',
      userId: 'user-1',
      isPublic: false,
      isVault: true,
    });

    await expect(toggleShare('user-1', 'n1')).rejects.toThrow('errors.sharing.vaultNotShareable');
  });
});

// ---------------------------------------------------------------------------
// getPublicNote
// ---------------------------------------------------------------------------
describe('getPublicNote', () => {
  it('returns the note with tags and attachments when shareId exists', async () => {
    const publicNote = {
      id: 'n1',
      shareId: 'share-abc',
      title: 'Public Note',
      tags: [{ tag: { id: 'tag-1', name: 'demo' } }],
      attachments: [{ id: 'att-1' }],
    };
    prismaMock.note.findFirst.mockResolvedValue(publicNote);

    const result = await getPublicNote('share-abc');

    expect(prismaMock.note.findFirst).toHaveBeenCalledWith({
      where: { shareId: 'share-abc', isVault: false },
      include: {
        tags: { include: { tag: true } },
        attachments: { where: { isLatest: true } },
      },
    });
    expect(result).toEqual(publicNote);
  });

  it('returns null when shareId does not match any note', async () => {
    prismaMock.note.findFirst.mockResolvedValue(null);

    const result = await getPublicNote('nonexistent-share');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getNoteSizeBreakdown
// ---------------------------------------------------------------------------
describe('getNoteSizeBreakdown', () => {
  it('correctly sums note content, attachments, chat messages, and AI conversations', async () => {
    // Mock checkNoteAccess via the underlying prisma call
    prismaMock.note.findUnique
      .mockResolvedValueOnce({ userId: 'user-1', sharedWith: [] }) // checkNoteAccess
      .mockResolvedValueOnce({ // note data for size calculation
        title: 'Hello',
        content: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello doc' }] }] }),
        searchText: 'hello doc',
        ydocState: Buffer.from([1, 2, 3, 4, 5]), // 5 bytes
      });

    prismaMock.attachment.findMany.mockResolvedValue([
      { size: 1000 },
      { size: 2500 },
    ]);

    prismaMock.chatMessage.findMany.mockResolvedValue([
      { content: 'Hi there' },
      { content: 'Hello!' },
    ]);

    prismaMock.aiConversation.findMany.mockResolvedValue([
      { content: 'AI response text', metadata: { model: 'gpt-4' } },
      { content: 'Another response', metadata: null },
    ]);

    const result = await getNoteSizeBreakdown('user-1', 'note-1');

    // Note size: Buffer.byteLength(title) + Buffer.byteLength(content JSON) + Buffer.byteLength(searchText) + 5 (ydocState)
    const contentJson = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello doc' }] }] });
    const expectedNoteSize =
      Buffer.byteLength('Hello', 'utf8') +
      Buffer.byteLength(contentJson, 'utf8') +
      Buffer.byteLength('hello doc', 'utf8') +
      5;

    // Attachments: 1000 + 2500
    const expectedAttachmentsSize = 3500;

    // Chat: Buffer.byteLength('Hi there') + Buffer.byteLength('Hello!')
    const expectedChatSize =
      Buffer.byteLength('Hi there', 'utf8') +
      Buffer.byteLength('Hello!', 'utf8');

    // AI: Buffer.byteLength('AI response text') + Buffer.byteLength(JSON.stringify({ model: 'gpt-4' }))
    //   + Buffer.byteLength('Another response') + 0 (null metadata)
    const expectedAiSize =
      Buffer.byteLength('AI response text', 'utf8') +
      Buffer.byteLength(JSON.stringify({ model: 'gpt-4' }), 'utf8') +
      Buffer.byteLength('Another response', 'utf8');

    expect(result.note).toBe(expectedNoteSize);
    expect(result.attachments).toBe(expectedAttachmentsSize);
    expect(result.chat).toBe(expectedChatSize);
    expect(result.ai).toBe(expectedAiSize);
    expect(result.total).toBe(expectedNoteSize + expectedAttachmentsSize + expectedChatSize + expectedAiSize);
    expect(result.characters).toBe('hello doc'.length);
    expect(result.lines).toBe(1);
  });

  it('throws when user has no access to the note', async () => {
    // checkNoteAccess returns null
    prismaMock.note.findUnique.mockResolvedValueOnce(null);

    await expect(getNoteSizeBreakdown('stranger', 'note-1'))
      .rejects.toThrow('errors.notes.notFound');
  });

  it('throws when note data is not found (inconsistent state)', async () => {
    // checkNoteAccess passes (OWNER)
    prismaMock.note.findUnique
      .mockResolvedValueOnce({ userId: 'user-1', sharedWith: [] })
      .mockResolvedValueOnce(null); // note data query returns null

    prismaMock.attachment.findMany.mockResolvedValue([]);
    prismaMock.chatMessage.findMany.mockResolvedValue([]);
    prismaMock.aiConversation.findMany.mockResolvedValue([]);

    await expect(getNoteSizeBreakdown('user-1', 'note-1'))
      .rejects.toThrow('errors.notes.notFound');
  });

  it('handles notes with null/empty fields gracefully', async () => {
    prismaMock.note.findUnique
      .mockResolvedValueOnce({ userId: 'user-1', sharedWith: [] })
      .mockResolvedValueOnce({
        title: null,
        content: null,
        searchText: null,
        ydocState: null,
      });

    prismaMock.attachment.findMany.mockResolvedValue([]);
    prismaMock.chatMessage.findMany.mockResolvedValue([]);
    prismaMock.aiConversation.findMany.mockResolvedValue([]);

    const result = await getNoteSizeBreakdown('user-1', 'note-1');

    expect(result.note).toBe(0);
    expect(result.attachments).toBe(0);
    expect(result.chat).toBe(0);
    expect(result.ai).toBe(0);
    expect(result.total).toBe(0);
    expect(result.characters).toBe(0);
    expect(result.lines).toBe(0);
  });

  it('works for users with READ share access', async () => {
    // checkNoteAccess returns READ
    prismaMock.note.findUnique
      .mockResolvedValueOnce({ userId: 'owner-1', sharedWith: [{ permission: 'READ' }] })
      .mockResolvedValueOnce({
        title: 'Shared',
        content: '{}',
        searchText: '',
        ydocState: null,
      });

    prismaMock.attachment.findMany.mockResolvedValue([]);
    prismaMock.chatMessage.findMany.mockResolvedValue([]);
    prismaMock.aiConversation.findMany.mockResolvedValue([]);

    const result = await getNoteSizeBreakdown('reader-user', 'note-1');

    // Should succeed without throwing
    expect(result.total).toBeGreaterThanOrEqual(0);
  });
});

describe('vault P0 guards', () => {
  it('checkNoteAccess returns null for a non-owner on a vault note', async () => {
    prismaMock.note.findUnique.mockResolvedValue({
      userId: 'owner-1',
      isVault: true,
      sharedWith: [{ permission: 'WRITE' }],
    });
    expect(await checkNoteAccess('user-2', 'note-1')).toBeNull();
  });

  it('checkNoteAccess still returns OWNER for the owner of a vault note', async () => {
    prismaMock.note.findUnique.mockResolvedValue({ userId: 'user-1', isVault: true, sharedWith: [] });
    expect(await checkNoteAccess('user-1', 'note-1')).toBe('OWNER');
  });

  it('getPublicNote only looks up non-vault notes', async () => {
    prismaMock.note.findFirst.mockResolvedValue(null);
    expect(await getPublicNote('share-vault')).toBeNull();
    expect(prismaMock.note.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shareId: 'share-vault', isVault: false } }),
    );
  });

  it('getNote shared branch excludes vault notes', async () => {
    prismaMock.note.findFirst.mockResolvedValue(null);
    await getNote('user-2', 'n1');
    const where = prismaMock.note.findFirst.mock.calls[0][0].where;
    expect(where.OR).toContainEqual({ isVault: false, sharedWith: { some: { userId: 'user-2', status: 'ACCEPTED' } } });
  });
});
