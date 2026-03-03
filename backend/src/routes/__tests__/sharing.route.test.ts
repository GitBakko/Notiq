import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

// Mock all services BEFORE imports
vi.mock('../../services/sharing.service', () => ({
  shareNote: vi.fn(),
  revokeNoteShare: vi.fn(),
  getSharedNotes: vi.fn(),
  getAcceptedSharedNotes: vi.fn(),
  shareNotebook: vi.fn(),
  revokeNotebookShare: vi.fn(),
  getSharedNotebooks: vi.fn(),
  respondToShareById: vi.fn(),
  shareKanbanBoard: vi.fn(),
  revokeKanbanBoardShare: vi.fn(),
  getSentShares: vi.fn(),
  resendShareInvitation: vi.fn(),
}));

vi.mock('../../services/tasklist-sharing.service', () => ({
  shareTaskList: vi.fn(),
  revokeTaskListShare: vi.fn(),
  getSharedTaskLists: vi.fn(),
  respondToTaskListShareById: vi.fn(),
}));

vi.mock('../../services/tasklist.service', () => ({
  getAcceptedSharedTaskLists: vi.fn(),
}));

vi.mock('../../services/note.service', () => ({
  getPublicNote: vi.fn(),
}));

vi.mock('../../services/group.service', () => ({
  getGroup: vi.fn(),
}));

vi.mock('../../plugins/prisma', () => ({
  default: {
    sharedKanbanBoard: {
      findMany: vi.fn(),
    },
  },
}));

import * as sharingService from '../../services/sharing.service';
import * as taskListSharingService from '../../services/tasklist-sharing.service';
import * as taskListService from '../../services/tasklist.service';
import * as noteService from '../../services/note.service';
import * as groupService from '../../services/group.service';
import prisma from '../../plugins/prisma';
import { AppError, NotFoundError, ForbiddenError, BadRequestError } from '../../utils/errors';
import sharingRoutes from '../sharing';

const mockSharingService = sharingService as any;
const mockTaskListSharingService = taskListSharingService as any;
const mockTaskListService = taskListService as any;
const mockNoteService = noteService as any;
const mockGroupService = groupService as any;
const mockPrisma = prisma as any;

const TEST_USER = { id: 'user-1', email: 'test@test.com', role: 'USER', tokenVersion: 0 };

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

  app.register(sharingRoutes, { prefix: '/api/sharing' });
  await app.ready();
  authToken = app.jwt.sign(TEST_USER);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Public Note Access ──────────────────────────────────────────────
// Note: addHook('onRequest', authenticate) applies to ALL routes in the plugin,
// including /public/:shareId. The frontend calls it with JWT via api.get().

describe('GET /api/sharing/public/:shareId', () => {
  it('returns a public note by shareId', async () => {
    const mockNote = { id: 'note-1', title: 'Public Note', content: '<p>Hello</p>' };
    mockNoteService.getPublicNote.mockResolvedValue(mockNote);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sharing/public/share-abc-123',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockNote);
    expect(mockNoteService.getPublicNote).toHaveBeenCalledWith('share-abc-123');
  });

  it('returns 404 when public note not found', async () => {
    mockNoteService.getPublicNote.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sharing/public/nonexistent',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload)).toEqual({ message: 'errors.notes.notFound' });
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sharing/public/share-abc-123',
    });

    expect(res.statusCode).toBe(401);
  });
});

// ── Share Note ──────────────────────────────────────────────────────

