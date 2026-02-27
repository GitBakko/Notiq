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
  restoreNote, permanentlyDeleteNote,
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
