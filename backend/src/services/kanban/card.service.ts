import { Prisma } from '@prisma/client';
import prisma from '../../plugins/prisma';
import logger from '../../utils/logger';
import { NotFoundError, BadRequestError } from '../../utils/errors';
import { broadcast } from '../kanbanSSE';
import { logCardActivity, cardWithAssigneeSelect, transformCard, accessibleNoteIds } from './helpers';
import { computeColumnOrder } from './position';
import { notifyBoardUsers, notifyBoardUsersTiered } from './notifications';
import { assertBelongsToBoard } from '../kanbanPermissions';

// ─── Card CRUD ──────────────────────────────────────────────

export async function createCard(
  columnId: string,
  title: string,
  description?: string,
  actorId?: string,
  id?: string
) {
  const column = await prisma.kanbanColumn.findUnique({
    where: { id: columnId },
    select: { boardId: true, title: true },
  });
  if (!column) throw new NotFoundError('errors.kanban.columnNotFound');

  // aggregate + create in ONE transaction: a read-then-write split across two
  // round trips lets two concurrent creates read the same max and write the
  // same position.
  // NOTE: this makes the pair atomic, not serialized — at PostgreSQL's default
  // READ COMMITTED two transactions can still read the same max. Upgrade path
  // if it ever bites in production: @@unique([columnId, position]) on
  // KanbanCard plus a retry, or isolationLevel: 'Serializable'.
  const card = await prisma.$transaction(async (tx) => {
    const maxPos = await tx.kanbanCard.aggregate({
      where: { columnId },
      _max: { position: true },
    });
    const position = (maxPos._max.position ?? -1) + 1;

    return tx.kanbanCard.create({
      data: { ...(id ? { id } : {}), columnId, title, description, position },
      select: cardWithAssigneeSelect,
    });
  });

  broadcast(column.boardId, {
    type: 'card:created',
    boardId: column.boardId,
    card,
    actorId,
  });

  if (actorId) {
    await logCardActivity(card.id, actorId, 'CREATED', { toColumnTitle: column.title });
  }

  return transformCard(card);
}

