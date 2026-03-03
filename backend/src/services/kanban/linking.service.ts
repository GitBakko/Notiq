import { Prisma } from '@prisma/client';
import prisma from '../../plugins/prisma';
import logger from '../../utils/logger';
import { NotFoundError, BadRequestError, ForbiddenError } from '../../utils/errors';
import { broadcast } from '../kanbanSSE';
import { logCardActivity, cardWithAssigneeSelect, transformCard } from './helpers';

// ─── Note Linking ──────────────────────────────────────────

/**
 * Check which board participants have/don't have access to the given note.
 */
export async function checkNoteSharingForBoard(
  noteId: string,
  boardId: string,
  requestingUserId: string
) {
  // Get note owner
  const note = await prisma.note.findUnique({
    where: { id: noteId },
    select: { id: true, title: true, userId: true },
  });
  if (!note) throw new NotFoundError('errors.notes.notFound');

  // Get board owner + accepted shares
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: {
      ownerId: true,
      owner: { select: { id: true, name: true, email: true } },
      shares: {
        where: { status: 'ACCEPTED' },
        select: { user: { select: { id: true, name: true, email: true } } },
      },
    },
  });
  if (!board) throw new NotFoundError('errors.kanban.boardNotFound');

  // All board participants (owner + accepted shares)
  const boardParticipants = [
    board.owner,
    ...board.shares.map((s) => s.user),
  ];

  // Get existing note shares (ACCEPTED)
  const noteShares = await prisma.sharedNote.findMany({
    where: { noteId, status: 'ACCEPTED' },
    select: { userId: true },
  });
  const noteAccessUserIds = new Set([note.userId, ...noteShares.map((s) => s.userId)]);

  const usersWithAccess = boardParticipants.filter((u) => noteAccessUserIds.has(u.id));
  const usersWithoutAccess = boardParticipants.filter(
    (u) => !noteAccessUserIds.has(u.id) && u.id !== requestingUserId
  );

  return {
    noteTitle: note.title,
    noteOwnerId: note.userId,
    alreadyFullyShared: usersWithoutAccess.length === 0,
    usersWithAccess,
    usersWithoutAccess,
  };
}

/**
 * Link a note to a card. Optionally auto-share with specified users.
 */
export async function linkNoteToCard(
  cardId: string,
  noteId: string,
  actorId: string,
  shareWithUserIds?: string[]
) {
  const card = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: { noteId: true, column: { select: { boardId: true, board: { select: { title: true } } } } },
  });
  if (!card) throw new NotFoundError('errors.kanban.cardNotFound');
  if (card.noteId) throw new BadRequestError('errors.kanban.cardAlreadyLinkedNote');

  const note = await prisma.note.findUnique({
    where: { id: noteId },
    select: { id: true, title: true, userId: true },
  });
  if (!note) throw new NotFoundError('errors.notes.notFound');

  // Only the note owner can link their note
  if (note.userId !== actorId) throw new ForbiddenError('errors.kanban.onlyOwnerCanLink');

  await prisma.kanbanCard.update({
    where: { id: cardId },
    data: { noteId, noteLinkedById: actorId },
  });

  const boardId = card.column.boardId;

  // Auto-share with selected users
  if (shareWithUserIds && shareWithUserIds.length > 0) {
    const { autoShareNoteForBoard } = await import('../sharing.service');
    await autoShareNoteForBoard(
      actorId,
      noteId,
      shareWithUserIds,
      'READ',
      card.column.board.title
    );
  }

  // Log activity
  await logCardActivity(cardId, actorId, 'NOTE_LINKED', {
    metadata: { noteId, noteTitle: note.title },
  });

  // Broadcast update
  const rawUpdatedCard = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: cardWithAssigneeSelect,
  });
  if (rawUpdatedCard) {
    const updatedCard = transformCard(rawUpdatedCard);
    broadcast(boardId, { type: 'card:updated', boardId, card: updatedCard });
    return updatedCard;
  }

  return rawUpdatedCard;
}

/**
 * Unlink a note from a card. Only the user who linked it can unlink.
 */
export async function unlinkNoteFromCard(cardId: string, actorId: string) {
  const card = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: {
      noteId: true,
      noteLinkedById: true,
      note: { select: { title: true } },
      column: { select: { boardId: true } },
    },
  });
  if (!card) throw new NotFoundError('errors.kanban.cardNotFound');
  if (!card.noteId) throw new BadRequestError('errors.kanban.cardNoLinkedNote');
  if (card.noteLinkedById !== actorId) throw new ForbiddenError('errors.kanban.onlyLinkerCanUnlinkNote');

  const noteTitle = card.note?.title || '';

  await prisma.kanbanCard.update({
    where: { id: cardId },
    data: { noteId: null, noteLinkedById: null },
  });

  const boardId = card.column.boardId;

  await logCardActivity(cardId, actorId, 'NOTE_UNLINKED', {
    metadata: { noteTitle },
  });

  const rawUpdatedCard = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: cardWithAssigneeSelect,
  });
  if (rawUpdatedCard) {
    const updatedCard = transformCard(rawUpdatedCard);
    broadcast(boardId, { type: 'card:updated', boardId, card: updatedCard });
    return updatedCard;
  }

  return rawUpdatedCard;
}

