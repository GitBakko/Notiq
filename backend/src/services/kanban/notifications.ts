import { Prisma } from '@prisma/client';
import prisma from '../../plugins/prisma';
import { getPresenceUsers } from '../kanbanSSE';
import logger from '../../utils/logger';

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
 *
 * [BACKUP] 2026-09-29 — 5.5: this used to run one `user.findUnique` per recipient and
 * `await` every `sendNotificationEmail`, and all its callers awaited it — so the request
 * that moved a card or posted a comment waited on the SMTP server once per offline
 * recipient. Now the recipients are read with one query, emails are fire-and-forget
 * (failures are logged), and callers do not await this function at all. It never throws.
 */
export async function notifyBoardUsersTiered(
  actorId: string,
  boardId: string,
  type: KanbanNotificationType,
  title: string,
  message: string,
  data: Prisma.InputJsonObject,
  emailTemplate: {
    type: 'KANBAN_COMMENT' | 'KANBAN_COMMENT_DELETED' | 'KANBAN_CARD_MOVED' | 'CHAT_MESSAGE';
    data: (recipientEmail: string, recipientLocale: string) => Record<string, string>;
  },
  debounceMs: number = CARD_ACTION_EMAIL_DEBOUNCE_MS,
  debounce: { map: Map<string, number>; key: (uid: string) => string } = {
    map: cardActionEmailDebounce,
    key: (uid) => `card:${type}:${uid}:${boardId}`,
  },
): Promise<void> {
  try {
    const board = await prisma.kanbanBoard.findUnique({
      where: { id: boardId },
      select: {
        title: true,
        ownerId: true,
        shares: { where: { status: 'ACCEPTED' }, select: { userId: true } },
      },
    });
    if (!board) return;

    // Users currently connected to this board via SSE — the frontend handles them.
    const activeOnBoard = new Set(getPresenceUsers(boardId).map((u) => u.id));

    const recipientIds = new Set<string>();
    recipientIds.add(board.ownerId);
    for (const s of board.shares) recipientIds.add(s.userId);
    recipientIds.delete(actorId);
    for (const uid of activeOnBoard) recipientIds.delete(uid); // Tier 1
    if (recipientIds.size === 0) return;

    const recipients = await prisma.user.findMany({
      where: { id: { in: [...recipientIds] } },
      select: { id: true, lastActiveAt: true, email: true, locale: true, emailNotificationsEnabled: true },
    });

    const { createNotification } = await import('../notification.service');
    const emailService = await import('../email.service'); // loading the module, not sending
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    for (const recipient of recipients) {
      try {
        // Always create DB notification (Tier 2 & 3)
        await createNotification(recipient.id, type, title, message, data);
      } catch (err) {
        logger.warn({ err, userId: recipient.id, boardId, type }, 'Kanban notification failed');
        continue;
      }

      // Tier 3: Offline → also send email (debounced), without waiting for the mail server
      const isOnlineInApp = recipient.lastActiveAt && recipient.lastActiveAt > fiveMinutesAgo;
      if (isOnlineInApp || !recipient.emailNotificationsEnabled) continue;
      const debounceKey = debounce.key(recipient.id);
      if (Date.now() - (debounce.map.get(debounceKey) || 0) < debounceMs) continue;
      // Claimed before sending, so a second request in the same window does not send
      // it again; released if the send fails, so the next event can retry.
      debounce.map.set(debounceKey, Date.now());
      emailService
        .sendNotificationEmail(recipient.email, emailTemplate.type, emailTemplate.data(recipient.email, recipient.locale))
        .catch((err) => {
          debounce.map.delete(debounceKey);
          logger.warn({ err, userId: recipient.id, boardId, type }, 'Kanban notification email failed');
        });
    }
  } catch (err) {
    // Notifications are a side effect of an action that already succeeded.
    logger.error({ err, boardId, type }, 'Kanban tiered notification failed');
  }
}

export { BOARD_CHAT_EMAIL_DEBOUNCE_MS };