export async function updateCard(
  cardId: string,
  data: {
    title?: string;
    description?: string | null;
    assigneeId?: string | null;
    dueDate?: string | null;
    priority?: string | null;
  },
  actorId: string
) {
  // Get current card to detect assignee changes
  const currentCard = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: { assigneeId: true, title: true, dueDate: true, column: { select: { boardId: true } } },
  });
  if (!currentCard) throw new NotFoundError('errors.kanban.cardNotFound');

  // A card may only be assigned to someone who is already on the board: otherwise
  // any writer can push notifications and reminders onto arbitrary users.
  // Truthy check on purpose — `null` means "unassign" and needs no membership.
  if (data.assigneeId) {
    await assertBelongsToBoard(currentCard.column.boardId, { userIds: [data.assigneeId] });
  }

  const updateData: Record<string, unknown> = {};
  if (data.title !== undefined) updateData.title = data.title;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.assigneeId !== undefined) updateData.assigneeId = data.assigneeId;
  if (data.priority !== undefined) updateData.priority = data.priority;
  if (data.dueDate !== undefined) {
    updateData.dueDate = data.dueDate ? new Date(data.dueDate) : null;
  }

  const rawCard = await prisma.kanbanCard.update({
    where: { id: cardId },
    data: updateData,
    select: cardWithAssigneeSelect,
  });
  const card = transformCard(rawCard);

  const boardId = currentCard.column.boardId;

  broadcast(boardId, { type: 'card:updated', boardId, card, actorId });

  // Log activity for specific field changes
  if (data.assigneeId !== undefined) {
    if (data.assigneeId !== null && data.assigneeId !== currentCard.assigneeId) {
      const assignee = await prisma.user.findUnique({ where: { id: data.assigneeId }, select: { name: true, email: true } });
      await logCardActivity(cardId, actorId, 'ASSIGNED', {
        metadata: { assigneeName: assignee?.name || assignee?.email },
      });
    } else if (data.assigneeId === null && currentCard.assigneeId) {
      await logCardActivity(cardId, actorId, 'UNASSIGNED');
    }
  }
  if (data.dueDate !== undefined) {
    if (data.dueDate !== null) {
      await logCardActivity(cardId, actorId, 'DUE_DATE_SET', {
        metadata: { dueDate: data.dueDate },
      });
    } else if (currentCard.dueDate) {
      await logCardActivity(cardId, actorId, 'DUE_DATE_REMOVED');
    }
  }

  // Manage kanban reminders based on dueDate changes
  if (data.dueDate !== undefined) {
    const { createRemindersForCard, updateRemindersForCard, deleteRemindersForCard } =
      await import('../kanbanReminder.service');

    if (data.dueDate !== null && !currentCard.dueDate) {
      // dueDate SET for the first time: create reminders for all board users
      await createRemindersForCard(cardId, boardId, new Date(data.dueDate));
    } else if (data.dueDate !== null && currentCard.dueDate) {
      // dueDate CHANGED: update all existing reminders
      await updateRemindersForCard(cardId, new Date(data.dueDate));
    } else if (data.dueDate === null && currentCard.dueDate) {
      // dueDate REMOVED: delete all reminders for this card
      await deleteRemindersForCard(cardId);
    }
  }

  if (data.title !== undefined && data.title !== currentCard.title) {
    await logCardActivity(cardId, actorId, 'UPDATED', {
      metadata: { field: 'title', oldValue: currentCard.title, newValue: data.title },
    });
  }
  if (data.description !== undefined) {
    await logCardActivity(cardId, actorId, 'UPDATED', {
      metadata: { field: 'description' },
    });
  }

  // Notify new assignee if assignee changed to a non-null value
  if (
    data.assigneeId !== undefined &&
    data.assigneeId !== null &&
    data.assigneeId !== currentCard.assigneeId
  ) {
    const actor = await prisma.user.findUnique({
      where: { id: actorId },
      select: { name: true, email: true },
    });
    const board = await prisma.kanbanBoard.findUnique({
      where: { id: boardId },
      select: { title: true },
    });
    const assignerName = actor?.name || actor?.email || 'Someone';
    const cardTitle = data.title ?? currentCard.title;
    const boardTitle = board?.title || '';

    await notifyBoardUsers(
      actorId,
      boardId,
      'KANBAN_CARD_ASSIGNED',
      'Card Assigned',
      `${assignerName} assigned you to "${cardTitle}"`,
      {
        boardId,
        boardTitle,
        cardTitle,
        assignerName,
        localizationKey: 'notifications.kanbanCardAssigned',
        localizationArgs: { assignerName, cardTitle, boardTitle },
      },
      data.assigneeId
    );
  }

  return card;
}

