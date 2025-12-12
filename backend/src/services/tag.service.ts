import prisma from '../plugins/prisma';

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
            where: { note: { isVault: isVault ?? undefined } } // If undefined, count all notes? Or match tag's vault status?
            // If we are fetching ALL tags, we probably want the count to match the tag's type roughly?
            // But if we fetch all, we might mix them.
            // Actually, for Sync, we only need the Tag object. The `_count` is for display.
            // If isVault is undefined, we probably don't care about precise count filtering for Sync.
          }
        }
      }
    }
  });
};

export const deleteTag = async (userId: string, id: string) => {
  return prisma.tag.deleteMany({
    where: { id, userId },
  });
};

export const addTagToNote = async (userId: string, noteId: string, tagId: string) => {
  // Verify ownership
  const note = await prisma.note.findFirst({ where: { id: noteId, userId } });
  const tag = await prisma.tag.findFirst({ where: { id: tagId, userId } });

  if (!note || !tag) throw new Error('Note or Tag not found');

  return prisma.tagsOnNotes.create({
    data: {
      noteId,
      tagId,
    },
  });
};

export const removeTagFromNote = async (userId: string, noteId: string, tagId: string) => {
  // Verify ownership implicitly via deleteMany
  return prisma.tagsOnNotes.deleteMany({
    where: {
      noteId,
      tagId,
      note: { userId }, // Ensure note belongs to user
    }
  });
};
