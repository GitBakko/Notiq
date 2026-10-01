import prisma from '../../plugins/prisma';
import { NotFoundError, ForbiddenError } from '../../utils/errors';
import { cardWithNoteSelect, transformCard, accessibleNoteIds } from './helpers';
import fs from 'fs';
import { createHash } from 'crypto';
import logger from '../../utils/logger';
import { resolveUploadPath } from '../../utils/uploadPaths';
import { broadcast, disconnectBoard } from '../kanbanSSE';

// ─── Board CRUD ─────────────────────────────────────────────

/**
 * Kanban 5.2: what listBoards reads of each column, enough to fingerprint the board's
 * content without loading its cards.
 */
const contentVersionColumnSelect = {
  id: true,
  title: true,
  position: true,
  isCompleted: true,
  _count: { select: { cards: true } },
  cards: { select: { updatedAt: true }, orderBy: { updatedAt: 'desc' as const }, take: 1 },
};

type ContentVersionColumn = {
  id: string;
  title: string;
  position: number;
  isCompleted: boolean;
  _count: { cards: number };
  cards: { updatedAt: Date }[];
};

/**
 * Kanban 5.2: fingerprint of what GET /kanban/boards/:id would return for columns and
 * cards, so the sync can skip that request while it is unchanged.
 * - Columns go in by value: KanbanColumn has no updatedAt.
 * - Cards go in by count (a delete lowers it) and newest updatedAt (@updatedAt moves on
 *   create, edit, move and archive).
 * Not covered, because they don't touch the card row: comment counts and the linked
 * note's title. The sync bounds that staleness with a periodic full refresh.
 */
export function boardContentVersion(columns: ContentVersionColumn[]): string {
  const cols = [...columns]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => `${c.id}:${c.position}:${c.isCompleted ? 1 : 0}:${c.title}`);
  const cardCount = columns.reduce((sum, c) => sum + c._count.cards, 0);
  const newestCard = columns.reduce(
    (max, c) => Math.max(max, c.cards[0] ? new Date(c.cards[0].updatedAt).getTime() : 0),
    0,
  );
  return createHash('sha1').update(JSON.stringify([cols, cardCount, newestCard])).digest('hex').slice(0, 16);
}

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
        columns: { select: contentVersionColumnSelect },
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
            columns: { select: contentVersionColumnSelect },
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
    contentVersion: boardContentVersion(b.columns),
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
    contentVersion: boardContentVersion(s.board.columns),
    ownership: 'shared' as const,
    permission: s.permission,
  }));

  return [...ownedBoards, ...sharedBoards];
}

export async function createBoard(
  userId: string,
  title: string,
  description?: string,
  columnTitles?: { todo: string; inProgress: string; done: string },
  id?: string
) {
  // R4: idempotent replay of the FE sync CREATE (same id, same owner) returns the existing board; a foreign id
  // falls through to create and fails as before.
  if (id) {
    const replay = await prisma.kanbanBoard.findFirst({
      where: { id, ownerId: userId },
      include: { columns: { orderBy: [{ position: 'asc' }, { id: 'asc' }] } },
    });
    if (replay) return replay;
  }
  const cols = columnTitles || { todo: 'TODO', inProgress: 'IN_PROGRESS', done: 'DONE' };
  return prisma.$transaction(async (tx) => {
    const board = await tx.kanbanBoard.create({
      data: {
        ...(id ? { id } : {}),
        title,
        description,
        ownerId: userId,
        columns: {
          create: [
            { title: cols.todo, position: 0 },
            { title: cols.inProgress, position: 1 },
            { title: cols.done, position: 2, isCompleted: true },
          ],
        },
      },
      include: {
        columns: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
      },
    });
    return board;
  });
}