export async function moveCard(
  cardId: string,
  toColumnId: string,
  newPosition: number,
  actorId?: string,
  skipNotification: boolean = false
) {
  const card = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: {
      title: true,
      columnId: true,
      position: true,
      taskItemId: true,
      column: { select: { boardId: true, title: true, isCompleted: true } },
    },
  });
  if (!card) throw new NotFoundError('errors.kanban.cardNotFound');

  const targetColumn = await prisma.kanbanColumn.findUnique({
    where: { id: toColumnId },
    select: { boardId: true, title: true, position: true, isCompleted: true },
  });
  if (!targetColumn) throw new NotFoundError('errors.kanban.columnNotFound');

  const boardId = card.column.boardId;

  // The target column must live on the same board as the card: without this the
  // caller can inject a card into any board whose column id they can guess.
  if (targetColumn.boardId !== boardId) {
    logger.warn(
      { cardId, toColumnId, boardId, targetBoardId: targetColumn.boardId },
      'Rejected cross-board card move'
    );
    throw new NotFoundError('errors.kanban.columnNotFound');
  }

  // [BACKUP] 2026-08-31 — the previous body was three updateMany calls:
  //   1. increment every position >= newPosition in the target column
  //   2. update the card to (toColumnId, newPosition)
  //   3. decrement every position > card.position in the source column
  // Step 3 used card.position (the PRE-move value) against rows step 1 had
  // already shifted. With A=0 B=1 C=2 D=3 and A moved to index 2 the result was
  // A=2, C=2 (collision) and a hole at position 1. Replaced by a read-then-diff
  // resequence: the column order is computed in memory and only the rows that
  // actually change position are written.
  //
  // That fixed a single-user resequence but is still racy under concurrency:
  // at READ COMMITTED (no row locks) two moves on the same column each read
  // the same pre-state and each skip rows the other one changed, producing a
  // duplicate position + a hole. Worked counterexample: on [A0, B1, C2, D3],
  // T1 moves A to index 3 and writes B:0, C:1, D:2, A:3. T2, holding a stale
  // read of the same pre-state, moves B to index 0 and writes B:0, A:1 —
  // skipping C and D, which in its read were already at 2 and 3. Commit T1
  // then T2 and the column is A=1, B=0, C=1, D=2: a duplicate at 1 and a
  // hole at 3.
  // Locking every candidate row up front, ORDERED BY id (not by the
  // move-dependent computed position), makes two concurrent moves request
  // the same rows in the same order: the second blocks on the lock until the
  // first commits, instead of racing it. This narrows the window to
  // uncontended reads/writes; it does not add retry or serializable
  // isolation. What is intentionally left open:
  //   - FOR UPDATE is not a predicate lock: a createCard committing between
  //     the lock and the ordering read produces a row that is visible to
  //     the read, unprotected, and updated outside the ascending-id order.
  //   - The deadlock-freedom argument is exact for the lock statement, not
  //     for the whole transaction — the source-column repair loop writes in
  //     position order, and archiveCompletedCards / executeBulkArchive
  //     acquire locks in plan order via updateMany.
  //   - The lock covers KanbanCard rows only, not KanbanColumn, so a
  //     concurrent deleteColumn on the target still races the final write.
  const { order, isCrossColumn, fromColumnTitle, fromColumnIsCompleted } = await prisma.$transaction(async (tx) => {
    // Lock candidate rows before any ordering read: the card's own row (in
    // case a concurrent move already relocated it — see the liveCard reread
    // below) plus every row currently in the source and target columns.
    // Ordering by id keeps the lock order identical across concurrent moves
    // regardless of which cards are actually being reordered, which is what
    // prevents a Postgres deadlock (40P01) between two moves that touch the
    // same column pair from opposite directions.
    const lockColumnIds = Array.from(new Set([card.columnId, toColumnId]));
    await tx.$queryRaw`
      SELECT id FROM "KanbanCard"
      WHERE id = ${cardId} OR "columnId" IN (${Prisma.join(lockColumnIds)})
      ORDER BY id
      FOR UPDATE
    `;

    // Re-read the card now that its row is locked. `card` above was read
    // BEFORE this transaction opened; a concurrent move landing in that
    // window could have changed its columnId, and deciding isCrossColumn
    // from the stale value would write `position` without `columnId`,
    // stranding the card in a foreign column. sourceColumnId (not the outer
    // card.columnId) drives the source-column repair below.
    // NOTE: if the live columnId turns out to be a THIRD column — this exact
    // card relocated elsewhere by another transaction in the sliver between
    // the outer read and the lock above — that column's rows are not part
    // of lockColumnIds and are not locked here. That residual window is far
    // narrower than the bug this task closes (it requires a second move of
    // this specific card, not just any card in the column, to land in that
    // sliver).
    // Selects the source column's title/isCompleted too, at zero extra cost
    // (same query): the post-transaction cross-column branch below used to
    // read these off the same pre-transaction `card`, which is exactly the
    // staleness this reread exists to close for columnId — isCompleted
    // drives a real write (TaskItem.isChecked), not just log text, so it
    // needs to be fresh for the same reason columnId does.
    const liveCard = await tx.kanbanCard.findUnique({
      where: { id: cardId },
      select: { columnId: true, column: { select: { isCompleted: true, title: true } } },
    });
    if (!liveCard) throw new NotFoundError('errors.kanban.cardNotFound');
    const sourceColumnId = liveCard.columnId;
    const isCrossColumn = sourceColumnId !== toColumnId;

    // Cross-column: close the hole the card leaves behind in the source column.
    // Twin of deleteCard's repack loop below (same file) — same read-then-diff
    // shape, minus the `id: { not: cardId }` exclude (deleteCard's card is
    // already physically gone by this point). Kept duplicated rather than
    // extracted: the two loops differ only by that exclude, moveCard had just
    // been stabilised with tests pinned to its exact call sequence, and two
    // callers didn't justify the extraction risk. Keep the two in sync by hand.
    if (isCrossColumn) {
      const sourceCards = await tx.kanbanCard.findMany({
        where: { columnId: sourceColumnId, archivedAt: null, id: { not: cardId } },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, position: true },
      });
      for (let i = 0; i < sourceCards.length; i++) {
        if (sourceCards[i].position === i) continue;
        await tx.kanbanCard.update({ where: { id: sourceCards[i].id }, data: { position: i } });
      }
    }

    // The target column as it is now. Archived cards are excluded on purpose:
    // getBoard() filters archivedAt: null, so they are never rendered and must
    // not consume positions.
    const targetCards = await tx.kanbanCard.findMany({
      where: { columnId: toColumnId, archivedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, position: true },
    });

    const nextOrder = computeColumnOrder(targetCards.map((c) => c.id), cardId, newPosition);
    // The explicit <string, number> generic is required: without it TS types the
    // .map() result as (string | number)[][] and the Map constructor rejects it.
    const currentPosition = new Map<string, number>(targetCards.map((c) => [c.id, c.position]));

    for (let i = 0; i < nextOrder.length; i++) {
      const id = nextOrder[i];
      // Rows that do not actually move are NOT written. KanbanCard.updatedAt is
      // @updatedAt and archiveCompletedCards() filters on `updatedAt <= cutoff`
      // as the 7-day archive clock: rewriting the whole column would reset that
      // clock for every card on every single drag.
      // (On a cross-column move the moved card is absent from currentPosition,
      // so it is always written — together with its new columnId.)
      if (currentPosition.get(id) === i) continue;
      await tx.kanbanCard.update({
        where: { id },
        data:
          id === cardId && isCrossColumn
            ? { columnId: toColumnId, position: i }
            : { position: i },
      });
    }

    return {
      order: nextOrder,
      isCrossColumn,
      fromColumnTitle: liveCard.column.title,
      fromColumnIsCompleted: liveCard.column.isCompleted,
    };
  });

  broadcast(boardId, {
    type: 'card:moved',
    boardId,
    cardId,
    toColumnId,
    // The position actually written, not the one requested: computeColumnOrder
    // clamps an out-of-range index (e.g. an append) into the column.
    position: order.indexOf(cardId),
    actorId,
  });

  // Cross-column move: log activity + auto-assign card to the mover.
  // Uses the transaction's isCrossColumn (decided from the row read AFTER
  // the lock), not a recompute against the outer, pre-transaction `card`.
  if (actorId && isCrossColumn) {
    await prisma.kanbanCard.update({
      where: { id: cardId },
      data: { assigneeId: actorId },
    });

    await logCardActivity(cardId, actorId, 'MOVED', {
      fromColumnTitle,
      toColumnTitle: targetColumn.title,
    });

    // Sync linked TaskItem checked status based on isCompleted columns
    if (card.taskItemId) {
      const movedIntoCompleted = targetColumn.isCompleted && !fromColumnIsCompleted;
      const movedOutOfCompleted = !targetColumn.isCompleted && fromColumnIsCompleted;

      if (movedIntoCompleted) {
        await prisma.taskItem.update({
          where: { id: card.taskItemId },
          data: { isChecked: true, checkedByUserId: actorId },
        });
      } else if (movedOutOfCompleted) {
        await prisma.taskItem.update({
          where: { id: card.taskItemId },
          data: { isChecked: false, checkedByUserId: null },
        });
      }
    }

    // Notify all board participants about cross-column move (tiered)
    if (!skipNotification) {
      const actor = await prisma.user.findUnique({
        where: { id: actorId },
        select: { name: true, email: true },
      });
      const actorName = actor?.name || actor?.email || 'Someone';

      await notifyBoardUsersTiered(
        actorId,
        boardId,
        'KANBAN_CARD_MOVED',
        'Card Moved',
        `${actorName} moved "${card.title}" from "${fromColumnTitle}" to "${targetColumn.title}"`,
        {
          boardId,
          cardId,
          cardTitle: card.title,
          actorName,
          fromColumn: fromColumnTitle,
          toColumn: targetColumn.title,
          localizationKey: 'notifications.kanbanCardMoved',
          localizationArgs: {
            actorName,
            cardTitle: card.title,
            fromColumn: fromColumnTitle,
            toColumn: targetColumn.title,
          },
        },
        {
          type: 'KANBAN_CARD_MOVED',
          data: (_email, locale) => ({
            actorName,
            cardTitle: card.title,
            fromColumn: fromColumnTitle,
            toColumn: targetColumn.title,
            boardId,
            locale,
          }),
        }
      );
    }

    // Auto-complete reminders when card moves to a completed column
    if (targetColumn.isCompleted) {
      await prisma.kanbanReminder.updateMany({
        where: { cardId, isDone: false },
        data: { isDone: true },
      });
    }
  }
}

