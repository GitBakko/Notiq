import { describe, it, expect, beforeEach, vi } from 'vitest';
import prisma from '../../../plugins/prisma';
import {
  makeUser,
  makeNote,
  makeKanbanBoard,
  makeKanbanCard,
  makeKanbanColumn,
  makeTaskList,
  makeTaskItem,
} from '../../../__tests__/factories';

// Mock sibling services — dynamic import used in linking.service.ts
vi.mock('../../sharing.service', () => ({
  autoShareNoteForBoard: vi.fn().mockResolvedValue(undefined),
}));

// Mock kanbanSSE broadcast
vi.mock('../../kanbanSSE', () => ({
  broadcast: vi.fn(),
}));

// Mock helpers — logCardActivity, transformCard, cardWithAssigneeSelect
vi.mock('../helpers', () => ({
  logCardActivity: vi.fn().mockResolvedValue(undefined),
  cardWithAssigneeSelect: { id: true },
  transformCard: vi.fn((card: any) => {
    const { _count, ...rest } = card;
    return { ...rest, commentCount: _count?.comments ?? 0 };
  }),
}));

import {
  checkNoteSharingForBoard,
  linkNoteToCard,
  unlinkNoteFromCard,
  linkNoteToBoard,
  unlinkNoteFromBoard,
  searchUserNotes,
  getLinkedBoardsForNote,
  linkTaskListToBoard,
  unlinkTaskListFromBoard,
  searchUserTaskLists,
} from '../linking.service';

import { logCardActivity, transformCard } from '../helpers';
import { broadcast } from '../../kanbanSSE';

const prismaMock = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Shared Fixtures ─────────────────────────────────────────

function setupUser() {
  return makeUser();
}

// ═════════════════════════════════════════════════════════════
// checkNoteSharingForBoard
// ═════════════════════════════════════════════════════════════

describe('checkNoteSharingForBoard', () => {
  it('returns sharing info with users who have/lack access', async () => {
    const owner = setupUser();
    const sharedUser = makeUser();
    const unsharedUser = makeUser();
    const note = makeNote({ userId: owner.id });
    const board = makeKanbanBoard({ ownerId: owner.id });

    prismaMock.note.findUnique.mockResolvedValue({
      id: note.id,
      title: note.title,
      userId: note.userId,
    });

    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      ownerId: board.ownerId,
      owner: { id: owner.id, name: owner.name, email: owner.email },
      shares: [
        { user: { id: sharedUser.id, name: sharedUser.name, email: sharedUser.email } },
        { user: { id: unsharedUser.id, name: unsharedUser.name, email: unsharedUser.email } },
      ],
    });

    // Only owner and sharedUser have note access
    prismaMock.sharedNote.findMany.mockResolvedValue([
      { userId: sharedUser.id },
    ]);

    const result = await checkNoteSharingForBoard(note.id, board.id, owner.id);

    expect(result.noteTitle).toBe(note.title);
    expect(result.noteOwnerId).toBe(owner.id);
    expect(result.alreadyFullyShared).toBe(false);
    expect(result.usersWithAccess).toHaveLength(2); // owner + sharedUser
    expect(result.usersWithoutAccess).toHaveLength(1); // unsharedUser
    expect(result.usersWithoutAccess[0].id).toBe(unsharedUser.id);
  });

  it('throws NotFoundError if note does not exist', async () => {
    prismaMock.note.findUnique.mockResolvedValue(null);

    await expect(
      checkNoteSharingForBoard('missing-note', 'board-1', 'user-1')
    ).rejects.toThrow('errors.notes.notFound');
  });

  it('throws NotFoundError if board does not exist', async () => {
    prismaMock.note.findUnique.mockResolvedValue({ id: 'n1', title: 'T', userId: 'u1' });
    prismaMock.kanbanBoard.findUnique.mockResolvedValue(null);

    await expect(
      checkNoteSharingForBoard('n1', 'missing-board', 'u1')
    ).rejects.toThrow('errors.kanban.boardNotFound');
  });
});

