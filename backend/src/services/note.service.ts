import prisma from '../plugins/prisma';
import { hocuspocus, extensions } from '../hocuspocus';
import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import { v4 as uuidv4 } from 'uuid';

export const createNote = async (
  userId: string,
  notebookId: string,
  title: string,
  content: string = '',
  id?: string,
  isVault: boolean = false,
  isEncrypted: boolean = false
) => {
  return prisma.note.create({
    data: {
      ...(id ? { id } : {}),
      title,
      content,
      userId,
      notebookId,
      isVault,
      isEncrypted,
    },
  });
};

export const getNotes = async (userId: string, notebookId?: string, search?: string, tagId?: string, reminderFilter?: 'all' | 'pending' | 'done', includeTrashed: boolean = false) => {
  const whereClause = {
    userId,
    ...(notebookId ? { notebookId } : {}),
    ...(tagId ? { tags: { some: { tagId } } } : {}),
    ...(search ? {
      OR: [
        { title: { contains: search } },
        { content: { contains: search } },
      ]
    } : {}),
    ...(reminderFilter ? {
      reminderDate: { not: null },
      ...(reminderFilter === 'pending' ? { isReminderDone: false } : {}),
      ...(reminderFilter === 'done' ? { isReminderDone: true } : {}),
    } : {}),
    ...(includeTrashed ? {} : { isTrashed: false }),
  };

  console.log('getNotes query:', JSON.stringify(whereClause, null, 2));

  const notes = await prisma.note.findMany({
    where: whereClause,
    orderBy: { updatedAt: 'desc' },
    include: {
      tags: { include: { tag: true } },
      attachments: {
        where: { isLatest: true }
      },
      sharedWith: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true
            }
          }
        }
      },
      user: {
        select: {
          id: true,
          name: true,
          email: true
        }
      }
    }
  });

  console.log(`getNotes found ${notes.length} notes`);
  return notes;
};

export const getNote = async (userId: string, id: string) => {
  return prisma.note.findFirst({
    where: {
      id,
      OR: [
        { userId },
        { sharedWith: { some: { userId } } }
      ]
    },
    include: {
      tags: { include: { tag: true } },
      attachments: {
        where: { isLatest: true }
      },
      sharedWith: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true
            }
          }
        }
      },
      user: {
        select: {
          id: true,
          name: true,
          email: true
        }
      }
    }
  });
};

export const updateNote = async (userId: string, id: string, data: {
  title?: string;
  content?: string;
  notebookId?: string;
  isTrashed?: boolean;
  reminderDate?: string | null;
  isReminderDone?: boolean;
  isPinned?: boolean;
  isVault?: boolean;
  isEncrypted?: boolean;
  tags?: { tag: { id: string } }[];
}) => {
  // Verify ownership first
  const note = await prisma.note.findFirst({ where: { id, userId } });
  if (!note) throw new Error('Note not found');

  const { tags, ...rest } = data;

  return prisma.$transaction(async (tx: any) => {
    if (tags !== undefined) {
      // Replace tags
      await tx.tagsOnNotes.deleteMany({ where: { noteId: id } });
      if (tags.length > 0) {
        await tx.tagsOnNotes.createMany({
          data: tags.map(t => ({
            noteId: id,
            tagId: t.tag.id
          }))
        });
      }
    }

    return tx.note.update({
      where: { id },
      data: {
        ...rest,
        updatedAt: new Date(),
      },
    });
  });
};

export const toggleShare = async (userId: string, id: string) => {
  const note = await prisma.note.findFirst({ where: { id, userId } });
  if (!note) throw new Error('Note not found');

  const isPublic = !note.isPublic;
  const shareId = isPublic ? uuidv4() : null;

  return prisma.note.update({
    where: { id },
    data: { isPublic, shareId, updatedAt: new Date() }
  });
};

export const getPublicNote = async (shareId: string) => {
  return prisma.note.findUnique({
    where: { shareId },
    include: {
      tags: { include: { tag: true } },
      attachments: { where: { isLatest: true } }
    }
  });
};

export const deleteNote = async (userId: string, id: string) => {
  return prisma.note.deleteMany({
    where: { id, userId },
  });
};
