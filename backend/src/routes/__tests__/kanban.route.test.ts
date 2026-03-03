import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

// Mock kanban services (must be before imports)
vi.mock('../../services/kanban/index', () => ({
  listBoards: vi.fn(),
  createBoard: vi.fn(),
  getBoard: vi.fn(),
  updateBoard: vi.fn(),
  deleteBoard: vi.fn(),
  createBoardFromTaskList: vi.fn(),
  createColumn: vi.fn(),
  updateColumn: vi.fn(),
  reorderColumns: vi.fn(),
  deleteColumn: vi.fn(),
  createCard: vi.fn(),
  updateCard: vi.fn(),
  moveCard: vi.fn(),
  deleteCard: vi.fn(),
  getCardActivities: vi.fn(),
  getComments: vi.fn(),
  createComment: vi.fn(),
  deleteComment: vi.fn(),
  getBoardChat: vi.fn(),
  createBoardChatMessage: vi.fn(),
  checkNoteSharingForBoard: vi.fn(),
  linkNoteToCard: vi.fn(),
  unlinkNoteFromCard: vi.fn(),
  linkNoteToBoard: vi.fn(),
  unlinkNoteFromBoard: vi.fn(),
  searchUserNotes: vi.fn(),
  getLinkedBoardsForNote: vi.fn(),
  getArchivedCards: vi.fn(),
  unarchiveCard: vi.fn(),
  linkTaskListToBoard: vi.fn(),
  unlinkTaskListFromBoard: vi.fn(),
  searchUserTaskLists: vi.fn(),
}));

vi.mock('../../services/kanbanPermissions', () => ({
  assertBoardAccess: vi.fn(),
  getColumnWithAccess: vi.fn(),
  getCardWithAccess: vi.fn(),
}));

vi.mock('../../services/kanbanSSE', () => ({
  addConnection: vi.fn(),
}));

vi.mock('../../plugins/prisma', () => ({
  default: {
    kanbanBoard: { findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock('../../services/kanbanReminder.service', () => ({
  getUserKanbanReminders: vi.fn(),
  toggleReminderDone: vi.fn(),
}));

import * as kanbanService from '../../services/kanban/index';
import * as kanbanPermissions from '../../services/kanbanPermissions';
import { AppError, NotFoundError, ForbiddenError } from '../../utils/errors';
import kanbanRoutes from '../kanban';

const mockKanbanService = kanbanService as any;
const mockPermissions = kanbanPermissions as any;

const TEST_USER = { id: 'user-1', email: 'test@test.com', role: 'USER', tokenVersion: 0 };
const TEST_UUID = '550e8400-e29b-41d4-a716-446655440000';

let app: FastifyInstance;
let authToken: string;

beforeAll(async () => {
  app = Fastify();
  app.register(jwt, { secret: 'test-secret' });

  app.decorate('authenticate', async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ message: 'Unauthorized' });
    }
  });

  // Error handler (matches production behavior)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ message: error.message });
    }
    if (error.name === 'ZodError') {
      return reply.status(400).send({ message: 'Validation error', issues: (error as any).issues || (error as any).errors });
    }
    reply.status(500).send({ message: error.message });
  });

  app.register(kanbanRoutes, { prefix: '/api/kanban' });
  await app.ready();
  authToken = app.jwt.sign(TEST_USER);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: permissions pass with isOwner true
  mockPermissions.assertBoardAccess.mockResolvedValue({ isOwner: true });
  mockPermissions.getColumnWithAccess.mockResolvedValue({ boardId: 'board-1', isOwner: true });
  mockPermissions.getCardWithAccess.mockResolvedValue({ boardId: 'board-1', columnId: 'col-1', isOwner: true });
});

// ── Boards ──────────────────────────────────────────────────────

