import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock hocuspocus (imported by note.service.ts)
vi.mock('../hocuspocus', () => ({
  hocuspocus: { hocuspocus: { closeConnections: vi.fn() } },
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
import { sha256hex } from '../services/vault.service';

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

    await expect(createNote('user-1', 'Test', '{}', 'nb-none')).rejects.toThrow('errors.notebooks.notFound');
  });

  it('should return existing note on P2002 duplicate key conflict', async () => {
    const existingNote = { id: 'note-dup', title: 'Existing' };
    prismaMock.notebook.findFirst.mockResolvedValueOnce({ id: 'nb-1' } as any);

    const p2002Error = new Error('Unique constraint failed') as Error & { code: string };
    p2002Error.code = 'P2002';
    prismaMock.note.create.mockRejectedValueOnce(p2002Error);
    prismaMock.note.findFirst.mockResolvedValueOnce(existingNote as any);

    const result = await createNote('user-1', 'Test', '{}', 'nb-1', false, false, 'note-dup');
    expect(result).toEqual(existingNote);
    expect(prismaMock.note.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'note-dup', userId: 'user-1' } }),
    );
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

    await expect(updateNote('user-2', 'note-1', { title: 'Hack' })).rejects.toThrow('errors.notes.notFound');
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

    await expect(toggleShare('user-1', 'note-1')).rejects.toThrow('errors.sharing.vaultNotShareable');
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

    await expect(deleteNote('user-2', 'note-1')).rejects.toThrow('errors.notes.notFound');
  });
});

