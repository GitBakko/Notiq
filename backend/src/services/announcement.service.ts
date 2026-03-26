import prisma from '../plugins/prisma';
import { sendPushNotification } from './push.service';
import { NotFoundError, BadRequestError } from '../utils/errors';
import logger from '../utils/logger';

// ─── Helpers ────────────────────────────────────────────────

function extractPlainText(content: string): string {
  // Try to parse as TipTap JSON and walk the doc tree
  try {
    const doc = JSON.parse(content);
    if (doc && typeof doc === 'object') {
      const texts: string[] = [];
      const walk = (node: Record<string, unknown>) => {
        if (node.type === 'text' && typeof node.text === 'string') {
          texts.push(node.text);
        }
        if (Array.isArray(node.content)) {
          for (const child of node.content) {
            walk(child as Record<string, unknown>);
          }
        }
      };
      walk(doc);
      if (texts.length > 0) {
        const full = texts.join(' ').trim();
        return full.length > 200 ? full.slice(0, 200) + '...' : full;
      }
    }
  } catch {
    // Not valid JSON — fall through to HTML strip
  }

  // Fallback: strip HTML tags
  const stripped = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped.length > 200 ? stripped.slice(0, 200) + '...' : stripped;
}

// ─── Service Functions ──────────────────────────────────────

export const createAnnouncement = async (
  createdById: string,
  data: { title: string; content: string; category: 'MAINTENANCE' | 'FEATURE' | 'URGENT' }
) => {
  const announcement = await prisma.announcement.create({
    data: {
      title: data.title,
      content: data.content,
      category: data.category,
      createdById,
    },
  });

  // Fire-and-forget push notifications to all users with subscriptions
  prisma.user
    .findMany({
      where: { pushSubscriptions: { some: {} } },
      select: { id: true },
    })
    .then((users) => {
      const body = extractPlainText(data.content);
      const payload = {
        title: `[${data.category}] ${data.title}`,
        body,
        data: { type: 'ANNOUNCEMENT', announcementId: announcement.id },
      };
      for (const user of users) {
        sendPushNotification(user.id, payload).catch((err) => {
          logger.warn({ err, userId: user.id, announcementId: announcement.id }, 'Failed to send announcement push');
        });
      }
    })
    .catch((err) => {
      logger.error({ err, announcementId: announcement.id }, 'Failed to fetch users for announcement push');
    });

  return announcement;
};

export const getActiveAnnouncements = async (userId: string) => {
  return prisma.announcement.findMany({
    where: {
      isActive: true,
      NOT: {
        dismissals: {
          some: { userId },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      createdBy: {
        select: { id: true, name: true, email: true },
      },
    },
  });
};

export const getAnnouncementHistory = async (page: number = 1, limit: number = 20) => {
  const skip = (page - 1) * limit;

  const [data, total] = await Promise.all([
    prisma.announcement.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        createdBy: {
          select: { id: true, name: true },
        },
        _count: {
          select: { dismissals: true },
        },
      },
    }),
    prisma.announcement.count(),
  ]);

  return { data, total };
};

export const dismissAnnouncement = async (announcementId: string, userId: string) => {
  const announcement = await prisma.announcement.findUnique({
    where: { id: announcementId },
  });

  if (!announcement) {
    throw new NotFoundError('Announcement not found');
  }

  if (!announcement.isActive) {
    throw new BadRequestError('Announcement is no longer active');
  }

  await prisma.announcementDismissal.upsert({
    where: {
      announcementId_userId: { announcementId, userId },
    },
    create: { announcementId, userId },
    update: {},
  });
};

export const deactivateAnnouncement = async (announcementId: string) => {
  return prisma.announcement.update({
    where: { id: announcementId },
    data: { isActive: false },
  });
};

export const deleteAnnouncement = async (announcementId: string) => {
  await prisma.announcement.delete({
    where: { id: announcementId },
  });
};
