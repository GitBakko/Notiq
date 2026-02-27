import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock notification service before imports
vi.mock('../services/notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue({ id: 'notif-1' }),
}));

import prisma from '../plugins/prisma';
import {
  createTaskList,
  getTaskList,
  getTaskLists,
  updateTaskList,
  deleteTaskList,
  addTaskItem,
  updateTaskItem,
  deleteTaskItem,
} from '../services/tasklist.service';

// The setup.ts mock doesn't include taskList, taskItem, sharedTaskList.
// Augment the existing mock object with the missing models.
const prismaMock = prisma as any;

// Add missing models to the already-mocked prisma object
prismaMock.taskList = {
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

prismaMock.taskItem = {
  findUnique: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  aggregate: vi.fn(),
};

prismaMock.sharedTaskList = {
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  upsert: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();

  // Re-create the mock functions after clearAllMocks wipes them
  prismaMock.taskList.findUnique = vi.fn();
  prismaMock.taskList.findFirst = vi.fn();
  prismaMock.taskList.findMany = vi.fn();
  prismaMock.taskList.create = vi.fn();
  prismaMock.taskList.update = vi.fn();
  prismaMock.taskList.delete = vi.fn();

  prismaMock.taskItem.findUnique = vi.fn();
  prismaMock.taskItem.findMany = vi.fn();
  prismaMock.taskItem.create = vi.fn();
  prismaMock.taskItem.update = vi.fn();
  prismaMock.taskItem.delete = vi.fn();
  prismaMock.taskItem.aggregate = vi.fn();

  prismaMock.sharedTaskList.findUnique = vi.fn();
  prismaMock.sharedTaskList.findFirst = vi.fn();
  prismaMock.sharedTaskList.findMany = vi.fn();
  prismaMock.sharedTaskList.create = vi.fn();
  prismaMock.sharedTaskList.update = vi.fn();
  prismaMock.sharedTaskList.delete = vi.fn();
  prismaMock.sharedTaskList.upsert = vi.fn();
});

describe('tasklist.service — createTaskList', () => {
  it('should create a task list', async () => {
    const mockList = { id: 'tl-1', title: 'My Tasks', userId: 'user-1', items: [] };
    prismaMock.taskList.create.mockResolvedValueOnce(mockList);

    const result = await createTaskList('user-1', 'My Tasks');
    expect(result).toEqual(mockList);
    expect(prismaMock.taskList.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ title: 'My Tasks', userId: 'user-1' }),
      })
    );
  });

  it('should create a task list with custom id', async () => {
    const mockList = { id: 'custom-id', title: 'Custom', userId: 'user-1', items: [] };
    prismaMock.taskList.create.mockResolvedValueOnce(mockList);

    const result = await createTaskList('user-1', 'Custom', 'custom-id');
    expect(result.id).toBe('custom-id');
  });
});

describe('tasklist.service — getTaskList', () => {
  it('should return task list for owner', async () => {
    const mockList = { id: 'tl-1', title: 'Tasks', userId: 'user-1', items: [], sharedWith: [] };
    prismaMock.taskList.findUnique.mockResolvedValueOnce(mockList);

    const result = await getTaskList('user-1', 'tl-1');
    expect(result).toEqual(mockList);
  });

  it('should return task list for accepted shared user', async () => {
    const mockList = { id: 'tl-1', title: 'Tasks', userId: 'owner-1', items: [], sharedWith: [] };
    prismaMock.taskList.findUnique.mockResolvedValueOnce(mockList);
    prismaMock.sharedTaskList.findUnique.mockResolvedValueOnce({ status: 'ACCEPTED' });

    const result = await getTaskList('user-2', 'tl-1');
    expect(result).toEqual(mockList);
  });

  it('should throw if task list not found', async () => {
    prismaMock.taskList.findUnique.mockResolvedValueOnce(null);

    await expect(getTaskList('user-1', 'nonexistent')).rejects.toThrow('TaskList not found');
  });

  it('should throw if user has no access (not owner and no accepted share)', async () => {
    const mockList = { id: 'tl-1', title: 'Tasks', userId: 'owner-1', items: [], sharedWith: [] };
    prismaMock.taskList.findUnique.mockResolvedValueOnce(mockList);
    prismaMock.sharedTaskList.findUnique.mockResolvedValueOnce(null);

    await expect(getTaskList('stranger', 'tl-1')).rejects.toThrow('TaskList not found');
  });
});

describe('tasklist.service — deleteTaskList', () => {
  it('should soft-delete (trash) a task list by owner', async () => {
    prismaMock.taskList.findUnique.mockResolvedValueOnce({ id: 'tl-1', userId: 'user-1' });
    prismaMock.taskList.update.mockResolvedValueOnce({ id: 'tl-1', isTrashed: true });

    const result = await deleteTaskList('user-1', 'tl-1');
    expect(result.isTrashed).toBe(true);
  });

  it('should throw if not the owner', async () => {
    prismaMock.taskList.findUnique.mockResolvedValueOnce({ id: 'tl-1', userId: 'real-owner' });

    await expect(deleteTaskList('not-owner', 'tl-1')).rejects.toThrow('Access denied');
  });
});