describe('vault P1 enforcement (T10)', () => {
  const READY = { status: 'READY', epoch: 0 };
  const env = (epoch = 0, len = 120) => {
    const head = `nv3.${epoch}.AAAAAAAAAAAAAAAA.`;
    return head + 'B'.repeat(len - head.length);
  };
  const vaultNote = (content: string, extra: Record<string, unknown> = {}) => ({
    id: 'n1', userId: 'u1', title: '', content, isVault: true, isEncrypted: true, noteType: 'NOTE', ...extra,
  });
  const plainNote = (content: string, extra: Record<string, unknown> = {}) => ({
    id: 'n1', userId: 'u1', title: 't', content, isVault: false, isEncrypted: false, noteType: 'NOTE', ...extra,
  });
  const fail = (p: Promise<unknown>, message: string) =>
    expect(p).rejects.toMatchObject({ statusCode: 422, message });

  const noteMock = prismaMock.note as any;
  const keyring = prismaMock.vaultKeyring.findUnique as any;

  beforeEach(() => {
    keyring.mockReset();
    noteMock.findFirst.mockReset();
    noteMock.update.mockReset();
    noteMock.updateMany.mockReset();
    noteMock.create.mockReset();
    noteMock.findUniqueOrThrow = vi.fn();
    prismaMock.notebook.findFirst.mockReset();
  });

  describe('without keyring', () => {
    it('legacy vault note accepts plaintext via tx.note.update, even without pepper, and drops baseHash', async () => {
      const pepper = process.env.VAULT_PEPPER_KEY;
      delete process.env.VAULT_PEPPER_KEY;
      try {
        const old = 'A'.repeat(300);
        const row = { id: 'n1' };
        keyring.mockResolvedValue(null);
        noteMock.findFirst.mockResolvedValue(vaultNote(old));
        noteMock.update.mockResolvedValue(row);

        const res = await updateNote('u1', 'n1', { content: 'P'.repeat(300), baseHash: 'a'.repeat(64) });

        expect(res).toBe(row);
        expect(noteMock.updateMany).not.toHaveBeenCalled();
        expect(noteMock.update).toHaveBeenCalledTimes(1);
        const data = noteMock.update.mock.calls[0][0].data;
        expect(data.content).toBe('P'.repeat(300));
        expect(data).not.toHaveProperty('baseHash');
      } finally {
        process.env.VAULT_PEPPER_KEY = pepper;
      }
    });

    it('normal note: vaultKeyring.findUnique is not called', async () => {
      noteMock.findFirst.mockResolvedValue(plainNote('A'.repeat(300)));
      noteMock.update.mockResolvedValue({ id: 'n1' });
      await updateNote('u1', 'n1', { title: 'x', baseHash: 'a'.repeat(64) });
      expect(keyring).not.toHaveBeenCalled();
      expect(noteMock.update.mock.calls[0][0].data).not.toHaveProperty('baseHash');
    });

    it('empty TipTap doc on a legacy vault note with long content is still dropped by the guard', async () => {
      const old = 'A'.repeat(300);
      keyring.mockResolvedValue(null);
      noteMock.findFirst.mockResolvedValue(vaultNote(old));
      noteMock.update.mockResolvedValue({ id: 'n1' });
      await updateNote('u1', 'n1', { content: '{"type":"doc","content":[{"type":"paragraph"}]}' });
      const data = noteMock.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('content');
    });

    it('createNote with isVault false: vaultKeyring.findUnique not called', async () => {
      prismaMock.notebook.findFirst.mockResolvedValue({ id: 'nb-1' } as any);
      noteMock.create.mockResolvedValue({ id: 'n1' });
      await createNote('u1', 'Title', '{"type":"doc"}', 'nb-1', false, false);
      expect(keyring).not.toHaveBeenCalled();
    });

    it('normal note PUT with content: vaultKeyring.findUnique not called', async () => {
      noteMock.findFirst.mockResolvedValue(plainNote('A'.repeat(300)));
      noteMock.update.mockResolvedValue({ id: 'n1' });
      await updateNote('u1', 'n1', { content: 'P'.repeat(300) });
      expect(keyring).not.toHaveBeenCalled();
    });

    it('createNote with isVault and no keyring: create as today, isEncrypted unchanged', async () => {
      keyring.mockResolvedValue(null);
      prismaMock.notebook.findFirst.mockResolvedValue({ id: 'nb-1' } as any);
      noteMock.create.mockResolvedValue({ id: 'n1' });
      await createNote('u1', 'Title', '{"type":"doc"}', 'nb-1', true, false);
      const data = noteMock.create.mock.calls[0][0].data;
      expect(data.isEncrypted).toBe(false);
      expect(data.title).toBe('Title');
    });
  });

  describe('with READY keyring', () => {
    beforeEach(() => keyring.mockResolvedValue(READY));

    it('rejects plaintext content', async () => {
      noteMock.findFirst.mockResolvedValue(vaultNote(env()));
      await fail(updateNote('u1', 'n1', { content: 'P'.repeat(300), baseHash: sha256hex(env()) }), 'errors.vault.plaintextRejected');
    });

    it('rejects a wrong baseHash', async () => {
      noteMock.findFirst.mockResolvedValue(vaultNote(env()));
      await fail(updateNote('u1', 'n1', { content: env(0, 130), baseHash: 'f'.repeat(64) }), 'errors.vault.conflict');
    });

    it('rejects an envelope of another epoch', async () => {
      noteMock.findFirst.mockResolvedValue(vaultNote(env()));
      await fail(updateNote('u1', 'n1', { content: env(1), baseHash: sha256hex(env()) }), 'errors.vault.stale');
    });

    it('persists a short (120 char) envelope with the right baseHash via updateMany', async () => {
      const old = env(0, 200);
      const next = env(0, 120);
      const row = { id: 'n1', content: next };
      noteMock.findFirst.mockResolvedValue(vaultNote(old));
      noteMock.updateMany.mockResolvedValue({ count: 1 });
      noteMock.findUniqueOrThrow.mockResolvedValue(row);

      const res = await updateNote('u1', 'n1', { content: next, baseHash: sha256hex(old) });

      expect(res).toBe(row);
      expect(noteMock.update).not.toHaveBeenCalled();
      const arg = noteMock.updateMany.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 'n1', content: old });
      expect(arg.data.content).toBe(next);
      expect(arg.data.isEncrypted).toBe(true);
      expect(arg.data).not.toHaveProperty('baseHash');
    });

    it('updateMany count 0 -> 422 conflict', async () => {
      const old = env();
      noteMock.findFirst.mockResolvedValue(vaultNote(old));
      noteMock.updateMany.mockResolvedValue({ count: 0 });
      await fail(updateNote('u1', 'n1', { content: env(0, 130), baseHash: sha256hex(old) }), 'errors.vault.conflict');
      expect(noteMock.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('metadata-only writes on a vault note pass without baseHash, through update', async () => {
      noteMock.findFirst.mockResolvedValue(vaultNote(env()));
      noteMock.update.mockResolvedValue({ id: 'n1' });
      await updateNote('u1', 'n1', { isTrashed: true });
      await updateNote('u1', 'n1', { isPinned: true });
      await updateNote('u1', 'n1', { tags: [] });
      expect(noteMock.update).toHaveBeenCalledTimes(3);
      expect(noteMock.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a non-empty title on a vault note', async () => {
      noteMock.findFirst.mockResolvedValue(vaultNote(env()));
      await fail(updateNote('u1', 'n1', { title: 'x' }), 'errors.vault.plaintextRejected');
    });

    it('entering the vault without content -> plaintextRejected', async () => {
      noteMock.findFirst.mockResolvedValue(plainNote('A'.repeat(300)));
      await fail(updateNote('u1', 'n1', { isVault: true }), 'errors.vault.plaintextRejected');
    });

    it('entering the vault with envelope and right CAS: title empty, isEncrypted true, searchText null', async () => {
      const old = 'A'.repeat(300);
      noteMock.findFirst.mockResolvedValue(plainNote(old));
      noteMock.updateMany.mockResolvedValue({ count: 1 });
      noteMock.findUniqueOrThrow.mockResolvedValue({ id: 'n1' });
      prismaMock.sharedNote.deleteMany.mockResolvedValue({ count: 0 } as any);

      await updateNote('u1', 'n1', { isVault: true, title: 'secret', content: env(), baseHash: sha256hex(old) });

      const data = noteMock.updateMany.mock.calls[0][0].data;
      expect(data.title).toBe('');
      expect(data.isEncrypted).toBe(true);
      expect(data.searchText).toBeNull();
      expect(prismaMock.sharedNote.deleteMany).toHaveBeenCalled();
    });

    it('leaving the vault with an envelope -> plaintextRequired', async () => {
      const old = env();
      noteMock.findFirst.mockResolvedValue(vaultNote(old));
      await fail(updateNote('u1', 'n1', { isVault: false, isEncrypted: false, content: env(0, 130), baseHash: sha256hex(old) }), 'errors.vault.plaintextRequired');
    });

    it('leaving the vault with short plaintext is not dropped by the 150 char guard and recomputes searchText', async () => {
      const old = env(0, 200);
      const doc = '{"type":"doc","content":[{}]}'.padEnd(30, ' ');
      noteMock.findFirst.mockResolvedValue(vaultNote(old));
      noteMock.updateMany.mockResolvedValue({ count: 1 });
      noteMock.findUniqueOrThrow.mockResolvedValue({ id: 'n1' });

      await updateNote('u1', 'n1', { isVault: false, isEncrypted: false, content: doc, baseHash: sha256hex(old) });

      const arg = noteMock.updateMany.mock.calls[0][0];
      expect(arg.data.content).toBe(doc);
      expect(arg.data.searchText).toBe('extracted plain text');
    });

    it('leaving the vault with a wrong baseHash -> conflict', async () => {
      noteMock.findFirst.mockResolvedValue(vaultNote(env()));
      await fail(updateNote('u1', 'n1', { isVault: false, isEncrypted: false, content: 'P'.repeat(300), baseHash: 'f'.repeat(64) }), 'errors.vault.conflict');
    });

    it('stays-in-vault metadata-only PUT { isEncrypted: false } -> 422 plaintextRejected', async () => {
      noteMock.findFirst.mockResolvedValue(vaultNote(env()));
      await fail(updateNote('u1', 'n1', { isEncrypted: false }), 'errors.vault.plaintextRejected');
      expect(noteMock.update).not.toHaveBeenCalled();
    });

    it('exit without isEncrypted in the request forces isEncrypted false and recomputes searchText for NOTE', async () => {
      const old = env(0, 200);
      noteMock.findFirst.mockResolvedValue(vaultNote(old));
      noteMock.updateMany.mockResolvedValue({ count: 1 });
      noteMock.findUniqueOrThrow.mockResolvedValue({ id: 'n1' });
      await updateNote('u1', 'n1', { isVault: false, content: 'P'.repeat(40), baseHash: sha256hex(old) });
      const data = noteMock.updateMany.mock.calls[0][0].data;
      expect(data.isEncrypted).toBe(false);
      expect(data.searchText).toBe('extracted plain text');
    });

    it('exit of a CREDENTIAL does not set searchText', async () => {
      const old = env(0, 200);
      noteMock.findFirst.mockResolvedValue(vaultNote(old, { noteType: 'CREDENTIAL' }));
      noteMock.updateMany.mockResolvedValue({ count: 1 });
      noteMock.findUniqueOrThrow.mockResolvedValue({ id: 'n1' });
      await updateNote('u1', 'n1', { isVault: false, content: 'P'.repeat(40), baseHash: sha256hex(old) });
      const data = noteMock.updateMany.mock.calls[0][0].data;
      expect(data.isEncrypted).toBe(false);
      expect(data).not.toHaveProperty('searchText');
    });

    it('entry with wrong baseHash -> conflict; entry with plaintext content -> plaintextRejected', async () => {
      const old = 'A'.repeat(300);
      noteMock.findFirst.mockResolvedValue(plainNote(old));
      await fail(updateNote('u1', 'n1', { isVault: true, content: env(), baseHash: 'f'.repeat(64) }), 'errors.vault.conflict');
      await fail(updateNote('u1', 'n1', { isVault: true, content: 'P'.repeat(300), baseHash: sha256hex(old) }), 'errors.vault.plaintextRejected');
    });

    it('exit without content -> plaintextRequired', async () => {
      noteMock.findFirst.mockResolvedValue(vaultNote(env()));
      await fail(updateNote('u1', 'n1', { isVault: false }), 'errors.vault.plaintextRequired');
    });

    it('successful entry clears share state and closes collab connections', async () => {
      const { hocuspocus } = await import('../hocuspocus');
      const old = 'A'.repeat(300);
      noteMock.findFirst.mockResolvedValue(plainNote(old));
      noteMock.updateMany.mockResolvedValue({ count: 1 });
      noteMock.findUniqueOrThrow.mockResolvedValue({ id: 'n1' });
      prismaMock.sharedNote.deleteMany.mockResolvedValue({ count: 0 } as any);
      await updateNote('u1', 'n1', { isVault: true, title: 'secret', content: env(), baseHash: sha256hex(old) });
      const data = noteMock.updateMany.mock.calls[0][0].data;
      expect(data).toMatchObject({ isPublic: false, shareId: null, ydocState: null, searchText: null, title: '', isEncrypted: true });
      expect(hocuspocus.hocuspocus.closeConnections).toHaveBeenCalledWith('n1');
    });

    it('createNote isVault: plaintext -> 422', async () => {
      prismaMock.notebook.findFirst.mockResolvedValue({ id: 'nb-1' } as any);
      await fail(createNote('u1', '', 'P'.repeat(300), 'nb-1', true, false), 'errors.vault.plaintextRejected');
      expect(noteMock.create).not.toHaveBeenCalled();
    });

    it('createNote isVault: envelope with empty title -> isEncrypted true, searchText null', async () => {
      prismaMock.notebook.findFirst.mockResolvedValue({ id: 'nb-1' } as any);
      noteMock.create.mockResolvedValue({ id: 'n1' });
      await createNote('u1', '', env(), 'nb-1', true, false);
      const data = noteMock.create.mock.calls[0][0].data;
      expect(data.isEncrypted).toBe(true);
      expect(data.searchText).toBeNull();
    });

    it('createNote isVault: non-empty title -> 422', async () => {
      prismaMock.notebook.findFirst.mockResolvedValue({ id: 'nb-1' } as any);
      await fail(createNote('u1', 'x', env(), 'nb-1', true, false), 'errors.vault.plaintextRejected');
    });
  });

  describe('with RESET_PENDING keyring', () => {
    it('content -> 422 notReady', async () => {
      keyring.mockResolvedValue({ status: 'RESET_PENDING', epoch: 1 });
      noteMock.findFirst.mockResolvedValue(vaultNote(env()));
      await fail(updateNote('u1', 'n1', { content: env(1), baseHash: sha256hex(env()) }), 'errors.vault.notReady');
    });

    it('exit with valid plaintext and right baseHash -> 422 notReady, no write', async () => {
      const old = env();
      keyring.mockResolvedValue({ status: 'RESET_PENDING', epoch: 1 });
      noteMock.findFirst.mockResolvedValue(vaultNote(old));
      await fail(updateNote('u1', 'n1', { isVault: false, content: 'P'.repeat(300), baseHash: sha256hex(old) }), 'errors.vault.notReady');
      expect(noteMock.update).not.toHaveBeenCalled();
      expect(noteMock.updateMany).not.toHaveBeenCalled();
    });
  });
});
