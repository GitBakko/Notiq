import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';
import { snapshotPreviousVersion, pruneNoteVersions } from '../noteVersion.service';

const prismaMock = prisma as any;
const NOW = new Date('2026-06-10T12:00:00Z').getTime();

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  prismaMock.noteVersion.findFirst.mockReset();
  prismaMock.noteVersion.create.mockReset();
  prismaMock.noteVersion.deleteMany.mockReset();
  prismaMock.noteVersion.findMany.mockReset();
});

describe('snapshotPreviousVersion', () => {
  it('creates a version when there is no prior snapshot', async () => {
    prismaMock.noteVersion.findFirst.mockResolvedValue(null);
    prismaMock.noteVersion.findMany.mockResolvedValue([]);
    await snapshotPreviousVersion(prismaMock, 'note-1', 'A'.repeat(200), 'Old title');
    expect(prismaMock.noteVersion.create).toHaveBeenCalledWith({
      data: { noteId: 'note-1', content: 'A'.repeat(200), title: 'Old title' },
    });
  });

  it('skips when the latest snapshot is younger than the throttle window', async () => {
    prismaMock.noteVersion.findFirst.mockResolvedValue({ createdAt: new Date(NOW - 30_000) }); // 30s ago
    await snapshotPreviousVersion(prismaMock, 'note-1', 'A'.repeat(200), 'T');
    expect(prismaMock.noteVersion.create).not.toHaveBeenCalled();
  });

  it('snapshots when the latest snapshot is older than the throttle window', async () => {
    prismaMock.noteVersion.findFirst.mockResolvedValue({ createdAt: new Date(NOW - 5 * 60_000) }); // 5m ago
    prismaMock.noteVersion.findMany.mockResolvedValue([]);
    await snapshotPreviousVersion(prismaMock, 'note-1', 'A'.repeat(200), 'T');
    expect(prismaMock.noteVersion.create).toHaveBeenCalled();
  });

  it('does not snapshot empty/short previous content', async () => {
    prismaMock.noteVersion.findFirst.mockResolvedValue(null);
    await snapshotPreviousVersion(prismaMock, 'note-1', 'x', 'T');
    expect(prismaMock.noteVersion.create).not.toHaveBeenCalled();
  });

  it('forces a snapshot even within the throttle window when options.force is true', async () => {
    prismaMock.noteVersion.findFirst.mockResolvedValue({ createdAt: new Date(NOW - 30_000) }); // 30s ago — within throttle
    prismaMock.noteVersion.findMany.mockResolvedValue([]);
    await snapshotPreviousVersion(prismaMock, 'note-1', 'A'.repeat(200), 'T', { force: true });
    expect(prismaMock.noteVersion.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.noteVersion.create).toHaveBeenCalled();
  });
});

describe('pruneNoteVersions', () => {
  it('deletes versions older than 30 days and beyond the 50 newest', async () => {
    prismaMock.noteVersion.findMany.mockResolvedValue([{ id: 'v50' }]);
    prismaMock.noteVersion.deleteMany.mockResolvedValue({ count: 1 });
    await pruneNoteVersions(prismaMock, 'note-1');
    // age-based delete (first call) targets this noteId
    expect(prismaMock.noteVersion.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ noteId: 'note-1' }) }),
    );
    // count-based delete (second call) removes ids beyond the newest 50
    expect(prismaMock.noteVersion.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['v50'] } } });
  });
});

import { listNoteVersions, restoreNoteVersion } from '../noteVersion.service';

describe('listNoteVersions', () => {
  it('returns versions for an owned note (newest first)', async () => {
    prismaMock.note.findFirst.mockResolvedValue({ id: 'note-1', userId: 'u1' });
    prismaMock.noteVersion.findMany.mockResolvedValue([
      { id: 'v2', title: 'B', content: 'c', createdAt: new Date(NOW) },
    ]);
    const out = await listNoteVersions('u1', 'note-1');
    expect(prismaMock.note.findFirst).toHaveBeenCalledWith({ where: { id: 'note-1', userId: 'u1' } });
    expect(out).toHaveLength(1);
  });

  it('throws when the note is not owned by the user', async () => {
    prismaMock.note.findFirst.mockResolvedValue(null);
    await expect(listNoteVersions('u1', 'note-1')).rejects.toThrow();
  });
});

