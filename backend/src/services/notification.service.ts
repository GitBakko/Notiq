import prisma from '../plugins/prisma';

export const createNotification = async (
  userId: string,
  type: 'SHARE_NOTE' | 'SHARE_NOTEBOOK' | 'SYSTEM' | 'REMINDER' | 'CHAT_MESSAGE' | 'GROUP_INVITE' | 'GROUP_REMOVE',
  title: string,
  message: string,
  data?: any
) => {
  return prisma.notification.create({
    data: {
      userId,
      type,
      title,
      message,
      data,
    },
  });
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
