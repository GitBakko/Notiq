import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';
import { createTaskList, addTaskItem, deleteTaskList, deleteTaskItem } from '../tasklist.service';
import { NotFoundError, ForbiddenError } from '../../utils/errors';

vi.mock('../notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

const prismaMock = prisma as any;

beforeEach(() => {
  prismaMock.taskList.findFirst.mockReset();
  prismaMock.taskList.findUnique.mockReset();
  prismaMock.taskList.create.mockReset();
  prismaMock.taskItem.findFirst.mockReset();
  prismaMock.taskItem.create.mockReset();
  prismaMock.taskItem.aggregate = vi.fn();
});

describe('R4: idempotent client-id creates', () => {
  it('createTaskList: replay of the same id by the same owner returns the existing row, no create', async () => {
    const existing = { id: 'tl-1', title: 'T', userId: 'u1', items: [] };
    prismaMock.taskList.findFirst.mockResolvedValue(existing);

    const result = await createTaskList('u1', 'T', 'tl-1');

    expect(result).toBe(existing);
    expect(prismaMock.taskList.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'tl-1', userId: 'u1' } }),
    );
    expect(prismaMock.taskList.create).not.toHaveBeenCalled();
  });

  it('addTaskItem: replay of the same id on the same list returns the existing item, no create', async () => {
    const existing = { id: 'ti-1', taskListId: 'tl-1', text: 'x' };
    prismaMock.taskList.findUnique.mockResolvedValue({ userId: 'u1' }); // assertWriteAccess: owner
    prismaMock.taskItem.findFirst.mockResolvedValue(existing);

    const result = await addTaskItem('u1', 'tl-1', { id: 'ti-1', text: 'x' });

    expect(result).toBe(existing);
    expect(prismaMock.taskItem.findFirst).toHaveBeenCalledWith({ where: { id: 'ti-1', taskListId: 'tl-1' } });
    expect(prismaMock.taskItem.create).not.toHaveBeenCalled();
  });
});

describe('S1: lista inesistente = 404, lista di altri = 403', () => {
  it('deleteTaskList: lista inesistente -> NotFoundError (404)', async () => {
    prismaMock.taskList.findUnique.mockResolvedValue(null);
    await expect(deleteTaskList('u1', 'tl-x')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deleteTaskList: lista di altri -> ForbiddenError (403)', async () => {
    prismaMock.taskList.findUnique.mockResolvedValue({ userId: 'u2' });
    await expect(deleteTaskList('u1', 'tl-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('deleteTaskItem: lista inesistente -> NotFoundError (404), non 403', async () => {
    prismaMock.taskList.findUnique.mockResolvedValue(null);
    await expect(deleteTaskItem('u1', 'tl-x', 'ti-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deleteTaskItem: item inesistente su lista propria -> NotFoundError (404)', async () => {
    prismaMock.taskList.findUnique.mockResolvedValue({ userId: 'u1' });
    prismaMock.taskItem.findUnique = vi.fn().mockResolvedValue(null);
    await expect(deleteTaskItem('u1', 'tl-1', 'ti-x')).rejects.toBeInstanceOf(NotFoundError);
  });
});
