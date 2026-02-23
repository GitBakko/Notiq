import prisma from '../plugins/prisma';
import logger from '../utils/logger';
import * as notificationService from './notification.service';

// ── Internal helpers ──────────────────────────────────────────────

async function assertWriteAccess(userId: string, taskListId: string): Promise<void> {
  const taskList = await prisma.taskList.findUnique({
    where: { id: taskListId },
    select: { userId: true },
  });

  if (taskList && taskList.userId === userId) return;

  const shared = await prisma.sharedTaskList.findUnique({
    where: { taskListId_userId: { taskListId, userId } },
    select: { permission: true, status: true },
  });

  if (shared && shared.status === 'ACCEPTED' && shared.permission === 'WRITE') return;

  throw new Error('Access denied');
}

async function notifyCollaborators(
  actorUserId: string,
  taskListId: string,
  type: 'TASK_ITEM_ADDED' | 'TASK_ITEM_CHECKED' | 'TASK_ITEM_REMOVED',
  itemText: string
): Promise<void> {
  const taskList = await prisma.taskList.findUnique({
    where: { id: taskListId },
    include: {
      user: { select: { id: true, name: true, email: true } },
      sharedWith: {
        where: { status: 'ACCEPTED' },
        select: { userId: true },
      },
    },
  });

  if (!taskList) return;

  const actor = await prisma.user.findUnique({
    where: { id: actorUserId },
    select: { name: true, email: true },
  });

  const actorName = actor?.name || actor?.email || 'Someone';
  const recipientIds = new Set<string>();

  // Owner
  if (taskList.userId !== actorUserId) {
    recipientIds.add(taskList.userId);
  }

  // Accepted collaborators
  for (const share of taskList.sharedWith) {
    if (share.userId !== actorUserId) {
      recipientIds.add(share.userId);
    }
  }

  for (const recipientId of recipientIds) {
    try {
      await notificationService.createNotification(
        recipientId,
        type,
        taskList.title,
        `${actorName}: ${itemText}`,
        {
          taskListId,
          taskListTitle: taskList.title,
          actorName,
          itemText,
          localizationKey: `notifications.${type}`,
          localizationArgs: { actorName, itemText, listTitle: taskList.title },
        }
      );
    } catch (err) {
      logger.error(err, 'Failed to notify collaborator %s for task list %s', recipientId, taskListId);
    }
  }
}

// ── TaskList CRUD ─────────────────────────────────────────────────

export const createTaskList = async (userId: string, title: string, id?: string) => {
  return prisma.taskList.create({
    data: {
      ...(id ? { id } : {}),
      title,
      userId,
    },
    include: {
      items: { orderBy: { position: 'asc' } },
    },
  });
};