describe('POST /api/sharing/notes/:id', () => {
  it('shares a note with valid email and permission', async () => {
    const mockShare = { id: 'share-1', noteId: 'note-1', userId: 'user-2', permission: 'READ' };
    mockSharingService.shareNote.mockResolvedValue(mockShare);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/notes/note-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { email: 'other@test.com', permission: 'READ' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockShare);
    expect(mockSharingService.shareNote).toHaveBeenCalledWith('user-1', 'note-1', 'other@test.com', 'READ');
  });

  it('defaults permission to READ when not specified', async () => {
    mockSharingService.shareNote.mockResolvedValue({ id: 'share-1' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/notes/note-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { email: 'other@test.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockSharingService.shareNote).toHaveBeenCalledWith('user-1', 'note-1', 'other@test.com', 'READ');
  });

  it('returns 400 with invalid email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/notes/note-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { email: 'not-an-email' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 with missing email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/notes/note-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/notes/note-1',
      payload: { email: 'other@test.com' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('propagates NotFoundError from service', async () => {
    mockSharingService.shareNote.mockRejectedValue(new NotFoundError('errors.sharing.notFound'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/notes/note-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { email: 'other@test.com' },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload)).toEqual({ message: 'errors.sharing.notFound' });
  });

  it('propagates ForbiddenError from service', async () => {
    mockSharingService.shareNote.mockRejectedValue(new ForbiddenError('errors.sharing.forbidden'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/notes/note-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { email: 'other@test.com' },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload)).toEqual({ message: 'errors.sharing.forbidden' });
  });
});

// ── Revoke Note Share ───────────────────────────────────────────────

describe('DELETE /api/sharing/notes/:id/:userId', () => {
  it('revokes a note share', async () => {
    mockSharingService.revokeNoteShare.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/sharing/notes/note-1/user-2',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
    expect(mockSharingService.revokeNoteShare).toHaveBeenCalledWith('user-1', 'note-1', 'user-2');
  });

  it('treats Prisma P2025 (already deleted) as idempotent success', async () => {
    const prismaError = Object.assign(new Error('Record not found'), { code: 'P2025' });
    mockSharingService.revokeNoteShare.mockRejectedValue(prismaError);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/sharing/notes/note-1/user-2',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
  });

  it('propagates non-Prisma errors', async () => {
    mockSharingService.revokeNoteShare.mockRejectedValue(new ForbiddenError('errors.sharing.forbidden'));

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/sharing/notes/note-1/user-2',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(403);
  });
});

// ── Get Shared Notes ────────────────────────────────────────────────

describe('GET /api/sharing/notes', () => {
  it('returns shared notes for the user', async () => {
    const mockNotes = [{ id: 'share-1', noteId: 'note-1', status: 'PENDING' }];
    mockSharingService.getSharedNotes.mockResolvedValue(mockNotes);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sharing/notes',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockNotes);
    expect(mockSharingService.getSharedNotes).toHaveBeenCalledWith('user-1');
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sharing/notes',
    });

    expect(res.statusCode).toBe(401);
  });
});

// ── Get Accepted Shared Notes ───────────────────────────────────────

describe('GET /api/sharing/notes/accepted', () => {
  it('returns accepted shared notes for sync', async () => {
    const mockNotes = [{ id: 'note-1', title: 'Shared Note' }];
    mockSharingService.getAcceptedSharedNotes.mockResolvedValue(mockNotes);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sharing/notes/accepted',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockNotes);
    expect(mockSharingService.getAcceptedSharedNotes).toHaveBeenCalledWith('user-1');
  });
});

// ── Share Notebook ──────────────────────────────────────────────────

describe('POST /api/sharing/notebooks/:id', () => {
  it('shares a notebook with valid data', async () => {
    const mockShare = { id: 'share-1', notebookId: 'nb-1', userId: 'user-2', permission: 'WRITE' };
    mockSharingService.shareNotebook.mockResolvedValue(mockShare);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/notebooks/nb-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { email: 'other@test.com', permission: 'WRITE' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockShare);
    expect(mockSharingService.shareNotebook).toHaveBeenCalledWith('user-1', 'nb-1', 'other@test.com', 'WRITE');
  });

  it('returns 400 with invalid email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/notebooks/nb-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { email: 'bad-email' },
    });

    expect(res.statusCode).toBe(400);
  });
});

// ── Revoke Notebook Share ───────────────────────────────────────────

describe('DELETE /api/sharing/notebooks/:id/:userId', () => {
  it('revokes a notebook share', async () => {
    mockSharingService.revokeNotebookShare.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/sharing/notebooks/nb-1/user-2',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
    expect(mockSharingService.revokeNotebookShare).toHaveBeenCalledWith('user-1', 'nb-1', 'user-2');
  });

  it('treats Prisma P2025 as idempotent success', async () => {
    const prismaError = Object.assign(new Error('Record not found'), { code: 'P2025' });
    mockSharingService.revokeNotebookShare.mockRejectedValue(prismaError);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/sharing/notebooks/nb-1/user-2',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
  });
});

// ── Get Shared Notebooks ────────────────────────────────────────────

