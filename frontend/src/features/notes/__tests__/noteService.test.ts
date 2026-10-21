import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../../lib/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../../lib/db', () => ({
  db: {
    notes: {
      add: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    syncQueue: {
      add: vi.fn(),
    },
    transaction: vi.fn((...args: unknown[]) => (args[args.length - 1] as () => unknown)()),
  },
}));

vi.mock('../../../store/authStore', () => ({
  useAuthStore: {
    getState: vi.fn().mockReturnValue({ user: { id: 'user-1' } }),
  },
}));

vi.mock('../../sync/syncService', () => ({
  syncPush: vi.fn(),
}));

vi.mock('uuid', () => ({
  v4: vi.fn().mockReturnValue('mock-uuid'),
}));

import api from '../../../lib/api';
import { db } from '../../../lib/db';
import {
  getNotes, getNote, toggleShare, shareNote, revokeShare,
  createNote, updateNote, updateNoteLocalOnly, deleteNote,
  restoreNote, permanentlyDeleteNote, VaultPlaintextGuardError,
} from '../noteService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock overrides
const apiMock = api as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock overrides
const dbMock = db as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getNotes', () => {
  it('fetches notes with no filters', async () => {
    apiMock.get.mockResolvedValue({ data: [{ id: '1', title: 'A' }] });
    const result = await getNotes();
    expect(apiMock.get).toHaveBeenCalledWith('/notes?');
    expect(result).toEqual([{ id: '1', title: 'A' }]);
  });

  it('passes notebookId, search, tagId as query params', async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    await getNotes('nb-1', 'hello', 'tag-1');
    const url = apiMock.get.mock.calls[0][0];
    expect(url).toContain('notebookId=nb-1');
    expect(url).toContain('search=hello');
    expect(url).toContain('tagId=tag-1');
  });
});

describe('getNote', () => {
  it('fetches a single note by id', async () => {
    apiMock.get.mockResolvedValue({ data: { id: 'note-1', title: 'X' } });
    const result = await getNote('note-1');
    expect(apiMock.get).toHaveBeenCalledWith('/notes/note-1');
    expect(result.id).toBe('note-1');
  });
});

describe('toggleShare', () => {
  it('syncs first then toggles share', async () => {
    apiMock.post.mockResolvedValue({ data: { id: 'note-1', isPublic: true } });
    const result = await toggleShare('note-1');
    expect(result.isPublic).toBe(true);
  });
});

describe('shareNote', () => {
  it('shares a note with email and permission', async () => {
    apiMock.post.mockResolvedValue({ data: { success: true } });
    await shareNote('note-1', 'user@test.com', 'WRITE');
    expect(apiMock.post).toHaveBeenCalledWith('/share/notes/note-1', { email: 'user@test.com', permission: 'WRITE' });
  });

  it('defaults to READ permission', async () => {
    apiMock.post.mockResolvedValue({ data: {} });
    await shareNote('note-1', 'user@test.com');
    expect(apiMock.post).toHaveBeenCalledWith('/share/notes/note-1', { email: 'user@test.com', permission: 'READ' });
  });
});

describe('revokeShare', () => {
  it('revokes share by note and user id', async () => {
    apiMock.delete.mockResolvedValue({ data: {} });
    await revokeShare('note-1', 'user-2');
    expect(apiMock.delete).toHaveBeenCalledWith('/share/notes/note-1/user-2');
  });
});

describe('createNote', () => {
  it('creates a note in Dexie with ownership fields', async () => {
    dbMock.notes.add.mockResolvedValue(undefined);
    dbMock.syncQueue.add.mockResolvedValue(undefined);

    const result = await createNote({ title: 'New', notebookId: 'nb-1' });

    expect(result.id).toBe('mock-uuid');
    expect(result.title).toBe('New');
    expect(result.ownership).toBe('owned');
    expect(result.sharedPermission).toBeNull();
    expect(result.syncStatus).toBe('created');
    expect(dbMock.notes.add).toHaveBeenCalledOnce();
    expect(dbMock.syncQueue.add).toHaveBeenCalledOnce();
  });

  it('sets default values for optional fields', async () => {
    dbMock.notes.add.mockResolvedValue(undefined);
    dbMock.syncQueue.add.mockResolvedValue(undefined);

    const result = await createNote({ title: '', notebookId: 'nb-1' });
    expect(result.content).toBe('');
    expect(result.isTrashed).toBe(false);
    expect(result.isVault).toBe(false);
    expect(result.isEncrypted).toBe(false);
    expect(result.tags).toEqual([]);
    expect(result.attachments).toEqual([]);
  });
});

