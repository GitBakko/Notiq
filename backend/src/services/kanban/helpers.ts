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

// Re-usable select for card with assignee info
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
  note: { select: { id: true, title: true, userId: true } },
  _count: { select: { comments: true } },
} as const;

/** Transform Prisma _count.comments → commentCount for frontend */
export function transformCard(card: { _count: { comments: number }; [key: string]: unknown }) {
  const { _count, ...rest } = card;
  return { ...rest, commentCount: _count.comments };
}