/**
 * Link a note to a board. Optionally auto-share with specified users.
 */
export async function linkNoteToBoard(
  boardId: string,
  noteId: string,
  actorId: string,
  shareWithUserIds?: string[]
) {
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: { noteId: true, title: true },
  });
  if (!board) throw new NotFoundError('errors.kanban.boardNotFound');
  if (board.noteId) throw new BadRequestError('errors.kanban.boardAlreadyLinkedNote');

  const note = await prisma.note.findUnique({
    where: { id: noteId },
    select: { id: true, title: true, userId: true },
  });
  if (!note) throw new NotFoundError('errors.notes.notFound');

  // Only the note owner can link their note
  if (note.userId !== actorId) throw new ForbiddenError('errors.kanban.onlyOwnerCanLink');

  const updatedBoard = await prisma.kanbanBoard.update({
    where: { id: boardId },
    data: { noteId, noteLinkedById: actorId },
    select: {
      noteId: true,
      noteLinkedById: true,
      note: { select: { id: true, title: true, userId: true } },
    },
  });

  // Auto-share with selected users
  if (shareWithUserIds && shareWithUserIds.length > 0) {
    const { autoShareNoteForBoard } = await import('../sharing.service');
    await autoShareNoteForBoard(actorId, noteId, shareWithUserIds, 'READ', board.title);
  }

  broadcast(boardId, { type: 'board:updated', boardId });

  return updatedBoard;
}

/**
 * Unlink a note from a board. Only the user who linked it can unlink.
 */
export async function unlinkNoteFromBoard(boardId: string, actorId: string) {
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: { noteId: true, noteLinkedById: true },
  });
  if (!board) throw new NotFoundError('errors.kanban.boardNotFound');
  if (!board.noteId) throw new BadRequestError('errors.kanban.boardNoLinkedNote');
  if (board.noteLinkedById !== actorId) throw new ForbiddenError('errors.kanban.onlyLinkerCanUnlinkNote');

  await prisma.kanbanBoard.update({
    where: { id: boardId },
    data: { noteId: null, noteLinkedById: null },
  });

  broadcast(boardId, { type: 'board:updated', boardId });

  return { success: true };
}

/**
 * Search notes that belong to the user (owned) for the note picker.
 */
