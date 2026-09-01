import prisma from '../../plugins/prisma';
import { NotFoundError, BadRequestError } from '../../utils/errors';
import { broadcast } from '../kanbanSSE';
import { assertBelongsToBoard } from '../kanbanPermissions';

// ─── Column CRUD ────────────────────────────────────────────

export async function createColumn(boardId: string, title: string, id?: string) {
  // aggregate + create in ONE transaction — see createCard in card.service.ts
  // for the isolation-level caveat.
  const column = await prisma.$transaction(async (tx) => {
    const maxPos = await tx.kanbanColumn.aggregate({
      where: { boardId },
      _max: { position: true },
    });
    const position = (maxPos._max.position ?? -1) + 1;

    return tx.kanbanColumn.create({
      data: { ...(id ? { id } : {}), boardId, title, position },
    });
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
  // The route only proved WRITE access to `boardId`; the ids in the body are
  // caller-controlled and must be confirmed to live on that board before writing.
  await assertBelongsToBoard(boardId, { columnIds: items.map((item) => item.id) });

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
    select: { boardId: true, isCompleted: true, _count: { select: { cards: true } } },
  });
  if (!column) throw new NotFoundError('errors.kanban.columnNotFound');
  if (column._count.cards > 0) throw new BadRequestError('errors.kanban.columnHasCards');

  // [BACKUP] 2026-09-01 — era un `prisma.kanbanColumn.delete` nudo fuori transazione.
  // Fino al task 5.1 getBoard rimarcava l'ultima colonna a ogni lettura, quindi cancellare
  // la colonna "completed" si riparava da solo al fetch successivo. Quella scrittura sul
  // percorso di lettura è sparita (annullava la modifica dell'utente nella stessa
  // interazione), e senza nulla al suo posto una board resterebbe per sempre senza colonna
  // completed: niente auto-archiviazione, il task item collegato non viene mai spuntato,
  // i reminder non si chiudono mai. L'invariante si sposta qui, sulla scrittura che la rompe.
  await prisma.$transaction(async (tx) => {
    await tx.kanbanColumn.delete({ where: { id: columnId } });

    // Solo se la colonna cancellata ERA quella completed: una board che l'utente ha
    // deliberatamente lasciato senza resta com'è. E solo se non ne sopravvive un'altra.
    if (column.isCompleted) {
      const stillCompleted = await tx.kanbanColumn.count({
        where: { boardId: column.boardId, isCompleted: true },
      });
      if (stillCompleted === 0) {
        const last = await tx.kanbanColumn.findFirst({
          where: { boardId: column.boardId },
          orderBy: [{ position: 'desc' }, { id: 'desc' }],
          select: { id: true },
        });
        // `last` è null quando si cancella l'ultima colonna della board: niente da promuovere.
        if (last) {
          await tx.kanbanColumn.update({
            where: { id: last.id },
            data: { isCompleted: true },
          });
        }
      }
    }
  });

  broadcast(column.boardId, {
    type: 'column:deleted',
    boardId: column.boardId,
    columnId,
  });
}