// `requestingUserId` is REQUIRED, and that is a security property rather than a
// style choice: every note and task-list redaction below sits behind `if
// (requestingUserId)`, so an omitted argument would silently return the board
// unfiltered. [BACKUP] 2026-09-02 — it used to be optional.
export async function getBoard(boardId: string, requestingUserId: string) {
  // [BACKUP] 2026-09-01 — questa GET faceva due scritture:
  //   await archiveCompletedCards(boardId);              → ora job orario in app.ts
  //   try { ...kanbanColumn.update({ isCompleted: true }) } catch { ... }
  // Il secondo blocco era un backfill per board legacy, eseguito a ogni lettura:
  // riattivava "completed" sull'ultima colonna subito dopo che l'utente lo aveva
  // tolto, perché la invalidate della mutation rifaceva il fetch da qui.
  // createBoard e createBoardFromTaskList seminano gia una colonna isCompleted: true,
  // quindi ogni board NUOVA nasce con l'invariante. Non e vero per tutte le altre:
  // la migration 20260228130000 ha aggiunto isCompleted con DEFAULT false e nessun
  // backfill, e deleteColumn non impedisce di cancellare l'unica colonna completed.
  // Su quelle board archiveCompletedCards (che filtra isCompleted: true) non trova
  // nulla e l'auto-archiviazione resta inerte. Il backfill va rifatto una volta sola
  // come migration, non a ogni lettura: vedi il piano kanban, task 5.1bis.

  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    include: {
      columns: {
        // KanbanColumn has no createdAt (see schema.prisma): id is the stable
        // tiebreaker so the same board never renders in two different orders.
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        include: {
          cards: {
            where: { archivedAt: null },
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
            select: cardWithNoteSelect,
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
  if (!board) throw new NotFoundError('errors.kanban.boardNotFound');

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
      // [BACKUP] 2026-09-02 — the two lookups were inlined here. Extracted to
      // accessibleNoteIds() so getCardActivities resolves visibility through the
      // same predicate instead of growing a second definition of it (B1).
      const accessible = await accessibleNoteIds(noteIds, requestingUserId);

      // Null out note data for cards the user can't access
      for (const col of board.columns) {
        for (const card of col.cards) {
          if (card.noteId && !accessible.has(card.noteId)) {
            (card as Record<string, unknown>).note = null;
          }
        }
      }

      // Null out board-level note if user can't access it
      if (board.noteId && !accessible.has(board.noteId)) {
        (board as Record<string, unknown>).note = null;
      }
    }

    // Same treatment for the linked TASK LIST (B4). It is not a note and does not
    // go through the batch above: a board has at most one, so one lookup, and only
    // when it is linked and not owned by the reader. `taskListId` survives so the
    // UI can still render the "no access" row in place of the title.
    if (board.taskList && board.taskList.userId !== requestingUserId) {
      const share = await prisma.sharedTaskList.findUnique({
        where: { taskListId_userId: { taskListId: board.taskList.id, userId: requestingUserId } },
        select: { status: true },
      });
      if (share?.status !== 'ACCEPTED') {
        (board as Record<string, unknown>).taskList = null;
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
  data: { title?: string; description?: string | null },
  actorId?: string
) {
  const updated = await prisma.kanbanBoard.update({
    where: { id: boardId },
    data,
    include: {
      shares: {
        include: {
          user: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
        },
      },
      owner: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
      // [BACKUP] 2026-09-02 — this used to include
      //   note: { select: { id: true, title: true, userId: true } }
      // unfiltered, so the PUT handed a WRITE sharee the note title the GET hides
      // from them (B3). updateBoard has no userId to filter against, and the
      // response is discarded by the client (syncService.ts:842), so it stops
      // asking. The title still reaches everyone entitled to it through getBoard.
    },
  });
  // 4.4: other viewers used to see a rename only on their next refetch.
  broadcast(boardId, { type: 'board:updated', boardId, actorId });
  return updated;
}

export async function deleteBoard(boardId: string) {
  // [BACKUP] 2026-09-29 — 6.3: was a bare `return prisma.kanbanBoard.delete({ where: { id: boardId } });`.
  // That left the cover/avatar files on disk forever: they live under uploads/kanban/,
  // are served without authentication, and pruneAttachments only knows the Attachment
  // table, so nothing else ever reaped them.
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: { coverImage: true, avatarUrl: true },
  });

  const deleted = await prisma.kanbanBoard.delete({ where: { id: boardId } });
  // 4.4: close the board's open streams now rather than at the next heartbeat tick.
  disconnectBoard(boardId);

  for (const url of [board?.coverImage, board?.avatarUrl]) {
    const filepath = resolveUploadPath(url);
    if (!filepath) continue;
    try {
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    } catch (err) {
      // The row is already gone — a stuck file must not turn into a failed request.
      logger.warn({ err, boardId, filepath }, 'Failed to delete kanban board image file');
    }
  }

  return deleted;
}

// ─── Create Board from Task List ────────────────────────────

export async function createBoardFromTaskList(userId: string, taskListId: string, columnTitles?: { todo: string; done: string }) {
  // Fetch the task list with items
  const taskList = await prisma.taskList.findUnique({
    where: { id: taskListId },
    include: {
      items: { orderBy: { position: 'asc' } },
    },
  });

  if (!taskList) throw new NotFoundError('errors.tasks.listNotFound');

  // Only the owner can convert
  if (taskList.userId !== userId) {
    // Check if user has shared access
    const shared = await prisma.sharedTaskList.findUnique({
      where: { taskListId_userId: { taskListId, userId } },
      select: { status: true, permission: true },
    });
    if (!shared || shared.status !== 'ACCEPTED' || shared.permission !== 'WRITE') {
      throw new ForbiddenError('errors.common.accessDenied');
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
            { title: columnTitles?.todo || 'TODO', position: 0 },
            { title: columnTitles?.done || 'DONE', position: 1, isCompleted: true },
          ],
        },
      },
      include: {
        columns: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
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
