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
  if (!board) throw new NotFoundError('Board not found');
  if (board.ownerId === userId) return { isOwner: true };

  const share = await prisma.sharedKanbanBoard.findUnique({
    where: { boardId_userId: { boardId, userId } },
    select: { permission: true, status: true },
  });
  if (!share || share.status !== 'ACCEPTED') throw new ForbiddenError('Access denied');
  if (requiredPermission === 'WRITE' && share.permission !== 'WRITE') {
    throw new ForbiddenError('Write access required');
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
  if (!column) throw new NotFoundError('Column not found');
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
  if (!card) throw new NotFoundError('Card not found');
  const access = await assertBoardAccess(card.column.boardId, userId, requiredPermission);
  return { boardId: card.column.boardId, columnId: card.columnId, ...access };
}
