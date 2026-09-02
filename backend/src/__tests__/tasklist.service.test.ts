import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock notification service before imports
vi.mock('../services/notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue({ id: 'notif-1' }),
}));

import prisma from '../plugins/prisma';
import { cardWithAssigneeSelect } from '../services/kanban/helpers';
import {
  createTaskList,
  getTaskList,
  getTaskLists,
  getAcceptedSharedTaskLists,
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

    await expect(getTaskList('user-1', 'nonexistent')).rejects.toThrow('errors.tasks.listNotFound');
  });

  it('should throw if user has no access (not owner and no accepted share)', async () => {
    const mockList = { id: 'tl-1', title: 'Tasks', userId: 'owner-1', items: [], sharedWith: [] };
    prismaMock.taskList.findUnique.mockResolvedValueOnce(mockList);
    prismaMock.sharedTaskList.findUnique.mockResolvedValueOnce(null);

    await expect(getTaskList('stranger', 'tl-1')).rejects.toThrow('errors.tasks.listNotFound');
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

    await expect(deleteTaskList('not-owner', 'tl-1')).rejects.toThrow('errors.common.accessDenied');
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

    await expect(addTaskItem('user-1', 'tl-1', { text: 'Blocked' })).rejects.toThrow('errors.common.accessDenied');
  });

  it('auto-adds to the linked board with the shared card select, not a hand-copy', async () => {
    // This branch used to carry its own 19-line copy of cardWithAssigneeSelect, note
    // included, and it feeds broadcast('card:created') — one payload for every socket
    // on the board, which cannot filter per recipient. stripNote caught it on the
    // wire; a hand-copy of a security-relevant select outlives that guard. Pin the
    // identity, not the contents: the contents are pinned in helpers.test.ts.
    prismaMock.taskList.findUnique.mockResolvedValueOnce({ id: 'tl-1', userId: 'user-1' });
    prismaMock.taskItem.aggregate.mockResolvedValueOnce({ _max: { position: 0 } });
    prismaMock.taskItem.create.mockResolvedValueOnce({ id: 'item-1', text: 'x', position: 1, taskListId: 'tl-1' });
    prismaMock.taskList.findUnique.mockResolvedValueOnce({
      id: 'tl-1', userId: 'user-1',
      user: { id: 'user-1', name: 'User', email: 'u@t.com' }, sharedWith: [],
    });
    // the auto-add lookup: a linked board with one open column
    prismaMock.taskList.findUnique.mockResolvedValueOnce({
      kanbanBoard: { id: 'board-1', columns: [{ id: 'col-1' }] },
    });
    // setup.ts's kanbanCard mock has no aggregate; this branch needs one.
    if (!prismaMock.kanbanCard.aggregate) prismaMock.kanbanCard.aggregate = vi.fn();
    prismaMock.kanbanCard.aggregate.mockResolvedValueOnce({ _max: { position: null } });
    prismaMock.kanbanCard.create.mockResolvedValueOnce({
      id: 'card-1', title: 'x', noteId: null, _count: { comments: 0 },
    });

    await addTaskItem('user-1', 'tl-1', { text: 'x' });

    expect(prismaMock.kanbanCard.create).toHaveBeenCalled();
    const select = prismaMock.kanbanCard.create.mock.calls[0][0].select;
    expect(select).toBe(cardWithAssigneeSelect);
    expect(select).not.toHaveProperty('note');
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
      .rejects.toThrow('errors.tasks.onlyCheckerCanUncheck');
  });

  it('should throw if task item not found', async () => {
    prismaMock.taskList.findUnique.mockResolvedValueOnce({ id: 'tl-1', userId: 'user-1' });
    prismaMock.taskItem.findUnique.mockResolvedValueOnce(null);

    await expect(updateTaskItem('user-1', 'tl-1', 'item-999', { text: 'Updated' }))
      .rejects.toThrow('errors.tasks.itemNotFound');
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

    await expect(deleteTaskItem('user-1', 'tl-1', 'item-1')).rejects.toThrow('errors.tasks.itemNotFound');
  });
});

