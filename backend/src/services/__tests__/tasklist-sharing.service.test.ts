import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';
import {
  shareTaskList,
  revokeTaskListShare,
  getSharedTaskLists,
  respondToTaskListShareById,
} from '../tasklist-sharing.service';

// Mock sibling services
vi.mock('../email.service', () => ({
  sendNotificationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

import * as emailService from '../email.service';
import * as notificationService from '../notification.service';

const prismaMock = prisma as any;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const OWNER_ID = 'owner-id-1';
const TARGET_USER_ID = 'target-user-id-2';
const TASK_LIST_ID = 'tasklist-id-1';

const ownerUser = { id: OWNER_ID, name: 'Owner', email: 'owner@test.com', locale: 'en' };
const targetUser = { id: TARGET_USER_ID, name: 'Target', email: 'target@test.com', locale: 'en' };

const sampleTaskList = {
  id: TASK_LIST_ID,
  title: 'My Task List',
  userId: OWNER_ID,
};

// ---------------------------------------------------------------------------
// Reset all mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// shareTaskList
// ===========================================================================

describe('shareTaskList', () => {
  it('should create a share with PENDING status', async () => {
    prismaMock.taskList.findUnique.mockResolvedValue(sampleTaskList);
    prismaMock.user.findUnique
      .mockResolvedValueOnce(targetUser)  // target lookup
      .mockResolvedValueOnce(ownerUser);  // owner lookup for email
    const sharedRecord = {
      id: 'shared-1',
      taskListId: TASK_LIST_ID,
      userId: TARGET_USER_ID,
      permission: 'READ',
      status: 'PENDING',
      user: targetUser,
    };
    prismaMock.sharedTaskList.upsert.mockResolvedValue(sharedRecord);

    const result = await shareTaskList(OWNER_ID, TASK_LIST_ID, targetUser.email, 'READ');

    expect(result).toEqual(sharedRecord);
    expect(result.status).toBe('PENDING');
    expect(prismaMock.taskList.findUnique).toHaveBeenCalledWith({ where: { id: TASK_LIST_ID } });
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({ where: { email: targetUser.email } });
    expect(prismaMock.sharedTaskList.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { taskListId_userId: { taskListId: TASK_LIST_ID, userId: TARGET_USER_ID } },
        create: expect.objectContaining({ permission: 'READ', status: 'PENDING' }),
        update: expect.objectContaining({ permission: 'READ', status: 'PENDING' }),
      }),
    );
  });

  it('should send email and in-app notification', async () => {
    prismaMock.taskList.findUnique.mockResolvedValue(sampleTaskList);
    prismaMock.user.findUnique
      .mockResolvedValueOnce(targetUser)
      .mockResolvedValueOnce(ownerUser);
    const sharedRecord = {
      id: 'shared-1',
      taskListId: TASK_LIST_ID,
      userId: TARGET_USER_ID,
      permission: 'READ',
      status: 'PENDING',
      user: targetUser,
    };
    prismaMock.sharedTaskList.upsert.mockResolvedValue(sharedRecord);

    await shareTaskList(OWNER_ID, TASK_LIST_ID, targetUser.email, 'READ');

    expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
      targetUser.email,
      'SHARE_INVITATION',
      expect.objectContaining({
        sharerName: ownerUser.name,
        itemName: sampleTaskList.title,
        itemType: 'Task List',
        shareId: sharedRecord.id,
        tab: 'taskLists',
        locale: targetUser.locale,
      }),
    );
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      TARGET_USER_ID,
      'TASK_LIST_SHARED',
      'Task List Shared',
      expect.stringContaining(sampleTaskList.title),
      expect.objectContaining({
        taskListId: TASK_LIST_ID,
        taskListTitle: sampleTaskList.title,
        status: 'PENDING',
        localizationKey: 'notifications.taskListShared',
      }),
    );
  });

  it('should throw NotFoundError when task list not found', async () => {
    prismaMock.taskList.findUnique.mockResolvedValue(null);

    await expect(
      shareTaskList(OWNER_ID, TASK_LIST_ID, targetUser.email, 'READ'),
    ).rejects.toThrow('errors.tasks.listNotFoundOrDenied');
    expect(prismaMock.sharedTaskList.upsert).not.toHaveBeenCalled();
  });

  it('should throw NotFoundError when caller is not the owner', async () => {
    prismaMock.taskList.findUnique.mockResolvedValue({ ...sampleTaskList, userId: 'other-owner' });

    await expect(
      shareTaskList(OWNER_ID, TASK_LIST_ID, targetUser.email, 'READ'),
    ).rejects.toThrow('errors.tasks.listNotFoundOrDenied');
    expect(prismaMock.sharedTaskList.upsert).not.toHaveBeenCalled();
  });

  it('should throw BadRequestError for self-share', async () => {
    prismaMock.taskList.findUnique.mockResolvedValue(sampleTaskList);
    prismaMock.user.findUnique.mockResolvedValue(ownerUser);

    await expect(
      shareTaskList(OWNER_ID, TASK_LIST_ID, ownerUser.email, 'WRITE'),
    ).rejects.toThrow('errors.sharing.cannotShareSelf');
  });

  it('should throw NotFoundError when target user does not exist', async () => {
    prismaMock.taskList.findUnique.mockResolvedValue(sampleTaskList);
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(
      shareTaskList(OWNER_ID, TASK_LIST_ID, 'nobody@test.com', 'READ'),
    ).rejects.toThrow('errors.user.notFound');
  });

  it('should still return the shared record when email sending fails', async () => {
    prismaMock.taskList.findUnique.mockResolvedValue(sampleTaskList);
    prismaMock.user.findUnique
      .mockResolvedValueOnce(targetUser)
      .mockResolvedValueOnce(ownerUser);
    const sharedRecord = {
      id: 'shared-1',
      taskListId: TASK_LIST_ID,
      userId: TARGET_USER_ID,
      permission: 'READ',
      status: 'PENDING',
      user: targetUser,
    };
    prismaMock.sharedTaskList.upsert.mockResolvedValue(sharedRecord);
    vi.mocked(emailService.sendNotificationEmail).mockRejectedValueOnce(new Error('SMTP down'));

    const result = await shareTaskList(OWNER_ID, TASK_LIST_ID, targetUser.email, 'READ');

    // The function catches email errors and continues
    expect(result).toEqual(sharedRecord);
  });

  it('should skip email and notification when owner lookup returns null', async () => {
    prismaMock.taskList.findUnique.mockResolvedValue(sampleTaskList);
    prismaMock.user.findUnique
      .mockResolvedValueOnce(targetUser)
      .mockResolvedValueOnce(null); // owner not found (edge case)
    const sharedRecord = {
      id: 'shared-1',
      taskListId: TASK_LIST_ID,
      userId: TARGET_USER_ID,
      permission: 'READ',
      status: 'PENDING',
      user: targetUser,
    };
    prismaMock.sharedTaskList.upsert.mockResolvedValue(sharedRecord);

    const result = await shareTaskList(OWNER_ID, TASK_LIST_ID, targetUser.email, 'READ');

    expect(result).toEqual(sharedRecord);
    expect(emailService.sendNotificationEmail).not.toHaveBeenCalled();
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// revokeTaskListShare
// ===========================================================================

describe('revokeTaskListShare', () => {
  it('should delete the shared task list record when owner revokes', async () => {
    prismaMock.taskList.findUnique.mockResolvedValue(sampleTaskList);
    prismaMock.sharedTaskList.delete.mockResolvedValue({
      taskListId: TASK_LIST_ID,
      userId: TARGET_USER_ID,
    });

    const result = await revokeTaskListShare(OWNER_ID, TASK_LIST_ID, TARGET_USER_ID);

    expect(result).toEqual({ taskListId: TASK_LIST_ID, userId: TARGET_USER_ID });
    expect(prismaMock.sharedTaskList.delete).toHaveBeenCalledWith({
      where: { taskListId_userId: { taskListId: TASK_LIST_ID, userId: TARGET_USER_ID } },
    });
  });

  it('should throw NotFoundError when task list not found', async () => {
    prismaMock.taskList.findUnique.mockResolvedValue(null);

    await expect(
      revokeTaskListShare(OWNER_ID, TASK_LIST_ID, TARGET_USER_ID),
    ).rejects.toThrow('errors.tasks.listNotFoundOrDenied');
    expect(prismaMock.sharedTaskList.delete).not.toHaveBeenCalled();
  });

  it('should throw NotFoundError when caller is not the owner', async () => {
    prismaMock.taskList.findUnique.mockResolvedValue({ ...sampleTaskList, userId: 'someone-else' });

    await expect(
      revokeTaskListShare(OWNER_ID, TASK_LIST_ID, TARGET_USER_ID),
    ).rejects.toThrow('errors.tasks.listNotFoundOrDenied');
    expect(prismaMock.sharedTaskList.delete).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// getSharedTaskLists
// ===========================================================================

describe('getSharedTaskLists', () => {
  it('should return shared task lists for the given user', async () => {
    const rows = [
      {
        taskListId: TASK_LIST_ID,
        userId: TARGET_USER_ID,
        status: 'ACCEPTED',
        taskList: {
          id: TASK_LIST_ID,
          title: 'My Task List',
          items: [],
          user: ownerUser,
        },
      },
    ];
    prismaMock.sharedTaskList.findMany.mockResolvedValue(rows);

    const result = await getSharedTaskLists(TARGET_USER_ID);

    expect(result).toEqual(rows);
    expect(prismaMock.sharedTaskList.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: TARGET_USER_ID },
        include: expect.objectContaining({
          taskList: expect.objectContaining({
            include: expect.objectContaining({
              items: expect.any(Object),
              user: expect.any(Object),
            }),
          }),
        }),
      }),
    );
  });

  it('should return an empty array when no shared task lists exist', async () => {
    prismaMock.sharedTaskList.findMany.mockResolvedValue([]);

    const result = await getSharedTaskLists(TARGET_USER_ID);

    expect(result).toEqual([]);
  });
});

// ===========================================================================
// respondToTaskListShareById
// ===========================================================================

describe('respondToTaskListShareById', () => {
  it('should accept a task list share and notify the owner', async () => {
    const existing = { taskListId: TASK_LIST_ID, userId: TARGET_USER_ID, status: 'PENDING' };
    prismaMock.sharedTaskList.findUnique.mockResolvedValue(existing);
    const updateResult = {
      taskListId: TASK_LIST_ID,
      userId: TARGET_USER_ID,
      status: 'ACCEPTED',
      taskList: { ...sampleTaskList, user: ownerUser },
      user: targetUser,
    };
    prismaMock.sharedTaskList.update.mockResolvedValue(updateResult);

    const result = await respondToTaskListShareById(TARGET_USER_ID, TASK_LIST_ID, 'accept');

    expect(result).toEqual({ success: true, status: 'ACCEPTED' });
    expect(prismaMock.sharedTaskList.findUnique).toHaveBeenCalledWith({
      where: { taskListId_userId: { taskListId: TASK_LIST_ID, userId: TARGET_USER_ID } },
    });
    expect(prismaMock.sharedTaskList.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'ACCEPTED' },
      }),
    );
    expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
      ownerUser.email,
      'SHARE_RESPONSE',
      expect.objectContaining({ action: 'accepted', itemName: sampleTaskList.title }),
    );
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      OWNER_ID,
      'SYSTEM',
      'Invitation Update',
      expect.stringContaining('accepted'),
      expect.objectContaining({
        itemId: TASK_LIST_ID,
        type: 'TASKLIST',
        action: 'accept',
        localizationKey: 'notifications.shareResponseAccepted',
      }),
    );
  });

  it('should decline a task list share and notify the owner', async () => {
    const existing = { taskListId: TASK_LIST_ID, userId: TARGET_USER_ID, status: 'PENDING' };
    prismaMock.sharedTaskList.findUnique.mockResolvedValue(existing);
    const updateResult = {
      taskListId: TASK_LIST_ID,
      userId: TARGET_USER_ID,
      status: 'DECLINED',
      taskList: { ...sampleTaskList, user: ownerUser },
      user: targetUser,
    };
    prismaMock.sharedTaskList.update.mockResolvedValue(updateResult);

    const result = await respondToTaskListShareById(TARGET_USER_ID, TASK_LIST_ID, 'decline');

    expect(result).toEqual({ success: true, status: 'DECLINED' });
    expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
      ownerUser.email,
      'SHARE_RESPONSE',
      expect.objectContaining({ action: 'declined' }),
    );
    // Note: the service uses `${action}ed` which produces "declineed" — a known typo
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      OWNER_ID,
      'SYSTEM',
      'Invitation Update',
      expect.stringContaining('declineed'),
      expect.objectContaining({
        localizationKey: 'notifications.shareResponseDeclined',
      }),
    );
  });

  it('should throw NotFoundError when invitation does not exist', async () => {
    prismaMock.sharedTaskList.findUnique.mockResolvedValue(null);

    await expect(
      respondToTaskListShareById(TARGET_USER_ID, TASK_LIST_ID, 'accept'),
    ).rejects.toThrow('errors.sharing.invitationNotFound');
    expect(prismaMock.sharedTaskList.update).not.toHaveBeenCalled();
  });

  it('should return early without updating when share is already responded to', async () => {
    const existing = { taskListId: TASK_LIST_ID, userId: TARGET_USER_ID, status: 'ACCEPTED' };
    prismaMock.sharedTaskList.findUnique.mockResolvedValue(existing);

    const result = await respondToTaskListShareById(TARGET_USER_ID, TASK_LIST_ID, 'accept');

    expect(result).toEqual({ success: true, status: 'ACCEPTED' });
    expect(prismaMock.sharedTaskList.update).not.toHaveBeenCalled();
    expect(emailService.sendNotificationEmail).not.toHaveBeenCalled();
  });

  it('should still succeed when notification sending fails', async () => {
    const existing = { taskListId: TASK_LIST_ID, userId: TARGET_USER_ID, status: 'PENDING' };
    prismaMock.sharedTaskList.findUnique.mockResolvedValue(existing);
    const updateResult = {
      taskListId: TASK_LIST_ID,
      userId: TARGET_USER_ID,
      status: 'ACCEPTED',
      taskList: { ...sampleTaskList, user: ownerUser },
      user: targetUser,
    };
    prismaMock.sharedTaskList.update.mockResolvedValue(updateResult);
    vi.mocked(emailService.sendNotificationEmail).mockRejectedValueOnce(new Error('SMTP down'));

    const result = await respondToTaskListShareById(TARGET_USER_ID, TASK_LIST_ID, 'accept');

    // The function catches notification errors and continues
    expect(result).toEqual({ success: true, status: 'ACCEPTED' });
  });

  it('should skip notifications when owner is null', async () => {
    const existing = { taskListId: TASK_LIST_ID, userId: TARGET_USER_ID, status: 'PENDING' };
    prismaMock.sharedTaskList.findUnique.mockResolvedValue(existing);
    const updateResult = {
      taskListId: TASK_LIST_ID,
      userId: TARGET_USER_ID,
      status: 'ACCEPTED',
      taskList: { ...sampleTaskList, user: null },
      user: targetUser,
    };
    prismaMock.sharedTaskList.update.mockResolvedValue(updateResult);

    const result = await respondToTaskListShareById(TARGET_USER_ID, TASK_LIST_ID, 'accept');

    expect(result).toEqual({ success: true, status: 'ACCEPTED' });
    expect(emailService.sendNotificationEmail).not.toHaveBeenCalled();
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });
});