export async function deleteCard(cardId: string, actorId?: string) {
  const card = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: { columnId: true, title: true, column: { select: { boardId: true, title: true } } },
  });
  if (!card) throw new NotFoundError('errors.kanban.cardNotFound');

  const boardId = card.column.boardId;

  // Log activity before deletion (activity will cascade-delete with card)
  // Instead, we don't log DELETED since the card (and its activities) are removed.
  // If we want to keep history after deletion, we'd need a board-level log.
  // For now, activities are tied to the card lifecycle.

  // [BACKUP] 2026-08-31 — the previous body was a blind updateMany:
  //   updateMany({ where: { columnId, position: { gt: card.position } }, data: { position: { decrement: 1 } } })
  // Same defect class moveCard had before task 2.2/2.7: no archivedAt filter
  // (archived cards were counted and shifted even though the frontend only
  // ever sees live ones — getBoard() filters archivedAt: null), and no diff
  // (every row below the deleted card was rewritten regardless of whether
  // its index actually changed). Since KanbanCard.updatedAt is @updatedAt
  // and Prisma applies it on updateMany, every delete reset the 7-day
  // auto-archive clock — archiveCompletedCards() filters on updatedAt — for
  // the whole lower part of the column, so completed cards on an active
  // board never reached the archive. Replaced with the same read-then-diff
  // resequence moveCard uses: read the live rows, write only the ones whose
  // index actually changed.
  await prisma.$transaction(async (tx) => {
    // Lock the card's row plus every row currently in its column, ordered by
    // id, before any read — same primitive moveCard's FOR UPDATE lock uses
    // (task 2.7). Two concurrent deleteCards on the same column don't
    // strictly need this to stay safe: Prisma's own row lock on the DELETE
    // plus a P2025 on a since-deleted row turns that race into a transient
    // error + retry, not silent corruption. But an unlocked deleteCard
    // racing a (now-locked) moveCard on the same column is a real lost
    // update: moveCard can commit a fresh position for a row after this
    // transaction's own repack read below has already captured that row's
    // stale position, and this transaction's later UPDATE would silently
    // overwrite moveCard's fresh write — the exact corruption class task
    // 2.7 closed for moveCard-vs-moveCard, just reachable from the other
    // side. The lock closes that window for the price of one extra query.
    await tx.$queryRaw`
      SELECT id FROM "KanbanCard"
      WHERE id = ${cardId} OR "columnId" = ${card.columnId}
      ORDER BY id
      FOR UPDATE
    `;

    // Re-read after the lock: a concurrent move could have relocated this
    // card to a different column in the window between the outer read above
    // and this transaction opening (same residual documented in moveCard —
    // narrower still, since it needs a second move of this exact card in
    // that sliver).
    const liveCard = await tx.kanbanCard.findUnique({
      where: { id: cardId },
      select: { columnId: true },
    });
    if (!liveCard) throw new NotFoundError('errors.kanban.cardNotFound');
    const columnId = liveCard.columnId;

    await tx.kanbanCard.delete({ where: { id: cardId } });

    // Repack the live cards left in the column. archivedAt: null excludes
    // archived cards — they consume no position, matching getBoard(). Only
    // rows whose index actually changed are written (see the note above on
    // the archive-clock reset). Twin of moveCard's source-column repair loop
    // above (`isCrossColumn` block) — same shape, minus the `id: { not:
    // cardId }` exclude since the card is already deleted by this point.
    // Kept duplicated rather than extracted: the two loops differ only by
    // that exclude, moveCard had just been stabilised with tests pinned to
    // its exact call sequence, and two callers didn't justify the extraction
    // risk. Keep the two in sync by hand.
    const remaining = await tx.kanbanCard.findMany({
      where: { columnId, archivedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, position: true },
    });
    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i].position === i) continue;
      await tx.kanbanCard.update({ where: { id: remaining[i].id }, data: { position: i } });
    }
  });

  broadcast(boardId, { type: 'card:deleted', boardId, cardId, actorId });
}

