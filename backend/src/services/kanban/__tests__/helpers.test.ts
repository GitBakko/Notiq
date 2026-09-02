import { describe, it, expect, vi, beforeEach } from 'vitest';

import prisma from '../../../plugins/prisma';
import {
  cardWithAssigneeSelect,
  cardWithNoteSelect,
  accessibleNoteIds,
} from '../helpers';

const m = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

describe('kanban helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Select shapes ──────────────────────────────────────────
  //
  // These are the structural half of the B2 fix. The leak was not a missing
  // filter, it was a select that carried `note` into responses nobody filters.
  // Asserting on the real constants (this file does NOT mock ../helpers) is the
  // only place the guarantee is real: card.service.test.ts mocks the module and
  // would happily assert against its own copy.

  describe('cardWithAssigneeSelect', () => {
    it('does NOT select the linked note', () => {
      expect(cardWithAssigneeSelect).not.toHaveProperty('note');
    });

    it('still selects the noteId scalar, which every board reader may see', () => {
      // The UI keys its "linked note (no access)" fallback off this scalar, so
      // stripping it would break the fallback instead of the leak.
      expect(cardWithAssigneeSelect).toHaveProperty('noteId', true);
      expect(cardWithAssigneeSelect).toHaveProperty('noteLinkedById', true);
    });
  });

  describe('cardWithNoteSelect', () => {
    it('selects the linked note', () => {
      expect(cardWithNoteSelect).toHaveProperty('note');
    });

    it('is cardWithAssigneeSelect plus note, so the two cannot drift', () => {
      const { note, ...rest } = cardWithNoteSelect as Record<string, unknown>;
      expect(note).toBeDefined();
      expect(rest).toEqual(cardWithAssigneeSelect);
    });
  });

  // ─── accessibleNoteIds ──────────────────────────────────────

  describe('accessibleNoteIds', () => {
    it('returns notes shared with the user as ACCEPTED', async () => {
      m(prisma.sharedNote.findMany).mockResolvedValue([{ noteId: 'note-shared' }] as never);
      m(prisma.note.findMany).mockResolvedValue([] as never);

      const result = await accessibleNoteIds(['note-shared'], 'user-1');

      expect(result.has('note-shared')).toBe(true);
    });

    it('returns notes owned by the user', async () => {
      m(prisma.sharedNote.findMany).mockResolvedValue([] as never);
      m(prisma.note.findMany).mockResolvedValue([{ id: 'note-owned' }] as never);

      const result = await accessibleNoteIds(['note-owned'], 'user-1');

      expect(result.has('note-owned')).toBe(true);
    });

    it('only accepts ACCEPTED shares — a PENDING share is not access', async () => {
      // PENDING is the MAJORITY of SharedNote rows in the dev database (53 of 72),
      // so a query without the status filter would read as "works" on most data.
      m(prisma.sharedNote.findMany).mockResolvedValue([] as never);
      m(prisma.note.findMany).mockResolvedValue([] as never);

      await accessibleNoteIds(['note-1'], 'user-1');

      expect(prisma.sharedNote.findMany).toHaveBeenCalledWith({
        where: { noteId: { in: ['note-1'] }, userId: 'user-1', status: 'ACCEPTED' },
        select: { noteId: true },
      });
    });

    it('scopes the ownership lookup to the requesting user', async () => {
      m(prisma.sharedNote.findMany).mockResolvedValue([] as never);
      m(prisma.note.findMany).mockResolvedValue([] as never);

      await accessibleNoteIds(['note-1'], 'user-1');

      expect(prisma.note.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['note-1'] }, userId: 'user-1' },
        select: { id: true },
      });
    });

    it('does not return a note the user neither owns nor has an accepted share on', async () => {
      m(prisma.sharedNote.findMany).mockResolvedValue([] as never);
      m(prisma.note.findMany).mockResolvedValue([] as never);

      const result = await accessibleNoteIds(['note-secret'], 'user-1');

      expect(result.has('note-secret')).toBe(false);
      expect(result.size).toBe(0);
    });

    it('deduplicates the input before querying', async () => {
      m(prisma.sharedNote.findMany).mockResolvedValue([] as never);
      m(prisma.note.findMany).mockResolvedValue([] as never);

      await accessibleNoteIds(['note-1', 'note-1', 'note-2'], 'user-1');

      expect(prisma.sharedNote.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ noteId: { in: ['note-1', 'note-2'] } }),
        })
      );
    });

    it('refuses to run without a userId instead of failing open', async () => {
      // Prisma DROPS a `where` key whose value is undefined, so
      // `{ id: { in: ids }, userId: undefined }` returns EVERY note in the table and
      // this helper would answer "all accessible". Verified against the dev database:
      // 3 notes in, 3 out. Callers reach it through an optional parameter, so the
      // guard is the thing that makes the class impossible rather than unlikely.
      await expect(
        accessibleNoteIds(['note-1'], undefined as unknown as string)
      ).rejects.toThrow();

      expect(prisma.note.findMany).not.toHaveBeenCalled();
      expect(prisma.sharedNote.findMany).not.toHaveBeenCalled();
    });

    it('issues no query at all for an empty id list', async () => {
      const result = await accessibleNoteIds([], 'user-1');

      expect(result.size).toBe(0);
      expect(prisma.sharedNote.findMany).not.toHaveBeenCalled();
      expect(prisma.note.findMany).not.toHaveBeenCalled();
    });
  });
});
