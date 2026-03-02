import { Prisma } from '@prisma/client';
import prisma from '../../plugins/prisma';
import { getPresenceUsers } from '../kanbanSSE';

// ─── Email debounce (max 1 per user/board every 30 min for chat, 30s for card actions) ──
const BOARD_CHAT_EMAIL_DEBOUNCE_MS = 30 * 60 * 1000;
const CARD_ACTION_EMAIL_DEBOUNCE_MS = 30 * 1000;
export const boardChatEmailDebounce = new Map<string, number>();
export const cardActionEmailDebounce = new Map<string, number>();

// ─── Notification helpers ────────────────────────────────────

export type KanbanNotificationType =
  | 'KANBAN_CARD_ASSIGNED'
  | 'KANBAN_COMMENT_ADDED'
  | 'KANBAN_COMMENT_DELETED'
  | 'KANBAN_CARD_MOVED';

/** Simple notification to a specific user (no tiering, no email). Used for card assignment. */
export async function notifyBoardUsers(
  actorId: string,
  boardId: string,
  type: KanbanNotificationType,
  title: string,
  message: string,
  data: Prisma.InputJsonObject,
  specificUserId?: string
): Promise<void> {
  const { createNotification } = await import('../notification.service');

  if (specificUserId && specificUserId !== actorId) {
    await createNotification(specificUserId, type, title, message, data);
    return;
  }

  // Get all board participants (owner + ACCEPTED shares) excluding actor
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: {
      ownerId: true,
      shares: { where: { status: 'ACCEPTED' }, select: { userId: true } },
    },
  });
  if (!board) return;

  const recipientIds = new Set<string>();
  recipientIds.add(board.ownerId);
  for (const s of board.shares) recipientIds.add(s.userId);
  recipientIds.delete(actorId);

  for (const uid of recipientIds) {
    try {
      await createNotification(uid, type, title, message, data);
    } catch {
      // Silently continue — push failure should not block the operation
    }
  }
}

/**
 * Tiered notification for board participants:
 * 1. User on board (SSE) → skip
 * 2. User online in app (lastActiveAt < 5min) → DB notification only
 * 3. User offline → DB notification + email (debounced, respecting emailNotificationsEnabled)
 */
export async function notifyBoardUsersTiered(
  actorId: string,
  boardId: string,
  type: KanbanNotificationType,
  title: string,
  message: string,
  data: Prisma.InputJsonObject,
  emailTemplate: { type: 'KANBAN_COMMENT' | 'KANBAN_COMMENT_DELETED' | 'KANBAN_CARD_MOVED'; data: (recipientEmail: string, recipientLocale: string) => Record<string, string> },
  debounceMs: number = CARD_ACTION_EMAIL_DEBOUNCE_MS
): Promise<void> {
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: {
      title: true,
      ownerId: true,
      shares: { where: { status: 'ACCEPTED' }, select: { userId: true } },
    },
  });
  if (!board) return;

  const recipientIds = new Set<string>();
  recipientIds.add(board.ownerId);
  for (const s of board.shares) recipientIds.add(s.userId);
  recipientIds.delete(actorId);

  if (recipientIds.size === 0) return;

  // Users currently connected to this board via SSE
  const activeOnBoard = new Set(getPresenceUsers(boardId).map((u) => u.id));

  const { createNotification } = await import('../notification.service');
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

  for (const uid of recipientIds) {
    // Tier 1: User is viewing board → skip
    if (activeOnBoard.has(uid)) continue;

    try {
      const recipient = await prisma.user.findUnique({
        where: { id: uid },
        select: { lastActiveAt: true, email: true, locale: true, emailNotificationsEnabled: true },
      });
      if (!recipient) continue;

      const isOnlineInApp = recipient.lastActiveAt && recipient.lastActiveAt > fiveMinutesAgo;

      // Always create DB notification (Tier 2 & 3)
      await createNotification(uid, type, title, message, data);

      // Tier 3: Offline → also send email (debounced)
      if (!isOnlineInApp && recipient.emailNotificationsEnabled) {
        const debounceKey = `card:${type}:${uid}:${boardId}`;
        const lastSent = cardActionEmailDebounce.get(debounceKey) || 0;
        if (Date.now() - lastSent >= debounceMs) {
          try {
            const emailService = await import('../email.service');
            await emailService.sendNotificationEmail(
              recipient.email,
              emailTemplate.type,
              emailTemplate.data(recipient.email, recipient.locale)
            );
            cardActionEmailDebounce.set(debounceKey, Date.now());
          } catch {
            // Email send failure is non-critical
          }
        }
      }
    } catch {
      // Silently continue
    }
  }
}

export { BOARD_CHAT_EMAIL_DEBOUNCE_MS };
