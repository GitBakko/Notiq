import { describe, it, expect, beforeEach, vi } from 'vitest';
import prisma from '../../../plugins/prisma'; // Auto-mocked by setup.ts

// Mock sibling services used by board.service.ts
vi.mock('../helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../helpers')>();
  return {
    ...actual,
    // Keep transformCard + cardWithAssigneeSelect real; logCardActivity can stay real too
  };
});

vi.mock('../card.service', () => ({
  archiveCompletedCards: vi.fn().mockResolvedValue(0),
}));

// Import service functions AFTER mocks are declared
import {
  listBoards,
  createBoard,
  getBoard,
  updateBoard,
  deleteBoard,
  createBoardFromTaskList,
} from '../board.service';
import {
  makeUser,
  makeKanbanBoard,
  makeKanbanColumn,
  makeKanbanCard,
  makeTaskList,
  makeTaskItem,
} from '../../../__tests__/factories';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorthand for vi.mocked */
const m = vi.mocked;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('board.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── listBoards ────────────────────────────────────────────

  describe('listBoards', () => {
    it('returns owned and shared boards merged', async () => {
      const user = makeUser();

      const ownedBoard = makeKanbanBoard({ ownerId: user.id });
      const sharedBoard = makeKanbanBoard();

      m(prisma.kanbanBoard.findMany).mockResolvedValue([
        {
          ...ownedBoard,
          _count: { columns: 3, shares: 1 },
          columns: [
            { _count: { cards: 2 } },
            { _count: { cards: 3 } },
            { _count: { cards: 0 } },
          ],
          shares: [
            {
              userId: 'u2',
              permission: 'WRITE',
              user: { id: 'u2', name: 'Bob', email: 'bob@test.com', avatarUrl: null },
            },
          ],
        } as any,
      ]);

      m(prisma.sharedKanbanBoard.findMany).mockResolvedValue([
        {
          permission: 'READ',
          board: {
            ...sharedBoard,
            owner: { id: sharedBoard.ownerId, name: 'Alice', email: 'alice@test.com' },
            _count: { columns: 2, shares: 0 },
            columns: [{ _count: { cards: 1 } }],
            shares: [],
          },
        } as any,
      ]);

      const result = await listBoards(user.id);

      expect(result).toHaveLength(2);
      expect(result[0].ownership).toBe('owned');
      expect(result[0].cardCount).toBe(5); // 2+3+0
      expect(result[0].columnCount).toBe(3);
      expect(result[0].shareCount).toBe(1);
      expect(result[1].ownership).toBe('shared');
      expect(result[1].cardCount).toBe(1);
    });

    it('returns empty array when user has no boards', async () => {
      m(prisma.kanbanBoard.findMany).mockResolvedValue([]);
      m(prisma.sharedKanbanBoard.findMany).mockResolvedValue([]);

      const result = await listBoards('no-boards-user');

      expect(result).toEqual([]);
    });
  });

  // ─── createBoard ───────────────────────────────────────────

  describe('createBoard', () => {
    it('creates board with 3 default columns inside a transaction', async () => {
      const user = makeUser();
      const board = makeKanbanBoard({ ownerId: user.id, title: 'My Board' });
      const columns = [
        makeKanbanColumn({ boardId: board.id, title: 'TODO', position: 0 }),
        makeKanbanColumn({ boardId: board.id, title: 'IN_PROGRESS', position: 1 }),
        makeKanbanColumn({ boardId: board.id, title: 'DONE', position: 2, isCompleted: true }),
      ];

      // $transaction passes mockPrisma into fn — setup.ts already handles this
      m(prisma.kanbanBoard.create).mockResolvedValue({
        ...board,
        columns,
      } as any);

      const result = await createBoard(user.id, 'My Board', 'A description');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.kanbanBoard.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: 'My Board',
            description: 'A description',
            ownerId: user.id,
            columns: {
              create: [
                { title: 'TODO', position: 0 },
                { title: 'IN_PROGRESS', position: 1 },
                { title: 'DONE', position: 2, isCompleted: true },
              ],
            },
          }),
        })
      );
      expect(result.columns).toHaveLength(3);
    });

    it('creates board without description when omitted', async () => {
      const user = makeUser();
      const board = makeKanbanBoard({ ownerId: user.id });

      m(prisma.kanbanBoard.create).mockResolvedValue({
        ...board,
        columns: [],
      } as any);

      await createBoard(user.id, 'Untitled');

      expect(prisma.kanbanBoard.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            description: undefined,
          }),
        })
      );
    });
  });

  // ─── getBoard ──────────────────────────────────────────────

  describe('getBoard', () => {
    it('returns board with columns, cards (transformed), and archivedCardsCount', async () => {
      const user = makeUser();
      const board = makeKanbanBoard({ ownerId: user.id });
      const column = makeKanbanColumn({ boardId: board.id });
      const card = makeKanbanCard({ columnId: column.id });

      // archiveCompletedCards is already mocked to return 0

      // Mock kanbanColumn.findMany for auto-complete check
      m(prisma.kanbanColumn.findMany).mockResolvedValue([
        { id: column.id, isCompleted: true } as any,
      ]);

      m(prisma.kanbanBoard.findUnique).mockResolvedValue({
        ...board,
        noteId: null,
        taskListId: null,
        columns: [
          {
            ...column,
            cards: [
              {
                ...card,
                assignee: null,
                note: null,
                _count: { comments: 5 },
              },
            ],
          },
        ],
        shares: [],
        owner: { id: user.id, name: user.name, email: user.email, color: user.color, avatarUrl: user.avatarUrl },
        note: null,
        taskList: null,
      } as any);

      m(prisma.kanbanCard.count).mockResolvedValue(3);

      const result = await getBoard(board.id);

      expect(result.archivedCardsCount).toBe(3);
      // transformCard converts _count.comments -> commentCount
      expect(result.columns[0].cards[0]).toHaveProperty('commentCount', 5);
      expect(result.columns[0].cards[0]).not.toHaveProperty('_count');
    });

    it('throws NotFoundError when board does not exist', async () => {
      // archiveCompletedCards already mocked
      m(prisma.kanbanColumn.findMany).mockResolvedValue([]);
      m(prisma.kanbanBoard.findUnique).mockResolvedValue(null);

      await expect(getBoard('nonexistent-id')).rejects.toThrow('errors.kanban.boardNotFound');
    });

    it('auto-marks last column as completed if none have isCompleted set', async () => {
      const user = makeUser();
      const board = makeKanbanBoard({ ownerId: user.id });
      const col1 = makeKanbanColumn({ boardId: board.id, position: 0, isCompleted: false });
      const col2 = makeKanbanColumn({ boardId: board.id, position: 1, isCompleted: false });

      m(prisma.kanbanColumn.findMany).mockResolvedValue([
        { id: col1.id, isCompleted: false },
        { id: col2.id, isCompleted: false },
      ] as any);

      m(prisma.kanbanColumn.update).mockResolvedValue({} as any);

      m(prisma.kanbanBoard.findUnique).mockResolvedValue({
        ...board,
        noteId: null,
        taskListId: null,
        columns: [],
        shares: [],
        owner: { id: user.id, name: user.name, email: user.email, color: user.color, avatarUrl: user.avatarUrl },
        note: null,
        taskList: null,
      } as any);

      m(prisma.kanbanCard.count).mockResolvedValue(0);

      await getBoard(board.id);

      // Should update the LAST column (col2) to isCompleted: true
      expect(prisma.kanbanColumn.update).toHaveBeenCalledWith({
        where: { id: col2.id },
        data: { isCompleted: true },
      });
    });

    it('filters linked note visibility for requesting user', async () => {
      const owner = makeUser();
      const requestingUser = makeUser();
      const board = makeKanbanBoard({ ownerId: owner.id });
      const column = makeKanbanColumn({ boardId: board.id });
      const noteId = 'note-1';
      const card = makeKanbanCard({ columnId: column.id, noteId });

      m(prisma.kanbanColumn.findMany).mockResolvedValue([
        { id: column.id, isCompleted: true } as any,
      ]);

      m(prisma.kanbanBoard.findUnique).mockResolvedValue({
        ...board,
        noteId: null,
        taskListId: null,
        columns: [
          {
            ...column,
            cards: [
              {
                ...card,
                noteId,
                assignee: null,
                note: { id: noteId, title: 'Secret Note', userId: owner.id },
                _count: { comments: 0 },
              },
            ],
          },
        ],
        shares: [],
        owner: { id: owner.id, name: owner.name, email: owner.email, color: owner.color, avatarUrl: owner.avatarUrl },
        note: null,
        taskList: null,
      } as any);

      m(prisma.kanbanCard.count).mockResolvedValue(0);

      // User has NO shared access and does NOT own the note
      m(prisma.sharedNote.findMany).mockResolvedValue([]);
      m(prisma.note.findMany).mockResolvedValue([]);

      const result = await getBoard(board.id, requestingUser.id);

      // The card's note should be nulled out since user can't access it
      expect(result.columns[0].cards[0].note).toBeNull();
    });
  });

  // ─── updateBoard ───────────────────────────────────────────

  describe('updateBoard', () => {
    it('updates board title and description', async () => {
      const board = makeKanbanBoard({ title: 'Old Title' });

      m(prisma.kanbanBoard.update).mockResolvedValue({
        ...board,
        title: 'New Title',
        description: 'New Desc',
        shares: [],
        owner: { id: board.ownerId, name: 'User', email: 'user@test.com', color: null, avatarUrl: null },
        note: null,
      } as any);

      const result = await updateBoard(board.id, { title: 'New Title', description: 'New Desc' });

      expect(prisma.kanbanBoard.update).toHaveBeenCalledWith({
        where: { id: board.id },
        data: { title: 'New Title', description: 'New Desc' },
        include: expect.any(Object),
      });
      expect(result.title).toBe('New Title');
    });

    it('propagates Prisma error when board not found', async () => {
      // Prisma throws P2025 when record not found on update
      m(prisma.kanbanBoard.update).mockRejectedValue(
        new Error('Record to update not found.')
      );

      await expect(
        updateBoard('nonexistent', { title: 'X' })
      ).rejects.toThrow('Record to update not found.');
    });
  });

  // ─── deleteBoard ───────────────────────────────────────────

  describe('deleteBoard', () => {
    it('deletes board by id', async () => {
      const board = makeKanbanBoard();

      m(prisma.kanbanBoard.delete).mockResolvedValue(board);

      const result = await deleteBoard(board.id);

      expect(prisma.kanbanBoard.delete).toHaveBeenCalledWith({
        where: { id: board.id },
      });
      expect(result.id).toBe(board.id);
    });

    it('propagates Prisma error when board not found', async () => {
      m(prisma.kanbanBoard.delete).mockRejectedValue(
        new Error('Record to delete does not exist.')
      );

      await expect(deleteBoard('nonexistent')).rejects.toThrow(
        'Record to delete does not exist.'
      );
    });
  });

  // ─── createBoardFromTaskList ───────────────────────────────

  describe('createBoardFromTaskList', () => {
    it('creates board from task list with unchecked items in TODO and checked items in DONE', async () => {
      const user = makeUser();
      const taskList = makeTaskList({ userId: user.id, title: 'My Tasks' });
      const uncheckedItem = makeTaskItem({
        taskListId: taskList.id,
        text: 'Do something',
        isChecked: false,
        position: 0,
        priority: 'HIGH',
      });
      const checkedItem = makeTaskItem({
        taskListId: taskList.id,
        text: 'Already done',
        isChecked: true,
        checkedByUserId: user.id,
        position: 1,
        priority: 'LOW',
      });

      m(prisma.taskList.findUnique).mockResolvedValue({
        ...taskList,
        items: [uncheckedItem, checkedItem],
      } as any);

      const boardId = 'board-1';
      const todoColId = 'col-todo';
      const doneColId = 'col-done';

      m(prisma.kanbanBoard.create).mockResolvedValue({
        ...makeKanbanBoard({ id: boardId, ownerId: user.id, title: taskList.title, taskListId: taskList.id }),
        columns: [
          makeKanbanColumn({ id: todoColId, boardId, title: 'TODO', position: 0 }),
          makeKanbanColumn({ id: doneColId, boardId, title: 'DONE', position: 1, isCompleted: true }),
        ],
      } as any);

      m(prisma.kanbanCard.create).mockResolvedValue({} as any);

      const result = await createBoardFromTaskList(user.id, taskList.id);

      expect(result.title).toBe('My Tasks');

      // Should create 2 cards: one in TODO, one in DONE
      expect(prisma.kanbanCard.create).toHaveBeenCalledTimes(2);

      // Unchecked → TODO column
      expect(prisma.kanbanCard.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            columnId: todoColId,
            title: 'Do something',
            priority: 'HIGH',
            position: 0,
          }),
        })
      );

      // Checked → DONE column, assigneeId = checkedByUserId
      expect(prisma.kanbanCard.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            columnId: doneColId,
            title: 'Already done',
            assigneeId: user.id,
            priority: 'LOW',
            position: 0,
          }),
        })
      );
    });

    it('throws NotFoundError when task list does not exist', async () => {
      m(prisma.taskList.findUnique).mockResolvedValue(null);

      await expect(
        createBoardFromTaskList('user-1', 'nonexistent')
      ).rejects.toThrow('errors.tasks.listNotFound');
    });

    it('throws ForbiddenError when user is not owner and lacks WRITE shared access', async () => {
      const owner = makeUser();
      const otherUser = makeUser();
      const taskList = makeTaskList({ userId: owner.id });

      m(prisma.taskList.findUnique).mockResolvedValue({
        ...taskList,
        items: [],
      } as any);

      // No shared access at all
      m(prisma.sharedTaskList.findUnique).mockResolvedValue(null);

      await expect(
        createBoardFromTaskList(otherUser.id, taskList.id)
      ).rejects.toThrow('errors.common.accessDenied');
    });

    it('allows shared user with WRITE+ACCEPTED access to convert', async () => {
      const owner = makeUser();
      const sharedUser = makeUser();
      const taskList = makeTaskList({ userId: owner.id, title: 'Shared Tasks' });

      m(prisma.taskList.findUnique).mockResolvedValue({
        ...taskList,
        items: [],
      } as any);

      // Shared with WRITE + ACCEPTED
      m(prisma.sharedTaskList.findUnique).mockResolvedValue({
        status: 'ACCEPTED',
        permission: 'WRITE',
      } as any);

      const boardId = 'board-shared';
      m(prisma.kanbanBoard.create).mockResolvedValue({
        ...makeKanbanBoard({ id: boardId, ownerId: sharedUser.id, title: taskList.title, taskListId: taskList.id }),
        columns: [
          makeKanbanColumn({ boardId, title: 'TODO', position: 0 }),
          makeKanbanColumn({ boardId, title: 'DONE', position: 1, isCompleted: true }),
        ],
      } as any);

      const result = await createBoardFromTaskList(sharedUser.id, taskList.id);

      expect(result.title).toBe('Shared Tasks');
    });

    it('truncates long task item text into title + description', async () => {
      const user = makeUser();
      const longText = 'A'.repeat(150);
      const taskList = makeTaskList({ userId: user.id });
      const longItem = makeTaskItem({
        taskListId: taskList.id,
        text: longText,
        isChecked: false,
        position: 0,
      });

      m(prisma.taskList.findUnique).mockResolvedValue({
        ...taskList,
        items: [longItem],
      } as any);

      const boardId = 'board-long';
      const todoColId = 'col-todo-long';
      m(prisma.kanbanBoard.create).mockResolvedValue({
        ...makeKanbanBoard({ id: boardId, ownerId: user.id, taskListId: taskList.id }),
        columns: [
          makeKanbanColumn({ id: todoColId, boardId, title: 'TODO', position: 0 }),
          makeKanbanColumn({ boardId, title: 'DONE', position: 1, isCompleted: true }),
        ],
      } as any);

      m(prisma.kanbanCard.create).mockResolvedValue({} as any);

      await createBoardFromTaskList(user.id, taskList.id);

      expect(prisma.kanbanCard.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            columnId: todoColId,
            title: longText.substring(0, 100) + '...',
            description: longText,
          }),
        })
      );
    });
  });
});