// ─── Card Activities ────────────────────────────────────────

/** The two activity actions whose metadata is about a note the reader may not see. */
const NOTE_ACTIONS = new Set(['NOTE_LINKED', 'NOTE_UNLINKED']);

function metadataObject(metadata: unknown): Record<string, unknown> | null {
  // logCardActivity writes Prisma.JsonNull when there is no metadata, which comes
  // back as JS null — the majority shape in this table. Arrays are not produced by
  // any writer, but `typeof [] === 'object'` would let one through the spread.
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  return metadata as Record<string, unknown>;
}

/**
 * Card activity feed, with the linked note's title resolved per reader (B1).
 *
 * linkNoteToCard used to PERSIST the note title in metadata, and this endpoint
 * served it to anyone with READ on the board — the title the board view hides on
 * the face of the card was readable in the Activity tab of the same modal. The
 * write side now stores only `noteId`; this side resolves the title for readers
 * who may see it, and drops any title still sitting in a row written before the
 * fix (or on a database where the scrub migration has not run yet).
 */
export async function getCardActivities(
  cardId: string,
  page: number,
  limit: number,
  userId: string
) {
  const activities = await prisma.kanbanCardActivity.findMany({
    where: { cardId },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit,
    include: {
      user: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
    },
  });

  const noteIds = activities
    .filter((a) => NOTE_ACTIONS.has(a.action))
    .map((a) => metadataObject(a.metadata)?.noteId)
    .filter((id): id is string => typeof id === 'string');

  // Same predicate getBoard uses, so the two views of the same note cannot disagree.
  // No early return for a page without note activity: accessibleNoteIds already
  // issues nothing for an empty list, and a second guard here only looked like it
  // was doing the work — a mutation that removed it killed no test.
  const accessible = await accessibleNoteIds(noteIds, userId);
  const titles = new Map<string, string>();
  if (accessible.size > 0) {
    const notes = await prisma.note.findMany({
      where: { id: { in: [...accessible] } },
      select: { id: true, title: true },
    });
    for (const n of notes) titles.set(n.id, n.title);
  }

  return activities.map((a) => {
    if (!NOTE_ACTIONS.has(a.action)) return a;
    const meta = metadataObject(a.metadata);
    // Fail CLOSED on a shape this code does not understand. Returning it untouched
    // would be the wrong direction: an array or a scalar cannot be redacted key by
    // key, so passing it through would serve whatever it holds. No writer produces
    // those shapes today — which is exactly why the branch has to be decided here
    // rather than left to whoever adds the writer that does.
    if (!meta) return { ...a, metadata: null };

    // Drop first, resolve second: a legacy row keeps its title only if the reader
    // is separately entitled to it, and a row with no noteId keeps none at all.
    const { noteTitle: _persisted, ...rest } = meta;
    const noteId = typeof meta.noteId === 'string' ? meta.noteId : null;
    const title = noteId ? titles.get(noteId) : undefined;

    return { ...a, metadata: title === undefined ? rest : { ...rest, noteTitle: title } };
  });
}

