import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { mockUseLiveQuery, mockRetry, mockToast } = vi.hoisted(() => ({
  mockUseLiveQuery: vi.fn(),
  mockRetry: vi.fn().mockResolvedValue(undefined),
  mockToast: Object.assign(vi.fn(), { error: vi.fn() }),
}));

vi.mock('dexie-react-hooks', () => ({ useLiveQuery: mockUseLiveQuery }));
vi.mock('../../../features/sync/syncService', () => ({ retryFailedSyncItems: mockRetry }));
vi.mock('react-hot-toast', () => ({ default: mockToast }));
vi.mock('../../../lib/db', () => ({ db: { syncQueue: {} } }));
vi.mock('../../../store/authStore', () => ({
  useAuthStore: (selector?: (s: { user: { id: string } }) => unknown) => {
    const state = { user: { id: 'user-1' } };
    return selector ? selector(state) : state;
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count !== undefined ? `${key}:${opts.count}` : key,
  }),
}));

import SyncStatusIndicator from '../SyncStatusIndicator';

describe('SyncStatusIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when the queue is empty', () => {
    mockUseLiveQuery.mockReturnValue([]);
    const { container } = render(<SyncStatusIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for fresh pending items (normal debounce window)', () => {
    mockUseLiveQuery.mockReturnValue([
      { id: 1, createdAt: Date.now() - 1000, userId: 'user-1' },
    ]);
    const { container } = render(<SyncStatusIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the pending banner when the oldest pending item is older than 15s', () => {
    mockUseLiveQuery.mockReturnValue([
      { id: 1, createdAt: Date.now() - 20_000, userId: 'user-1' },
      { id: 2, createdAt: Date.now() - 18_000, userId: 'user-1' },
    ]);
    render(<SyncStatusIndicator />);
    expect(screen.getByText('sync.pending:2')).toBeTruthy();
  });

  it('shows the failed banner with a retry button; clicking calls retryFailedSyncItems', () => {
    mockUseLiveQuery.mockReturnValue([
      { id: 1, status: 'failed', createdAt: Date.now() - 1000, userId: 'user-1' },
    ]);
    render(<SyncStatusIndicator />);
    expect(screen.getByText('sync.failed:1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(mockRetry).toHaveBeenCalledOnce();
  });

  it('failed banner takes precedence over pending banner', () => {
    mockUseLiveQuery.mockReturnValue([
      { id: 1, status: 'failed', createdAt: Date.now() - 90_000, userId: 'user-1' },
      { id: 2, createdAt: Date.now() - 90_000, userId: 'user-1' },
    ]);
    render(<SyncStatusIndicator />);
    expect(screen.getByText('sync.failed:1')).toBeTruthy();
    expect(screen.queryByText('sync.pending:1')).toBeNull();
  });

  it('fires the error toast only on the FIRST transition to failed', () => {
    mockUseLiveQuery.mockReturnValue([
      { id: 1, status: 'failed', createdAt: Date.now(), userId: 'user-1' },
    ]);
    const { rerender } = render(<SyncStatusIndicator />);
    expect(mockToast.error).toHaveBeenCalledTimes(1);
    rerender(<SyncStatusIndicator />);
    expect(mockToast.error).toHaveBeenCalledTimes(1); // still exactly once
  });
});
