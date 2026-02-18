import prisma from '../plugins/prisma';
import { hocuspocus, extensions } from '../hocuspocus';
import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import { v4 as uuidv4 } from 'uuid';
import { extractTextFromTipTapJson } from '../utils/extractText';

export const checkNoteAccess = async (userId: string, noteId: string): Promise<'OWNER' | 'READ' | 'WRITE' | null> => {
  const note = await prisma.note.findUnique({
    where: { id: noteId },
    select: {
      userId: true,
      sharedWith: { where: { userId, status: 'ACCEPTED' }, select: { permission: true } }
    }
  });
  if (!note) return null;
  if (note.userId === userId) return 'OWNER';
  if (note.sharedWith.length > 0) return note.sharedWith[0].permission as 'READ' | 'WRITE';
  return null;
};

export const createNote = async (
  userId: string,
  title: string,
  content: string,
  notebookId: string,
  isVault: boolean = false,
  isEncrypted: boolean = false,
  id?: string
) => {
  // Check if notebook exists/belongs to user
  let targetNotebookId = notebookId;
  const notebook = await prisma.notebook.findFirst({
    where: { id: notebookId, userId },
  });

  if (!notebook) {
    // Fallback: find ANY notebook for this user
    const anyNotebook = await prisma.notebook.findFirst({
      where: { userId },
    });
    if (anyNotebook) {
      targetNotebookId = anyNotebook.id;
    } else {
      // Create a default notebook? For now throw
      throw new Error('Notebook not found');
    }
  }

  try {
    const searchText = isEncrypted ? null : extractTextFromTipTapJson(content);
    return await prisma.note.create({
      data: {
        ...(id ? { id } : {}),
        title,
        content,
        searchText,
        userId,
        notebookId: targetNotebookId,
        isVault,
        isEncrypted,
      },
    });
  } catch (error: any) {
    if (error.code === 'P2002') {
      // If ID conflict, try to find existing and return it (idempotency)
      const existing = await prisma.note.findUnique({ where: { id } });
      if (existing) return existing;
    }
    throw error;
  }
};

export const getNotes = async (userId: string, notebookId?: string, search?: string, tagId?: string, reminderFilter?: 'all' | 'pending' | 'done', includeTrashed: boolean = false, page: number = 1, limit: number = 50) => {
  const whereClause = {
    userId,
    ...(notebookId ? { notebookId } : {}),
    ...(tagId ? { tags: { some: { tagId } } } : {}),
    ...(search ? {
      OR: [
        { title: { contains: search, mode: 'insensitive' as const } },
        { searchText: { contains: search, mode: 'insensitive' as const } },
      ]
    } : {}),
    ...(reminderFilter ? {
      reminderDate: { not: null },
      ...(reminderFilter === 'pending' ? { isReminderDone: false } : {}),
      ...(reminderFilter === 'done' ? { isReminderDone: true } : {}),
    } : {}),
    ...(includeTrashed ? {} : { isTrashed: false }),
  };

  const notes = await prisma.note.findMany({
    where: whereClause,
    orderBy: { updatedAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit,
    select: {
      id: true,
      title: true,
      notebookId: true,
      userId: true,
      isPinned: true,
      isTrashed: true,
      isEncrypted: true,
      isPublic: true,
      isVault: true,
      shareId: true,
      reminderDate: true,
      isReminderDone: true,
      createdAt: true,
      updatedAt: true,
      searchText: true,
      tags: { include: { tag: true } },
      attachments: {
        where: { isLatest: true },
        select: { id: true, filename: true, mimeType: true, size: true }
      },
      sharedWith: {
        include: {
          user: {
            select: { id: true, name: true, email: true }
          }
        }
      },
      user: {
        select: { id: true, name: true, email: true }
      },
      _count: { select: { attachments: true } }
    }
  });

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

    // Recalculate searchText if content changed
    const updateData: any = { ...rest, updatedAt: new Date() };
    if (rest.content && !rest.isEncrypted && !note.isEncrypted) {
      updateData.searchText = extractTextFromTipTapJson(rest.content);
    }

    return tx.note.update({
      where: { id },
      data: updateData,
    });
  });
};

export const toggleShare = async (userId: string, id: string) => {
  const note = await prisma.note.findFirst({ where: { id, userId } });
  if (!note) throw new Error('Note not found');

  if (note.isVault) {
    throw new Error('Vault notes cannot be shared');
  }

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
  return prisma.$transaction(async (tx) => {
    // Check ownership FIRST before deleting any relations
    const note = await tx.note.findFirst({ where: { id, userId } });
    if (!note) throw new Error('Note not found');

    await tx.tagsOnNotes.deleteMany({ where: { noteId: id } });
    await tx.attachment.deleteMany({ where: { noteId: id } });
    await tx.sharedNote.deleteMany({ where: { noteId: id } });
    await tx.chatMessage.deleteMany({ where: { noteId: id } });

    return tx.note.delete({ where: { id } });
  });
};
