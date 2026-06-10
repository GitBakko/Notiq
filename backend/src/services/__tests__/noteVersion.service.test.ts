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
    prismaMock.note.update.mockReset();
  });

  it('snapshots current content, writes the version content back, and nulls ydocState', async () => {
    prismaMock.note.findFirst.mockResolvedValue({ id: 'note-1', userId: 'u1', content: 'C'.repeat(200), title: 'now', isEncrypted: false });
    prismaMock.noteVersion.findUnique.mockResolvedValue({ id: 'v1', noteId: 'note-1', content: 'D'.repeat(200), title: 'old' });
    prismaMock.noteVersion.findFirst.mockResolvedValue(null);
    prismaMock.noteVersion.findMany.mockResolvedValue([]);
    prismaMock.note.update.mockResolvedValue({});
    await restoreNoteVersion('u1', 'note-1', 'v1');
    expect(prismaMock.note.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: 'D'.repeat(200), ydocState: null }),
    }));
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
});