// ─── Card Archiving ────────────────────────────────────────

const ARCHIVE_AFTER_DAYS = 7;

/**
 * Archive cards sitting in completed columns that haven't been updated in ≥7 days.
 * Called hourly from app.ts. Pass a boardId to scope it to a single board.
 *
 * [BACKUP] 2026-09-01 — previously this was invoked from getBoard() on every read,
 * making GET /api/kanban/boards/:id a write endpoint. Moved to a scheduled job.
 */
export async function archiveCompletedCards(boardId?: string): Promise<number> {
  const cutoffDate = new Date(Date.now() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000);

  // Find completed columns (optionally scoped to one board)
  // ponytail: unscoped, this loads every completed column id into one IN list
  // (~1 per board). Batch by board if the board count ever makes that query fat.
  const completedColumns = await prisma.kanbanColumn.findMany({
    where: boardId ? { boardId, isCompleted: true } : { isCompleted: true },
    select: { id: true },
  });

  if (completedColumns.length === 0) return 0;

  const completedColumnIds = completedColumns.map((c) => c.id);

  const result = await prisma.kanbanCard.updateMany({
    where: {
      columnId: { in: completedColumnIds },
      archivedAt: null,
      updatedAt: { lte: cutoffDate },
    },
    data: { archivedAt: new Date() },
  });

  if (result.count > 0) {
    logger.info({ boardId: boardId ?? 'ALL', count: result.count }, 'Archived completed cards');
  }

  return result.count;
}

/**
 * Get archived cards for a board.
 */
