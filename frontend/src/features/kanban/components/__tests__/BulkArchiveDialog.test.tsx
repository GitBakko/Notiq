import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// i18n: return the key verbatim (mirrors CardContextMenu.test.tsx)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// getApiErrorMessage (errorUtils.ts) calls i18n.t directly, not via the hook
vi.mock('i18next', () => ({
  default: { t: (k: string) => k },
}));

const { mockApi, mockToastError } = vi.hoisted(() => ({
  mockApi: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  mockToastError: vi.fn(),
}));
vi.mock('../../../../lib/api', () => ({ default: mockApi }));
vi.mock('react-hot-toast', () => ({
  default: { error: mockToastError, success: vi.fn() },
}));

import BulkArchiveDialog from '../BulkArchiveDialog';

describe('BulkArchiveDialog — handleArchive error path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces the server error via toast when the archive request is rejected, instead of silently completing', async () => {
    mockApi.post
      // preview
      .mockResolvedValueOnce({ data: [{ id: 'card-1', title: 'Stale card', updatedAt: '2026-01-01' }] })
      // archive — server rejects (e.g. the cardIds cap, or any other validation failure)
      .mockRejectedValueOnce({ response: { data: { message: 'errors.kanban.bulkArchiveFailed' } } });

    const onArchived = vi.fn();
    const onClose = vi.fn();

    render(
      <BulkArchiveDialog
        isOpen
        onClose={onClose}
        boardId="board-1"
        onPreview={vi.fn()}
        onArchived={onArchived}
      />
    );

    fireEvent.click(screen.getByText('kanban.bulkArchive.preview'));
    // Preview resolves async — the archive button only renders once previewCards is populated
    await screen.findByText('kanban.bulkArchive.archive');

    fireEvent.click(screen.getByText('kanban.bulkArchive.archive'));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('errors.kanban.bulkArchiveFailed');
    });

    // Before the fix this was a bare try/finally: the spinner reset but nothing
    // told the user the archive failed, and onArchived/onClose never ran either
    // way — a failure and a success looked identical. Pin that it stays a
    // no-op on failure now that the error is surfaced.
    expect(onArchived).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
