import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';
import { snapshotPreviousVersion, pruneNoteVersions } from '../noteVersion.service';
import { rebaseYdocState, contentToYNodes } from '../../utils/ydoc';

const liveDocs = vi.hoisted(() => new Set<string>());
vi.mock('../../hocuspocus', () => ({
  hocuspocus: { hocuspocus: { documents: liveDocs, loadingDocuments: new Set<string>() } },
}));
vi.mock('../../utils/ydoc', () => ({
  rebaseYdocState: vi.fn(() => null),
  contentToYNodes: vi.fn(() => [{}]),
}));

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

import { listNoteVersions, restoreNoteVersion, archiveRestWriteWhileLive, __restArchiveSizeForTests } from '../noteVersion.service';

describe('archiveRestWriteWhileLive', () => {
  const doc = (t: string) => JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
  let n = 0;
  let id: string; // fresh noteId per test: the coalescing map is module-level
  beforeEach(() => {
    id = `note-live-${++n}`;
    prismaMock.noteVersion.findFirst.mockResolvedValue(null);
    prismaMock.noteVersion.findMany.mockResolvedValue([]);
    prismaMock.noteVersion.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.noteVersion.create.mockResolvedValue({ id: 'v1' });
    prismaMock.noteVersion.findUnique.mockReset();
    prismaMock.noteVersion.update.mockReset();
  });

  it('first call creates (short content allowed) and prunes', async () => {
    await archiveRestWriteWhileLive(id, doc('hi'), 'T', 'u1');
    expect(prismaMock.noteVersion.create).toHaveBeenCalledWith({ data: { noteId: id, content: doc('hi'), title: 'T' } });
    expect(prismaMock.noteVersion.deleteMany).toHaveBeenCalled(); // prune ran
  });

  it('returns archived / identical / skipped', async () => {
    expect(await archiveRestWriteWhileLive(id, doc('a'), 'T', 'u1', 's1')).toBe('archived');
    prismaMock.noteVersion.findFirst.mockResolvedValue({ content: doc('a') });
    expect(await archiveRestWriteWhileLive(id, doc('a'), 'T', 'u1', 's1')).toBe('identical');
    expect(await archiveRestWriteWhileLive(id, '', 'T', 'u1', 's1')).toBe('skipped');
    expect(await archiveRestWriteWhileLive(id, 'not json', 'T', 'u1', 's1')).toBe('skipped');
    expect(await archiveRestWriteWhileLive(id, '{"type":"doc","content":[]}', 'T', 'u1', 's1')).toBe('skipped');
  });

  it('same user, different session within the window -> retryable 503, the other session version is NOT overwritten', async () => {
    await archiveRestWriteWhileLive(id, doc('a'), 'T', 'u1', 'iat-1');
    prismaMock.noteVersion.findUnique.mockResolvedValue({ id: 'v1' });
    await expect(archiveRestWriteWhileLive(id, doc('b'), 'T', 'u1', 'iat-2'))
      .rejects.toMatchObject({ statusCode: 503, message: 'errors.notes.archiveBusy' });
    expect(prismaMock.noteVersion.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.noteVersion.update).not.toHaveBeenCalled();
  });

  it('no sessionKey and a create already in the window -> 503 (never coalesces, never creates a second)', async () => {
    await archiveRestWriteWhileLive(id, doc('a'), 'T', 'u1');
    prismaMock.noteVersion.findUnique.mockResolvedValue({ id: 'v1' });
    await expect(archiveRestWriteWhileLive(id, doc('b'), 'T', 'u1')).rejects.toMatchObject({ statusCode: 503 });
    expect(prismaMock.noteVersion.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.noteVersion.update).not.toHaveBeenCalled();
  });

  it('second call within the window (same session) updates the same version', async () => {
    await archiveRestWriteWhileLive(id, doc('a'), 'T', 'u1', 's1');
    prismaMock.noteVersion.findUnique.mockResolvedValue({ id: 'v1' });
    await archiveRestWriteWhileLive(id, doc('b'), 'T2', 'u1', 's1');
    expect(prismaMock.noteVersion.create).toHaveBeenCalledTimes(1);
    // createdAt is bumped so the history shows the latest write, but `prev.at` stays anchored to the first write
    expect(prismaMock.noteVersion.update).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { content: doc('b'), title: 'T2', createdAt: expect.any(Date) } });
  });

  it('two different writers on the same note within the window -> two versions (no overwrite)', async () => {
    await archiveRestWriteWhileLive(id, doc('a'), 'T', 'u1', 's1');
    prismaMock.noteVersion.findUnique.mockResolvedValue({ id: 'v1' });
    await archiveRestWriteWhileLive(id, doc('b'), 'T', 'u2', 's1');
    expect(prismaMock.noteVersion.create).toHaveBeenCalledTimes(2);
    expect(prismaMock.noteVersion.update).not.toHaveBeenCalled();
  });

  it('evicts expired coalescing entries (the map does not grow without bound)', async () => {
    await archiveRestWriteWhileLive(`${id}-a`, doc('a'), 'T', 'u1', 's1');
    await archiveRestWriteWhileLive(`${id}-b`, doc('b'), 'T', 'u1', 's1');
    expect(__restArchiveSizeForTests()).toBeGreaterThanOrEqual(2);
    (Date.now as any).mockReturnValue(NOW + 10 * 60_000);
    await archiveRestWriteWhileLive(`${id}-c`, doc('c'), 'T', 'u1', 's1');
    expect(__restArchiveSizeForTests()).toBe(1);
  });

  it('after the window creates a new version', async () => {
    await archiveRestWriteWhileLive(id, doc('a'), 'T', 'u1', 's1');
    prismaMock.noteVersion.findUnique.mockResolvedValue({ id: 'v1' });
    (Date.now as any).mockReturnValue(NOW + 3 * 60_000);
    await archiveRestWriteWhileLive(id, doc('b'), 'T', 'u1', 's1');
    expect(prismaMock.noteVersion.create).toHaveBeenCalledTimes(2);
    expect(prismaMock.noteVersion.update).not.toHaveBeenCalled();
  });

  it('deleted version row within the window -> creates', async () => {
    await archiveRestWriteWhileLive(id, doc('a'), 'T', 'u1', 's1');
    prismaMock.noteVersion.findUnique.mockResolvedValue(null);
    await archiveRestWriteWhileLive(id, doc('b'), 'T', 'u1', 's1');
    expect(prismaMock.noteVersion.create).toHaveBeenCalledTimes(2);
    expect(prismaMock.noteVersion.update).not.toHaveBeenCalled();
  });

  it('identical latest content -> no-op', async () => {
    prismaMock.noteVersion.findFirst.mockResolvedValue({ content: doc('a') });
    await archiveRestWriteWhileLive(id, doc('a'), 'T', 'u1');
    expect(prismaMock.noteVersion.create).not.toHaveBeenCalled();
    expect(prismaMock.noteVersion.update).not.toHaveBeenCalled();
  });

  it('degenerate content is skipped', async () => {
    await archiveRestWriteWhileLive(id, '{"type":"doc","content":[]}', 'T', 'u1');
    await archiveRestWriteWhileLive(id, '', 'T', 'u1');
    expect(prismaMock.noteVersion.create).not.toHaveBeenCalled();
  });

  describe('H1: per (note, user) create cap inside the window', () => {
    let seq: number;
    beforeEach(() => {
      seq = 0;
      prismaMock.noteVersion.create.mockImplementation(async () => ({ id: `v${++seq}` }));
      prismaMock.noteVersion.findUnique.mockImplementation(async ({ where }: any) => ({ id: where.id }));
    });

    const attempt = async (u: string, s: string | undefined, text: string) => {
      try { await archiveRestWriteWhileLive(id, doc(text), 'T', u, s); return 'ok'; } catch (e: any) { return e.statusCode; }
    };

    it('60 PUTs with a different sessionKey each -> exactly 1 create, 1 ok, 59 x 503, no update', async () => {
      const out: any[] = [];
      for (let i = 0; i < 60; i++) out.push(await attempt('u1', `jti-${i}`, `t${i}`));
      expect(prismaMock.noteVersion.create).toHaveBeenCalledTimes(1);
      expect(prismaMock.noteVersion.update).not.toHaveBeenCalled();
      expect(out.filter((o) => o === 'ok')).toHaveLength(1);
      expect(out.filter((o) => o === 503)).toHaveLength(59);
    });

    it('same session after its create -> coalescing update, never a second create', async () => {
      expect(await attempt('u1', 's1', 'a')).toBe('ok');
      expect(await attempt('u1', 's1', 'b')).toBe('ok');
      expect(await attempt('u1', 's1', 'c')).toBe('ok');
      expect(prismaMock.noteVersion.create).toHaveBeenCalledTimes(1);
      expect(prismaMock.noteVersion.update).toHaveBeenCalledTimes(2);
      expect(prismaMock.noteVersion.update.mock.calls.every((c: any) => c[0].where.id === 'v1')).toBe(true);
    });

    it('J2: two concurrent calls from different sessions -> 1 create + 1 x 503', async () => {
      const out = await Promise.all([attempt('u1', 'sA', 'a'), attempt('u1', 'sB', 'b')]);
      expect(prismaMock.noteVersion.create).toHaveBeenCalledTimes(1);
      expect(out.filter((o) => o === 'ok')).toHaveLength(1);
      expect(out.filter((o) => o === 503)).toHaveLength(1);
    });

    it('J2: a failed create releases the placeholder so a retry can create', async () => {
      prismaMock.noteVersion.create.mockRejectedValueOnce(new Error('db down'));
      await expect(archiveRestWriteWhileLive(id, doc('a'), 'T', 'u1', 'sA')).rejects.toThrow('db down');
      expect(await attempt('u1', 'sB', 'b')).toBe('ok');
      expect(prismaMock.noteVersion.create).toHaveBeenCalledTimes(2);
    });

    it('no sessionKey is capped too (1 create, rest 503)', async () => {
      const out: any[] = [];
      for (let i = 0; i < 10; i++) out.push(await attempt('u1', undefined, `t${i}`));
      expect(prismaMock.noteVersion.create).toHaveBeenCalledTimes(1);
      expect(out.filter((o) => o === 503)).toHaveLength(9);
    });

    it('after the window -> create again', async () => {
      for (let i = 0; i < 5; i++) await attempt('u1', `s${i}`, `t${i}`);
      expect(prismaMock.noteVersion.create).toHaveBeenCalledTimes(1);
      (Date.now as any).mockReturnValue(NOW + 3 * 60_000);
      expect(await attempt('u1', 'sX', 'late')).toBe('ok');
      expect(prismaMock.noteVersion.create).toHaveBeenCalledTimes(2);
    });

    it('different users are independent', async () => {
      for (let i = 0; i < 5; i++) await attempt('u1', `s${i}`, `a${i}`);
      for (let i = 0; i < 5; i++) await attempt('u2', `s${i}`, `b${i}`);
      expect(prismaMock.noteVersion.create).toHaveBeenCalledTimes(2);
    });

    it('a version row pruned inside the window frees the slot (next write creates, no 503)', async () => {
      expect(await attempt('u1', 's1', 'a')).toBe('ok');
      prismaMock.noteVersion.findUnique.mockResolvedValue(null);
      expect(await attempt('u1', 's1', 'b')).toBe('ok');
      expect(prismaMock.noteVersion.create).toHaveBeenCalledTimes(2);
    });

    it('expired entries are evicted also when the call takes the update branch', async () => {
      (Date.now as any).mockReturnValue(NOW + 30 * 60_000); // past every entry left by earlier tests
      await archiveRestWriteWhileLive(`${id}-x`, doc('x'), 'T', 'u1', 's1');
      (Date.now as any).mockReturnValue(NOW + 30 * 60_000 + 100_000);
      await archiveRestWriteWhileLive(id, doc('a'), 'T', 'u1', 's1');
      expect(__restArchiveSizeForTests()).toBe(2);
      (Date.now as any).mockReturnValue(NOW + 30 * 60_000 + 110_000);
      await archiveRestWriteWhileLive(id, doc('b'), 'T', 'u1', 's1'); // same session in window -> update branch
      expect(prismaMock.noteVersion.update).toHaveBeenCalledTimes(1);
      (Date.now as any).mockReturnValue(NOW + 30 * 60_000 + 125_000); // only `${id}-x` expired
      await archiveRestWriteWhileLive(id, doc('c'), 'T', 'u1', 's1'); // session entry (+100s) still valid -> update
      expect(prismaMock.noteVersion.update).toHaveBeenCalledTimes(2);
      expect(__restArchiveSizeForTests()).toBe(1);
    });
  });
});

