import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// i18n: return the key, plus the interpolation values so the page label is checkable.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      o && 'total' in o ? `${k}:${o.from}-${o.to}/${o.total}` : k,
    i18n: { language: 'en' },
  }),
}));

const { mockGetArchivedCards, mockUnarchiveCard } = vi.hoisted(() => ({
  mockGetArchivedCards: vi.fn(),
  mockUnarchiveCard: vi.fn(),
}));
vi.mock('../../kanbanService', () => ({
  getArchivedCards: mockGetArchivedCards,
  unarchiveCard: mockUnarchiveCard,
}));

import ArchivedCardsModal from '../ArchivedCardsModal';

const card = (id: string) => ({ id, title: `Card ${id}`, columnTitle: 'Done', archivedAt: '2026-01-01T00:00:00Z' });

function renderModal() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ArchivedCardsModal isOpen onClose={vi.fn()} boardId="board-1" onUnarchive={vi.fn()} />
    </QueryClientProvider>,
  );
}

// Kanban 6.4: the archive is paged (50 per page), and each card shows its column.
describe('ArchivedCardsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the column of each archived card', async () => {
    mockGetArchivedCards.mockResolvedValue({ cards: [card('a')], total: 1, page: 1, limit: 50 });

    renderModal();

    expect(await screen.findByText('Card a')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    // A single page needs no pager.
    expect(screen.queryByRole('button', { name: 'common.next' })).not.toBeInTheDocument();
  });

  it('pages through the archive', async () => {
    mockGetArchivedCards.mockImplementation((_boardId: string, page: number) =>
      Promise.resolve(
        page === 1
          ? { cards: [card('a')], total: 51, page: 1, limit: 50 }
          : { cards: [card('z')], total: 51, page: 2, limit: 50 },
      ),
    );

    renderModal();

    expect(await screen.findByText('kanban.archive.pageOf:1-50/51')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.previous' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'common.next' }));

    expect(await screen.findByText('Card z')).toBeInTheDocument();
    expect(mockGetArchivedCards).toHaveBeenLastCalledWith('board-1', 2);
    expect(screen.getByText('kanban.archive.pageOf:51-51/51')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'common.next' })).toBeDisabled());
  });

  it('goes back a page when restoring the only card of the last page', async () => {
    mockUnarchiveCard.mockResolvedValue(undefined);
    let total = 51;
    mockGetArchivedCards.mockImplementation((_boardId: string, page: number) =>
      Promise.resolve(
        page === 1
          ? { cards: [card('a')], total, page: 1, limit: 50 }
          : { cards: total > 50 ? [card('z')] : [], total, page: 2, limit: 50 },
      ),
    );

    renderModal();
    await screen.findByText('Card a');
    fireEvent.click(screen.getByRole('button', { name: 'common.next' }));
    await screen.findByText('Card z');

    total = 50;
    fireEvent.click(screen.getByRole('button', { name: 'kanban.archive.unarchive' }));

    expect(await screen.findByText('Card a')).toBeInTheDocument();
    expect(mockGetArchivedCards).toHaveBeenLastCalledWith('board-1', 1);
  });

  it('reopens on page 1', async () => {
    mockGetArchivedCards.mockImplementation((_boardId: string, page: number) =>
      Promise.resolve({ cards: [card(page === 1 ? 'a' : 'z')], total: 51, page, limit: 50 }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (isOpen: boolean) => (
      <QueryClientProvider client={queryClient}>
        <ArchivedCardsModal isOpen={isOpen} onClose={vi.fn()} boardId="board-1" onUnarchive={vi.fn()} />
      </QueryClientProvider>
    );

    const { rerender } = render(ui(true));
    await screen.findByText('Card a');
    fireEvent.click(screen.getByRole('button', { name: 'common.next' }));
    await screen.findByText('Card z');

    rerender(ui(false));
    rerender(ui(true));

    expect(await screen.findByText('Card a')).toBeInTheDocument();
  });
});