describe('GET /api/sharing/notebooks', () => {
  it('returns shared notebooks for the user', async () => {
    const mockNotebooks = [{ id: 'share-1', notebookId: 'nb-1', status: 'ACCEPTED' }];
    mockSharingService.getSharedNotebooks.mockResolvedValue(mockNotebooks);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sharing/notebooks',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockNotebooks);
    expect(mockSharingService.getSharedNotebooks).toHaveBeenCalledWith('user-1');
  });
});

// ── Respond to Share by ID ──────────────────────────────────────────

describe('POST /api/sharing/respond-id', () => {
  const validUuid = '550e8400-e29b-41d4-a716-446655440000';

  it('accepts a note share', async () => {
    mockSharingService.respondToShareById.mockResolvedValue({ status: 'ACCEPTED' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/respond-id',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { itemId: validUuid, type: 'NOTE', action: 'accept' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ status: 'ACCEPTED' });
    expect(mockSharingService.respondToShareById).toHaveBeenCalledWith('user-1', validUuid, 'NOTE', 'accept');
  });

  it('declines a notebook share', async () => {
    mockSharingService.respondToShareById.mockResolvedValue({ status: 'DECLINED' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/respond-id',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { itemId: validUuid, type: 'NOTEBOOK', action: 'decline' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockSharingService.respondToShareById).toHaveBeenCalledWith('user-1', validUuid, 'NOTEBOOK', 'decline');
  });

  it('routes TASKLIST type to taskListSharingService', async () => {
    mockTaskListSharingService.respondToTaskListShareById.mockResolvedValue({ status: 'ACCEPTED' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/respond-id',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { itemId: validUuid, type: 'TASKLIST', action: 'accept' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockTaskListSharingService.respondToTaskListShareById).toHaveBeenCalledWith('user-1', validUuid, 'accept');
    expect(mockSharingService.respondToShareById).not.toHaveBeenCalled();
  });

  it('routes KANBAN type to sharingService with KANBAN', async () => {
    mockSharingService.respondToShareById.mockResolvedValue({ status: 'ACCEPTED' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/respond-id',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { itemId: validUuid, type: 'KANBAN', action: 'accept' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockSharingService.respondToShareById).toHaveBeenCalledWith('user-1', validUuid, 'KANBAN', 'accept');
  });

  it('returns 400 with non-UUID itemId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/respond-id',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { itemId: 'not-a-uuid', type: 'NOTE', action: 'accept' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 with invalid type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/respond-id',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { itemId: validUuid, type: 'INVALID', action: 'accept' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 with invalid action', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/respond-id',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { itemId: validUuid, type: 'NOTE', action: 'maybe' },
    });

    expect(res.statusCode).toBe(400);
  });
});

// ── Sent Shares ─────────────────────────────────────────────────────

describe('GET /api/sharing/sent', () => {
  it('returns sent shares for the user', async () => {
    const mockSent = { notes: [], notebooks: [], taskLists: [], kanbans: [] };
    mockSharingService.getSentShares.mockResolvedValue(mockSent);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sharing/sent',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockSent);
    expect(mockSharingService.getSentShares).toHaveBeenCalledWith('user-1');
  });
});

// ── Resend Share Invitation ─────────────────────────────────────────

describe('POST /api/sharing/resend/:type/:id', () => {
  it('resends a note share invitation', async () => {
    mockSharingService.resendShareInvitation.mockResolvedValue({ success: true });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/resend/NOTE/share-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
    expect(mockSharingService.resendShareInvitation).toHaveBeenCalledWith('user-1', 'NOTE', 'share-1');
  });

  it('accepts lowercase type and uppercases it', async () => {
    mockSharingService.resendShareInvitation.mockResolvedValue({ success: true });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/resend/notebook/share-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(mockSharingService.resendShareInvitation).toHaveBeenCalledWith('user-1', 'NOTEBOOK', 'share-1');
  });

  it('returns 400 for invalid share type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/resend/INVALID/share-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({ message: 'errors.sharing.invalidType' });
  });
});

// ── Share Task List ─────────────────────────────────────────────────

describe('POST /api/sharing/tasklists/:id', () => {
  it('shares a task list with valid data', async () => {
    const mockShare = { id: 'share-1', taskListId: 'tl-1', permission: 'READ' };
    mockTaskListSharingService.shareTaskList.mockResolvedValue(mockShare);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/tasklists/tl-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { email: 'other@test.com', permission: 'READ' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockShare);
    expect(mockTaskListSharingService.shareTaskList).toHaveBeenCalledWith('user-1', 'tl-1', 'other@test.com', 'READ');
  });

  it('returns 400 with invalid email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/tasklists/tl-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { email: 'not-valid' },
    });

    expect(res.statusCode).toBe(400);
  });
});

// ── Revoke Task List Share ──────────────────────────────────────────

describe('DELETE /api/sharing/tasklists/:id/:userId', () => {
  it('revokes a task list share', async () => {
    mockTaskListSharingService.revokeTaskListShare.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/sharing/tasklists/tl-1/user-2',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
    expect(mockTaskListSharingService.revokeTaskListShare).toHaveBeenCalledWith('user-1', 'tl-1', 'user-2');
  });

  it('treats Prisma P2025 as idempotent success', async () => {
    const prismaError = Object.assign(new Error('Record not found'), { code: 'P2025' });
    mockTaskListSharingService.revokeTaskListShare.mockRejectedValue(prismaError);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/sharing/tasklists/tl-1/user-2',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
  });
});

// ── Get Shared Task Lists ───────────────────────────────────────────

describe('GET /api/sharing/tasklists', () => {
  it('returns shared task lists', async () => {
    const mockLists = [{ id: 'share-1', taskListId: 'tl-1', status: 'ACCEPTED' }];
    mockTaskListSharingService.getSharedTaskLists.mockResolvedValue(mockLists);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sharing/tasklists',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockLists);
    expect(mockTaskListSharingService.getSharedTaskLists).toHaveBeenCalledWith('user-1');
  });
});

// ── Get Accepted Shared Task Lists ──────────────────────────────────

describe('GET /api/sharing/tasklists/accepted', () => {
  it('returns accepted shared task lists for sync', async () => {
    const mockLists = [{ id: 'tl-1', title: 'Shared Tasks' }];
    mockTaskListService.getAcceptedSharedTaskLists.mockResolvedValue(mockLists);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sharing/tasklists/accepted',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockLists);
    expect(mockTaskListService.getAcceptedSharedTaskLists).toHaveBeenCalledWith('user-1');
  });
});

// ── Share Kanban Board ──────────────────────────────────────────────

describe('POST /api/sharing/kanbans/:id', () => {
  it('shares a kanban board with valid data', async () => {
    const mockShare = { id: 'share-1', boardId: 'board-1', permission: 'WRITE' };
    mockSharingService.shareKanbanBoard.mockResolvedValue(mockShare);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/kanbans/board-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { email: 'other@test.com', permission: 'WRITE' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockShare);
    expect(mockSharingService.shareKanbanBoard).toHaveBeenCalledWith('user-1', 'board-1', 'other@test.com', 'WRITE');
  });
});

// ── Revoke Kanban Board Share ───────────────────────────────────────

describe('DELETE /api/sharing/kanbans/:id/:userId', () => {
  it('revokes a kanban board share', async () => {
    mockSharingService.revokeKanbanBoardShare.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/sharing/kanbans/board-1/user-2',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true });
    expect(mockSharingService.revokeKanbanBoardShare).toHaveBeenCalledWith('user-1', 'board-1', 'user-2');
  });
});

// ── Get Shared Kanban Boards (all statuses) ─────────────────────────

describe('GET /api/sharing/kanbans', () => {
  it('returns shared kanban boards', async () => {
    const mockShares = [
      { id: 'share-1', permission: 'READ', status: 'PENDING', board: { id: 'board-1', title: 'Board' } },
    ];
    mockPrisma.sharedKanbanBoard.findMany.mockResolvedValue(mockShares);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sharing/kanbans',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockShares);
  });
});

// ── Get Accepted Shared Kanban Boards ───────────────────────────────

describe('GET /api/sharing/kanbans/accepted', () => {
  it('returns accepted kanban boards with _sharedPermission', async () => {
    const mockShares = [
      {
        permission: 'WRITE',
        board: {
          id: 'board-1',
          title: 'Board',
          owner: { id: 'user-2', name: 'Other', email: 'other@test.com', avatarUrl: null },
          columns: [],
          _count: { columns: 0 },
        },
      },
    ];
    mockPrisma.sharedKanbanBoard.findMany.mockResolvedValue(mockShares);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sharing/kanbans/accepted',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.payload);
    expect(payload).toHaveLength(1);
    expect(payload[0]._sharedPermission).toBe('WRITE');
    expect(payload[0].id).toBe('board-1');
    expect(payload[0].title).toBe('Board');
  });
});

// ── Group Sharing ───────────────────────────────────────────────────

describe('POST /api/sharing/notes/:id/group', () => {
  it('shares a note with all group members', async () => {
    const mockGroup = {
      id: 'group-1',
      members: [
        { userId: 'user-1', user: { email: 'test@test.com' } },
        { userId: 'user-2', user: { email: 'member1@test.com' } },
        { userId: 'user-3', user: { email: 'member2@test.com' } },
      ],
    };
    mockGroupService.getGroup.mockResolvedValue(mockGroup);
    mockSharingService.shareNote.mockResolvedValue({ id: 'share-1' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/notes/note-1/group',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { groupId: 'group-1', permission: 'WRITE' },
    });

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.payload);
    expect(payload.shared).toBe(2);
    expect(payload.errors).toEqual([]);
    // Should skip the requesting user (user-1)
    expect(mockSharingService.shareNote).toHaveBeenCalledTimes(2);
    expect(mockSharingService.shareNote).toHaveBeenCalledWith('user-1', 'note-1', 'member1@test.com', 'WRITE');
    expect(mockSharingService.shareNote).toHaveBeenCalledWith('user-1', 'note-1', 'member2@test.com', 'WRITE');
  });

  it('collects per-member errors without failing entire request', async () => {
    const mockGroup = {
      id: 'group-1',
      members: [
        { userId: 'user-2', user: { email: 'member1@test.com' } },
        { userId: 'user-3', user: { email: 'member2@test.com' } },
      ],
    };
    mockGroupService.getGroup.mockResolvedValue(mockGroup);
    mockSharingService.shareNote
      .mockResolvedValueOnce({ id: 'share-1' })
      .mockRejectedValueOnce(new BadRequestError('errors.sharing.alreadyShared'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/notes/note-1/group',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { groupId: 'group-1' },
    });

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.payload);
    expect(payload.shared).toBe(1);
    expect(payload.errors).toHaveLength(1);
    expect(payload.errors[0].userId).toBe('user-3');
  });
});

