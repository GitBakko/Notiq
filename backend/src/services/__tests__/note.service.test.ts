import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// Additional mocks beyond setup.ts
vi.mock('../../hocuspocus', () => ({
  hocuspocus: { openDirectConnection: vi.fn() },
  extensions: [],
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
      .rejects.toThrow('Notebook not found');
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
    prismaMock.note.create.mockRejectedValue({ code: 'P2002' });
    prismaMock.note.findUnique.mockResolvedValue(existing);

    const result = await createNote('user-1', 'Test', '{}', 'nb-1', false, false, 'dup-id');
    expect(result).toEqual(existing);
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
          { sharedWith: { some: { userId: 'user-1' } } },
        ],
      },
      include: expect.objectContaining({
        tags: { include: { tag: true } },
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

  it('updates note fields and recalculates searchText', async () => {
    prismaMock.note.findFirst.mockResolvedValue(existingNote);
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

  it('throws when note does not exist or user is not owner', async () => {
    prismaMock.note.findFirst.mockResolvedValue(null);

    await expect(updateNote('stranger', 'n1', { title: 'Hack' }))
      .rejects.toThrow('Note not found');
  });

  it('replaces tags within the transaction', async () => {
    prismaMock.note.findFirst.mockResolvedValue(existingNote);
    prismaMock.tagsOnNotes.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.tagsOnNotes.createMany.mockResolvedValue({ count: 2 });
    prismaMock.note.update.mockResolvedValue(existingNote);

    await updateNote('user-1', 'n1', {
      tags: [{ tag: { id: 'tag-a' } }, { tag: { id: 'tag-b' } }],
    });

    expect(prismaMock.tagsOnNotes.deleteMany).toHaveBeenCalledWith({ where: { noteId: 'n1' } });
    expect(prismaMock.tagsOnNotes.createMany).toHaveBeenCalledWith({
      data: [
        { noteId: 'n1', tagId: 'tag-a' },
        { noteId: 'n1', tagId: 'tag-b' },
      ],
    });
  });

  it('handles empty tags array (clears all tags)', async () => {
    prismaMock.note.findFirst.mockResolvedValue(existingNote);
    prismaMock.tagsOnNotes.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.note.update.mockResolvedValue(existingNote);

    await updateNote('user-1', 'n1', { tags: [] });

    expect(prismaMock.tagsOnNotes.deleteMany).toHaveBeenCalledWith({ where: { noteId: 'n1' } });
    expect(prismaMock.tagsOnNotes.createMany).not.toHaveBeenCalled();
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

  it('throws when note does not exist or user is not owner', async () => {
    prismaMock.note.findFirst.mockResolvedValue(null);

    await expect(deleteNote('stranger', 'n1')).rejects.toThrow('Note not found');

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

    await expect(toggleShare('stranger', 'n1')).rejects.toThrow('Note not found');
  });

  it('throws when trying to share a vault note', async () => {
    prismaMock.note.findFirst.mockResolvedValue({
      id: 'n1',
      userId: 'user-1',
      isPublic: false,
      isVault: true,
    });

    await expect(toggleShare('user-1', 'n1')).rejects.toThrow('Vault notes cannot be shared');
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
    prismaMock.note.findUnique.mockResolvedValue(publicNote);

    const result = await getPublicNote('share-abc');

    expect(prismaMock.note.findUnique).toHaveBeenCalledWith({
      where: { shareId: 'share-abc' },
      include: {
        tags: { include: { tag: true } },
        attachments: { where: { isLatest: true } },
      },
    });
    expect(result).toEqual(publicNote);
  });

  it('returns null when shareId does not match any note', async () => {
    prismaMock.note.findUnique.mockResolvedValue(null);

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
      .rejects.toThrow('Note not found');
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
      .rejects.toThrow('Note not found');
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