// ═══════════════════════════════════════════════════════════════
//  N4 — the linked Kanban board, seen from the task-list side
// ═══════════════════════════════════════════════════════════════
//
// The mirror of B4. getBoard filters the board's linked task list, but the task
// list endpoints handed back `kanbanBoard: { id, title }` with no board check at
// all — so filtering only one direction just moves the leak to the other
// endpoint. Reachable because linkTaskListToBoard requires WRITE on the board and
// ACCEPTED-WRITE on the list, so a list collaborator can attach a list to their
// own private board and the list owner then reads that board's title.
describe('getTaskLists — linked board visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function listWithBoard(shares: { id: string }[], ownerId = 'other-user') {
    return [
      {
        id: 'tl-1',
        userId: 'user-1',
        title: 'My list',
        items: [],
        sharedWith: [],
        kanbanBoard: { id: 'board-1', title: 'BOARD SECRET', ownerId, shares },
      },
    ];
  }

  it('nulls the linked board for a user with no access to it', async () => {
    prismaMock.taskList.findMany.mockResolvedValueOnce(listWithBoard([]));

    const result = await getTaskLists('user-1');

    expect(result[0].kanbanBoard).toBeNull();
    expect(JSON.stringify(result)).not.toContain('BOARD SECRET');
  });

  it('keeps the linked board for its owner', async () => {
    prismaMock.taskList.findMany.mockResolvedValueOnce(listWithBoard([], 'user-1'));

    const result = await getTaskLists('user-1');

    expect(result[0].kanbanBoard).toEqual({ id: 'board-1', title: 'BOARD SECRET' });
  });

  it('keeps the linked board for a user with an ACCEPTED share', async () => {
    prismaMock.taskList.findMany.mockResolvedValueOnce(listWithBoard([{ id: 'share-1' }]));

    const result = await getTaskLists('user-1');

    expect(result[0].kanbanBoard).toEqual({ id: 'board-1', title: 'BOARD SECRET' });
  });

  it('asks the database only for shares that are ACCEPTED and the reader owns', async () => {
    // The scoped `shares` sub-select IS the access check: a where clause that
    // forgot the status would return a PENDING row and read as access.
    prismaMock.taskList.findMany.mockResolvedValueOnce([]);

    await getTaskLists('user-1');

    const include = prismaMock.taskList.findMany.mock.calls[0][0].include;
    expect(include.kanbanBoard.select.shares).toEqual({
      where: { userId: 'user-1', status: 'ACCEPTED' },
      select: { id: true },
    });
  });

  it('does not leak the board ownerId or the share rows into the response', async () => {
    prismaMock.taskList.findMany.mockResolvedValueOnce(listWithBoard([{ id: 'share-1' }]));

    const result = await getTaskLists('user-1');

    expect(result[0].kanbanBoard).not.toHaveProperty('ownerId');
    expect(result[0].kanbanBoard).not.toHaveProperty('shares');
  });

  it('leaves a list with no linked board alone', async () => {
    prismaMock.taskList.findMany.mockResolvedValueOnce([
      { id: 'tl-2', userId: 'user-1', title: 'No board', items: [], sharedWith: [], kanbanBoard: null },
    ]);

    const result = await getTaskLists('user-1');

    expect(result[0].kanbanBoard).toBeNull();
  });
});

// The SECOND call site of the same filter. Without these, deleting the
// withVisibleBoard() call from getAcceptedSharedTaskLists leaves the whole suite
// green — a fix applied to one of two siblings and guarded on only one.
describe('getAcceptedSharedTaskLists — linked board visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function sharedRow(shares: { id: string }[], boardOwnerId = 'other-user') {
    return [
      {
        permission: 'READ',
        taskList: {
          id: 'tl-1',
          userId: 'owner-user',
          title: 'Shared list',
          items: [],
          sharedWith: [],
          user: { id: 'owner-user', name: 'Owner', email: 'o@t.com' },
          kanbanBoard: { id: 'board-1', title: 'BOARD SECRET', ownerId: boardOwnerId, shares },
        },
      },
    ];
  }

  it('nulls the linked board for a user with no access to it', async () => {
    prismaMock.sharedTaskList.findMany.mockResolvedValueOnce(sharedRow([]));

    const result = await getAcceptedSharedTaskLists('user-1');

    expect(result[0].kanbanBoard).toBeNull();
    expect(JSON.stringify(result)).not.toContain('BOARD SECRET');
  });

  it('keeps the linked board for a user with an ACCEPTED share', async () => {
    prismaMock.sharedTaskList.findMany.mockResolvedValueOnce(sharedRow([{ id: 'share-1' }]));

    const result = await getAcceptedSharedTaskLists('user-1');

    expect(result[0].kanbanBoard).toEqual({ id: 'board-1', title: 'BOARD SECRET' });
  });

  it('keeps the linked board for the board owner', async () => {
    prismaMock.sharedTaskList.findMany.mockResolvedValueOnce(sharedRow([], 'user-1'));

    const result = await getAcceptedSharedTaskLists('user-1');

    expect(result[0].kanbanBoard).toEqual({ id: 'board-1', title: 'BOARD SECRET' });
  });

  it('still carries _sharedPermission through the filter', async () => {
    prismaMock.sharedTaskList.findMany.mockResolvedValueOnce(sharedRow([]));

    const result = await getAcceptedSharedTaskLists('user-1');

    expect(result[0]._sharedPermission).toBe('READ');
  });

  it('scopes the share sub-select to the reader and to ACCEPTED', async () => {
    prismaMock.sharedTaskList.findMany.mockResolvedValueOnce([]);

    await getAcceptedSharedTaskLists('user-1');

    const args = prismaMock.sharedTaskList.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ userId: 'user-1', status: 'ACCEPTED' });
    expect(args.select.taskList.include.kanbanBoard.select.shares).toEqual({
      where: { userId: 'user-1', status: 'ACCEPTED' },
      select: { id: true },
    });
  });
});
