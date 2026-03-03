import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';
import { makeTag, makeNote } from '../../__tests__/factories';
import {
  createTag,
  getTags,
  updateTag,
  deleteTag,
  addTagToNote,
  removeTagFromNote,
} from '../tag.service';
import { NotFoundError } from '../../utils/errors';

const prismaMock = prisma as any;

// setup.ts does not include tag.updateMany or tag.deleteMany — add them here
prismaMock.tag.updateMany = vi.fn();
prismaMock.tag.deleteMany = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// createTag
// ---------------------------------------------------------------------------
describe('createTag', () => {
  it('creates a tag with the given name and userId', async () => {
    const tag = makeTag({ name: 'work', userId: 'user-1' });
    prismaMock.tag.create.mockResolvedValue(tag);

    const result = await createTag('user-1', 'work');

    expect(prismaMock.tag.create).toHaveBeenCalledWith({
      data: {
        id: undefined,
        name: 'work',
        userId: 'user-1',
        isVault: false,
      },
    });
    expect(result).toEqual(tag);
  });

  it('creates a vault tag when isVault is true', async () => {
    const tag = makeTag({ name: 'secret', userId: 'user-1', isVault: true });
    prismaMock.tag.create.mockResolvedValue(tag);

    const result = await createTag('user-1', 'secret', true);

    expect(prismaMock.tag.create).toHaveBeenCalledWith({
      data: {
        id: undefined,
        name: 'secret',
        userId: 'user-1',
        isVault: true,
      },
    });
    expect(result).toEqual(tag);
  });

  it('uses the provided id when given', async () => {
    const tag = makeTag({ id: 'custom-id', name: 'travel', userId: 'user-1' });
    prismaMock.tag.create.mockResolvedValue(tag);

    const result = await createTag('user-1', 'travel', false, 'custom-id');

    expect(prismaMock.tag.create).toHaveBeenCalledWith({
      data: {
        id: 'custom-id',
        name: 'travel',
        userId: 'user-1',
        isVault: false,
      },
    });
    expect(result).toEqual(tag);
  });

  it('defaults isVault to false when not specified', async () => {
    prismaMock.tag.create.mockResolvedValue(makeTag());

    await createTag('user-1', 'default-tag');

    expect(prismaMock.tag.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ isVault: false }),
    });
  });
});

