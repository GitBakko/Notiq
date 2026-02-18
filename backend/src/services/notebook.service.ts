import prisma from '../plugins/prisma';

export const createNotebook = async (userId: string, name: string, id?: string) => {
  const existing = await prisma.notebook.findFirst({
    where: { userId, name },
  });

  if (existing) {
    throw new Error('Notebook with this name already exists');
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
          }
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
  return prisma.$transaction(async (tx) => {
    const notebook = await tx.notebook.findFirst({ where: { id, userId } });
    if (!notebook) throw new Error('Notebook not found');

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
};