// ═════════════════════════════════════════════════════════════
// linkNoteToCard
// ═════════════════════════════════════════════════════════════

describe('linkNoteToCard', () => {
  it('links note to card, logs NOTE_LINKED activity, and broadcasts update', async () => {
    const user = setupUser();
    const note = makeNote({ userId: user.id, title: 'My Note' });
    const column = makeKanbanColumn({ boardId: 'board-1' });
    const card = makeKanbanCard({ id: 'card-1', columnId: column.id, noteId: null });

    prismaMock.kanbanCard.findUnique
      .mockResolvedValueOnce({
        noteId: null,
        column: { boardId: 'board-1', board: { title: 'Board Title' } },
      })
      // Second call for final card fetch after update
      .mockResolvedValueOnce({
        id: card.id,
        title: card.title,
        noteId: note.id,
        noteLinkedById: user.id,
        columnId: column.id,
        _count: { comments: 0 },
      });

    prismaMock.note.findUnique.mockResolvedValue({
      id: note.id,
      title: note.title,
      userId: user.id,
    });

    prismaMock.kanbanCard.update.mockResolvedValue({ id: card.id });

    const result = await linkNoteToCard(card.id, note.id, user.id);

    // Verify card update
    expect(prismaMock.kanbanCard.update).toHaveBeenCalledWith({
      where: { id: card.id },
      data: { noteId: note.id, noteLinkedById: user.id },
    });

    // Verify activity log
    expect(logCardActivity).toHaveBeenCalledWith(card.id, user.id, 'NOTE_LINKED', {
      metadata: { noteId: note.id, noteTitle: note.title },
    });

    // Verify broadcast
    expect(broadcast).toHaveBeenCalledWith('board-1', expect.objectContaining({
      type: 'card:updated',
      boardId: 'board-1',
    }));

    // Verify transformCard was used
    expect(result).toHaveProperty('commentCount', 0);
  });

  it('throws BadRequestError if card already has a linked note', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      noteId: 'existing-note',
      column: { boardId: 'b1', board: { title: 'B' } },
    });

    await expect(
      linkNoteToCard('card-1', 'note-2', 'user-1')
    ).rejects.toThrow('errors.kanban.cardAlreadyLinkedNote');
  });

  it('throws NotFoundError if card does not exist', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue(null);

    await expect(
      linkNoteToCard('missing-card', 'note-1', 'user-1')
    ).rejects.toThrow('errors.kanban.cardNotFound');
  });

  it('throws ForbiddenError if actor is not the note owner', async () => {
    const noteOwner = setupUser();
    const actor = setupUser();

    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      noteId: null,
      column: { boardId: 'b1', board: { title: 'B' } },
    });

    prismaMock.note.findUnique.mockResolvedValue({
      id: 'note-1',
      title: 'Note',
      userId: noteOwner.id,
    });

    await expect(
      linkNoteToCard('card-1', 'note-1', actor.id)
    ).rejects.toThrow('errors.kanban.onlyOwnerCanLink');
  });

  it('calls autoShareNoteForBoard when shareWithUserIds are provided', async () => {
    const user = setupUser();
    const note = makeNote({ userId: user.id });

    prismaMock.kanbanCard.findUnique
      .mockResolvedValueOnce({
        noteId: null,
        column: { boardId: 'board-1', board: { title: 'Board Title' } },
      })
      .mockResolvedValueOnce({
        id: 'card-1',
        _count: { comments: 0 },
      });

    prismaMock.note.findUnique.mockResolvedValue({
      id: note.id,
      title: note.title,
      userId: user.id,
    });

    prismaMock.kanbanCard.update.mockResolvedValue({ id: 'card-1' });

    const { autoShareNoteForBoard } = await import('../../sharing.service');

    await linkNoteToCard('card-1', note.id, user.id, ['other-user-1', 'other-user-2']);

    expect(autoShareNoteForBoard).toHaveBeenCalledWith(
      user.id,
      note.id,
      ['other-user-1', 'other-user-2'],
      'READ',
      'Board Title'
    );
  });
});