// ---------------------------------------------------------------------------
// getTags
// ---------------------------------------------------------------------------
describe('getTags', () => {
  it('returns all tags for a user ordered by name', async () => {
    const tags = [
      makeTag({ name: 'alpha', userId: 'user-1' }),
      makeTag({ name: 'beta', userId: 'user-1' }),
    ];
    prismaMock.tag.findMany.mockResolvedValue(tags);

    const result = await getTags('user-1');

    expect(prismaMock.tag.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', isVault: undefined },
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: {
            notes: {
              where: { note: { isVault: undefined } },
            },
          },
        },
      },
    });
    expect(result).toEqual(tags);
  });

  it('filters by isVault when provided as true', async () => {
    prismaMock.tag.findMany.mockResolvedValue([]);

    await getTags('user-1', true);

    expect(prismaMock.tag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', isVault: true },
      }),
    );
  });

  it('filters by isVault when provided as false', async () => {
    prismaMock.tag.findMany.mockResolvedValue([]);

    await getTags('user-1', false);

    expect(prismaMock.tag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', isVault: false },
      }),
    );
  });

  it('returns empty array when user has no tags', async () => {
    prismaMock.tag.findMany.mockResolvedValue([]);

    const result = await getTags('user-1');

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// updateTag
// ---------------------------------------------------------------------------
describe('updateTag', () => {
  it('updates the tag name scoped to the user', async () => {
    prismaMock.tag.updateMany.mockResolvedValue({ count: 1 });

    const result = await updateTag('user-1', 'tag-1', { name: 'renamed' });

    expect(prismaMock.tag.updateMany).toHaveBeenCalledWith({
      where: { id: 'tag-1', userId: 'user-1' },
      data: { name: 'renamed' },
    });
    expect(result).toEqual({ count: 1 });
  });

  it('returns count 0 when tag does not belong to user', async () => {
    prismaMock.tag.updateMany.mockResolvedValue({ count: 0 });

    const result = await updateTag('stranger', 'tag-1', { name: 'hack' });

    expect(result).toEqual({ count: 0 });
  });

  it('passes through empty data object', async () => {
    prismaMock.tag.updateMany.mockResolvedValue({ count: 1 });

    await updateTag('user-1', 'tag-1', {});

    expect(prismaMock.tag.updateMany).toHaveBeenCalledWith({
      where: { id: 'tag-1', userId: 'user-1' },
      data: {},
    });
  });
});

// ---------------------------------------------------------------------------
// deleteTag
// ---------------------------------------------------------------------------
describe('deleteTag', () => {
  it('deletes the tag scoped to the user', async () => {
    prismaMock.tag.deleteMany.mockResolvedValue({ count: 1 });

    const result = await deleteTag('user-1', 'tag-1');

    expect(prismaMock.tag.deleteMany).toHaveBeenCalledWith({
      where: { id: 'tag-1', userId: 'user-1' },
    });
    expect(result).toEqual({ count: 1 });
  });

  it('returns count 0 when tag does not belong to user', async () => {
    prismaMock.tag.deleteMany.mockResolvedValue({ count: 0 });

    const result = await deleteTag('stranger', 'tag-1');

    expect(result).toEqual({ count: 0 });
  });
});

// ---------------------------------------------------------------------------
// addTagToNote
// ---------------------------------------------------------------------------
describe('addTagToNote', () => {
  it('creates a tagsOnNotes record when note and tag belong to the user', async () => {
    const note = makeNote({ id: 'note-1', userId: 'user-1' });
    const tag = makeTag({ id: 'tag-1', userId: 'user-1' });
    prismaMock.note.findFirst.mockResolvedValue(note);
    prismaMock.tag.findFirst.mockResolvedValue(tag);
    prismaMock.tagsOnNotes.create.mockResolvedValue({ noteId: 'note-1', tagId: 'tag-1' });

    const result = await addTagToNote('user-1', 'note-1', 'tag-1');

    expect(prismaMock.note.findFirst).toHaveBeenCalledWith({
      where: { id: 'note-1', userId: 'user-1' },
    });
    expect(prismaMock.tag.findFirst).toHaveBeenCalledWith({
      where: { id: 'tag-1', userId: 'user-1' },
    });
    expect(prismaMock.tagsOnNotes.create).toHaveBeenCalledWith({
      data: { noteId: 'note-1', tagId: 'tag-1' },
    });
    expect(result).toEqual({ noteId: 'note-1', tagId: 'tag-1' });
  });

  it('throws NotFoundError when note does not belong to user', async () => {
    prismaMock.note.findFirst.mockResolvedValue(null);
    prismaMock.tag.findFirst.mockResolvedValue(makeTag({ id: 'tag-1', userId: 'user-1' }));

    await expect(addTagToNote('user-1', 'note-1', 'tag-1'))
      .rejects.toThrow(NotFoundError);
    await expect(addTagToNote('user-1', 'note-1', 'tag-1'))
      .rejects.toThrow('errors.tags.noteOrTagNotFound');
  });

  it('throws NotFoundError when tag does not belong to user', async () => {
    prismaMock.note.findFirst.mockResolvedValue(makeNote({ id: 'note-1', userId: 'user-1' }));
    prismaMock.tag.findFirst.mockResolvedValue(null);

    await expect(addTagToNote('user-1', 'note-1', 'tag-1'))
      .rejects.toThrow(NotFoundError);
    await expect(addTagToNote('user-1', 'note-1', 'tag-1'))
      .rejects.toThrow('errors.tags.noteOrTagNotFound');
  });

  it('throws NotFoundError when both note and tag are missing', async () => {
    prismaMock.note.findFirst.mockResolvedValue(null);
    prismaMock.tag.findFirst.mockResolvedValue(null);

    await expect(addTagToNote('user-1', 'note-1', 'tag-1'))
      .rejects.toThrow('errors.tags.noteOrTagNotFound');
  });

  it('does not create tagsOnNotes when ownership check fails', async () => {
    prismaMock.note.findFirst.mockResolvedValue(null);
    prismaMock.tag.findFirst.mockResolvedValue(null);

    await expect(addTagToNote('user-1', 'note-1', 'tag-1')).rejects.toThrow();

    expect(prismaMock.tagsOnNotes.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// removeTagFromNote
// ---------------------------------------------------------------------------
describe('removeTagFromNote', () => {
  it('deletes the tagsOnNotes record scoped to the note owner', async () => {
    prismaMock.tagsOnNotes.deleteMany.mockResolvedValue({ count: 1 });

    const result = await removeTagFromNote('user-1', 'note-1', 'tag-1');

    expect(prismaMock.tagsOnNotes.deleteMany).toHaveBeenCalledWith({
      where: {
        noteId: 'note-1',
        tagId: 'tag-1',
        note: { userId: 'user-1' },
      },
    });
    expect(result).toEqual({ count: 1 });
  });

  it('returns count 0 when the note does not belong to the user', async () => {
    prismaMock.tagsOnNotes.deleteMany.mockResolvedValue({ count: 0 });

    const result = await removeTagFromNote('stranger', 'note-1', 'tag-1');

    expect(result).toEqual({ count: 0 });
  });

  it('returns count 0 when the tag-note association does not exist', async () => {
    prismaMock.tagsOnNotes.deleteMany.mockResolvedValue({ count: 0 });

    const result = await removeTagFromNote('user-1', 'note-1', 'nonexistent-tag');

    expect(result).toEqual({ count: 0 });
  });
});