describe('restoreNoteVersion H5: live doc + unconvertible version', () => {
  const setup = () => {
    prismaMock.note.findFirst.mockReset();
    prismaMock.noteVersion.findUnique.mockReset();
    prismaMock.noteVersion.findFirst.mockReset();
    prismaMock.noteVersion.findMany.mockResolvedValue([]);
    prismaMock.note.updateMany.mockReset();
    prismaMock.note.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.noteVersion.findFirst.mockResolvedValue(null);
    prismaMock.note.findFirst.mockResolvedValue({ id: 'n1', content: 'C'.repeat(200), title: 't', isEncrypted: false, isVault: false, ydocState: null });
    prismaMock.noteVersion.findUnique.mockResolvedValue({ id: 'v1', noteId: 'n1', content: 'D'.repeat(200), title: 'old' });
  };

  it.each([null, []])('live doc and contentToYNodes -> %j: 422 restoreUnsupportedLive, nothing written', async (conv) => {
    setup();
    (contentToYNodes as any).mockReturnValueOnce(conv);
    liveDocs.add('n1');
    try {
      await expect(restoreNoteVersion('u1', 'n1', 'v1')).rejects.toMatchObject({ statusCode: 422, message: 'errors.notes.restoreUnsupportedLive' });
      expect(prismaMock.note.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.noteVersion.create).not.toHaveBeenCalled(); // refused BEFORE the forced snapshot
    } finally {
      liveDocs.delete('n1');
    }
  });

  it('no live doc -> restore proceeds even if the content does not convert', async () => {
    setup();
    (contentToYNodes as any).mockReturnValue(null);
    await expect(restoreNoteVersion('u1', 'n1', 'v1')).resolves.toMatchObject({ ok: true });
    (contentToYNodes as any).mockReturnValue([{}]);
  });
});

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

  it('G7: a successful restore clears the coalescing entries of the note (next live archive creates, not updates)', async () => {
    const d = (t: string) => JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
    prismaMock.noteVersion.findFirst.mockResolvedValue(null);
    prismaMock.noteVersion.findMany.mockResolvedValue([]);
    prismaMock.noteVersion.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.noteVersion.create.mockReset();
    prismaMock.noteVersion.create.mockResolvedValue({ id: 'vA' });
    prismaMock.noteVersion.update.mockReset();
    await archiveRestWriteWhileLive('note-g7', d('a'), 'T', 'u1', 's1');
    expect(__restArchiveSizeForTests()).toBeGreaterThanOrEqual(1);

    prismaMock.note.findFirst.mockResolvedValue({ id: 'note-g7', content: 'C'.repeat(200), title: 'now', isEncrypted: false, isVault: false, ydocState: null });
    prismaMock.noteVersion.findUnique.mockResolvedValue({ id: 'v1', noteId: 'note-g7', content: 'D'.repeat(200), title: 'old' });
    prismaMock.note.updateMany.mockResolvedValue({ count: 1 });
    await restoreNoteVersion('u1', 'note-g7', 'v1');

    prismaMock.noteVersion.findUnique.mockResolvedValue({ id: 'vA' });
    prismaMock.noteVersion.create.mockClear();
    await archiveRestWriteWhileLive('note-g7', d('b'), 'T', 'u1', 's1');
    expect(prismaMock.noteVersion.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.noteVersion.update).not.toHaveBeenCalled();
  });

  it('plain note: ydocState = rebase of the stored state onto the restored content (and the read selects ydocState)', async () => {
    const stored = Buffer.from([1, 2, 3]);
    const rebased = Buffer.from([4, 5]);
    (rebaseYdocState as any).mockClear();
    (rebaseYdocState as any).mockReturnValueOnce(rebased);
    prismaMock.note.findFirst.mockResolvedValue({ id: 'note-1', content: 'C'.repeat(200), title: 'now', isEncrypted: false, isVault: false, ydocState: stored });
    prismaMock.noteVersion.findUnique.mockResolvedValue({ id: 'v1', noteId: 'note-1', content: 'D'.repeat(200), title: 'old' });
    prismaMock.noteVersion.findFirst.mockResolvedValue(null);
    prismaMock.noteVersion.findMany.mockResolvedValue([]);
    prismaMock.note.updateMany.mockResolvedValue({ count: 1 });

    await restoreNoteVersion('u1', 'note-1', 'v1');

    expect(rebaseYdocState).toHaveBeenCalledWith(stored, 'D'.repeat(200));
    expect(prismaMock.note.updateMany.mock.calls[0][0].data.ydocState).toBe(rebased);
    expect(prismaMock.note.findFirst.mock.calls[0][0].select).toMatchObject({ ydocState: true });
  });

  it('vault / encrypted note: ydocState null, rebase not called', async () => {
    prismaMock.noteVersion.findUnique.mockResolvedValue({ id: 'v1', noteId: 'note-1', content: 'D'.repeat(200), title: 'old' });
    prismaMock.noteVersion.findFirst.mockResolvedValue(null);
    prismaMock.noteVersion.findMany.mockResolvedValue([]);
    prismaMock.vaultKeyring.findUnique.mockResolvedValue(null);
    prismaMock.note.updateMany.mockResolvedValue({ count: 1 });
    (rebaseYdocState as any).mockClear();
    (rebaseYdocState as any).mockReturnValue(Buffer.from([9]));

    prismaMock.note.findFirst.mockResolvedValue({ id: 'note-1', content: 'C'.repeat(200), title: 'now', isEncrypted: false, isVault: true, ydocState: Buffer.from([1]) });
    await restoreNoteVersion('u1', 'note-1', 'v1');
    prismaMock.note.findFirst.mockResolvedValue({ id: 'note-1', content: 'C'.repeat(200), title: 'now', isEncrypted: true, isVault: false, ydocState: Buffer.from([1]) });
    await restoreNoteVersion('u1', 'note-1', 'v1');

    expect(rebaseYdocState).not.toHaveBeenCalled();
    expect(prismaMock.note.updateMany.mock.calls[0][0].data.ydocState).toBeNull();
    expect(prismaMock.note.updateMany.mock.calls[1][0].data.ydocState).toBeNull();
    (rebaseYdocState as any).mockReturnValue(null);
  });

  it('CREDENTIAL note: ydocState null, rebase not called (and noteType is selected)', async () => {
    prismaMock.noteVersion.findUnique.mockResolvedValue({ id: 'v1', noteId: 'note-1', content: 'D'.repeat(200), title: 'old' });
    prismaMock.noteVersion.findFirst.mockResolvedValue(null);
    prismaMock.noteVersion.findMany.mockResolvedValue([]);
    prismaMock.note.updateMany.mockResolvedValue({ count: 1 });
    (rebaseYdocState as any).mockClear();
    (rebaseYdocState as any).mockReturnValue(Buffer.from([9]));
    prismaMock.note.findFirst.mockReset();
    prismaMock.note.findFirst.mockResolvedValue({ id: 'note-1', content: 'C'.repeat(200), title: 'now', isEncrypted: false, isVault: false, noteType: 'CREDENTIAL', ydocState: Buffer.from([1]) });
    await restoreNoteVersion('u1', 'note-1', 'v1');
    expect(rebaseYdocState).not.toHaveBeenCalled();
    expect(prismaMock.note.updateMany.mock.calls[0][0].data.ydocState).toBeNull();
    expect(prismaMock.note.findFirst.mock.calls[0][0].select).toMatchObject({ noteType: true });
    (rebaseYdocState as any).mockReturnValue(null);
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

    it('rebases onto the ydocState as re-read after the hook, not the pre-hook one', async () => {
      const before = Buffer.from([1]);
      const after = Buffer.from([2, 2]);
      (rebaseYdocState as any).mockClear();
      prismaMock.note.findFirst
        .mockResolvedValueOnce({ ...okNote, ydocState: before })
        .mockResolvedValueOnce({ ...okNote, ydocState: after });
      prismaMock.noteVersion.findUnique.mockResolvedValue(okVersion);
      prismaMock.noteVersion.findMany.mockResolvedValue([]);
      prismaMock.note.updateMany.mockResolvedValue({ count: 1 });
      await restoreNoteVersion('u1', 'note-1', 'v1', { beforeRestore: async () => {} });
      expect(rebaseYdocState).toHaveBeenCalledTimes(1);
      expect(rebaseYdocState).toHaveBeenCalledWith(after, okVersion.content);
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
