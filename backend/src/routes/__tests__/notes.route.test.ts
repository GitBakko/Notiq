import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

// Mock note service
vi.mock('../../services/note.service', () => ({
  createNote: vi.fn(),
  getNotes: vi.fn(),
  getNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
  toggleShare: vi.fn(),
  getNoteSizeBreakdown: vi.fn(),
}));

vi.mock('../../services/sharing.service', () => ({
  shareNote: vi.fn(),
}));

vi.mock('../../services/noteVersion.service', () => ({
  listNoteVersions: vi.fn(),
  restoreNoteVersion: vi.fn(),
}));

vi.mock('../../hocuspocus', () => ({
  flushLiveDoc: vi.fn(),
  replaceLiveDocContent: vi.fn(),
}));

import * as noteService from '../../services/note.service';
import { restoreNoteVersion } from '../../services/noteVersion.service';
import { flushLiveDoc, replaceLiveDocContent } from '../../hocuspocus';
import { AppError, NotFoundError } from '../../utils/errors';
import noteRoutes from '../notes';

const mockNoteService = noteService as any;

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

  app.register(noteRoutes, { prefix: '/api/notes' });
  await app.ready();
  authToken = app.jwt.sign(TEST_USER);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/notes', () => {
  it('creates a note with valid data', async () => {
    const mockNote = { id: 'note-1', title: 'Test', content: '', notebookId: 'nb-1' };
    mockNoteService.createNote.mockResolvedValue(mockNote);

    const res = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { title: 'Test', notebookId: '550e8400-e29b-41d4-a716-446655440000' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockNote);
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/notes',
      payload: { title: 'Test', notebookId: '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 with invalid notebookId (not UUID)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { title: 'Test', notebookId: 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/notes', () => {
  it('returns notes list', async () => {
    const mockNotes = [{ id: 'note-1', title: 'A' }];
    mockNoteService.getNotes.mockResolvedValue(mockNotes);

    const res = await app.inject({
      method: 'GET',
      url: '/api/notes',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockNotes);
  });

  it('passes query params correctly', async () => {
    mockNoteService.getNotes.mockResolvedValue([]);
    const nbId = '550e8400-e29b-41d4-a716-446655440000';

    const res = await app.inject({
      method: 'GET',
      url: `/api/notes?notebookId=${nbId}&search=hello&page=2&limit=10`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(mockNoteService.getNotes).toHaveBeenCalledWith(
      TEST_USER.id, nbId, 'hello', undefined, undefined, false, 2, 10
    );
  });

  it('rejects limit > 100', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/notes?limit=200',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/notes/:id', () => {
  it('returns a note by id', async () => {
    const mockNote = { id: 'note-1', title: 'Test' };
    mockNoteService.getNote.mockResolvedValue(mockNote);

    const res = await app.inject({
      method: 'GET',
      url: '/api/notes/note-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockNote);
  });

  it('returns 404 when note not found', async () => {
    mockNoteService.getNote.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/api/notes/note-999',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('PUT /api/notes/:id', () => {
  it('updates a note', async () => {
    mockNoteService.updateNote.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/notes/note-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { title: 'Updated Title' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ message: 'Note updated' });
  });

  it('returns 404 when note not found', async () => {
    mockNoteService.updateNote.mockRejectedValue(new NotFoundError('errors.notes.notFound'));

    const res = await app.inject({
      method: 'PUT',
      url: '/api/notes/note-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { title: 'X' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('accepts valid tags structure', async () => {
    mockNoteService.updateNote.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/notes/note-1',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        tags: [{ tag: { id: '550e8400-e29b-41d4-a716-446655440000' } }],
      },
    });

    expect(res.statusCode).toBe(200);
  });
});

describe('DELETE /api/notes/:id', () => {
  it('deletes a note', async () => {
    mockNoteService.deleteNote.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/notes/note-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ message: 'Note deleted' });
  });

  it('returns 404 when note not found', async () => {
    mockNoteService.deleteNote.mockRejectedValue(new NotFoundError('errors.notes.notFound'));

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/notes/note-1',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/notes/:id/size', () => {
  it('returns size breakdown', async () => {
    const breakdown = { note: 1000, attachments: 5000, chat: 200, ai: 100, total: 6300, characters: 450, lines: 12 };
    mockNoteService.getNoteSizeBreakdown.mockResolvedValue(breakdown);
    const uuid = '550e8400-e29b-41d4-a716-446655440000';

    const res = await app.inject({
      method: 'GET',
      url: `/api/notes/${uuid}/size`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(breakdown);
  });

  it('returns 404 when note not found', async () => {
    mockNoteService.getNoteSizeBreakdown.mockRejectedValue(new NotFoundError('errors.notes.notFound'));
    const uuid = '550e8400-e29b-41d4-a716-446655440000';

    const res = await app.inject({
      method: 'GET',
      url: `/api/notes/${uuid}/size`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it('rejects non-UUID id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/notes/not-a-uuid/size',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/notes/:id/share', () => {
  it('toggles share on a note', async () => {
    const mockNote = { id: 'note-1', isPublic: true, shareId: 'share-123' };
    mockNoteService.toggleShare.mockResolvedValue(mockNote);

    const res = await app.inject({
      method: 'POST',
      url: '/api/notes/note-1/share',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockNote);
  });
});

describe('POST /api/notes/:id/versions/:versionId/restore', () => {
  const NOTE = '550e8400-e29b-41d4-a716-446655440000';
  const VER = '550e8400-e29b-41d4-a716-446655440001';
  const call = () => app.inject({
    method: 'POST',
    url: `/api/notes/${NOTE}/versions/${VER}/restore`,
    headers: { authorization: `Bearer ${authToken}` },
  });

  it('pushes the raw restored content into the live collab doc', async () => {
    const raw = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] });
    (restoreNoteVersion as any).mockResolvedValue({ ok: true, restoredContent: raw });
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true });
    expect(replaceLiveDocContent).toHaveBeenCalledWith(NOTE, raw);
  });

  it('passes a beforeRestore hook as 4th arg to restoreNoteVersion', async () => {
    (restoreNoteVersion as any).mockResolvedValue({ ok: true, restoredContent: null });
    await call();
    expect(restoreNoteVersion).toHaveBeenCalledWith(
      TEST_USER.id, NOTE, VER, expect.objectContaining({ beforeRestore: expect.any(Function) }),
    );
  });

  it('flushes inside beforeRestore (during restore), then swaps the live doc', async () => {
    (restoreNoteVersion as any).mockImplementationOnce(async (_u: string, _n: string, _v: string, opts: any) => {
      await opts.beforeRestore();
      return { ok: true, restoredContent: '{"type":"doc"}' };
    });
    await call();
    expect(flushLiveDoc).toHaveBeenCalledWith(NOTE);
    const flushOrder = (flushLiveDoc as any).mock.invocationCallOrder[0];
    const restoreOrder = (restoreNoteVersion as any).mock.invocationCallOrder[0];
    const replaceOrder = (replaceLiveDocContent as any).mock.invocationCallOrder[0];
    expect(restoreOrder).toBeLessThan(flushOrder);
    expect(flushOrder).toBeLessThan(replaceOrder);
  });

  it('still restores (200) and warns when the flush fails', async () => {
    (restoreNoteVersion as any).mockImplementationOnce(async (_u: string, _n: string, _v: string, opts: any) => {
      await opts.beforeRestore();
      return { ok: true, restoredContent: '{"type":"doc"}' };
    });
    (flushLiveDoc as any).mockRejectedValue(new Error('flush boom'));
    const logWarn = vi.spyOn(app.log, 'warn');
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(restoreNoteVersion).toHaveBeenCalledTimes(1);
    expect(replaceLiveDocContent).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalled();
    logWarn.mockRestore();
    (flushLiveDoc as any).mockReset();
  });

  it('returns 404 and does not touch the live doc when the restore target is not found', async () => {
    (restoreNoteVersion as any).mockRejectedValue(new NotFoundError('errors.notes.versionNotFound'));
    const res = await call();
    expect(res.statusCode).toBe(404);
    expect(flushLiveDoc).not.toHaveBeenCalled();
    expect(replaceLiveDocContent).not.toHaveBeenCalled();
  });

  it('does not touch the live doc when restoredContent is null', async () => {
    (restoreNoteVersion as any).mockResolvedValue({ ok: true, restoredContent: null });
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(replaceLiveDocContent).not.toHaveBeenCalled();
  });

  it('still answers 200 { ok: true } when the live doc update fails', async () => {
    (restoreNoteVersion as any).mockResolvedValue({ ok: true, restoredContent: '{"type":"doc"}' });
    (replaceLiveDocContent as any).mockRejectedValue(new Error('boom'));
    const logError = vi.spyOn(app.log, 'error');
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true });
    expect(logError).toHaveBeenCalled();
    logError.mockRestore();
  });
});
