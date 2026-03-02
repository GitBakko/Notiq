import prisma from '../../plugins/prisma';
import { broadcast } from '../kanbanSSE';

// ─── Column CRUD ────────────────────────────────────────────

export async function createColumn(boardId: string, title: string) {
  const maxPos = await prisma.kanbanColumn.aggregate({
    where: { boardId },
    _max: { position: true },
  });
  const position = (maxPos._max.position ?? -1) + 1;

  const column = await prisma.kanbanColumn.create({
    data: { boardId, title, position },
  });

  broadcast(boardId, { type: 'column:created', boardId, column });
  return column;
}

export async function updateColumn(columnId: string, data: { title?: string; isCompleted?: boolean }) {
  // If setting isCompleted to true, first unset any other completed column in the same board
  if (data.isCompleted === true) {
    const col = await prisma.kanbanColumn.findUnique({
      where: { id: columnId },
      select: { boardId: true },
    });
    if (col) {
      await prisma.kanbanColumn.updateMany({
        where: { boardId: col.boardId, isCompleted: true, id: { not: columnId } },
        data: { isCompleted: false },
      });
    }
  }

  const updateData: Record<string, unknown> = {};
  if (data.title !== undefined) updateData.title = data.title;
  if (data.isCompleted !== undefined) updateData.isCompleted = data.isCompleted;

  const column = await prisma.kanbanColumn.update({
    where: { id: columnId },
    data: updateData,
  });

  broadcast(column.boardId, {
    type: 'column:updated',
    boardId: column.boardId,
    column,
  });
  return column;
}

export async function reorderColumns(
  boardId: string,
  items: { id: string; position: number }[]
) {
  await prisma.$transaction(
    items.map((item) =>
      prisma.kanbanColumn.update({
        where: { id: item.id },
        data: { position: item.position },
      })
    )
  );

  broadcast(boardId, { type: 'columns:reordered', boardId, columns: items });
}

export async function deleteColumn(columnId: string) {
  const column = await prisma.kanbanColumn.findUnique({
    where: { id: columnId },
    select: { boardId: true, _count: { select: { cards: true } } },
  });
  if (!column) throw new Error('Column not found');
  if (column._count.cards > 0) throw new Error('Column has cards');

  await prisma.kanbanColumn.delete({ where: { id: columnId } });

  broadcast(column.boardId, {
    type: 'column:deleted',
    boardId: column.boardId,
    columnId,
  });
}
