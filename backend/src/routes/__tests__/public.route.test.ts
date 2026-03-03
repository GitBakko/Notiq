import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

// Mock note service BEFORE imports
vi.mock('../../services/note.service', () => ({
  getPublicNote: vi.fn(),
}));

import * as noteService from '../../services/note.service';
import { AppError } from '../../utils/errors';
import publicRoutes from '../public';

const mockNoteService = noteService as any;

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ message: error.message });
    }
    if (error.name === 'ZodError') {
      return reply.status(400).send({ message: 'Validation error', issues: (error as any).issues || (error as any).errors });
    }
    reply.status(500).send({ message: error.message });
  });

  app.register(publicRoutes, { prefix: '/api/public' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/public/notes/:shareId', () => {
  it('returns a public note', async () => {
    const mockNote = { id: 'note-1', title: 'Public Note', isPublic: true, shareId: 'share-abc' };
    mockNoteService.getPublicNote.mockResolvedValue(mockNote);

    const res = await app.inject({
      method: 'GET',
      url: '/api/public/notes/share-abc',
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockNote);
    expect(mockNoteService.getPublicNote).toHaveBeenCalledWith('share-abc');
  });

  it('returns 404 when note not found', async () => {
    mockNoteService.getPublicNote.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/api/public/notes/nonexistent',
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload)).toEqual({ message: 'errors.notes.notFoundOrNotPublic' });
  });

  it('returns 404 when note exists but is not public', async () => {
    mockNoteService.getPublicNote.mockResolvedValue({ id: 'note-2', title: 'Private', isPublic: false });

    const res = await app.inject({
      method: 'GET',
      url: '/api/public/notes/share-xyz',
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload)).toEqual({ message: 'errors.notes.notFoundOrNotPublic' });
  });

  it('does not require authentication', async () => {
    const mockNote = { id: 'note-3', title: 'Open Note', isPublic: true, shareId: 'open-share' };
    mockNoteService.getPublicNote.mockResolvedValue(mockNote);

    // No auth header — should still work
    const res = await app.inject({
      method: 'GET',
      url: '/api/public/notes/open-share',
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(mockNote);
  });
});