describe('restoreNoteVersion', () => {
  beforeEach(() => {
    prismaMock.note.findFirst.mockReset();
    prismaMock.noteVersion.findUnique.mockReset();
    prismaMock.noteVersion.findFirst.mockReset();
    prismaMock.note.updateMany.mockReset();
  });

  it('snapshots current content, writes the version content back, and nulls ydocState', async () => {
    prismaMock.note.findFirst.mockResolvedValue({ id: 'note-1', userId: 'u1', content: 'C'.repeat(200), title: 'now', isEncrypted: false });
    prismaMock.noteVersion.findUnique.mockResolvedValue({ id: 'v1', noteId: 'note-1', content: 'D'.repeat(200), title: 'old' });
    prismaMock.noteVersion.findFirst.mockResolvedValue(null);
    prismaMock.noteVersion.findMany.mockResolvedValue([]);
    prismaMock.note.updateMany.mockResolvedValue({ count: 1 });
    await restoreNoteVersion('u1', 'note-1', 'v1');
    expect(prismaMock.note.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: 'D'.repeat(200), ydocState: null }),
    }));
  });

  it('writes conditionally (userId, isVault, isEncrypted from the read); count 0 -> 409 restoreConflict', async () => {
    prismaMock.note.findFirst.mockResolvedValue({ id: 'note-1', content: 'C'.repeat(200), title: 'now', isEncrypted: false, isVault: true });
    prismaMock.noteVersion.findUnique.mockResolvedValue({ id: 'v1', noteId: 'note-1', content: 'D'.repeat(200), title: 'old' });
    prismaMock.noteVersion.findFirst.mockResolvedValue(null);
    prismaMock.noteVersion.findMany.mockResolvedValue([]);
    prismaMock.vaultKeyring.findUnique.mockResolvedValue(null);
    prismaMock.note.updateMany.mockResolvedValue({ count: 0 });
    await expect(restoreNoteVersion('u1', 'note-1', 'v1'))
      .rejects.toMatchObject({ statusCode: 409, message: 'errors.notes.restoreConflict' });
    expect(prismaMock.note.updateMany.mock.calls[0][0].where)
      .toEqual({ id: 'note-1', userId: 'u1', isVault: true, isEncrypted: false });
  });

  it('writes searchText null for a vault note, but keeps it for a normal note', async () => {
    const tiptap = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'secret words' }] }] });
    prismaMock.noteVersion.findUnique.mockResolvedValue({ id: 'v1', noteId: 'note-1', content: tiptap, title: 'old' });
    prismaMock.noteVersion.findFirst.mockResolvedValue(null);
    prismaMock.noteVersion.findMany.mockResolvedValue([]);
    prismaMock.note.updateMany.mockResolvedValue({ count: 1 });

    prismaMock.note.findFirst.mockResolvedValue({ id: 'note-1', content: 'C'.repeat(200), title: 'now', isEncrypted: false, isVault: true });
    await restoreNoteVersion('u1', 'note-1', 'v1');
    expect(prismaMock.note.updateMany.mock.calls[0][0].data.searchText).toBeNull();

    prismaMock.note.findFirst.mockResolvedValue({ id: 'note-1', content: 'C'.repeat(200), title: 'now', isEncrypted: false, isVault: false });
    await restoreNoteVersion('u1', 'note-1', 'v1');
    expect(prismaMock.note.updateMany.mock.calls[1][0].data.searchText).toContain('secret words');
  });

  it('returns restoredContent for a plain note, null for vault/encrypted', async () => {
    prismaMock.noteVersion.findUnique.mockResolvedValue({ id: 'v1', noteId: 'note-1', content: 'D'.repeat(200), title: 'old' });
    prismaMock.noteVersion.findFirst.mockResolvedValue(null);
    prismaMock.noteVersion.findMany.mockResolvedValue([]);
    prismaMock.note.updateMany.mockResolvedValue({ count: 1 });
    const base = { id: 'note-1', content: 'C'.repeat(200), title: 'now' };

    prismaMock.note.findFirst.mockResolvedValue({ ...base, isEncrypted: false, isVault: false });
    expect(await restoreNoteVersion('u1', 'note-1', 'v1')).toEqual({ ok: true, restoredContent: 'D'.repeat(200) });

    prismaMock.note.findFirst.mockResolvedValue({ ...base, isEncrypted: true, isVault: false });
    expect((await restoreNoteVersion('u1', 'note-1', 'v1')).restoredContent).toBeNull();

    prismaMock.note.findFirst.mockResolvedValue({ ...base, isEncrypted: false, isVault: true });
    expect((await restoreNoteVersion('u1', 'note-1', 'v1')).restoredContent).toBeNull();
  });

  it('throws when the version does not belong to the note', async () => {
    prismaMock.note.findFirst.mockResolvedValue({ id: 'note-1', userId: 'u1', content: 'x', title: 't', isEncrypted: false });
    prismaMock.noteVersion.findUnique.mockResolvedValue({ id: 'v1', noteId: 'OTHER', content: 'y', title: 't' });
    await expect(restoreNoteVersion('u1', 'note-1', 'v1')).rejects.toThrow();
  });

  it('throws when the note is not owned by the user', async () => {
    prismaMock.note.findFirst.mockResolvedValue(null);
    await expect(restoreNoteVersion('u2', 'note-1', 'v1')).rejects.toThrow();
  });

  describe('beforeRestore hook', () => {
    const okNote = { id: 'note-1', content: 'C'.repeat(200), title: 'now', isEncrypted: false, isVault: false };
    const okVersion = { id: 'v1', noteId: 'note-1', content: 'D'.repeat(200), title: 'old' };

    it('runs once, after the checks, before the forced snapshot and the note update', async () => {
      prismaMock.note.findFirst.mockResolvedValue(okNote);
      prismaMock.noteVersion.findUnique.mockResolvedValue(okVersion);
      prismaMock.noteVersion.findMany.mockResolvedValue([]);
      prismaMock.noteVersion.create.mockReset();
      prismaMock.note.updateMany.mockResolvedValue({ count: 1 });
      const beforeRestore = vi.fn().mockResolvedValue(undefined);
      await restoreNoteVersion('u1', 'note-1', 'v1', { beforeRestore });
      expect(beforeRestore).toHaveBeenCalledTimes(1);
      const hookOrder = beforeRestore.mock.invocationCallOrder[0];
      expect(hookOrder).toBeGreaterThan(prismaMock.noteVersion.findUnique.mock.invocationCallOrder[0]);
      expect(hookOrder).toBeLessThan(prismaMock.noteVersion.create.mock.invocationCallOrder[0]);
      expect(hookOrder).toBeLessThan(prismaMock.note.updateMany.mock.invocationCallOrder[0]);
    });

    it('snapshots the content as re-read after the hook (flushed live edits)', async () => {
      prismaMock.note.findFirst
        .mockResolvedValueOnce(okNote)
        .mockResolvedValueOnce({ ...okNote, content: 'F'.repeat(200) });
      prismaMock.noteVersion.findUnique.mockResolvedValue(okVersion);
      prismaMock.noteVersion.findMany.mockResolvedValue([]);
      prismaMock.noteVersion.create.mockReset();
      prismaMock.note.updateMany.mockResolvedValue({ count: 1 });
      await restoreNoteVersion('u1', 'note-1', 'v1', { beforeRestore: async () => {} });
      expect(prismaMock.noteVersion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ content: 'F'.repeat(200) }),
      });
    });

    it('is NOT called when the note is not owned / not found', async () => {
      prismaMock.note.findFirst.mockResolvedValue(null);
      const beforeRestore = vi.fn();
      await expect(restoreNoteVersion('u2', 'note-1', 'v1', { beforeRestore })).rejects.toThrow();
      expect(beforeRestore).not.toHaveBeenCalled();
    });

    it('is NOT called when the version is not found', async () => {
      prismaMock.note.findFirst.mockResolvedValue(okNote);
      prismaMock.noteVersion.findUnique.mockResolvedValue(null);
      const beforeRestore = vi.fn();
      await expect(restoreNoteVersion('u1', 'note-1', 'v1', { beforeRestore })).rejects.toThrow();
      expect(beforeRestore).not.toHaveBeenCalled();
    });

    it('is NOT called when the vault guard rejects the version content', async () => {
      prismaMock.note.findFirst.mockResolvedValue({ ...okNote, isVault: true });
      prismaMock.noteVersion.findUnique.mockResolvedValue(okVersion); // plaintext, not an envelope
      prismaMock.vaultKeyring.findUnique.mockResolvedValue({ status: 'READY', epoch: 1 });
      const beforeRestore = vi.fn();
      await expect(restoreNoteVersion('u1', 'note-1', 'v1', { beforeRestore })).rejects.toThrow();
      expect(beforeRestore).not.toHaveBeenCalled();
    });

    it.each([
      ['isVault', { isVault: true }],
      ['isEncrypted', { isEncrypted: true }],
    ])('aborts with a conflict, writing nothing, when %s flips during the hook', async (_n, flip) => {
      prismaMock.note.findFirst
        .mockResolvedValueOnce(okNote)
        .mockResolvedValueOnce({ ...okNote, ...flip });
      prismaMock.noteVersion.findUnique.mockResolvedValue(okVersion);
      prismaMock.noteVersion.create.mockReset();
      prismaMock.note.updateMany.mockReset();
      await expect(restoreNoteVersion('u1', 'note-1', 'v1', { beforeRestore: async () => {} }))
        .rejects.toMatchObject({ statusCode: 409, message: 'errors.notes.restoreConflict' });
      expect(prismaMock.noteVersion.create).not.toHaveBeenCalled();
      expect(prismaMock.note.updateMany).not.toHaveBeenCalled();
    });

    it('works when opts is omitted', async () => {
      prismaMock.note.findFirst.mockResolvedValue(okNote);
      prismaMock.noteVersion.findUnique.mockResolvedValue(okVersion);
      prismaMock.noteVersion.findMany.mockResolvedValue([]);
      prismaMock.note.updateMany.mockResolvedValue({ count: 1 });
      await expect(restoreNoteVersion('u1', 'note-1', 'v1')).resolves.toEqual({ ok: true, restoredContent: 'D'.repeat(200) });
    });
  });
});