// ═════════════════════════════════════════════════════════════
// unlinkNoteFromCard
// ═════════════════════════════════════════════════════════════

describe('unlinkNoteFromCard', () => {
  it('unlinks note from card and logs NOTE_UNLINKED activity', async () => {
    const user = setupUser();

    prismaMock.kanbanCard.findUnique
      .mockResolvedValueOnce({
        noteId: 'note-1',
        noteLinkedById: user.id,
        note: { title: 'Linked Note' },
        column: { boardId: 'board-1' },
      })
      .mockResolvedValueOnce({
        id: 'card-1',
        noteId: null,
        _count: { comments: 0 },
      });

    prismaMock.kanbanCard.update.mockResolvedValue({ id: 'card-1' });

    const result = await unlinkNoteFromCard('card-1', user.id);

    expect(prismaMock.kanbanCard.update).toHaveBeenCalledWith({
      where: { id: 'card-1' },
      data: { noteId: null, noteLinkedById: null },
    });

    expect(logCardActivity).toHaveBeenCalledWith('card-1', user.id, 'NOTE_UNLINKED', {
      metadata: { noteTitle: 'Linked Note' },
    });

    expect(broadcast).toHaveBeenCalledWith('board-1', expect.objectContaining({
      type: 'card:updated',
    }));

    expect(result).toHaveProperty('commentCount', 0);
  });

  it('throws ForbiddenError if actor is not the linker', async () => {
    const linker = setupUser();
    const otherUser = setupUser();

    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      noteId: 'note-1',
      noteLinkedById: linker.id,
      note: { title: 'N' },
      column: { boardId: 'b1' },
    });

    await expect(
      unlinkNoteFromCard('card-1', otherUser.id)
    ).rejects.toThrow('errors.kanban.onlyLinkerCanUnlinkNote');
  });

  it('throws BadRequestError if card has no linked note', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      noteId: null,
      noteLinkedById: null,
      note: null,
      column: { boardId: 'b1' },
    });

    await expect(
      unlinkNoteFromCard('card-1', 'user-1')
    ).rejects.toThrow('errors.kanban.cardNoLinkedNote');
  });

  it('throws NotFoundError if card does not exist', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue(null);

    await expect(
      unlinkNoteFromCard('missing-card', 'user-1')
    ).rejects.toThrow('errors.kanban.cardNotFound');
  });
});

// ═════════════════════════════════════════════════════════════
// linkNoteToBoard
// ═════════════════════════════════════════════════════════════

describe('linkNoteToBoard', () => {
  it('links note to board and broadcasts update', async () => {
    const user = setupUser();
    const note = makeNote({ userId: user.id, title: 'Board Note' });

    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      noteId: null,
      title: 'My Board',
    });

    prismaMock.note.findUnique.mockResolvedValue({
      id: note.id,
      title: note.title,
      userId: user.id,
    });

    const updatedBoard = {
      noteId: note.id,
      noteLinkedById: user.id,
      note: { id: note.id, title: note.title, userId: user.id },
    };
    prismaMock.kanbanBoard.update.mockResolvedValue(updatedBoard);

    const result = await linkNoteToBoard('board-1', note.id, user.id);

    expect(prismaMock.kanbanBoard.update).toHaveBeenCalledWith({
      where: { id: 'board-1' },
      data: { noteId: note.id, noteLinkedById: user.id },
      select: {
        noteId: true,
        noteLinkedById: true,
        note: { select: { id: true, title: true, userId: true } },
      },
    });

    expect(broadcast).toHaveBeenCalledWith('board-1', {
      type: 'board:updated',
      boardId: 'board-1',
    });

    expect(result).toEqual(updatedBoard);
  });

  it('throws BadRequestError if board already has a linked note', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      noteId: 'existing-note',
      title: 'B',
    });

    await expect(
      linkNoteToBoard('board-1', 'note-2', 'user-1')
    ).rejects.toThrow('errors.kanban.boardAlreadyLinkedNote');
  });

  it('throws ForbiddenError if actor is not the note owner', async () => {
    const noteOwner = setupUser();
    const actor = setupUser();

    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      noteId: null,
      title: 'B',
    });

    prismaMock.note.findUnique.mockResolvedValue({
      id: 'note-1',
      title: 'Note',
      userId: noteOwner.id,
    });

    await expect(
      linkNoteToBoard('board-1', 'note-1', actor.id)
    ).rejects.toThrow('errors.kanban.onlyOwnerCanLink');
  });

  it('throws NotFoundError if board does not exist', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue(null);

    await expect(
      linkNoteToBoard('missing-board', 'note-1', 'user-1')
    ).rejects.toThrow('errors.kanban.boardNotFound');
  });

  it('throws NotFoundError if note does not exist', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ noteId: null, title: 'B' });
    prismaMock.note.findUnique.mockResolvedValue(null);

    await expect(
      linkNoteToBoard('board-1', 'missing-note', 'user-1')
    ).rejects.toThrow('errors.notes.notFound');
  });
});