describe('updateNote', () => {
  it('updates owned note in Dexie + sync queue', async () => {
    dbMock.notes.get.mockResolvedValue({ id: 'note-1', ownership: 'owned' });
    dbMock.notes.update.mockResolvedValue(undefined);
    dbMock.syncQueue.add.mockResolvedValue(undefined);

    await updateNote('note-1', { title: 'Updated' });

    expect(dbMock.notes.update).toHaveBeenCalled();
    expect(dbMock.syncQueue.add).toHaveBeenCalledOnce();
  });

  it('redirects shared notes to updateNoteLocalOnly (no sync queue)', async () => {
    dbMock.notes.get.mockResolvedValue({ id: 'note-1', ownership: 'shared' });
    dbMock.notes.update.mockResolvedValue(undefined);

    await updateNote('note-1', { title: 'Updated' });

    // Should have called update but NOT added to sync queue
    expect(dbMock.notes.update).toHaveBeenCalled();
    expect(dbMock.syncQueue.add).not.toHaveBeenCalled();
  });
});

describe('updateNoteLocalOnly', () => {
  it('updates Dexie without adding to sync queue', async () => {
    dbMock.notes.update.mockResolvedValue(undefined);
    dbMock.notes.get.mockResolvedValue({ id: 'note-1', title: 'Updated' });

    const result = await updateNoteLocalOnly('note-1', { title: 'Updated' });

    expect(dbMock.notes.update).toHaveBeenCalled();
    expect(dbMock.syncQueue.add).not.toHaveBeenCalled();
    expect(result?.title).toBe('Updated');
  });
});

describe('deleteNote', () => {
  it('soft deletes note (sets isTrashed) and queues sync', async () => {
    dbMock.notes.update.mockResolvedValue(undefined);
    dbMock.syncQueue.add.mockResolvedValue(undefined);

    await deleteNote('note-1');

    expect(dbMock.notes.update).toHaveBeenCalledWith('note-1', expect.objectContaining({ isTrashed: true, syncStatus: 'updated' }));
    expect(dbMock.syncQueue.add).toHaveBeenCalledWith(expect.objectContaining({
      type: 'UPDATE',
      entity: 'NOTE',
      data: { isTrashed: true },
    }));
  });
});

describe('restoreNote', () => {
  it('restores a trashed note', async () => {
    dbMock.notes.update.mockResolvedValue(undefined);
    dbMock.syncQueue.add.mockResolvedValue(undefined);

    await restoreNote('note-1');

    expect(dbMock.notes.update).toHaveBeenCalledWith('note-1', expect.objectContaining({ isTrashed: false }));
    expect(dbMock.syncQueue.add).toHaveBeenCalledWith(expect.objectContaining({
      type: 'UPDATE',
      data: { isTrashed: false },
    }));
  });
});

describe('permanentlyDeleteNote', () => {
  it('deletes from Dexie and queues DELETE', async () => {
    dbMock.notes.delete.mockResolvedValue(undefined);
    dbMock.syncQueue.add.mockResolvedValue(undefined);

    await permanentlyDeleteNote('note-1');

    expect(dbMock.notes.delete).toHaveBeenCalledWith('note-1');
    expect(dbMock.syncQueue.add).toHaveBeenCalledWith(expect.objectContaining({
      type: 'DELETE',
      entity: 'NOTE',
      entityId: 'note-1',
    }));
  });
});

