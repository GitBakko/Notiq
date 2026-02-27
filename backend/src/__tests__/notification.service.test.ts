import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock push service before imports
vi.mock('../services/push.service', () => ({
  sendPushNotification: vi.fn().mockResolvedValue(undefined),
}));

import prisma from '../plugins/prisma';
import {
  createNotification,
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  deleteAllNotifications,
} from '../services/notification.service';
import { sendPushNotification } from '../services/push.service';

const prismaMock = vi.mocked(prisma, true);
const sendPushMock = vi.mocked(sendPushNotification);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('notification.service — createNotification', () => {
  it('should create a notification and skip push if user is active', async () => {
    const mockNotification = {
      id: 'notif-1',
      userId: 'user-1',
      type: 'SYSTEM',
      title: 'Test',
      message: 'Hello',
    };
    prismaMock.notification.create.mockResolvedValueOnce(mockNotification as any);
    prismaMock.user.findUnique.mockResolvedValueOnce({
      lastActiveAt: new Date(), // just now — active
    } as any);

    const result = await createNotification('user-1', 'SYSTEM', 'Test', 'Hello');

    expect(result).toEqual(mockNotification);
    expect(prismaMock.notification.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        type: 'SYSTEM',
        title: 'Test',
        message: 'Hello',
        data: undefined,
      },
    });
    expect(sendPushMock).not.toHaveBeenCalled();
  });

  it('should send push notification if user is inactive (>5 min)', async () => {
    const mockNotification = { id: 'notif-1', userId: 'user-1', type: 'SHARE_NOTE', title: 'Shared', message: 'Note shared' };
    prismaMock.notification.create.mockResolvedValueOnce(mockNotification as any);
    // User inactive for 10 minutes
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    prismaMock.user.findUnique.mockResolvedValueOnce({
      lastActiveAt: tenMinAgo,
    } as any);

    await createNotification('user-1', 'SHARE_NOTE', 'Shared', 'Note shared', { noteId: 'n-1' });

    expect(sendPushMock).toHaveBeenCalledWith('user-1', {
      title: 'Shared',
      body: 'Note shared',
      data: { noteId: 'n-1', type: 'SHARE_NOTE' },
    });
  });

  it('should not crash if push notification fails', async () => {
    prismaMock.notification.create.mockResolvedValueOnce({ id: 'notif-1' } as any);
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    prismaMock.user.findUnique.mockResolvedValueOnce({ lastActiveAt: tenMinAgo } as any);
    sendPushMock.mockRejectedValueOnce(new Error('Push failed'));

    // Should not throw
    const result = await createNotification('user-1', 'SYSTEM', 'Test', 'Message');
    expect(result).toBeDefined();
  });

  it('should store custom data in notification', async () => {
    prismaMock.notification.create.mockResolvedValueOnce({ id: 'notif-1' } as any);
    prismaMock.user.findUnique.mockResolvedValueOnce({ lastActiveAt: new Date() } as any);

    await createNotification('user-1', 'KANBAN_CARD_ASSIGNED', 'Card Assigned', 'You were assigned', {
      boardId: 'b-1',
      cardId: 'c-1',
    });

    expect(prismaMock.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        data: { boardId: 'b-1', cardId: 'c-1' },
      }),
    });
  });
});

describe('notification.service — getUserNotifications', () => {
  it('should return paginated notifications', async () => {
    const mockNotifications = [
      { id: 'n-1', title: 'First' },
      { id: 'n-2', title: 'Second' },
    ];
    prismaMock.notification.findMany.mockResolvedValueOnce(mockNotifications as any);

    const result = await getUserNotifications('user-1', 1, 50);

    expect(result).toEqual(mockNotifications);
    expect(prismaMock.notification.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'desc' },
      skip: 0,
      take: 50,
    });
  });

  it('should handle page 2 with correct offset', async () => {
    prismaMock.notification.findMany.mockResolvedValueOnce([]);

    await getUserNotifications('user-1', 2, 10);

    expect(prismaMock.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 })
    );
  });
});

describe('notification.service — markNotificationAsRead', () => {
  it('should mark a single notification as read', async () => {
    prismaMock.notification.updateMany.mockResolvedValueOnce({ count: 1 } as any);

    const result = await markNotificationAsRead('notif-1', 'user-1');
    expect(result.count).toBe(1);
    expect(prismaMock.notification.updateMany).toHaveBeenCalledWith({
      where: { id: 'notif-1', userId: 'user-1' },
      data: { isRead: true },
    });
  });
});

describe('notification.service — markAllNotificationsAsRead', () => {
  it('should mark all unread notifications as read', async () => {
    prismaMock.notification.updateMany.mockResolvedValueOnce({ count: 5 } as any);

    const result = await markAllNotificationsAsRead('user-1');
    expect(result.count).toBe(5);
    expect(prismaMock.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', isRead: false },
      data: { isRead: true },
    });
  });
});

describe('notification.service — deleteNotification', () => {
  it('should delete a single notification scoped to user', async () => {
    prismaMock.notification.deleteMany.mockResolvedValueOnce({ count: 1 } as any);

    const result = await deleteNotification('notif-1', 'user-1');
    expect(result.count).toBe(1);
    expect(prismaMock.notification.deleteMany).toHaveBeenCalledWith({
      where: { id: 'notif-1', userId: 'user-1' },
    });
  });
});

describe('notification.service — deleteAllNotifications', () => {
  it('should delete all notifications for user', async () => {
    prismaMock.notification.deleteMany.mockResolvedValueOnce({ count: 10 } as any);

    const result = await deleteAllNotifications('user-1');
    expect(result.count).toBe(10);
  });
});
