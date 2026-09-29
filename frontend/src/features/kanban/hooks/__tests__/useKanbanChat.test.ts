import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const { mockUseQuery } = vi.hoisted(() => ({ mockUseQuery: vi.fn(() => ({ data: [], isLoading: false })) }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: mockUseQuery,
  useMutation: () => ({ mutate: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('../../kanbanService', () => ({ getBoardChat: vi.fn(), sendBoardChatMessage: vi.fn() }));

import { useKanbanChat } from '../useKanbanChat';

// 5.3 — the board chat polled every 3 s on top of the SSE `chat:message` event that
// already invalidates it (useKanbanRealtime). The only gap SSE left, messages sent while
// the stream was down, is closed by invalidating the chat on `connected`.
describe('useKanbanChat', () => {
  it('does not poll: new messages arrive through the SSE chat:message event', () => {
    renderHook(() => useKanbanChat('board-1'));

    const options = mockUseQuery.mock.calls[0][0] as { refetchInterval?: unknown };
    expect(options.refetchInterval).toBeUndefined();
  });
});
