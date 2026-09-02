import { Prisma } from '@prisma/client';
import prisma from '../../plugins/prisma';
import logger from '../../utils/logger';

// ─── Activity logging helper ──────────────────────────────

export async function logCardActivity(
  cardId: string,
  userId: string,
  action: 'CREATED' | 'MOVED' | 'UPDATED' | 'ASSIGNED' | 'UNASSIGNED' | 'DUE_DATE_SET' | 'DUE_DATE_REMOVED' | 'NOTE_LINKED' | 'NOTE_UNLINKED' | 'DELETED',
  extra?: { fromColumnTitle?: string; toColumnTitle?: string; metadata?: Record<string, unknown> }
): Promise<void> {
  try {
    await prisma.kanbanCardActivity.create({
      data: {
        cardId,
        userId,
        action,
        fromColumnTitle: extra?.fromColumnTitle ?? null,
        toColumnTitle: extra?.toColumnTitle ?? null,
        metadata: extra?.metadata ? (extra.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
    });
  } catch (err) {
    logger.warn({ err, cardId, action }, 'Failed to log card activity');
  }
}

// Re-usable select for card with assignee info.
//
// [BACKUP] 2026-09-02 — this used to carry `note: { select: { id, title, userId } }`.
// Only getBoard ever filtered it per requesting user; updateCard, getArchivedCards
// and the link/unlink re-reads returned it whole, so a board member with no access
// to the linked note received its title (finding B2). The default is now safe and
// the note is opt-in through cardWithNoteSelect below, which has exactly one caller.
// Keep `noteId`: the UI keys its "linked note (no access)" fallback off that scalar,
// which every board reader is already entitled to see.
export const cardWithAssigneeSelect = {
  id: true,
  title: true,
  description: true,
  position: true,
  columnId: true,
  assigneeId: true,
  dueDate: true,
  priority: true,
  noteId: true,
  noteLinkedById: true,
  archivedAt: true,
  taskItemId: true,
  createdAt: true,
  updatedAt: true,
  assignee: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
  _count: { select: { comments: true } },
} as const;

/**
 * The only select that carries the linked note. Reserved for getBoard, which nulls
 * it per requesting user through accessibleNoteIds(). Any new caller must filter
 * too — if you are about to use this in a response that has no userId to filter
 * against, you want cardWithAssigneeSelect instead.
 */
export const cardWithNoteSelect = {
  ...cardWithAssigneeSelect,
  note: { select: { id: true, title: true, userId: true } },
} as const;

/**
 * Which of these notes may `userId` see? Owned, or shared with an ACCEPTED share —
 * the same predicate checkNoteAccess() applies to a single note, batched.
 *
 * PENDING is the majority of SharedNote rows in practice, so dropping the status
 * filter would look correct on most data and leak on the rest.
 */
export async function accessibleNoteIds(
  noteIds: string[],
  userId: string
): Promise<Set<string>> {
  // Prisma DROPS a `where` key whose value is undefined, so a missing userId would
  // turn both lookups below into unscoped ones and this function would answer
  // "everything is accessible" — the exact inverse of its job. Measured on the dev
  // database: 3 notes in, 3 back. Throwing is deliberate; returning an empty set
  // would hide the caller's bug behind a blank activity feed.
  if (!userId) throw new Error('accessibleNoteIds called without a userId');

  const accessible = new Set<string>();
  if (noteIds.length === 0) return accessible;

  const uniqueNoteIds = [...new Set(noteIds)];

  const accessibleShares = await prisma.sharedNote.findMany({
    where: { noteId: { in: uniqueNoteIds }, userId, status: 'ACCEPTED' },
    select: { noteId: true },
  });
  for (const s of accessibleShares) accessible.add(s.noteId);

  const ownedNotes = await prisma.note.findMany({
    where: { id: { in: uniqueNoteIds }, userId },
    select: { id: true },
  });
  for (const n of ownedNotes) accessible.add(n.id);

  return accessible;
}

/** Transform Prisma _count.comments → commentCount for frontend */
export function transformCard(card: { _count: { comments: number }; [key: string]: unknown }) {
  const { _count, ...rest } = card;
  return { ...rest, commentCount: _count.comments };
}
