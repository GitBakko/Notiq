import prisma from '../plugins/prisma';
import { ConflictError, NotFoundError } from '../utils/errors';
import { logEvent } from './audit.service';

export const createNotebook = async (userId: string, name: string, id?: string) => {
  const existing = await prisma.notebook.findFirst({
    where: { userId, name },
  });

  if (existing) {
    throw new ConflictError('errors.notebooks.nameExists');
  }

  return prisma.notebook.create({
    data: {
      ...(id ? { id } : {}),
      name,
      userId,
    },
  });
};

export const getNotebooks = async (userId: string) => {
  return prisma.notebook.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    include: {
      _count: {
        select: {
          notes: {
            where: { isVault: false }
          },
          sharedWith: {
            where: { status: 'ACCEPTED' }
          }
        }
      },
      sharedWith: {
        where: { status: 'ACCEPTED' },
        select: {
          userId: true,
          permission: true,
          status: true,
          user: { select: { id: true, name: true, email: true, avatarUrl: true } }
        }
      }
    }
  });
};

export const getNotebook = async (userId: string, id: string) => {
  return prisma.notebook.findFirst({
    where: { id, userId },
  });
};

export const updateNotebook = async (userId: string, id: string, name: string) => {
  return prisma.notebook.updateMany({
    where: { id, userId },
    data: { name },
  });
};

export const deleteNotebook = async (userId: string, id: string) => {
  const result = await prisma.$transaction(async (tx) => {
    const notebook = await tx.notebook.findFirst({ where: { id, userId } });
    if (!notebook) throw new NotFoundError('errors.notebooks.notFound');

    // Find or create a fallback notebook for orphaned notes
    let fallbackNotebook = await tx.notebook.findFirst({
      where: { userId, id: { not: id } },
      orderBy: { createdAt: 'asc' },
    });
    if (!fallbackNotebook) {
      fallbackNotebook = await tx.notebook.create({
        data: { name: 'Uncategorized', userId },
      });
    }

    // Move notes to fallback notebook instead of orphaning
    await tx.note.updateMany({
      where: { notebookId: id, userId },
      data: { notebookId: fallbackNotebook.id },
    });

    return tx.notebook.delete({ where: { id } });
  });

  logEvent(userId, 'NOTEBOOK_DELETED', { notebookId: id });

  return result;
};