describe('tasklist.service — addTaskItem', () => {
  it('should add an item to a task list', async () => {
    // assertWriteAccess: owner check
    prismaMock.taskList.findUnique.mockResolvedValueOnce({ id: 'tl-1', userId: 'user-1' });
    // aggregate for max position
    prismaMock.taskItem.aggregate.mockResolvedValueOnce({ _max: { position: 2 } });
    // create item
    const mockItem = { id: 'item-1', text: 'Buy milk', position: 3, taskListId: 'tl-1' };
    prismaMock.taskItem.create.mockResolvedValueOnce(mockItem);
    // notifyCollaborators: taskList lookup + user lookup
    prismaMock.taskList.findUnique.mockResolvedValueOnce({
      id: 'tl-1',
      userId: 'user-1',
      user: { id: 'user-1', name: 'User', email: 'u@t.com' },
      sharedWith: [],
    });

    const result = await addTaskItem('user-1', 'tl-1', { text: 'Buy milk' });
    expect(result).toEqual(mockItem);
    expect(result.position).toBe(3);
  });

  it('should throw if user has no write access', async () => {
    prismaMock.taskList.findUnique.mockResolvedValueOnce({ id: 'tl-1', userId: 'other' });
    prismaMock.sharedTaskList.findUnique.mockResolvedValueOnce(null);

    await expect(addTaskItem('user-1', 'tl-1', { text: 'Blocked' })).rejects.toThrow('Access denied');
  });
});

describe('tasklist.service — updateTaskItem (only-checker-can-uncheck)', () => {
  it('should allow the checker to uncheck their own item', async () => {
    // assertWriteAccess
    prismaMock.taskList.findUnique.mockResolvedValueOnce({ id: 'tl-1', userId: 'user-1' });
    // existing item: checked by user-1
    prismaMock.taskItem.findUnique.mockResolvedValueOnce({
      id: 'item-1',
      taskListId: 'tl-1',
      isChecked: true,
      checkedByUserId: 'user-1',
      text: 'Buy milk',
    });
    prismaMock.taskItem.update.mockResolvedValueOnce({ id: 'item-1', isChecked: false });
    // notifyCollaborators
    prismaMock.taskList.findUnique.mockResolvedValueOnce({
      id: 'tl-1', userId: 'user-1',
      user: { id: 'user-1', name: 'User', email: 'u@t.com' },
      sharedWith: [],
    });
    prismaMock.user.findUnique.mockResolvedValueOnce({ name: 'User', email: 'u@t.com' });

    const result = await updateTaskItem('user-1', 'tl-1', 'item-1', { isChecked: false });
    expect(result.isChecked).toBe(false);
  });

  it('should throw if a different user tries to uncheck', async () => {
    // assertWriteAccess (user-2 has write access via shared task list)
    prismaMock.taskList.findUnique.mockResolvedValueOnce({ id: 'tl-1', userId: 'owner' });
    prismaMock.sharedTaskList.findUnique.mockResolvedValueOnce({
      permission: 'WRITE',
      status: 'ACCEPTED',
    });
    // existing item: checked by user-1
    prismaMock.taskItem.findUnique.mockResolvedValueOnce({
      id: 'item-1',
      taskListId: 'tl-1',
      isChecked: true,
      checkedByUserId: 'user-1',
      text: 'Buy milk',
    });

    await expect(updateTaskItem('user-2', 'tl-1', 'item-1', { isChecked: false }))
      .rejects.toThrow('Only the user who checked this item can uncheck it');
  });

  it('should throw if task item not found', async () => {
    prismaMock.taskList.findUnique.mockResolvedValueOnce({ id: 'tl-1', userId: 'user-1' });
    prismaMock.taskItem.findUnique.mockResolvedValueOnce(null);

    await expect(updateTaskItem('user-1', 'tl-1', 'item-999', { text: 'Updated' }))
      .rejects.toThrow('TaskItem not found');
  });
});

describe('tasklist.service — deleteTaskItem', () => {
  it('should delete a task item', async () => {
    prismaMock.taskList.findUnique.mockResolvedValueOnce({ id: 'tl-1', userId: 'user-1' });
    prismaMock.taskItem.findUnique.mockResolvedValueOnce({
      id: 'item-1',
      taskListId: 'tl-1',
      text: 'Buy milk',
    });
    prismaMock.taskItem.delete.mockResolvedValueOnce({});
    // notifyCollaborators
    prismaMock.taskList.findUnique.mockResolvedValueOnce({
      id: 'tl-1', userId: 'user-1',
      user: { id: 'user-1', name: 'User', email: 'u@t.com' },
      sharedWith: [],
    });

    const result = await deleteTaskItem('user-1', 'tl-1', 'item-1');
    expect(result.success).toBe(true);
  });

  it('should throw if item not found in this task list', async () => {
    prismaMock.taskList.findUnique.mockResolvedValueOnce({ id: 'tl-1', userId: 'user-1' });
    prismaMock.taskItem.findUnique.mockResolvedValueOnce({
      id: 'item-1',
      taskListId: 'tl-OTHER', // different task list
      text: 'Wrong list',
    });

    await expect(deleteTaskItem('user-1', 'tl-1', 'item-1')).rejects.toThrow('TaskItem not found');
  });
});