export const getTaskLists = async (userId: string) => {
  return prisma.taskList.findMany({
    where: { userId, isTrashed: false },
    include: {
      items: { orderBy: { position: 'asc' } },
      sharedWith: {
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });
};

export const getTaskList = async (userId: string, id: string) => {
  const taskList = await prisma.taskList.findUnique({
    where: { id },
    include: {
      items: { orderBy: { position: 'asc' } },
      sharedWith: {
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      },
      user: { select: { id: true, name: true, email: true } },
    },
  });

  if (!taskList) throw new Error('TaskList not found');

  // Owner can always access
  if (taskList.userId === userId) return taskList;

  // Check accepted share
  const shared = await prisma.sharedTaskList.findUnique({
    where: { taskListId_userId: { taskListId: id, userId } },
    select: { status: true },
  });

  if (shared && shared.status === 'ACCEPTED') return taskList;

  throw new Error('TaskList not found');
};

export const updateTaskList = async (userId: string, id: string, data: { title?: string }) => {
  await assertWriteAccess(userId, id);

  return prisma.taskList.update({
    where: { id },
    data,
    include: {
      items: { orderBy: { position: 'asc' } },
    },
  });
};

export const deleteTaskList = async (userId: string, id: string) => {
  const taskList = await prisma.taskList.findUnique({
    where: { id },
    select: { userId: true },
  });

  if (!taskList || taskList.userId !== userId) {
    throw new Error('Access denied');
  }

  return prisma.taskList.update({
    where: { id },
    data: { isTrashed: true },
  });
};

// ── TaskItem CRUD ─────────────────────────────────────────────────

export const addTaskItem = async (
  userId: string,
  taskListId: string,
  data: { id?: string; text: string; priority?: 'LOW' | 'MEDIUM' | 'HIGH'; dueDate?: string | null }
) => {
  await assertWriteAccess(userId, taskListId);

  const maxPosition = await prisma.taskItem.aggregate({
    where: { taskListId },
    _max: { position: true },
  });

  const position = (maxPosition._max.position ?? -1) + 1;

  const item = await prisma.taskItem.create({
    data: {
      ...(data.id ? { id: data.id } : {}),
      taskListId,
      text: data.text,
      priority: data.priority || 'MEDIUM',
      dueDate: data.dueDate ? new Date(data.dueDate) : null,
      position,
    },
  });

  await notifyCollaborators(userId, taskListId, 'TASK_ITEM_ADDED', data.text);

  return item;
};

export const updateTaskItem = async (
  userId: string,
  taskListId: string,
  itemId: string,
  data: { text?: string; isChecked?: boolean; priority?: 'LOW' | 'MEDIUM' | 'HIGH'; dueDate?: string | null; position?: number }
) => {
  await assertWriteAccess(userId, taskListId);

  const existing = await prisma.taskItem.findUnique({
    where: { id: itemId },
    select: { taskListId: true, isChecked: true, text: true },
  });

  if (!existing || existing.taskListId !== taskListId) {
    throw new Error('TaskItem not found');
  }

  const updateData: any = {};
  if (data.text !== undefined) updateData.text = data.text;
  if (data.isChecked !== undefined) updateData.isChecked = data.isChecked;
  if (data.priority !== undefined) updateData.priority = data.priority;
  if (data.dueDate !== undefined) updateData.dueDate = data.dueDate ? new Date(data.dueDate) : null;
  if (data.position !== undefined) updateData.position = data.position;

  const item = await prisma.taskItem.update({
    where: { id: itemId },
    data: updateData,
  });

  if (data.isChecked !== undefined && data.isChecked !== existing.isChecked) {
    await notifyCollaborators(userId, taskListId, 'TASK_ITEM_CHECKED', existing.text);
  }

  return item;
};

export const deleteTaskItem = async (userId: string, taskListId: string, itemId: string) => {
  await assertWriteAccess(userId, taskListId);

  const existing = await prisma.taskItem.findUnique({
    where: { id: itemId },
    select: { taskListId: true, text: true },
  });

  if (!existing || existing.taskListId !== taskListId) {
    throw new Error('TaskItem not found');
  }

  await prisma.taskItem.delete({ where: { id: itemId } });

  await notifyCollaborators(userId, taskListId, 'TASK_ITEM_REMOVED', existing.text);

  return { success: true };
};

export const reorderTaskItems = async (
  userId: string,
  taskListId: string,
  items: { id: string; position: number }[]
) => {
  await assertWriteAccess(userId, taskListId);

  await prisma.$transaction(
    items.map((item) =>
      prisma.taskItem.update({
        where: { id: item.id },
        data: { position: item.position },
      })
    )
  );

  return { success: true };
};

// ── Sharing helpers ───────────────────────────────────────────────

export const getAcceptedSharedTaskLists = async (userId: string) => {
  const shared = await prisma.sharedTaskList.findMany({
    where: { userId, status: 'ACCEPTED' },
    select: {
      permission: true,
      taskList: {
        include: {
          items: { orderBy: { position: 'asc' } },
          user: { select: { id: true, name: true, email: true } },
          sharedWith: {
            include: {
              user: { select: { id: true, name: true, email: true } },
            },
          },
        },
      },
    },
  });

  return shared.map((s) => ({ ...s.taskList, _sharedPermission: s.permission }));
};
