import prisma from '../plugins/prisma';
import { sendPushNotification } from './push.service';
import logger from '../utils/logger';

const INACTIVE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export const createNotification = async (
  userId: string,
  type: 'SHARE_NOTE' | 'SHARE_NOTEBOOK' | 'SYSTEM' | 'REMINDER' | 'CHAT_MESSAGE' | 'GROUP_INVITE' | 'GROUP_REMOVE' | 'TASK_ITEM_ADDED' | 'TASK_ITEM_CHECKED' | 'TASK_ITEM_REMOVED' | 'TASK_LIST_SHARED',
  title: string,
  message: string,
  data?: any
) => {
  const notification = await prisma.notification.create({
    data: {
      userId,
      type,
      title,
      message,
      data,
    },
  });

  // Send push notification if user is inactive (lastActiveAt > 5 minutes ago)
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { lastActiveAt: true },
    });

    if (user) {
      const inactiveSince = Date.now() - new Date(user.lastActiveAt).getTime();
      if (inactiveSince > INACTIVE_THRESHOLD_MS) {
        await sendPushNotification(userId, {
          title,
          body: message,
          data: { ...data, type },
        });
      }
    }
  } catch (err) {
    logger.error(err, 'Failed to send push notification for user %s', userId);
  }

  return notification;
};

export const getUserNotifications = async (userId: string, page: number = 1, limit: number = 50) => {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit,
  });
};

export const markNotificationAsRead = async (id: string, userId: string) => {
  return prisma.notification.updateMany({
    where: { id, userId },
    data: { isRead: true },
  });
};

export const markAllNotificationsAsRead = async (userId: string) => {
  return prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true },
  });
};

export const deleteNotification = async (id: string, userId: string) => {
  return prisma.notification.deleteMany({
    where: { id, userId },
  });
};

export const deleteAllNotifications = async (userId: string) => {
  return prisma.notification.deleteMany({
    where: { userId },
  });
};