describe('POST /api/sharing/notebooks/:id/group', () => {
  it('shares a notebook with all group members', async () => {
    const mockGroup = {
      id: 'group-1',
      members: [
        { userId: 'user-1', user: { email: 'test@test.com' } },
        { userId: 'user-2', user: { email: 'member@test.com' } },
      ],
    };
    mockGroupService.getGroup.mockResolvedValue(mockGroup);
    mockSharingService.shareNotebook.mockResolvedValue({ id: 'share-1' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/notebooks/nb-1/group',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { groupId: 'group-1' },
    });

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.payload);
    expect(payload.shared).toBe(1);
    expect(mockSharingService.shareNotebook).toHaveBeenCalledWith('user-1', 'nb-1', 'member@test.com', 'READ');
  });
});

describe('POST /api/sharing/tasklists/:id/group', () => {
  it('shares a task list with all group members', async () => {
    const mockGroup = {
      id: 'group-1',
      members: [
        { userId: 'user-1', user: { email: 'test@test.com' } },
        { userId: 'user-2', user: { email: 'member@test.com' } },
      ],
    };
    mockGroupService.getGroup.mockResolvedValue(mockGroup);
    mockTaskListSharingService.shareTaskList.mockResolvedValue({ id: 'share-1' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/tasklists/tl-1/group',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { groupId: 'group-1', permission: 'WRITE' },
    });

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.payload);
    expect(payload.shared).toBe(1);
    expect(mockTaskListSharingService.shareTaskList).toHaveBeenCalledWith('user-1', 'tl-1', 'member@test.com', 'WRITE');
  });
});

describe('POST /api/sharing/kanbans/:id/group', () => {
  it('shares a kanban board with all group members', async () => {
    const mockGroup = {
      id: 'group-1',
      members: [
        { userId: 'user-1', user: { email: 'test@test.com' } },
        { userId: 'user-2', user: { email: 'member@test.com' } },
      ],
    };
    mockGroupService.getGroup.mockResolvedValue(mockGroup);
    mockSharingService.shareKanbanBoard.mockResolvedValue({ id: 'share-1' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sharing/kanbans/board-1/group',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { groupId: 'group-1' },
    });

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.payload);
    expect(payload.shared).toBe(1);
    expect(mockSharingService.shareKanbanBoard).toHaveBeenCalledWith('user-1', 'board-1', 'member@test.com', 'READ');
  });
});
