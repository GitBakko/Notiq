import prisma from '../../plugins/prisma';
import logger from '../../utils/logger';
import { NotFoundError, ForbiddenError } from '../../utils/errors';
import { cardWithAssigneeSelect, transformCard } from './helpers';
import { archiveCompletedCards } from './card.service';

// ─── Board CRUD ─────────────────────────────────────────────

export async function listBoards(userId: string) {
  const [owned, shared] = await Promise.all([
    prisma.kanbanBoard.findMany({
      where: { ownerId: userId },
      select: {
        id: true,
        title: true,
        description: true,
        coverImage: true,
        avatarUrl: true,
        ownerId: true,
        taskListId: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { columns: true, shares: { where: { status: 'ACCEPTED' } } } },
        columns: {
          select: { _count: { select: { cards: true } } },
        },
        shares: {
          where: { status: 'ACCEPTED' },
          select: {
            userId: true,
            permission: true,
            user: { select: { id: true, name: true, email: true, avatarUrl: true } },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.sharedKanbanBoard.findMany({
      where: { userId, status: 'ACCEPTED' },
      select: {
        permission: true,
        board: {
          select: {
            id: true,
            title: true,
            description: true,
            coverImage: true,
            avatarUrl: true,
            ownerId: true,
            taskListId: true,
            createdAt: true,
            updatedAt: true,
            owner: { select: { id: true, name: true, email: true } },
            _count: { select: { columns: true, shares: { where: { status: 'ACCEPTED' } } } },
            columns: {
              select: { _count: { select: { cards: true } } },
            },
            shares: {
              where: { status: 'ACCEPTED' },
              select: {
                userId: true,
                permission: true,
                user: { select: { id: true, name: true, email: true, avatarUrl: true } },
              },
            },
          },
        },
      },
    }),
  ]);

  const ownedBoards = owned.map((b) => ({
    id: b.id,
    title: b.title,
    description: b.description,
    coverImage: b.coverImage,
    avatarUrl: b.avatarUrl,
    ownerId: b.ownerId,
    taskListId: b.taskListId,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    columnCount: b._count.columns,
    cardCount: b.columns.reduce((sum, col) => sum + col._count.cards, 0),
    shareCount: b._count.shares,
    shares: b.shares.map((s) => ({ userId: s.userId, permission: s.permission, user: s.user })),
    ownership: 'owned' as const,
  }));

  const sharedBoards = shared.map((s) => ({
    id: s.board.id,
    title: s.board.title,
    description: s.board.description,
    coverImage: s.board.coverImage,
    avatarUrl: s.board.avatarUrl,
    ownerId: s.board.ownerId,
    taskListId: s.board.taskListId,
    owner: s.board.owner,
    createdAt: s.board.createdAt,
    updatedAt: s.board.updatedAt,
    columnCount: s.board._count.columns,
    cardCount: s.board.columns.reduce((sum, col) => sum + col._count.cards, 0),
    shareCount: s.board._count.shares,
    shares: s.board.shares.map((sh) => ({ userId: sh.userId, permission: sh.permission, user: sh.user })),
    ownership: 'shared' as const,
    permission: s.permission,
  }));

  return [...ownedBoards, ...sharedBoards];
}

export async function createBoard(
  userId: string,
  title: string,
  description?: string
) {
  return prisma.$transaction(async (tx) => {
    const board = await tx.kanbanBoard.create({
      data: {
        title,
        description,
        ownerId: userId,
        columns: {
          create: [
            { title: 'TODO', position: 0 },
            { title: 'IN_PROGRESS', position: 1 },
            { title: 'DONE', position: 2, isCompleted: true },
          ],
        },
      },
      include: {
        columns: { orderBy: { position: 'asc' } },
      },
    });
    return board;
  });
}

export async function getBoard(boardId: string, requestingUserId?: string) {
  // Run lazy archive before returning board data
  await archiveCompletedCards(boardId);

  // Auto-mark last column as "completed" if no column has isCompleted set
  try {
    const columns = await prisma.kanbanColumn.findMany({
      where: { boardId },
      orderBy: { position: 'asc' },
      select: { id: true, isCompleted: true },
    });
    if (columns.length > 0 && !columns.some(c => c.isCompleted)) {
      const lastColumn = columns[columns.length - 1];
      await prisma.kanbanColumn.update({
        where: { id: lastColumn.id },
        data: { isCompleted: true },
      });
    }
  } catch (err) {
    logger.error(err, 'Failed to auto-set last column as completed');
  }

  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    include: {
      columns: {
        orderBy: { position: 'asc' },
        include: {
          cards: {
            where: { archivedAt: null },
            orderBy: { position: 'asc' },
            select: cardWithAssigneeSelect,
          },
        },
      },
      shares: {
        include: {
          user: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
        },
      },
      owner: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
      note: { select: { id: true, title: true, userId: true } },
      taskList: { select: { id: true, title: true, userId: true } },
    },
  });
  if (!board) throw new NotFoundError('Board not found');

  // Count archived cards
  const archivedCardsCount = await prisma.kanbanCard.count({
    where: {
      column: { boardId },
      archivedAt: { not: null },
    },
  });

  // Filter note visibility: only show linked note data if requesting user has access
  if (requestingUserId) {
    // Collect all noteIds from cards AND the board itself
    const noteIds = board.columns
      .flatMap((col) => col.cards)
      .map((c) => c.noteId)
      .filter((id): id is string => !!id);

    if (board.noteId) noteIds.push(board.noteId);

    if (noteIds.length > 0) {
      const uniqueNoteIds = [...new Set(noteIds)];

      // Get notes the user can see (owned or shared-ACCEPTED)
      const accessibleShares = await prisma.sharedNote.findMany({
        where: { noteId: { in: uniqueNoteIds }, userId: requestingUserId, status: 'ACCEPTED' },
        select: { noteId: true },
      });
      const accessibleNoteIds = new Set(accessibleShares.map((s) => s.noteId));

      // Also add notes owned by the requesting user
      const ownedNotes = await prisma.note.findMany({
        where: { id: { in: uniqueNoteIds }, userId: requestingUserId },
        select: { id: true },
      });
      for (const n of ownedNotes) accessibleNoteIds.add(n.id);

      // Null out note data for cards the user can't access
      for (const col of board.columns) {
        for (const card of col.cards) {
          if (card.noteId && !accessibleNoteIds.has(card.noteId)) {
            (card as Record<string, unknown>).note = null;
          }
        }
      }

      // Null out board-level note if user can't access it
      if (board.noteId && !accessibleNoteIds.has(board.noteId)) {
        (board as Record<string, unknown>).note = null;
      }
    }
  }

  // Transform _count.comments → commentCount for frontend compatibility
  return {
    ...board,
    taskListId: board.taskListId,
    archivedCardsCount,
    columns: board.columns.map(col => ({
      ...col,
      cards: col.cards.map(transformCard),
    })),
  };
}

export async function updateBoard(
  boardId: string,
  data: { title?: string; description?: string | null }
) {
  return prisma.kanbanBoard.update({
    where: { id: boardId },
    data,
    include: {
      shares: {
        include: {
          user: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
        },
      },
      owner: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
      note: { select: { id: true, title: true, userId: true } },
    },
  });
}

export async function deleteBoard(boardId: string) {
  return prisma.kanbanBoard.delete({ where: { id: boardId } });
}

// ─── Create Board from Task List ────────────────────────────

export async function createBoardFromTaskList(userId: string, taskListId: string) {
  // Fetch the task list with items
  const taskList = await prisma.taskList.findUnique({
    where: { id: taskListId },
    include: {
      items: { orderBy: { position: 'asc' } },
    },
  });

  if (!taskList) throw new NotFoundError('TaskList not found');

  // Only the owner can convert
  if (taskList.userId !== userId) {
    // Check if user has shared access
    const shared = await prisma.sharedTaskList.findUnique({
      where: { taskListId_userId: { taskListId, userId } },
      select: { status: true, permission: true },
    });
    if (!shared || shared.status !== 'ACCEPTED' || shared.permission !== 'WRITE') {
      throw new ForbiddenError('Access denied');
    }
  }

  // Map TaskPriority → KanbanCardPriority (they share the same names for LOW/MEDIUM/HIGH)
  const mapPriority = (p: string): 'LOW' | 'MEDIUM' | 'HIGH' => {
    if (p === 'LOW') return 'LOW';
    if (p === 'HIGH') return 'HIGH';
    return 'MEDIUM';
  };

  // Helper: if text is long, use truncated title + full description
  const splitText = (text: string) => {
    if (text.length > 100) {
      return { title: text.substring(0, 100) + '...', description: text };
    }
    return { title: text, description: undefined as string | undefined };
  };

  return prisma.$transaction(async (tx) => {
    // Create board with two columns + auto-link to task list
    const board = await tx.kanbanBoard.create({
      data: {
        title: taskList.title,
        ownerId: userId,
        taskListId: taskListId,
        taskListLinkedById: userId,
        columns: {
          create: [
            { title: 'TODO', position: 0 },
            { title: 'DONE', position: 1, isCompleted: true },
          ],
        },
      },
      include: {
        columns: { orderBy: { position: 'asc' } },
      },
    });

    const todoColumnId = board.columns[0].id;
    const doneColumnId = board.columns[1].id;

    // Separate items by checked status
    const uncheckedItems = taskList.items.filter((i) => !i.isChecked);
    const checkedItems = taskList.items.filter((i) => i.isChecked);

    // Create cards for unchecked items → TODO column
    for (let i = 0; i < uncheckedItems.length; i++) {
      const item = uncheckedItems[i];
      const { title, description } = splitText(item.text);
      await tx.kanbanCard.create({
        data: {
          columnId: todoColumnId,
          title,
          description,
          position: i,
          dueDate: item.dueDate,
          priority: mapPriority(item.priority),
          taskItemId: item.id,
        },
      });
    }

    // Create cards for checked items → DONE column
    // Assign the card to whoever checked the task item
    for (let i = 0; i < checkedItems.length; i++) {
      const item = checkedItems[i];
      const { title, description } = splitText(item.text);
      await tx.kanbanCard.create({
        data: {
          columnId: doneColumnId,
          title,
          description,
          position: i,
          dueDate: item.dueDate,
          assigneeId: item.checkedByUserId,
          priority: mapPriority(item.priority),
          taskItemId: item.id,
        },
      });
    }

    return board;
  });
}