// ═════════════════════════════════════════════════════════════
// unlinkNoteFromBoard
// ═════════════════════════════════════════════════════════════

describe('unlinkNoteFromBoard', () => {
  it('unlinks note from board and broadcasts update', async () => {
    const user = setupUser();

    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      noteId: 'note-1',
      noteLinkedById: user.id,
    });

    prismaMock.kanbanBoard.update.mockResolvedValue({});

    const result = await unlinkNoteFromBoard('board-1', user.id);

    expect(prismaMock.kanbanBoard.update).toHaveBeenCalledWith({
      where: { id: 'board-1' },
      data: { noteId: null, noteLinkedById: null },
    });

    expect(broadcast).toHaveBeenCalledWith('board-1', {
      type: 'board:updated',
      boardId: 'board-1',
    });

    expect(result).toEqual({ success: true });
  });

  it('throws ForbiddenError if actor is not the linker', async () => {
    const linker = setupUser();
    const otherUser = setupUser();

    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      noteId: 'note-1',
      noteLinkedById: linker.id,
    });

    await expect(
      unlinkNoteFromBoard('board-1', otherUser.id)
    ).rejects.toThrow('errors.kanban.onlyLinkerCanUnlinkNote');
  });

  it('throws BadRequestError if board has no linked note', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      noteId: null,
      noteLinkedById: null,
    });

    await expect(
      unlinkNoteFromBoard('board-1', 'user-1')
    ).rejects.toThrow('errors.kanban.boardNoLinkedNote');
  });

  it('throws NotFoundError if board does not exist', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue(null);

    await expect(
      unlinkNoteFromBoard('missing-board', 'user-1')
    ).rejects.toThrow('errors.kanban.boardNotFound');
  });
});

// ═════════════════════════════════════════════════════════════
// linkTaskListToBoard
// ═════════════════════════════════════════════════════════════

