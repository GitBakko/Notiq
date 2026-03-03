import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';
import { searchNotes } from '../search.service';

const prismaMock = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// searchNotes
// ---------------------------------------------------------------------------
describe('searchNotes', () => {
  const mockSearchResults = [
    {
      id: 'note-1',
      title: 'Test Note',
      notebookId: 'nb-1',
      notebookName: 'My Notebook',
      updatedAt: new Date('2026-03-01'),
      isPinned: false,
      titleHighlight: '[[HL]]Test[[/HL]] Note',
      contentHighlight: 'Some [[HL]]test[[/HL]] content',
      rank: 0.5,
    },
  ];

  it('returns search results with correct pagination metadata', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce(mockSearchResults);

    const result = await searchNotes('user-1', 'test');

    expect(result).toEqual({
      results: mockSearchResults,
      total: 1,
      page: 1,
      limit: 20,
    });
  });

  it('passes userId and query to the count query', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    await searchNotes('user-1', 'hello');

    const countCall = prismaMock.$queryRawUnsafe.mock.calls[0];
    // First param is the SQL string, then userId, then query
    expect(countCall[1]).toBe('user-1');
    expect(countCall[2]).toBe('hello');
  });

  it('passes userId, query, limit, and offset to the search query', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ total: 5 }])
      .mockResolvedValueOnce(mockSearchResults);

    await searchNotes('user-1', 'hello', 2, 10);

    const searchCall = prismaMock.$queryRawUnsafe.mock.calls[1];
    // Params: SQL, userId, query, limit, offset
    expect(searchCall[1]).toBe('user-1');
    expect(searchCall[2]).toBe('hello');
    expect(searchCall[3]).toBe(10); // limit
    expect(searchCall[4]).toBe(10); // offset = (2-1) * 10
  });

  it('uses default page=1 and limit=20 when not provided', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const result = await searchNotes('user-1', 'test');

    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);

    // Verify offset is 0 for page 1
    const searchCall = prismaMock.$queryRawUnsafe.mock.calls[1];
    expect(searchCall[3]).toBe(20); // default limit
    expect(searchCall[4]).toBe(0);  // offset = (1-1) * 20
  });

  it('calculates offset correctly for various pages', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ total: 100 }])
      .mockResolvedValueOnce([]);

    await searchNotes('user-1', 'query', 3, 15);

    const searchCall = prismaMock.$queryRawUnsafe.mock.calls[1];
    expect(searchCall[3]).toBe(15); // limit
    expect(searchCall[4]).toBe(30); // offset = (3-1) * 15
  });

  it('returns empty results when count is zero', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const result = await searchNotes('user-1', 'nonexistent');

    expect(result.results).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('defaults total to 0 when count query returns empty array', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([]) // empty count result
      .mockResolvedValueOnce([]);

    const result = await searchNotes('user-1', 'test');

    expect(result.total).toBe(0);
  });

  describe('with notebookId filter', () => {
    it('includes notebookId in count query params', async () => {
      prismaMock.$queryRawUnsafe
        .mockResolvedValueOnce([{ total: 3 }])
        .mockResolvedValueOnce([]);

      await searchNotes('user-1', 'test', 1, 20, 'nb-1');

      const countCall = prismaMock.$queryRawUnsafe.mock.calls[0];
      // With notebookId: SQL, userId, query, notebookId
      expect(countCall[1]).toBe('user-1');
      expect(countCall[2]).toBe('test');
      expect(countCall[3]).toBe('nb-1');
    });

    it('includes notebookId in search query params', async () => {
      prismaMock.$queryRawUnsafe
        .mockResolvedValueOnce([{ total: 3 }])
        .mockResolvedValueOnce([]);

      await searchNotes('user-1', 'test', 1, 20, 'nb-1');

      const searchCall = prismaMock.$queryRawUnsafe.mock.calls[1];
      // With notebookId: SQL, userId, query, limit, offset, notebookId
      expect(searchCall[1]).toBe('user-1');
      expect(searchCall[2]).toBe('test');
      expect(searchCall[3]).toBe(20);
      expect(searchCall[4]).toBe(0);
      expect(searchCall[5]).toBe('nb-1');
    });

    it('includes notebook condition in SQL when notebookId is provided', async () => {
      prismaMock.$queryRawUnsafe
        .mockResolvedValueOnce([{ total: 0 }])
        .mockResolvedValueOnce([]);

      await searchNotes('user-1', 'test', 1, 20, 'nb-1');

      const countSql = prismaMock.$queryRawUnsafe.mock.calls[0][0];
      expect(countSql).toContain('notebookId');

      const searchSql = prismaMock.$queryRawUnsafe.mock.calls[1][0];
      expect(searchSql).toContain('notebookId');
    });
  });

  describe('without notebookId filter', () => {
    it('does not pass notebookId param to count query', async () => {
      prismaMock.$queryRawUnsafe
        .mockResolvedValueOnce([{ total: 0 }])
        .mockResolvedValueOnce([]);

      await searchNotes('user-1', 'test');

      const countCall = prismaMock.$queryRawUnsafe.mock.calls[0];
      // Without notebookId: SQL, userId, query (3 params)
      expect(countCall).toHaveLength(3);
    });

    it('does not pass notebookId param to search query', async () => {
      prismaMock.$queryRawUnsafe
        .mockResolvedValueOnce([{ total: 0 }])
        .mockResolvedValueOnce([]);

      await searchNotes('user-1', 'test');

      const searchCall = prismaMock.$queryRawUnsafe.mock.calls[1];
      // Without notebookId: SQL, userId, query, limit, offset (5 params)
      expect(searchCall).toHaveLength(5);
    });
  });

  it('returns multiple results with correct structure', async () => {
    const multipleResults = [
      { ...mockSearchResults[0], id: 'note-1', rank: 0.8 },
      { ...mockSearchResults[0], id: 'note-2', rank: 0.5 },
      { ...mockSearchResults[0], id: 'note-3', rank: 0.3 },
    ];

    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ total: 3 }])
      .mockResolvedValueOnce(multipleResults);

    const result = await searchNotes('user-1', 'test');

    expect(result.results).toHaveLength(3);
    expect(result.total).toBe(3);
  });

  it('makes exactly two raw queries per call (count + search)', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    await searchNotes('user-1', 'test');

    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('SQL queries filter out trashed and encrypted notes', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    await searchNotes('user-1', 'test');

    const countSql = prismaMock.$queryRawUnsafe.mock.calls[0][0];
    expect(countSql).toContain('isTrashed');
    expect(countSql).toContain('isEncrypted');

    const searchSql = prismaMock.$queryRawUnsafe.mock.calls[1][0];
    expect(searchSql).toContain('isTrashed');
    expect(searchSql).toContain('isEncrypted');
  });

  it('SQL search query orders by isPinned, rank, and updatedAt', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    await searchNotes('user-1', 'test');

    const searchSql = prismaMock.$queryRawUnsafe.mock.calls[1][0];
    expect(searchSql).toContain('isPinned');
    expect(searchSql).toContain('rank');
    expect(searchSql).toContain('updatedAt');
  });
});
