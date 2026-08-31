import prisma from '../plugins/prisma';
import { NotFoundError, ForbiddenError } from '../utils/errors';

export async function assertBoardAccess(
  boardId: string,
  userId: string,
  requiredPermission: 'READ' | 'WRITE'
): Promise<{ isOwner: boolean }> {
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: { ownerId: true },
  });
  if (!board) throw new NotFoundError('errors.kanban.boardNotFound');
  if (board.ownerId === userId) return { isOwner: true };

  const share = await prisma.sharedKanbanBoard.findUnique({
    where: { boardId_userId: { boardId, userId } },
    select: { permission: true, status: true },
  });
  if (!share || share.status !== 'ACCEPTED') throw new ForbiddenError('errors.common.accessDenied');
  if (requiredPermission === 'WRITE' && share.permission !== 'WRITE') {
    throw new ForbiddenError('errors.common.writeAccessRequired');
  }
  return { isOwner: false };
}

export async function getColumnWithAccess(
  columnId: string,
  userId: string,
  requiredPermission: 'READ' | 'WRITE'
): Promise<{ boardId: string; isOwner: boolean }> {
  const column = await prisma.kanbanColumn.findUnique({
    where: { id: columnId },
    select: { boardId: true },
  });
  if (!column) throw new NotFoundError('errors.kanban.columnNotFound');
  const access = await assertBoardAccess(column.boardId, userId, requiredPermission);
  return { boardId: column.boardId, ...access };
}

export async function getCardWithAccess(
  cardId: string,
  userId: string,
  requiredPermission: 'READ' | 'WRITE'
): Promise<{ boardId: string; columnId: string; isOwner: boolean }> {
  const card = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: { columnId: true, column: { select: { boardId: true } } },
  });
  if (!card) throw new NotFoundError('errors.kanban.cardNotFound');
  const access = await assertBoardAccess(card.column.boardId, userId, requiredPermission);
  return { boardId: card.column.boardId, columnId: card.columnId, ...access };
}

/** Empty/undefined → [], and duplicates collapsed so `count === length` stays a valid check. */
const uniq = (ids?: string[]): string[] => (ids && ids.length > 0 ? [...new Set(ids)] : []);

/**
 * Assert that every given id actually belongs to `boardId`.
 * Call this AFTER assertBoardAccess/getColumnWithAccess: it answers
 * "is this id part of the board I already proved access to?", not "can I write here?".
 */
export async function assertBelongsToBoard(
  boardId: string,
  ids: { columnIds?: string[]; cardIds?: string[]; userIds?: string[] }
): Promise<void> {
  const columnIds = uniq(ids.columnIds);
  const cardIds = uniq(ids.cardIds);
  const userIds = uniq(ids.userIds);

  if (columnIds.length > 0) {
    const found = await prisma.kanbanColumn.count({
      where: { boardId, id: { in: columnIds } },
    });
    if (found !== columnIds.length) throw new ForbiddenError('errors.common.accessDenied');
  }

  if (cardIds.length > 0) {
    const found = await prisma.kanbanCard.count({
      where: { column: { boardId }, id: { in: cardIds } },
    });
    if (found !== cardIds.length) throw new ForbiddenError('errors.common.accessDenied');
  }

  if (userIds.length > 0) {
    const board = await prisma.kanbanBoard.findUnique({
      where: { id: boardId },
      select: {
        ownerId: true,
        shares: { where: { status: 'ACCEPTED' }, select: { userId: true } },
      },
    });
    if (!board) throw new NotFoundError('errors.kanban.boardNotFound');

    const participants = new Set<string>([board.ownerId, ...board.shares.map((s) => s.userId)]);
    for (const userId of userIds) {
      if (!participants.has(userId)) throw new ForbiddenError('errors.common.accessDenied');
    }
  }
}