export async function searchUserNotes(
  userId: string,
  query: string,
  limit: number = 20
) {
  const where: Prisma.NoteWhereInput = {
    userId,
    isVault: false, // Don't allow linking vault notes
  };

  if (query.trim()) {
    where.OR = [
      { title: { contains: query, mode: 'insensitive' } },
      { searchText: { contains: query, mode: 'insensitive' } },
    ];
  }

  return prisma.note.findMany({
    where,
    select: {
      id: true,
      title: true,
      notebookId: true,
      notebook: { select: { id: true, name: true } },
      updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
}

/**
 * Get kanban boards linked to the given note (via cards or directly),
 * accessible to the requesting user.
 */
export async function getLinkedBoardsForNote(noteId: string, userId: string) {
  const boardSelect = {
    id: true,
    title: true,
    avatarUrl: true,
    ownerId: true,
    shares: {
      where: { userId, status: 'ACCEPTED' as const },
      select: { id: true },
    },
  };

  // Find cards and boards that reference this note in parallel
  const [cards, directBoards] = await Promise.all([
    prisma.kanbanCard.findMany({
      where: { noteId },
      select: {
        id: true,
        title: true,
        column: { select: { board: { select: boardSelect } } },
      },
    }),
    prisma.kanbanBoard.findMany({
      where: { noteId },
      select: boardSelect,
    }),
  ]);

  type LinkedBoardEntry = {
    boardId: string;
    boardTitle: string;
    boardAvatarUrl: string | null;
    linkedAs: 'board' | 'card';
    cardIds: string[];
    cardTitles: string[];
  };

  const results = new Map<string, LinkedBoardEntry>();

  // Process card-level links (grouped by board)
  for (const card of cards) {
    const board = card.column.board;
    const hasAccess = board.ownerId === userId || board.shares.length > 0;
    if (!hasAccess) continue;

    const existing = results.get(board.id);
    if (existing && existing.linkedAs === 'card') {
      existing.cardIds.push(card.id);
      existing.cardTitles.push(card.title);
    } else if (!results.has(board.id)) {
      results.set(board.id, {
        boardId: board.id,
        boardTitle: board.title,
        boardAvatarUrl: board.avatarUrl,
        linkedAs: 'card',
        cardIds: [card.id],
        cardTitles: [card.title],
      });
    }
  }

  // Process board-level links
  for (const board of directBoards) {
    const hasAccess = board.ownerId === userId || board.shares.length > 0;
    if (!hasAccess) continue;

    // If already in results from a card link, add a separate board entry
    const key = `board:${board.id}`;
    results.set(key, {
      boardId: board.id,
      boardTitle: board.title,
      boardAvatarUrl: board.avatarUrl,
      linkedAs: 'board',
      cardIds: [],
      cardTitles: [],
    });
  }

  return Array.from(results.values());
}

// ─── Task List Linking ─────────────────────────────────────

/**
 * Link a task list to a board. Error if board already has a linked task list.
 */
export async function linkTaskListToBoard(
  boardId: string,
  taskListId: string,
  userId: string
) {
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: { taskListId: true },
  });
  if (!board) throw new NotFoundError('errors.kanban.boardNotFound');
  if (board.taskListId) throw new BadRequestError('errors.kanban.boardAlreadyLinkedTaskList');

  const taskList = await prisma.taskList.findUnique({
    where: { id: taskListId },
    select: { id: true, title: true, userId: true },
  });
  if (!taskList) throw new NotFoundError('errors.tasks.listNotFound');

  const updatedBoard = await prisma.kanbanBoard.update({
    where: { id: boardId },
    data: { taskListId, taskListLinkedById: userId },
    select: {
      taskListId: true,
      taskListLinkedById: true,
      taskList: { select: { id: true, title: true, userId: true } },
    },
  });

  // ── Sync existing cards' completion state back to task items ──
  // After linking, match kanban cards to task items by title and sync checkboxes.
  try {
    const columns = await prisma.kanbanColumn.findMany({
      where: { boardId },
      select: { id: true, isCompleted: true },
    });

    const completedColumnIds = new Set(
      columns.filter(c => c.isCompleted).map(c => c.id)
    );

    // Get all cards in this board (with their taskItemId if any)
    const cards = await prisma.kanbanCard.findMany({
      where: { column: { boardId } },
      select: { id: true, title: true, columnId: true, taskItemId: true },
    });

    // Get all task items in this task list
    const taskItems = await prisma.taskItem.findMany({
      where: { taskListId },
      select: { id: true, text: true, isChecked: true },
    });

    // Build a map of task item text (lowercase) → task item
    const taskItemByText = new Map<string, typeof taskItems[0]>();
    for (const item of taskItems) {
      taskItemByText.set(item.text.trim().toLowerCase(), item);
    }

    // Match cards to task items by title and sync completion state
    for (const card of cards) {
      const isInCompleted = completedColumnIds.has(card.columnId);
      const matchedItem = taskItemByText.get(card.title.trim().toLowerCase());

      if (matchedItem) {
        // Link card to task item if not already linked
        if (!card.taskItemId) {
          await prisma.kanbanCard.update({
            where: { id: card.id },
            data: { taskItemId: matchedItem.id },
          });
        }

        // If card is in a completed column and task item is not checked, check it
        if (isInCompleted && !matchedItem.isChecked) {
          await prisma.taskItem.update({
            where: { id: matchedItem.id },
            data: { isChecked: true, checkedByUserId: userId },
          });
        }

        // Remove matched item so it's not matched again
        taskItemByText.delete(matchedItem.text.trim().toLowerCase());
      }
    }
  } catch (err) {
    // Sync is non-critical — the link is created regardless
    logger.error(err, 'Failed to sync task list items with kanban cards on link');
  }

  broadcast(boardId, { type: 'board:updated', boardId });

  return updatedBoard;
}

/**
 * Unlink a task list from a board. Only the user who linked it can unlink.
 */
export async function unlinkTaskListFromBoard(boardId: string, userId: string) {
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: { taskListId: true, taskListLinkedById: true },
  });
  if (!board) throw new NotFoundError('errors.kanban.boardNotFound');
  if (!board.taskListId) throw new BadRequestError('errors.kanban.boardNoLinkedTaskList');
  if (board.taskListLinkedById !== userId) throw new ForbiddenError('errors.kanban.onlyLinkerCanUnlinkTaskList');

  await prisma.kanbanBoard.update({
    where: { id: boardId },
    data: { taskListId: null, taskListLinkedById: null },
  });

  broadcast(boardId, { type: 'board:updated', boardId });

  return { success: true };
}

/**
 * Search task lists for the picker. Returns task lists the user owns
 * or has WRITE permission on.
 */
export async function searchUserTaskLists(
  userId: string,
  query: string,
  limit: number = 20
) {
  const where: Prisma.TaskListWhereInput = {
    isTrashed: false,
    OR: [
      { userId },
      {
        sharedWith: {
          some: { userId, status: 'ACCEPTED', permission: 'WRITE' },
        },
      },
    ],
  };

  if (query.trim()) {
    where.title = { contains: query, mode: 'insensitive' };
  }

  return prisma.taskList.findMany({
    where,
    select: {
      id: true,
      title: true,
      userId: true,
      _count: { select: { items: true } },
      kanbanBoard: { select: { id: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
}