describe('linkTaskListToBoard', () => {
  it('links task list to board and broadcasts update', async () => {
    const user = setupUser();
    const taskList = makeTaskList({ userId: user.id });

    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ taskListId: null });

    prismaMock.taskList.findUnique.mockResolvedValue({
      id: taskList.id,
      title: taskList.title,
      userId: user.id,
    });

    const updatedBoard = {
      taskListId: taskList.id,
      taskListLinkedById: user.id,
      taskList: { id: taskList.id, title: taskList.title, userId: user.id },
    };
    prismaMock.kanbanBoard.update.mockResolvedValue(updatedBoard);

    // Sync-related mocks (columns, cards, taskItems)
    prismaMock.kanbanColumn.findMany.mockResolvedValue([]);
    prismaMock.kanbanCard.findMany.mockResolvedValue([]);
    prismaMock.taskItem.findMany.mockResolvedValue([]);

    const result = await linkTaskListToBoard('board-1', taskList.id, user.id);

    expect(prismaMock.kanbanBoard.update).toHaveBeenCalledWith({
      where: { id: 'board-1' },
      data: { taskListId: taskList.id, taskListLinkedById: user.id },
      select: {
        taskListId: true,
        taskListLinkedById: true,
        taskList: { select: { id: true, title: true, userId: true } },
      },
    });

    expect(broadcast).toHaveBeenCalledWith('board-1', {
      type: 'board:updated',
      boardId: 'board-1',
    });

    expect(result).toEqual(updatedBoard);
  });

  it('syncs card completion state to task items when linking', async () => {
    const user = setupUser();
    const taskList = makeTaskList({ userId: user.id });
    const completedColumn = makeKanbanColumn({ id: 'col-done', boardId: 'board-1', isCompleted: true });
    const todoColumn = makeKanbanColumn({ id: 'col-todo', boardId: 'board-1', isCompleted: false });

    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ taskListId: null });
    prismaMock.taskList.findUnique.mockResolvedValue({
      id: taskList.id,
      title: taskList.title,
      userId: user.id,
    });
    prismaMock.kanbanBoard.update.mockResolvedValue({
      taskListId: taskList.id,
      taskListLinkedById: user.id,
      taskList: { id: taskList.id, title: taskList.title, userId: user.id },
    });

    // Columns: one completed, one not
    prismaMock.kanbanColumn.findMany.mockResolvedValue([completedColumn, todoColumn]);

    // Cards: one in completed column matching task item
    prismaMock.kanbanCard.findMany.mockResolvedValue([
      { id: 'card-done', title: 'Buy groceries', columnId: completedColumn.id, taskItemId: null },
      { id: 'card-todo', title: 'Read book', columnId: todoColumn.id, taskItemId: null },
    ]);

    // Task items that match cards by title
    prismaMock.taskItem.findMany.mockResolvedValue([
      { id: 'ti-1', text: 'Buy groceries', isChecked: false },
      { id: 'ti-2', text: 'Read book', isChecked: false },
    ]);

    prismaMock.kanbanCard.update.mockResolvedValue({});
    prismaMock.taskItem.update.mockResolvedValue({});

    await linkTaskListToBoard('board-1', taskList.id, user.id);

    // Should link both cards to their matching task items
    expect(prismaMock.kanbanCard.update).toHaveBeenCalledWith({
      where: { id: 'card-done' },
      data: { taskItemId: 'ti-1' },
    });
    expect(prismaMock.kanbanCard.update).toHaveBeenCalledWith({
      where: { id: 'card-todo' },
      data: { taskItemId: 'ti-2' },
    });

    // Should mark the task item as checked for the card in completed column
    expect(prismaMock.taskItem.update).toHaveBeenCalledWith({
      where: { id: 'ti-1' },
      data: { isChecked: true, checkedByUserId: user.id },
    });

    // Task item for non-completed column should NOT be checked
    expect(prismaMock.taskItem.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ti-2' } })
    );
  });

  it('throws BadRequestError if board already has a linked task list', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ taskListId: 'existing-tl' });

    await expect(
      linkTaskListToBoard('board-1', 'tl-2', 'user-1')
    ).rejects.toThrow('errors.kanban.boardAlreadyLinkedTaskList');
  });

  it('throws NotFoundError if task list does not exist', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ taskListId: null });
    prismaMock.taskList.findUnique.mockResolvedValue(null);

    await expect(
      linkTaskListToBoard('board-1', 'missing-tl', 'user-1')
    ).rejects.toThrow('errors.tasks.listNotFound');
  });

  it('throws NotFoundError if board does not exist', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue(null);

    await expect(
      linkTaskListToBoard('missing-board', 'tl-1', 'user-1')
    ).rejects.toThrow('errors.kanban.boardNotFound');
  });
});