describe('GET /api/kanban/boards', () => {
  it('returns boards list', async () => {
    const mockBoards = [{ id: 'board-1', title: 'Sprint 1' }];
    mockKanbanService.listBoards.mockResolvedValue(mockBoards);

    const res = await app.inject({
      method: 'GET',
      url: '/api/kanban/boards',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockBoards);
    expect(mockKanbanService.listBoards).toHaveBeenCalledWith(TEST_USER.id);
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/kanban/boards',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/kanban/boards', () => {
  it('creates a board with valid data', async () => {
    const mockBoard = { id: 'board-1', title: 'Sprint 1', ownerId: TEST_USER.id };
    mockKanbanService.createBoard.mockResolvedValue(mockBoard);

    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/boards',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { title: 'Sprint 1', description: 'First sprint' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockBoard);
    expect(mockKanbanService.createBoard).toHaveBeenCalledWith(TEST_USER.id, 'Sprint 1', 'First sprint');
  });

  it('returns 400 with empty title', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/boards',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { title: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 with title exceeding 200 characters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/boards',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { title: 'x'.repeat(201) },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/kanban/boards/:id', () => {
  it('returns a board by id', async () => {
    const mockBoard = { id: 'board-1', title: 'Sprint 1', columns: [] };
    mockKanbanService.getBoard.mockResolvedValue(mockBoard);

    const res = await app.inject({
      method: 'GET',
      url: '/api/kanban/boards/board-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockBoard);
    expect(mockPermissions.assertBoardAccess).toHaveBeenCalledWith('board-1', TEST_USER.id, 'READ');
  });

  it('returns 404 when board not found', async () => {
    mockPermissions.assertBoardAccess.mockRejectedValue(new NotFoundError('errors.kanban.boardNotFound'));

    const res = await app.inject({
      method: 'GET',
      url: '/api/kanban/boards/board-999',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 403 when user has no access', async () => {
    mockPermissions.assertBoardAccess.mockRejectedValue(new ForbiddenError('errors.common.accessDenied'));

    const res = await app.inject({
      method: 'GET',
      url: '/api/kanban/boards/board-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('PUT /api/kanban/boards/:id', () => {
  it('updates a board', async () => {
    const updated = { id: 'board-1', title: 'Updated' };
    mockKanbanService.updateBoard.mockResolvedValue(updated);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/kanban/boards/board-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { title: 'Updated' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(updated);
    expect(mockPermissions.assertBoardAccess).toHaveBeenCalledWith('board-1', TEST_USER.id, 'WRITE');
  });

  it('returns 400 with description exceeding 2000 characters', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/kanban/boards/board-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { description: 'x'.repeat(2001) },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/kanban/boards/:id', () => {
  it('deletes a board when owner', async () => {
    mockPermissions.assertBoardAccess.mockResolvedValue({ isOwner: true });
    mockKanbanService.deleteBoard.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/kanban/boards/board-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
  });

  it('returns 403 when non-owner tries to delete', async () => {
    mockPermissions.assertBoardAccess.mockResolvedValue({ isOwner: false });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/kanban/boards/board-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).message).toBe('errors.kanban.onlyOwnerCanDelete');
  });
});

// ── Columns ──────────────────────────────────────────────────────

describe('POST /api/kanban/boards/:id/columns', () => {
  it('creates a column', async () => {
    const mockColumn = { id: 'col-1', title: 'To Do', position: 0 };
    mockKanbanService.createColumn.mockResolvedValue(mockColumn);

    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/boards/board-1/columns',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { title: 'To Do' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockColumn);
    expect(mockKanbanService.createColumn).toHaveBeenCalledWith('board-1', 'To Do');
  });

  it('returns 400 with empty title', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/boards/board-1/columns',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { title: '' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /api/kanban/columns/:id', () => {
  it('updates a column title', async () => {
    const updated = { id: 'col-1', title: 'In Progress' };
    mockKanbanService.updateColumn.mockResolvedValue(updated);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/kanban/columns/col-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { title: 'In Progress' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(updated);
    expect(mockPermissions.getColumnWithAccess).toHaveBeenCalledWith('col-1', TEST_USER.id, 'WRITE');
  });
});

describe('PUT /api/kanban/boards/:id/columns/reorder', () => {
  it('reorders columns', async () => {
    mockKanbanService.reorderColumns.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/kanban/boards/board-1/columns/reorder',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        columns: [
          { id: 'col-1', position: 1 },
          { id: 'col-2', position: 0 },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
  });

  it('returns 400 with negative position', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/kanban/boards/board-1/columns/reorder',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        columns: [{ id: 'col-1', position: -1 }],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/kanban/columns/:id', () => {
  it('deletes a column', async () => {
    mockKanbanService.deleteColumn.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/kanban/columns/col-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
  });
});

// ── Cards ────────────────────────────────────────────────────────

describe('POST /api/kanban/columns/:id/cards', () => {
  it('creates a card', async () => {
    const mockCard = { id: 'card-1', title: 'Fix bug', columnId: 'col-1' };
    mockKanbanService.createCard.mockResolvedValue(mockCard);

    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/columns/col-1/cards',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { title: 'Fix bug', description: 'Critical issue' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockCard);
    expect(mockKanbanService.createCard).toHaveBeenCalledWith('col-1', 'Fix bug', 'Critical issue', TEST_USER.id);
  });

  it('returns 400 with empty title', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/columns/col-1/cards',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { title: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 with title exceeding 500 characters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/columns/col-1/cards',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { title: 'x'.repeat(501) },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /api/kanban/cards/:id', () => {
  it('updates a card', async () => {
    const updated = { id: 'card-1', title: 'Updated card', priority: 'HIGH' };
    mockKanbanService.updateCard.mockResolvedValue(updated);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/kanban/cards/card-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { title: 'Updated card', priority: 'HIGH' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(updated);
    expect(mockKanbanService.updateCard).toHaveBeenCalledWith(
      'card-1',
      { title: 'Updated card', priority: 'HIGH' },
      TEST_USER.id,
    );
  });

  it('returns 400 with invalid priority value', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/kanban/cards/card-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { priority: 'INVALID' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /api/kanban/cards/:id/move', () => {
  it('moves a card to another column', async () => {
    mockKanbanService.moveCard.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/kanban/cards/card-1/move',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { toColumnId: 'col-2', position: 0 },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
    expect(mockKanbanService.moveCard).toHaveBeenCalledWith('card-1', 'col-2', 0, TEST_USER.id);
  });

  it('returns 400 with negative position', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/kanban/cards/card-1/move',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { toColumnId: 'col-2', position: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 without toColumnId', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/kanban/cards/card-1/move',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { position: 0 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/kanban/cards/:id', () => {
  it('deletes a card', async () => {
    mockKanbanService.deleteCard.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/kanban/cards/card-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
  });
});

// ── Comments ─────────────────────────────────────────────────────

describe('GET /api/kanban/cards/:id/comments', () => {
  it('returns paginated comments', async () => {
    const mockComments = [{ id: 'cmt-1', content: 'Looks good', userId: 'user-2' }];
    mockKanbanService.getComments.mockResolvedValue(mockComments);

    const res = await app.inject({
      method: 'GET',
      url: '/api/kanban/cards/card-1/comments',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockComments);
    expect(mockKanbanService.getComments).toHaveBeenCalledWith('card-1', 1, 50);
  });

  it('passes pagination params', async () => {
    mockKanbanService.getComments.mockResolvedValue([]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/kanban/cards/card-1/comments?page=2&limit=10',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(mockKanbanService.getComments).toHaveBeenCalledWith('card-1', 2, 10);
  });
});

describe('POST /api/kanban/cards/:id/comments', () => {
  it('creates a comment', async () => {
    const mockComment = { id: 'cmt-1', content: 'Great work', cardId: 'card-1', userId: TEST_USER.id };
    mockKanbanService.createComment.mockResolvedValue(mockComment);

    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/card-1/comments',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { content: 'Great work' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockComment);
    expect(mockKanbanService.createComment).toHaveBeenCalledWith('card-1', TEST_USER.id, 'Great work');
  });

  it('returns 400 with empty content', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/card-1/comments',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { content: '' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/kanban/comments/:id', () => {
  it('deletes a comment', async () => {
    mockKanbanService.deleteComment.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/kanban/comments/cmt-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
    expect(mockKanbanService.deleteComment).toHaveBeenCalledWith('cmt-1', TEST_USER.id);
  });
});

// ── Note Linking ─────────────────────────────────────────────────

describe('POST /api/kanban/cards/:id/link-note', () => {
  it('links a note to a card', async () => {
    const mockResult = { id: 'card-1', noteId: TEST_UUID };
    mockKanbanService.linkNoteToCard.mockResolvedValue(mockResult);

    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/card-1/link-note',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { noteId: TEST_UUID },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockResult);
    expect(mockKanbanService.linkNoteToCard).toHaveBeenCalledWith('card-1', TEST_UUID, TEST_USER.id, undefined);
  });

  it('returns 400 with non-UUID noteId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/card-1/link-note',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { noteId: 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/kanban/cards/:id/link-note', () => {
  it('unlinks a note from a card', async () => {
    const mockResult = { id: 'card-1', noteId: null };
    mockKanbanService.unlinkNoteFromCard.mockResolvedValue(mockResult);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/kanban/cards/card-1/link-note',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockResult);
  });
});

// ── Board Chat ───────────────────────────────────────────────────

describe('POST /api/kanban/boards/:id/chat', () => {
  it('creates a chat message', async () => {
    const mockMsg = { id: 'msg-1', content: 'Hello team', boardId: 'board-1', userId: TEST_USER.id };
    mockKanbanService.createBoardChatMessage.mockResolvedValue(mockMsg);

    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/boards/board-1/chat',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { content: 'Hello team' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockMsg);
    expect(mockKanbanService.createBoardChatMessage).toHaveBeenCalledWith('board-1', TEST_USER.id, 'Hello team');
  });

  it('returns 400 with empty content', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/boards/board-1/chat',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { content: '' },
    });
    expect(res.statusCode).toBe(400);
  });
});
