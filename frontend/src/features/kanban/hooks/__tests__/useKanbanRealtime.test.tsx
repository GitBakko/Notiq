import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { mockDb, mockAuthStore, mockQueryClient } = vi.hoisted(() => {
  const createTable = () => ({
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(1),
    where: vi.fn(() => ({ equals: vi.fn(() => ({ delete: vi.fn().mockResolvedValue(0) })) })),
  });
  return {
    mockDb: { kanbanCards: createTable(), kanbanColumns: createTable() },
    mockAuthStore: { getState: vi.fn(() => ({ token: 'test-token', user: { id: 'user-1' } })) },
    mockQueryClient: { invalidateQueries: vi.fn() },
  };
});

vi.mock('../../../../lib/db', () => ({ db: mockDb }));
vi.mock('../../../../store/authStore', () => ({ useAuthStore: mockAuthStore }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => mockQueryClient }));

import { useKanbanRealtime } from '../useKanbanRealtime';

function sseStream(payloads: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const p of payloads) controller.enqueue(encoder.encode(`data: ${JSON.stringify(p)}\n\n`));
      controller.close();
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthStore.getState.mockReturnValue({ token: 'test-token', user: { id: 'user-1' } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useKanbanRealtime harness', () => {
  it('invalidates the board query on a remote event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: sseStream([{ type: 'card:deleted', boardId: 'board-1', cardId: 'card-9', actorId: 'user-2' }]),
    }));

    renderHook(() => useKanbanRealtime('board-1'));

    await waitFor(() => {
      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['kanban-board', 'board-1'] });
    });
  });
});

describe('useKanbanRealtime reconnect', () => {
  it('schedules a reconnect when the SSE response is not ok', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, body: null });
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => useKanbanRealtime('board-nok'));

    // Flush the pending fetch promise
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // First backoff step is 2000ms
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    unmount();
  });

  it('schedules a reconnect when the stream ends cleanly', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, body: { getReader: () => ({ read: () => Promise.resolve({ done: true, value: undefined }) }) } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => useKanbanRealtime('board-eof'));

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    unmount();
  });

  it('does NOT reconnect after unmount', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, body: null });
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => useKanbanRealtime('board-unmount'));

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unmount();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