// ═════════════════════════════════════════════════════════════
// unlinkTaskListFromBoard
// ═════════════════════════════════════════════════════════════

describe('unlinkTaskListFromBoard', () => {
  it('unlinks task list from board and broadcasts update', async () => {
    const user = setupUser();

    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      taskListId: 'tl-1',
      taskListLinkedById: user.id,
    });

    prismaMock.kanbanBoard.update.mockResolvedValue({});

    const result = await unlinkTaskListFromBoard('board-1', user.id);

    expect(prismaMock.kanbanBoard.update).toHaveBeenCalledWith({
      where: { id: 'board-1' },
      data: { taskListId: null, taskListLinkedById: null },
    });

    expect(broadcast).toHaveBeenCalledWith('board-1', {
      type: 'board:updated',
      boardId: 'board-1',
    });

    expect(result).toEqual({ success: true });
  });

  it('throws ForbiddenError if actor is not the linker', async () => {
    const linker = setupUser();
    const otherUser = setupUser();

    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      taskListId: 'tl-1',
      taskListLinkedById: linker.id,
    });

    await expect(
      unlinkTaskListFromBoard('board-1', otherUser.id)
    ).rejects.toThrow('errors.kanban.onlyLinkerCanUnlinkTaskList');
  });

  it('throws BadRequestError if board has no linked task list', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      taskListId: null,
      taskListLinkedById: null,
    });

    await expect(
      unlinkTaskListFromBoard('board-1', 'user-1')
    ).rejects.toThrow('errors.kanban.boardNoLinkedTaskList');
  });

  it('throws NotFoundError if board does not exist', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue(null);

    await expect(
      unlinkTaskListFromBoard('missing-board', 'user-1')
    ).rejects.toThrow('errors.kanban.boardNotFound');
  });
});

// ═════════════════════════════════════════════════════════════
// searchUserNotes
// ═════════════════════════════════════════════════════════════

describe('searchUserNotes', () => {
  it('returns matching non-vault notes for the user', async () => {
    const user = setupUser();
    const notes = [
      { id: 'n1', title: 'Meeting Notes', notebookId: 'nb1', notebook: { id: 'nb1', name: 'Work' }, updatedAt: new Date() },
      { id: 'n2', title: 'Meeting Agenda', notebookId: 'nb1', notebook: { id: 'nb1', name: 'Work' }, updatedAt: new Date() },
    ];

    prismaMock.note.findMany.mockResolvedValue(notes);

    const result = await searchUserNotes(user.id, 'meeting');

    expect(prismaMock.note.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: user.id,
          isVault: false,
          OR: [
            { title: { contains: 'meeting', mode: 'insensitive' } },
            { searchText: { contains: 'meeting', mode: 'insensitive' } },
          ],
        }),
        orderBy: { updatedAt: 'desc' },
        take: 20,
      })
    );

    expect(result).toEqual(notes);
  });

  it('returns all non-vault notes when query is empty', async () => {
    const user = setupUser();
    prismaMock.note.findMany.mockResolvedValue([]);

    await searchUserNotes(user.id, '');

    expect(prismaMock.note.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: user.id,
          isVault: false,
        },
      })
    );
  });

  it('respects the limit parameter', async () => {
    const user = setupUser();
    prismaMock.note.findMany.mockResolvedValue([]);

    await searchUserNotes(user.id, 'test', 5);

    expect(prismaMock.note.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 5,
      })
    );
  });
});

// ═════════════════════════════════════════════════════════════
// searchUserTaskLists
// ═════════════════════════════════════════════════════════════

