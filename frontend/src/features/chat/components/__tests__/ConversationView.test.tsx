import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { mockGetMessages } = vi.hoisted(() => ({ mockGetMessages: vi.fn() }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../chatService', () => ({
  getMessages: mockGetMessages,
  getConversations: vi.fn().mockResolvedValue([]),
  searchMessages: vi.fn().mockResolvedValue([]),
  uploadChatFile: vi.fn(),
}));
vi.mock('../../ChatContext', () => ({
  useChatContext: () => ({ isConnected: true, send: vi.fn(), on: vi.fn(), off: vi.fn(), setActiveConversationId: vi.fn() }),
}));
vi.mock('../../../../store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u-1', name: 'Alice', email: 'a@example.com' } }),
}));
vi.mock('../../../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../MessageBubble', () => ({ default: ({ message }: { message: { content: string } }) => <div>{message.content}</div> }));
vi.mock('../MessageInput', () => ({ default: () => null }));
vi.mock('../ReactionPicker', () => ({ default: () => null }));
vi.mock('../EmojiPicker', () => ({ default: () => null }));

import ConversationView from '../ConversationView';

const sender = { id: 'u-2', name: 'Bob', email: 'b@example.com', avatarUrl: null, color: null };
const msg = (i: number) => ({
  id: `dm-${i}`, conversationId: 'conv-1', senderId: 'u-2', sender, content: `message ${i}`,
  replyTo: null, reactions: [], files: [], editedAt: null, isDeleted: false,
  createdAt: new Date(Date.UTC(2026, 8, 29, 10, 0, 0, i)).toISOString(),
});
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => msg(from + k));

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConversationView conversationId="conv-1" onBack={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
});

// T7 follow-up: "load more" pages with the `before` cursor. The cursor must be the
// OLDEST message held (allMessages is ascending), or scrollback repeats or skips rows.
describe('ConversationView — load more', () => {
  it('asks for the messages older than the oldest one loaded, page after page', async () => {
    mockGetMessages.mockImplementation(async (_conv: string, _page: number, _limit?: number, before?: string) => {
      if (!before) return range(100, 150);      // page 1: the newest 50, ascending
      if (before === 'dm-100') return range(50, 100);
      return range(0, 10);
    });

    renderView();
    await screen.findByText('message 149');

    fireEvent.click(screen.getByText('chat.loadMore'));
    await screen.findByText('message 50');
    expect(mockGetMessages).toHaveBeenLastCalledWith('conv-1', 1, 50, 'dm-100');

    fireEvent.click(screen.getByText('chat.loadMore'));
    await screen.findByText('message 0');
    expect(mockGetMessages).toHaveBeenLastCalledWith('conv-1', 1, 50, 'dm-50');

    // Fewer than 50 came back: there is nothing older, the button goes away.
    await waitFor(() => expect(screen.queryByText('chat.loadMore')).not.toBeInTheDocument());
  });
});
