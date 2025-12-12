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
  return prisma.notebook.deleteMany({
    where: { id, userId },
  });
};
