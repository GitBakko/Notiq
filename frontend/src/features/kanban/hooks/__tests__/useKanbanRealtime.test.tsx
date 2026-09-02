import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const { mockDb, mockAuthStore, mockQueryClient, mockLogout } = vi.hoisted(() => {
  const createTable = () => ({
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(1),
    where: vi.fn(() => ({ equals: vi.fn(() => ({ delete: vi.fn().mockResolvedValue(0) })) })),
  });
  const mockLogout = vi.fn();
  return {
    mockDb: { kanbanCards: createTable(), kanbanColumns: createTable() },
    mockAuthStore: {
      getState: vi.fn(() => ({ token: 'test-token', user: { id: 'user-1' }, logout: mockLogout })),
    },
    mockQueryClient: { invalidateQueries: vi.fn() },
    mockLogout,
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
  mockAuthStore.getState.mockReturnValue({ token: 'test-token', user: { id: 'user-1' }, logout: mockLogout });
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
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, body: null });
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
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, body: null });
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => useKanbanRealtime('board-unmount'));

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unmount();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('useKanbanRealtime terminal denials (C3)', () => {
  function jsonResponse(status: number) {
    return { ok: false, status, body: null };
  }

  it('stops reconnecting when access was revoked (403)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(403));
    vi.stubGlobal('fetch', fetchMock);

    const { result, unmount } = renderHook(() => useKanbanRealtime('board-403'));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Without this the client loops at 2s/4s/8s/16s/30s forever while still showing the
    // board it can no longer read.
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.accessDenied).toBe('revoked');

    unmount();
  });

  it('stops reconnecting when the board is gone (404)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404));
    vi.stubGlobal('fetch', fetchMock);

    const { result, unmount } = renderHook(() => useKanbanRealtime('board-404'));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });

    // A 404 is the one the board query papers over with the Dexie copy, so without a
    // terminal signal the page renders a ghost board indefinitely.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.accessDenied).toBe('deleted');

    unmount();
  });

  it('logs out and stops reconnecting when the token was invalidated (401)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401));
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => useKanbanRealtime('board-401'));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });

    // This is the status a password change produces, and it is what the axios interceptor
    // would already have done for any REST call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockLogout).toHaveBeenCalled();

    unmount();
  });

  it('keeps retrying a rate limit (429)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(429));
    vi.stubGlobal('fetch', fetchMock);

    const { result, unmount } = renderHook(() => useKanbanRealtime('board-429'));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    // 4xx is not uniformly definitive: throttling is transient, and treating it as a
    // revocation would throw a legitimate user off the board.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.accessDenied).toBeNull();

    unmount();
  });

  it('keeps retrying a gateway error (502)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(502));
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => useKanbanRealtime('board-502'));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    unmount();
  });

  it('re-reads the token on every reconnect', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(502));
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => useKanbanRealtime('board-refresh'));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // The axios interceptor refreshes the JWT behind the app's back. A stream that
    // captured the token once keeps polling with a dead one, forever, while everything
    // else stays healthy.
    mockAuthStore.getState.mockReturnValue({ token: 'refreshed-token', user: { id: 'user-1' }, logout: mockLogout });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { Authorization: 'Bearer refreshed-token' } }),
    );

    unmount();
  });
});
