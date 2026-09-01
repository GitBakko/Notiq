import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Task 6 fix round 2: useImport was the one other syncPull caller in the
// frontend, and it called syncPull() bare, dropping the pruned-board-ids
// return value — silently reopening the "board deleted, tab still rendering
// it" window fix round 1 closed for useSync. It now goes through the shared
// pullAndInvalidateBoards helper (mocked here) instead of syncPull directly;
// this test proves the wiring at THIS call site, not the loop itself (that's
// syncInvalidation.test.ts's job).
// ---------------------------------------------------------------------------

const { mockAxiosPost } = vi.hoisted(() => ({ mockAxiosPost: vi.fn() }));
vi.mock('axios', () => ({ default: { post: mockAxiosPost } }));

vi.mock('react-hot-toast', () => ({
  default: { loading: vi.fn(() => 'toast-id'), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

// The hook's notebook-picking path isn't exercised here (the hidden file
// input's onChange is invoked directly), so an empty list is enough.
vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => [] }));

vi.mock('../../lib/db', () => ({ db: { notebooks: {} } }));

const { mockUseAuthStore } = vi.hoisted(() => {
  const state = { user: { id: 'user-1' }, token: 'test-token' };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- zustand store double: callable + static getState()
  const fn: any = vi.fn((selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state));
  fn.getState = vi.fn(() => state);
  return { mockUseAuthStore: fn };
});
vi.mock('../../store/authStore', () => ({ useAuthStore: mockUseAuthStore }));

const { mockQueryClient } = vi.hoisted(() => ({ mockQueryClient: { invalidateQueries: vi.fn() } }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => mockQueryClient }));

const { mockPullAndInvalidate } = vi.hoisted(() => ({ mockPullAndInvalidate: vi.fn() }));
vi.mock('../../features/sync/syncInvalidation', () => ({ pullAndInvalidateBoards: mockPullAndInvalidate }));

import { useImport } from '../useImport';

beforeEach(() => {
  vi.clearAllMocks();
  mockPullAndInvalidate.mockResolvedValue([]);
});

async function selectFile(hiddenInput: { props: { onChange: (e: unknown) => Promise<void> } }, file: File): Promise<void> {
  await act(async () => {
    await hiddenInput.props.onChange({ target: { files: [file] } });
  });
}

describe('useImport — post-import kanban invalidation (fix round 2)', () => {
  it('routes the post-import pull through the shared helper, with its own queryClient', async () => {
    mockAxiosPost.mockResolvedValue({ data: { importedCount: 3 } });
    const { result } = renderHook(() => useImport());

    const file = new File(['<xml/>'], 'notes.enex', { type: 'text/xml' });
    await selectFile(result.current.hiddenInput as never, file);

    expect(mockPullAndInvalidate).toHaveBeenCalledTimes(1);
    expect(mockPullAndInvalidate).toHaveBeenCalledWith(mockQueryClient);
  });

  it('does not invalidate anything when the upload itself fails', async () => {
    mockAxiosPost.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useImport());

    const file = new File(['<xml/>'], 'notes.enex', { type: 'text/xml' });
    await selectFile(result.current.hiddenInput as never, file);

    expect(mockPullAndInvalidate).not.toHaveBeenCalled();
  });
});
