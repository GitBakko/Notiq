import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock hocuspocus (imported by note.service.ts)
vi.mock('../hocuspocus', () => ({
  hocuspocus: {},
  extensions: [],
}));

vi.mock('@hocuspocus/transformer', () => ({
  TiptapTransformer: {
    toYdoc: vi.fn(),
    fromYdoc: vi.fn(),
  },
}));

vi.mock('yjs', () => ({
  Doc: vi.fn(),
  encodeStateAsUpdate: vi.fn(),
  applyUpdate: vi.fn(),
}));

vi.mock('uuid', () => ({
  v4: vi.fn().mockReturnValue('generated-uuid'),
}));

vi.mock('../utils/extractText', () => ({
  extractTextFromTipTapJson: vi.fn().mockReturnValue('extracted plain text'),
  countDocumentStats: vi.fn().mockReturnValue({ characters: 100, lines: 5 }),
}));

import prisma from '../plugins/prisma';
import { createNote, getNote, getNotes, updateNote, deleteNote, toggleShare, checkNoteAccess } from '../services/note.service';

const prismaMock = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('note.service — checkNoteAccess', () => {
  it('should return OWNER when user owns the note', async () => {
    prismaMock.note.findUnique.mockResolvedValueOnce({
      userId: 'user-1',
      sharedWith: [],
    } as any);

    const result = await checkNoteAccess('user-1', 'note-1');
    expect(result).toBe('OWNER');
  });

  it('should return permission level for shared user', async () => {
    prismaMock.note.findUnique.mockResolvedValueOnce({
      userId: 'owner-1',
      sharedWith: [{ permission: 'WRITE' }],
    } as any);

    const result = await checkNoteAccess('user-2', 'note-1');
    expect(result).toBe('WRITE');
  });

  it('should return null for non-existent note', async () => {
    prismaMock.note.findUnique.mockResolvedValueOnce(null);

    const result = await checkNoteAccess('user-1', 'nonexistent');
    expect(result).toBeNull();
  });

  it('should return null when user has no access', async () => {
    prismaMock.note.findUnique.mockResolvedValueOnce({
      userId: 'owner-1',
      sharedWith: [],
    } as any);

    const result = await checkNoteAccess('user-2', 'note-1');
    expect(result).toBeNull();
  });
});

describe('note.service — createNote', () => {
  it('should create a note successfully', async () => {
    const mockNote = {
      id: 'note-1',
      title: 'Test Note',
      content: '{"type":"doc"}',
      userId: 'user-1',
      notebookId: 'nb-1',
    };

    prismaMock.notebook.findFirst.mockResolvedValueOnce({ id: 'nb-1', userId: 'user-1' } as any);
    prismaMock.note.create.mockResolvedValueOnce(mockNote as any);

    const result = await createNote('user-1', 'Test Note', '{"type":"doc"}', 'nb-1');

    expect(result).toEqual(mockNote);
    expect(prismaMock.note.create).toHaveBeenCalled();
  });

  it('should fallback to any notebook if specified notebook not found', async () => {
    prismaMock.notebook.findFirst
      .mockResolvedValueOnce(null) // specified notebook not found
      .mockResolvedValueOnce({ id: 'nb-fallback', userId: 'user-1' } as any); // fallback
    prismaMock.note.create.mockResolvedValueOnce({ id: 'note-1' } as any);

    await createNote('user-1', 'Test', '{}', 'nb-nonexistent');

    const createCall = prismaMock.note.create.mock.calls[0][0];
    expect(createCall.data.notebookId).toBe('nb-fallback');
  });

  it('should throw if no notebook exists for user', async () => {
    prismaMock.notebook.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await expect(createNote('user-1', 'Test', '{}', 'nb-none')).rejects.toThrow('Notebook not found');
  });

  it('should return existing note on P2002 duplicate key conflict', async () => {
    const existingNote = { id: 'note-dup', title: 'Existing' };
    prismaMock.notebook.findFirst.mockResolvedValueOnce({ id: 'nb-1' } as any);

    const p2002Error = new Error('Unique constraint failed') as Error & { code: string };
    p2002Error.code = 'P2002';
    prismaMock.note.create.mockRejectedValueOnce(p2002Error);
    prismaMock.note.findUnique.mockResolvedValueOnce(existingNote as any);

    const result = await createNote('user-1', 'Test', '{}', 'nb-1', false, false, 'note-dup');
    expect(result).toEqual(existingNote);
  });
});

