import prisma from '../plugins/prisma';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { checkNoteAccess } from './note.service';

export const createTag = async (userId: string, name: string, isVault: boolean = false, id?: string) => {
  return prisma.tag.create({
    data: {
      id,
      name,
      userId,
      isVault,
    },
  });
};

export const getTags = async (userId: string, isVault?: boolean) => {
  return prisma.tag.findMany({
    where: {
      userId,
      isVault // If isVault is undefined, Prisma ignores this filter (returns all)
    },
    orderBy: { name: 'asc' },
    include: {
      _count: {
        select: {
          notes: {
            where: {
              userId,
              ...(isVault !== undefined ? { note: { isVault } } : {}),
            }
          }
        }
      }
    }
  });
};

export const updateTag = async (userId: string, id: string, data: { name?: string }) => {
  return prisma.tag.updateMany({
    where: { id, userId },
    data,
  });
};

export const deleteTag = async (userId: string, id: string) => {
  return prisma.tag.deleteMany({
    where: { id, userId },
  });
};

export const addTagToNote = async (userId: string, noteId: string, tagId: string) => {
  // Verify note access (owner or WRITE shared)
  const access = await checkNoteAccess(userId, noteId);
  if (!access || access === 'READ') throw new ForbiddenError('errors.tags.noWriteAccess');

  // Verify tag belongs to the requesting user
  const tag = await prisma.tag.findFirst({ where: { id: tagId, userId } });
  if (!tag) throw new NotFoundError('errors.tags.noteOrTagNotFound');

  return prisma.tagsOnNotes.upsert({
    where: {
      noteId_tagId_userId: { noteId, tagId, userId },
    },
    update: {},
    create: { noteId, tagId, userId },
  });
};

export const removeTagFromNote = async (userId: string, noteId: string, tagId: string) => {
  // Users can only remove their own tag associations
  return prisma.tagsOnNotes.deleteMany({
    where: { noteId, tagId, userId },
  });
};