describe('vault safety net (T21a)', () => {
  const ENV = `nv3.1.${'A'.repeat(16)}.${'B'.repeat(30)}`;
  const vaultRow = { id: 'v1', isVault: true, ownership: 'owned' };

  it('updateNote rejects isVault key, Dexie and queue untouched', async () => {
    await expect(updateNote('n1', { isVault: true })).rejects.toThrow(/plaintextGuard/);
    expect(dbMock.notes.update).not.toHaveBeenCalled();
    expect(dbMock.syncQueue.add).not.toHaveBeenCalled();
  });

  it.each([
    [{ content: '{"type":"doc","content":[]}' }],
    [{ title: 'x' }],
    [{ isEncrypted: false }],
  ])('rejects %j on vault row', async (data) => {
    dbMock.notes.get.mockResolvedValue(vaultRow);
    await expect(updateNote('v1', data)).rejects.toThrow(/plaintextGuard/);
    expect(dbMock.notes.update).not.toHaveBeenCalled();
    expect(dbMock.syncQueue.add).not.toHaveBeenCalled();
  });

  it('accepts envelope content alone on vault row', async () => {
    dbMock.notes.get.mockResolvedValue(vaultRow);
    await updateNote('v1', { content: ENV });
    expect(dbMock.notes.update).toHaveBeenCalledWith('v1', expect.objectContaining({ content: ENV }));
    expect(dbMock.syncQueue.add).toHaveBeenCalled();
  });

  it('accepts envelope content with empty title on vault row', async () => {
    dbMock.notes.get.mockResolvedValue(vaultRow);
    await updateNote('v1', { content: ENV, title: '' });
    expect(dbMock.notes.update).toHaveBeenCalled();
  });

  it('rejects with VaultPlaintextGuardError', async () => {
    dbMock.notes.get.mockResolvedValue(vaultRow);
    await expect(updateNote('v1', { title: 'x' })).rejects.toBeInstanceOf(VaultPlaintextGuardError);
  });

  it('read, guard, update and queue run in one transaction', async () => {
    dbMock.notes.get.mockResolvedValue({ id: 'n1', ownership: 'owned' });
    await updateNote('n1', { title: 'x' });
    expect(dbMock.transaction).toHaveBeenCalledWith('rw', dbMock.notes, dbMock.syncQueue, expect.any(Function));
    const order = [dbMock.notes.get, dbMock.notes.update, dbMock.syncQueue.add].map(f => f.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(dbMock.transaction.mock.invocationCallOrder[0]).toBeLessThan(order[0]);
  });

  it('createNote vault rejects non-empty title, non-envelope, isEncrypted:false; nothing written', async () => {
    await expect(createNote({ isVault: true, title: 'x', notebookId: 'nb', content: ENV })).rejects.toBeInstanceOf(VaultPlaintextGuardError);
    await expect(createNote({ isVault: true, title: '', notebookId: 'nb', content: 'plain' })).rejects.toThrow(/plaintextGuard/);
    await expect(createNote({ isVault: true, title: '', notebookId: 'nb', content: ENV, isEncrypted: false })).rejects.toThrow(/plaintextGuard/);
    await expect(createNote({ isVault: true, title: '', notebookId: 'nb' })).rejects.toThrow(/plaintextGuard/);
    expect(dbMock.notes.add).not.toHaveBeenCalled();
    expect(dbMock.syncQueue.add).not.toHaveBeenCalled();
  });

  it('createNote vault accepts envelope and forces isEncrypted true', async () => {
    const n = await createNote({ isVault: true, title: '', notebookId: 'nb', content: ENV });
    expect(n.isEncrypted).toBe(true);
    expect(dbMock.notes.add).toHaveBeenCalled();
    expect(dbMock.syncQueue.add).toHaveBeenCalled();
  });

  it('normal notes unchanged', async () => {
    dbMock.notes.get.mockResolvedValue({ id: 'n1', ownership: 'owned' });
    const data = { title: 'x', content: 'plain', isEncrypted: false };
    await updateNote('n1', data);
    expect(dbMock.notes.update).toHaveBeenCalledWith('n1', expect.objectContaining({ ...data, syncStatus: 'updated' }));
    expect(dbMock.syncQueue.add).toHaveBeenCalledWith(expect.objectContaining({ type: 'UPDATE', entityId: 'n1', data }));
  });
});
