import { vi, describe, it, expect, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';
import {
  createNotification,
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
} from '../notification.service';

const prismaMock = prisma as any;

const USER_ID = 'user-1';
const NOTIFICATION_ID = 'notif-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createNotification', () => {
  it('should create a notification with all fields', async () => {
    const created = {
      id: NOTIFICATION_ID,
      userId: USER_ID,
      type: 'SHARE_NOTE',
      title: 'Note Shared',
      message: 'Alice shared a note with you',
      data: { noteId: 'note-1' },
    };
    prismaMock.notification.create.mockResolvedValue(created);

    const result = await createNotification(
      USER_ID,
      'SHARE_NOTE',
      'Note Shared',
      'Alice shared a note with you',
      { noteId: 'note-1' },
    );

    expect(prismaMock.notification.create).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        type: 'SHARE_NOTE',
        title: 'Note Shared',
        message: 'Alice shared a note with you',
        data: { noteId: 'note-1' },
      },
    });
    expect(result).toEqual(created);
  });

  it('should create a notification without optional data', async () => {
    const created = {
      id: NOTIFICATION_ID,
      userId: USER_ID,
      type: 'SYSTEM',
      title: 'System Update',
      message: 'Maintenance scheduled',
      data: undefined,
    };
    prismaMock.notification.create.mockResolvedValue(created);

    const result = await createNotification(
      USER_ID,
      'SYSTEM',
      'System Update',
      'Maintenance scheduled',
    );

    expect(prismaMock.notification.create).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        type: 'SYSTEM',
        title: 'System Update',
        message: 'Maintenance scheduled',
        data: undefined,
      },
    });
    expect(result).toEqual(created);
  });

  it('should support all notification types', async () => {
    const types = [
      'SHARE_NOTE',
      'SHARE_NOTEBOOK',
      'SYSTEM',
      'REMINDER',
      'CHAT_MESSAGE',
      'GROUP_INVITE',
      'GROUP_REMOVE',
    ] as const;

    for (const type of types) {
      prismaMock.notification.create.mockResolvedValue({ type });

      await createNotification(USER_ID, type, 'Title', 'Message');

      expect(prismaMock.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type }),
        }),
      );
    }
  });
});

describe('getUserNotifications', () => {
  it('should return notifications with default pagination', async () => {
    const notifications = [
      { id: 'n1', title: 'First', createdAt: new Date() },
      { id: 'n2', title: 'Second', createdAt: new Date() },
    ];
    prismaMock.notification.findMany.mockResolvedValue(notifications);

    const result = await getUserNotifications(USER_ID);

    expect(prismaMock.notification.findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: { createdAt: 'desc' },
      skip: 0,
      take: 50,
    });
    expect(result).toEqual(notifications);
  });

  it('should apply custom pagination parameters', async () => {
    prismaMock.notification.findMany.mockResolvedValue([]);

    await getUserNotifications(USER_ID, 3, 10);

    expect(prismaMock.notification.findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: { createdAt: 'desc' },
      skip: 20, // (3 - 1) * 10
      take: 10,
    });
  });

  it('should return empty array when user has no notifications', async () => {
    prismaMock.notification.findMany.mockResolvedValue([]);

    const result = await getUserNotifications(USER_ID);

    expect(result).toEqual([]);
  });
});

describe('markNotificationAsRead', () => {
  it('should mark a single notification as read scoped to the user', async () => {
    const updateResult = { count: 1 };
    prismaMock.notification.updateMany.mockResolvedValue(updateResult);

    const result = await markNotificationAsRead(NOTIFICATION_ID, USER_ID);

    expect(prismaMock.notification.updateMany).toHaveBeenCalledWith({
      where: { id: NOTIFICATION_ID, userId: USER_ID },
      data: { isRead: true },
    });
    expect(result).toEqual(updateResult);
  });

  it('should return count 0 when notification does not belong to user', async () => {
    prismaMock.notification.updateMany.mockResolvedValue({ count: 0 });

    const result = await markNotificationAsRead(NOTIFICATION_ID, 'other-user');

    expect(result).toEqual({ count: 0 });
  });
});

describe('markAllNotificationsAsRead', () => {
  it('should mark all unread notifications as read for a user', async () => {
    prismaMock.notification.updateMany.mockResolvedValue({ count: 5 });

    const result = await markAllNotificationsAsRead(USER_ID);

    expect(prismaMock.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, isRead: false },
      data: { isRead: true },
    });
    expect(result).toEqual({ count: 5 });
  });

  it('should return count 0 when all notifications are already read', async () => {
    prismaMock.notification.updateMany.mockResolvedValue({ count: 0 });

    const result = await markAllNotificationsAsRead(USER_ID);

    expect(result).toEqual({ count: 0 });
  });
});

describe('deleteNotification', () => {
  it('should delete a notification scoped to the user', async () => {
    prismaMock.notification.deleteMany.mockResolvedValue({ count: 1 });

    const result = await deleteNotification(NOTIFICATION_ID, USER_ID);

    expect(prismaMock.notification.deleteMany).toHaveBeenCalledWith({
      where: { id: NOTIFICATION_ID, userId: USER_ID },
    });
    expect(result).toEqual({ count: 1 });
  });

  it('should return count 0 when notification does not belong to user', async () => {
    prismaMock.notification.deleteMany.mockResolvedValue({ count: 0 });

    const result = await deleteNotification('non-existent', USER_ID);

    expect(result).toEqual({ count: 0 });
  });
});