describe('searchUserTaskLists', () => {
  it('returns matching task lists owned or shared with WRITE permission', async () => {
    const user = setupUser();
    const lists = [
      { id: 'tl1', title: 'Sprint Tasks', userId: user.id, _count: { items: 5 }, kanbanBoard: null },
    ];

    prismaMock.taskList.findMany.mockResolvedValue(lists);

    const result = await searchUserTaskLists(user.id, 'sprint');

    expect(prismaMock.taskList.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isTrashed: false,
          title: { contains: 'sprint', mode: 'insensitive' },
          OR: [
            { userId: user.id },
            {
              sharedWith: {
                some: { userId: user.id, status: 'ACCEPTED', permission: 'WRITE' },
              },
            },
          ],
        }),
        orderBy: { updatedAt: 'desc' },
        take: 20,
      })
    );

    expect(result).toEqual(lists);
  });

  it('omits title filter when query is empty', async () => {
    const user = setupUser();
    prismaMock.taskList.findMany.mockResolvedValue([]);

    await searchUserTaskLists(user.id, '  ');

    const callArgs = prismaMock.taskList.findMany.mock.calls[0][0];
    expect(callArgs.where.title).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════
// getLinkedBoardsForNote
// ═════════════════════════════════════════════════════════════

describe('getLinkedBoardsForNote', () => {
  it('returns boards linked via cards that user has access to', async () => {
    const user = setupUser();

    prismaMock.kanbanCard.findMany.mockResolvedValue([
      {
        id: 'card-1',
        title: 'Card A',
        column: {
          board: {
            id: 'board-1',
            title: 'Board 1',
            avatarUrl: null,
            ownerId: user.id,
            shares: [],
          },
        },
      },
    ]);

    prismaMock.kanbanBoard.findMany.mockResolvedValue([]);

    const result = await getLinkedBoardsForNote('note-1', user.id);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      boardId: 'board-1',
      boardTitle: 'Board 1',
      linkedAs: 'card',
      cardIds: ['card-1'],
      cardTitles: ['Card A'],
    });
  });

  it('returns boards linked directly at board level', async () => {
    const user = setupUser();

    prismaMock.kanbanCard.findMany.mockResolvedValue([]);

    prismaMock.kanbanBoard.findMany.mockResolvedValue([
      {
        id: 'board-2',
        title: 'Direct Board',
        avatarUrl: '/avatar.png',
        ownerId: user.id,
        shares: [],
      },
    ]);

    const result = await getLinkedBoardsForNote('note-1', user.id);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      boardId: 'board-2',
      boardTitle: 'Direct Board',
      boardAvatarUrl: '/avatar.png',
      linkedAs: 'board',
      cardIds: [],
      cardTitles: [],
    });
  });

  it('excludes boards user does not have access to', async () => {
    const user = setupUser();
    const otherUser = setupUser();

    prismaMock.kanbanCard.findMany.mockResolvedValue([
      {
        id: 'card-1',
        title: 'Card A',
        column: {
          board: {
            id: 'board-private',
            title: 'Private Board',
            avatarUrl: null,
            ownerId: otherUser.id,
            shares: [], // no shares for user
          },
        },
      },
    ]);

    prismaMock.kanbanBoard.findMany.mockResolvedValue([]);

    const result = await getLinkedBoardsForNote('note-1', user.id);

    expect(result).toHaveLength(0);
  });

  it('groups multiple cards under the same board', async () => {
    const user = setupUser();

    prismaMock.kanbanCard.findMany.mockResolvedValue([
      {
        id: 'card-1',
        title: 'Card A',
        column: {
          board: { id: 'board-1', title: 'Board 1', avatarUrl: null, ownerId: user.id, shares: [] },
        },
      },
      {
        id: 'card-2',
        title: 'Card B',
        column: {
          board: { id: 'board-1', title: 'Board 1', avatarUrl: null, ownerId: user.id, shares: [] },
        },
      },
    ]);

    prismaMock.kanbanBoard.findMany.mockResolvedValue([]);

    const result = await getLinkedBoardsForNote('note-1', user.id);

    expect(result).toHaveLength(1);
    expect(result[0].cardIds).toEqual(['card-1', 'card-2']);
    expect(result[0].cardTitles).toEqual(['Card A', 'Card B']);
  });
});