describe('note.service — getNote', () => {
  it('should return note for owner or shared user', async () => {
    const mockNote = { id: 'note-1', title: 'My Note', userId: 'user-1' };
    prismaMock.note.findFirst.mockResolvedValueOnce(mockNote as any);

    const result = await getNote('user-1', 'note-1');
    expect(result).toEqual(mockNote);
  });

  it('should return null if note not accessible', async () => {
    prismaMock.note.findFirst.mockResolvedValueOnce(null);

    const result = await getNote('user-2', 'note-1');
    expect(result).toBeNull();
  });
});

describe('note.service — updateNote', () => {
  it('should update note successfully', async () => {
    const existingNote = { id: 'note-1', userId: 'user-1', content: '{"type":"doc"}', isEncrypted: false };
    const updatedNote = { ...existingNote, title: 'Updated Title' };

    prismaMock.note.findFirst.mockResolvedValueOnce(existingNote as any);
    // $transaction calls the callback with the tx mock (which is prismaMock itself via setup.ts)
    prismaMock.note.update.mockResolvedValueOnce(updatedNote as any);

    const result = await updateNote('user-1', 'note-1', { title: 'Updated Title' });
    expect(result).toEqual(updatedNote);
  });

  it('should throw if note not found or not owned', async () => {
    prismaMock.note.findFirst.mockResolvedValueOnce(null);

    await expect(updateNote('user-2', 'note-1', { title: 'Hack' })).rejects.toThrow('Note not found');
  });

  it('should prevent overwriting substantial content with empty doc', async () => {
    const existingNote = {
      id: 'note-1',
      userId: 'user-1',
      content: 'A'.repeat(200), // substantial
      isEncrypted: false,
    };
    const emptyContent = '{"type":"doc","content":[{"type":"paragraph"}]}'; // ~50 chars

    prismaMock.note.findFirst.mockResolvedValueOnce(existingNote as any);
    prismaMock.note.update.mockResolvedValueOnce(existingNote as any);

    await updateNote('user-1', 'note-1', { content: emptyContent });

    // The update should NOT include the content field (it was dropped)
    const updateCall = prismaMock.note.update.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty('content');
  });
});

describe('note.service — toggleShare', () => {
  it('should toggle sharing on for a non-vault note', async () => {
    prismaMock.note.findFirst.mockResolvedValueOnce({
      id: 'note-1',
      userId: 'user-1',
      isPublic: false,
      isVault: false,
    } as any);
    prismaMock.note.update.mockResolvedValueOnce({ id: 'note-1', isPublic: true, shareId: 'generated-uuid' } as any);

    const result = await toggleShare('user-1', 'note-1');
    expect(result.isPublic).toBe(true);
  });

  it('should throw if note is in vault', async () => {
    prismaMock.note.findFirst.mockResolvedValueOnce({
      id: 'note-1',
      userId: 'user-1',
      isVault: true,
    } as any);

    await expect(toggleShare('user-1', 'note-1')).rejects.toThrow('Vault notes cannot be shared');
  });
});

describe('note.service — deleteNote', () => {
  it('should delete note and all related records in transaction', async () => {
    prismaMock.note.findFirst.mockResolvedValueOnce({ id: 'note-1', userId: 'user-1' } as any);
    prismaMock.tagsOnNotes.deleteMany.mockResolvedValueOnce({ count: 1 } as any);
    prismaMock.attachment.deleteMany.mockResolvedValueOnce({ count: 0 } as any);
    prismaMock.sharedNote.deleteMany.mockResolvedValueOnce({ count: 0 } as any);
    prismaMock.chatMessage.deleteMany.mockResolvedValueOnce({ count: 0 } as any);
    prismaMock.note.delete.mockResolvedValueOnce({ id: 'note-1' } as any);

    const result = await deleteNote('user-1', 'note-1');
    expect(result).toEqual({ id: 'note-1' });
  });

  it('should throw if note not owned by user', async () => {
    prismaMock.note.findFirst.mockResolvedValueOnce(null);

    await expect(deleteNote('user-2', 'note-1')).rejects.toThrow('Note not found');
  });
});
