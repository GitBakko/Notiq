import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { mockService } = vi.hoisted(() => ({
  mockService: {
    getFriends: vi.fn(),
    getFriendSuggestions: vi.fn(),
    searchUsers: vi.fn(),
    getPendingRequests: vi.fn(),
    sendFriendRequest: vi.fn(),
    getOrCreateDirectConversation: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../chatService', () => mockService);

import FriendRequestModal from '../FriendRequestModal';

beforeEach(() => {
  vi.clearAllMocks();
  mockService.getFriends.mockResolvedValue([]);
  mockService.getFriendSuggestions.mockResolvedValue([
    { id: 'u-9', name: 'Zoe', email: 'zoe@example.com', avatarUrl: null, color: null },
  ]);
  mockService.getPendingRequests.mockResolvedValue([]);
  mockService.sendFriendRequest.mockResolvedValue(undefined);
});

// Follow-up of #9: friend REQUESTS lived under two caches too — ['chat', ...] in this
// modal and ['friends', ...] in SharedWithMePage — and sending a request here
// invalidated ['chat','sentRequests'], a key no query ever used.
describe('FriendRequestModal — friend request caches', () => {
  it('shares the pending-requests cache with the sharing page', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <FriendRequestModal isOpen onClose={() => {}} onStartChat={() => {}} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(mockService.getPendingRequests).toHaveBeenCalled());
    expect(client.getQueryCache().find({ queryKey: ['friends', 'pendingRequests'], exact: true })).toBeDefined();
    expect(client.getQueryCache().find({ queryKey: ['chat', 'pendingRequests'], exact: true })).toBeUndefined();
  });

  it('refreshes the sent-requests list the sharing page reads after sending a request', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    render(
      <QueryClientProvider client={client}>
        <FriendRequestModal isOpen onClose={() => {}} onStartChat={() => {}} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByText('friends.findFriends'));
    fireEvent.click(await screen.findByText('friends.addFriend'));

    await waitFor(() => expect(mockService.sendFriendRequest).toHaveBeenCalledWith('u-9'));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['friends', 'sentRequests'] }));
  });
});
