import prisma from '../plugins/prisma';
import logger from '../utils/logger';
import * as notificationService from './notification.service';
import * as emailService from './email.service';
import { NotFoundError, BadRequestError } from '../utils/errors';
import { createFriendship, getFriendship } from './friendship.service';

export const shareTaskList = async (
  ownerId: string,
  taskListId: string,
  targetEmail: string,
  permission: 'READ' | 'WRITE'
) => {
  const taskList = await prisma.taskList.findUnique({
    where: { id: taskListId },
  });

  if (!taskList || taskList.userId !== ownerId) {
    throw new NotFoundError('errors.tasks.listNotFoundOrDenied');
  }

  const targetUser = await prisma.user.findUnique({
    where: { email: targetEmail },
  });

  if (!targetUser) {
    throw new NotFoundError('errors.user.notFound');
  }

  if (targetUser.id === ownerId) {
    throw new BadRequestError('errors.sharing.cannotShareSelf');
  }

  const sharedTaskList = await prisma.sharedTaskList.upsert({
    where: {
      taskListId_userId: {
        taskListId,
        userId: targetUser.id,
      },
    },
    update: {
      permission,
      status: 'PENDING',
    },
    create: {
      taskListId,
      userId: targetUser.id,
      permission,
      status: 'PENDING',
    },
    include: {
      user: {
        select: { id: true, name: true, email: true, avatarUrl: true },
      },
    },
  });

  const owner = await prisma.user.findUnique({ where: { id: ownerId } });

  if (owner) {
    try {
      await emailService.sendNotificationEmail(
        targetUser.email,
        'SHARE_INVITATION',
        {
          sharerName: owner.name || owner.email,
          itemName: taskList.title,
          itemType: 'Task List',
          shareId: sharedTaskList.id,
          tab: 'taskLists',
          locale: targetUser.locale,
        }
      );

      await notificationService.createNotification(
        targetUser.id,
        'TASK_LIST_SHARED',
        'Task List Shared',
        `${owner.name || owner.email} shared a task list: ${taskList.title}`,
        {
          taskListId,
          taskListTitle: taskList.title,
          sharerName: owner.name || owner.email,
          status: 'PENDING',
          localizationKey: 'notifications.taskListShared',
          localizationArgs: { sharerName: owner.name || owner.email, listTitle: taskList.title },
        }
      );
    } catch (e) {
      logger.error(e, 'Failed to send task list share notification');
    }
  }

  return sharedTaskList;
};

export const revokeTaskListShare = async (
  ownerId: string,
  taskListId: string,
  targetUserId: string
) => {
  const taskList = await prisma.taskList.findUnique({
    where: { id: taskListId },
  });

  if (!taskList || taskList.userId !== ownerId) {
    throw new NotFoundError('errors.tasks.listNotFoundOrDenied');
  }

  return prisma.sharedTaskList.delete({
    where: {
      taskListId_userId: {
        taskListId,
        userId: targetUserId,
      },
    },
  });
};

export const getSharedTaskLists = async (userId: string) => {
  return prisma.sharedTaskList.findMany({
    where: { userId },
    include: {
      taskList: {
        include: {
          items: {
            orderBy: { position: 'asc' },
            include: {
              checkedByUser: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
            },
          },
          user: {
            select: { id: true, name: true, email: true, avatarUrl: true },
          },
        },
      },
    },
  });
};

export const respondToTaskListShareById = async (
  userId: string,
  taskListId: string,
  action: 'accept' | 'decline'
) => {
  const status = action === 'accept' ? 'ACCEPTED' : 'DECLINED';

  const existing = await prisma.sharedTaskList.findUnique({
    where: { taskListId_userId: { taskListId, userId } },
  });

  if (!existing) throw new NotFoundError('errors.sharing.invitationNotFound');
  if (existing.status !== 'PENDING') return { success: true, status: existing.status };

  const result = await prisma.sharedTaskList.update({
    where: {
      taskListId_userId: { taskListId, userId },
    },
    data: { status },
    include: {
      taskList: { include: { user: true } },
      user: true,
    },
  });

  // Auto-create friendship on share accept
  if (action === 'accept') {
    const taskListOwnerId = result.taskList.user.id;
    try {
      const existing = await getFriendship(taskListOwnerId, userId);
      if (!existing) {
        await createFriendship(taskListOwnerId, userId);
      }
    } catch (e) {
      // Non-critical — don't fail the accept if friendship creation fails
      logger.warn({ err: e, ownerId: taskListOwnerId, userId }, 'Auto-friendship creation failed');
    }
  }

  // Notify owner
  const owner = result.taskList.user;
  const responder = result.user;

  if (owner) {
    try {
      await emailService.sendNotificationEmail(
        owner.email,
        'SHARE_RESPONSE',
        {
          responderName: responder.name || responder.email,
          action: action === 'accept' ? 'accepted' : 'declined',
          itemName: result.taskList.title,
          itemId: taskListId,
          locale: owner.locale,
        }
      );

      await notificationService.createNotification(
        owner.id,
        'SYSTEM',
        'Invitation Update',
        `${responder.name || responder.email} ${action}ed your invitation to ${result.taskList.title}`,
        {
          itemId: taskListId,
          type: 'TASKLIST',
          action,
          responderName: responder.name || responder.email,
          itemName: result.taskList.title,
          localizationKey: action === 'accept' ? 'notifications.shareResponseAccepted' : 'notifications.shareResponseDeclined',
          localizationArgs: { responderName: responder.name || responder.email, itemName: result.taskList.title },
        }
      );
    } catch (e) {
      logger.error(e, 'Failed to send task list share response notification');
    }
  }

  return { success: true, status };
};