export async function getArchivedCards(boardId: string) {
  const cards = await prisma.kanbanCard.findMany({
    where: {
      column: { boardId },
      archivedAt: { not: null },
    },
    orderBy: { archivedAt: 'desc' },
    select: {
      ...cardWithAssigneeSelect,
      column: { select: { id: true, title: true } },
    },
  });

  return cards.map((card) => {
    const { _count, ...rest } = card;
    return { ...rest, commentCount: _count.comments };
  });
}

/**
 * Unarchive a card (set archivedAt = null).
 */
export async function unarchiveCard(cardId: string) {
  const card = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: { id: true, archivedAt: true, column: { select: { boardId: true } } },
  });
  if (!card) throw new NotFoundError('errors.kanban.cardNotFound');
  if (!card.archivedAt) throw new BadRequestError('errors.kanban.cardNotArchived');

  await prisma.kanbanCard.update({
    where: { id: cardId },
    data: { archivedAt: null },
  });

  broadcast(card.column.boardId, {
    type: 'card:unarchived',
    boardId: card.column.boardId,
    cardId,
  });

  return { success: true };
}

// ─── Bulk Archive (owner-only) ──────────────────────────────

/**
 * Preview which cards in completed columns are older than N days.
 * Returns card IDs + titles for frontend highlight.
 */
export async function previewBulkArchive(boardId: string, olderThanDays: number) {
  const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  const completedColumns = await prisma.kanbanColumn.findMany({
    where: { boardId, isCompleted: true },
    select: { id: true },
  });

  if (completedColumns.length === 0) return [];

  const cards = await prisma.kanbanCard.findMany({
    where: {
      columnId: { in: completedColumns.map((c) => c.id) },
      archivedAt: null,
      updatedAt: { lte: cutoffDate },
    },
    select: { id: true, title: true, updatedAt: true },
    orderBy: { updatedAt: 'asc' },
    // The exec endpoint this preview feeds (executeBulkArchive) is capped at
    // 1000 card ids (bulkArchiveExecSchema.cardIds.max(1000)) — the preview
    // must not promise more than exec can accept.
    take: 1000,
  });

  return cards;
}

/**
 * Archive cards by IDs (owner-only). Returns count of archived cards.
 */
export async function executeBulkArchive(boardId: string, cardIds: string[]) {
  if (cardIds.length === 0) return 0;

  // Only archive cards that belong to this board and are not already archived
  const result = await prisma.kanbanCard.updateMany({
    where: {
      id: { in: cardIds },
      column: { boardId },
      archivedAt: null,
    },
    data: { archivedAt: new Date() },
  });

  if (result.count > 0) {
    logger.info({ boardId, count: result.count }, 'Bulk-archived cards by owner');
  }

  return result.count;
}

// ─── Bulk Move Notify ───────────────────────────────────────

export async function bulkMoveNotify(
  boardId: string,
  moves: { cardId: string; fromColumnId: string; toColumnId: string }[],
  actorId: string,
) {
  if (moves.length === 0) return;

  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: { title: true, columns: { select: { id: true, title: true } } },
  });
  if (!board) return;

  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { name: true, email: true },
  });
  const actorName = actor?.name || actor?.email || 'Unknown';

  const columnMap = new Map(board.columns.map(c => [c.id, c.title]));

  // Group moves by fromColumn -> toColumn
  const groups = new Map<string, number>();
  for (const move of moves) {
    const from = columnMap.get(move.fromColumnId) || '?';
    const to = columnMap.get(move.toColumnId) || '?';
    const key = `${from} \u2192 ${to}`;
    groups.set(key, (groups.get(key) || 0) + 1);
  }

  const summary = Array.from(groups.entries())
    .map(([key, count]) => `${count} \u00d7 ${key}`)
    .join(', ');

  const totalCount = moves.length;

  await notifyBoardUsersTiered(
    actorId,
    boardId,
    'KANBAN_CARD_MOVED',
    'Cards Moved',
    `${actorName} moved ${totalCount} cards on ${board.title}: ${summary}`,
    {
      boardId,
      actorName,
      count: totalCount,
      summary,
      boardTitle: board.title,
      localizationKey: 'notifications.kanbanBulkMove',
      localizationArgs: {
        actorName,
        count: String(totalCount),
        boardTitle: board.title,
        summary,
      },
    },
    {
      type: 'KANBAN_CARD_MOVED',
      data: (_email: string, locale: string) => ({
        actorName,
        count: String(totalCount),
        summary,
        boardTitle: board.title,
        locale,
      }),
    }
  );
}
